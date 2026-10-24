import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { recordEvent } from "./events";
import { agentValidator, assertNonEmpty } from "./validators";

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_EXEC_TIMEOUT_MS = 120_000;

async function requireReadySandbox(ctx: ActionCtx, sessionId: Id<"sessions">): Promise<string> {
  const info = await ctx.runQuery(internal.sessions.getInternal, { sessionId });
  if (!info) {
    throw new Error(`Session ${sessionId} not found`);
  }
  if (info.status !== "ready" || !info.sandboxId) {
    throw new Error(`Session ${sessionId} is ${info.status}`);
  }
  return info.sandboxId;
}

export const start = mutation({
  args: {
    projectId: v.id("projects"),
    userId: v.string(),
    agent: agentValidator,
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error(`Project ${args.projectId} not found`);
    }
    const userId = assertNonEmpty(args.userId, "userId");
    const now = Date.now();
    const sessionId = await ctx.db.insert("sessions", {
      projectId: args.projectId,
      userId,
      agent: args.agent,
      location: "cloud",
      status: "provisioning",
      branch: "visit/pending",
      lastActiveAt: now,
    });
    const branch = `visit/${sessionId}`;
    await ctx.db.patch(sessionId, { branch });
    await ctx.scheduler.runAfter(0, internal.sessions.launch, { sessionId });
    await recordEvent(ctx, {
      projectId: args.projectId,
      sessionId,
      kind: "session.started",
      detail: `${args.agent} provisioning ${branch}`,
    });
    return sessionId;
  },
});

export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const { envUrl: _envUrl, ...publicSession } = session;
    return publicSession;
  },
});

export const stop = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    if (session.status !== "stopped") {
      await ctx.db.patch(args.sessionId, { status: "stopped", lastActiveAt: Date.now() });
      await recordEvent(ctx, {
        projectId: session.projectId,
        sessionId: args.sessionId,
        kind: "session.stopped",
        detail: "stop requested",
      });
    }
    await ctx.scheduler.runAfter(0, internal.sessions.teardown, { sessionId: args.sessionId });
    return args.sessionId;
  },
});

export const heartbeat = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    if (session.status === "stopped") {
      throw new Error(`Session ${args.sessionId} is stopped`);
    }
    const lastActiveAt = Date.now();
    await ctx.db.patch(args.sessionId, { lastActiveAt });
    return { ok: true as const, lastActiveAt };
  },
});

export const getInternal = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return null;
    }
    const project = await ctx.db.get(session.projectId);
    return {
      status: session.status,
      branch: session.branch,
      repoUrl: project?.repoUrl ?? null,
      projectId: session.projectId,
      sandboxId: session.sandboxId ?? null,
      sandboxExtensions: session.sandboxExtensions ?? 0,
      lastActiveAt: session.lastActiveAt,
    };
  },
});

export const markReady = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    envUrl: v.string(),
    sandboxId: v.string(),
    detail: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    if (session.status !== "provisioning") {
      return { skipped: true as const };
    }
    await ctx.db.patch(args.sessionId, {
      status: "ready",
      envUrl: args.envUrl,
      sandboxId: args.sandboxId,
      sandboxExtensions: 0,
      lastActiveAt: Date.now(),
    });
    await recordEvent(ctx, {
      projectId: session.projectId,
      sessionId: args.sessionId,
      kind: "session.ready",
      detail: args.detail,
    });
    return { skipped: false as const };
  },
});

export const noteSandbox = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    kind: v.string(),
    detail: v.string(),
    extensions: v.optional(v.number()),
    stop: v.boolean(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error(`Session ${args.sessionId} not found`);
    await ctx.db.patch(args.sessionId, {
      ...(args.extensions !== undefined ? { sandboxExtensions: args.extensions } : {}),
      ...(args.stop ? { status: "stopped" as const } : {}),
    });
    await recordEvent(ctx, {
      projectId: session.projectId,
      sessionId: args.sessionId,
      kind: args.kind,
      detail: args.detail,
    });
  },
});

export const markError = internalMutation({
  args: { sessionId: v.id("sessions"), message: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    if (session.status !== "provisioning") {
      return { skipped: true as const };
    }
    await ctx.db.patch(args.sessionId, { status: "error" });
    await recordEvent(ctx, {
      projectId: session.projectId,
      sessionId: args.sessionId,
      kind: "session.error",
      detail: args.message,
    });
    return { skipped: false as const };
  },
});

export const recordTeardownFailure = internalMutation({
  args: { sessionId: v.id("sessions"), message: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    await recordEvent(ctx, {
      projectId: session.projectId,
      sessionId: args.sessionId,
      kind: "session.teardown_failed",
      detail: args.message,
    });
  },
});

export const stopIdle = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const sessions = await ctx.db.query("sessions").collect();
    const stopped: string[] = [];
    for (const session of sessions) {
      if (session.status === "stopped" || session.lastActiveAt >= cutoff) {
        continue;
      }
      await ctx.db.patch(session._id, { status: "stopped" });
      await recordEvent(ctx, {
        projectId: session.projectId,
        sessionId: session._id,
        kind: "session.stopped",
        detail: "idle for 30 minutes",
      });
      await ctx.scheduler.runAfter(0, internal.sessions.teardown, { sessionId: session._id });
      stopped.push(session._id);
    }
    return { stopped };
  },
});

export const touch = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const lastActiveAt = Date.now();
    await ctx.db.patch(args.sessionId, { lastActiveAt });
    return { lastActiveAt };
  },
});

export const recordSessionEvent = internalMutation({
  args: { sessionId: v.id("sessions"), kind: v.string(), detail: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    await recordEvent(ctx, {
      projectId: session.projectId,
      sessionId: args.sessionId,
      kind: args.kind,
      detail: args.detail,
    });
  },
});

export const exec = action({
  args: {
    sessionId: v.id("sessions"),
    cmd: v.string(),
    cwd: v.optional(v.string()),
    timeoutMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ stdout: string; stderr: string; code: number }> => {
    const sandboxId = await requireReadySandbox(ctx, args.sessionId);
    await ctx.runMutation(internal.sessions.touch, { sessionId: args.sessionId });
    const cmd = assertNonEmpty(args.cmd, "cmd");
    const timeoutMs = args.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXEC_TIMEOUT_MS) {
      throw new Error("timeoutMs must be an integer from 1 to 120000");
    }
    let result: { stdout: string; stderr: string; code: number };
    try {
      result = await ctx.runAction(internal.sessionSandbox.exec, {
        sandboxId,
        cmd,
        timeoutMs,
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "exec failed";
      await ctx.runMutation(internal.sessions.recordSessionEvent, {
        sessionId: args.sessionId,
        kind: "session.exec",
        detail: `${args.cwd ?? "repo"} failed: ${message.slice(0, 300)}`,
      });
      throw error;
    }
    await ctx.runMutation(internal.sessions.recordSessionEvent, {
      sessionId: args.sessionId,
      kind: "session.exec",
      detail: `${args.cwd ?? "repo"} exited ${result.code}: ${cmd.slice(0, 200)}`,
    });
    return result;
  },
});

export const readFile = action({
  args: { sessionId: v.id("sessions"), path: v.string() },
  handler: async (ctx, args): Promise<{ content: string }> => {
    const sandboxId = await requireReadySandbox(ctx, args.sessionId);
    await ctx.runMutation(internal.sessions.touch, { sessionId: args.sessionId });
    return await ctx.runAction(internal.sessionSandbox.readFile, { sandboxId, path: args.path });
  },
});

export const setPreview = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    previewStatus: v.union(v.literal("starting"), v.literal("live"), v.literal("error")),
    previewUrl: v.optional(v.string()),
    eventKind: v.optional(v.string()),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    if (session.status === "stopped") {
      return { skipped: true as const };
    }
    await ctx.db.patch(args.sessionId, {
      previewStatus: args.previewStatus,
      ...(args.previewUrl !== undefined ? { previewUrl: args.previewUrl } : {}),
      lastActiveAt: Date.now(),
    });
    if (args.eventKind && args.detail !== undefined) {
      await recordEvent(ctx, {
        projectId: session.projectId,
        sessionId: args.sessionId,
        kind: args.eventKind,
        detail: args.detail,
      });
    }
    return { skipped: false as const };
  },
});

export const startPreview = action({
  args: {
    sessionId: v.id("sessions"),
    command: v.optional(v.string()),
    port: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ previewUrl: string; previewStatus: "live" }> => {
    const sandboxId = await requireReadySandbox(ctx, args.sessionId);
    const port = args.port ?? 3000;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("port must be an integer from 1 to 65535");
    }
    const command = args.command === undefined ? undefined : assertNonEmpty(args.command, "command");
    await ctx.runMutation(internal.sessions.touch, { sessionId: args.sessionId });
    await ctx.runMutation(internal.sessions.setPreview, { sessionId: args.sessionId, previewStatus: "starting" });
    try {
      const result: { previewUrl: string; command: string } = await ctx.runAction(internal.sessionSandbox.startPreview, {
        sandboxId,
        port,
        ...(command !== undefined ? { command } : {}),
      });
      await ctx.runMutation(internal.sessions.setPreview, {
        sessionId: args.sessionId,
        previewStatus: "live",
        previewUrl: result.previewUrl,
        eventKind: "session.preview_ready",
        detail: result.previewUrl,
      });
      return { previewUrl: result.previewUrl, previewStatus: "live" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "preview failed";
      await ctx.runMutation(internal.sessions.setPreview, {
        sessionId: args.sessionId,
        previewStatus: "error",
        eventKind: "session.preview_error",
        detail: message.slice(0, 500),
      });
      throw error;
    }
  },
});

export const writeFile = action({
  args: { sessionId: v.id("sessions"), path: v.string(), content: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const sandboxId = await requireReadySandbox(ctx, args.sessionId);
    await ctx.runMutation(internal.sessions.touch, { sessionId: args.sessionId });
    try {
      await ctx.runAction(internal.sessionSandbox.writeFile, { sandboxId, path: args.path, content: args.content });
    } catch (error) {
      const message = error instanceof Error ? error.message : "write failed";
      await ctx.runMutation(internal.sessions.recordSessionEvent, {
        sessionId: args.sessionId,
        kind: "session.write_file",
        detail: `${args.path} failed: ${message.slice(0, 300)}`,
      });
      throw error;
    }
    await ctx.runMutation(internal.sessions.recordSessionEvent, {
      sessionId: args.sessionId,
      kind: "session.write_file",
      detail: args.path,
    });
    return { ok: true as const };
  },
});

export const deleteFile = action({
  args: { sessionId: v.id("sessions"), path: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const sandboxId = await requireReadySandbox(ctx, args.sessionId);
    await ctx.runMutation(internal.sessions.touch, { sessionId: args.sessionId });
    try {
      await ctx.runAction(internal.sessionSandbox.deleteFile, { sandboxId, path: args.path });
    } catch (error) {
      const message = error instanceof Error ? error.message : "delete failed";
      await ctx.runMutation(internal.sessions.recordSessionEvent, {
        sessionId: args.sessionId,
        kind: "session.delete_file",
        detail: `${args.path} failed: ${message.slice(0, 300)}`,
      });
      throw error;
    }
    await ctx.runMutation(internal.sessions.recordSessionEvent, {
      sessionId: args.sessionId,
      kind: "session.delete_file",
      detail: args.path,
    });
    return { ok: true as const };
  },
});

export const launch = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    await ctx.runAction(internal.sessionSandbox.launch, args);
  },
});

export const teardown = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    await ctx.runAction(internal.sessionSandbox.destroy, args);
  },
});
