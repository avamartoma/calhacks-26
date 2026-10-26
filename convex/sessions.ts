import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAccess } from "./access";
import { recordEvent } from "./events";
import { currentUser } from "./identity";
import { agentValidator, assertNonEmpty } from "./validators";

function contentHash(content: string): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}:${content.length}`;
}

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_EXEC_TIMEOUT_MS = 120_000;
const RESUME_LIMIT = 4;
const RESUME_WINDOW_MS = 60_000;
const IDLE_PAUSE_MS = 5 * 60 * 1000;

type AgentName = "claude" | "cursor" | "codex" | "droid";

async function upsertPresence(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  userId: string,
  sessionId: Id<"sessions">,
  agent: AgentName,
) {
  const now = Date.now();
  const rows = await ctx.db
    .query("presence")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  const matches = rows.filter((row) => row.userId === userId);
  const [existing, ...extras] = matches;
  if (existing) {
    await ctx.db.patch(existing._id, { sessionId, agent, lastSeenAt: now });
    for (const extra of extras) {
      await ctx.db.delete(extra._id);
    }
    return;
  }
  await ctx.db.insert("presence", { projectId, userId, sessionId, agent, lastSeenAt: now });
}

async function clearPresence(ctx: MutationCtx, projectId: Id<"projects">, userId: string) {
  const rows = await ctx.db
    .query("presence")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const row of rows) {
    if (row.userId === userId) {
      await ctx.db.delete(row._id);
    }
  }
}

async function hasFreshPresence(ctx: MutationCtx, projectId: Id<"projects">, cutoff: number): Promise<boolean> {
  const rows = await ctx.db
    .query("presence")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return rows.some((row) => row.lastSeenAt >= cutoff);
}

/** Opens the project's sandbox for this caller, reusing a ready session when there is one. */
export async function beginSession(ctx: MutationCtx, projectId: Id<"projects">, agent: AgentName) {
  await requireAccess(ctx, projectId, "viewer");
  const user = await currentUser(ctx);
  return await openSession(ctx, projectId, agent, user.id);
}

/** beginSession without the access check, for callers that already decided, like the hosted Fetch.ai agents. */
export async function openSession(ctx: MutationCtx, projectId: Id<"projects">, agent: AgentName, userId: string) {
  const user = { id: userId };
  const project = await ctx.db.get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  const now = Date.now();
  const existing = await ctx.db.query("sessions").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect();
  const live = existing.find((session) => session.status === "ready");
  if (live) {
    await ctx.db.patch(live._id, { lastActiveAt: now });
    await upsertPresence(ctx, projectId, user.id, live._id, agent);
    return live._id;
  }
  if (project.sandboxId || project.backup) {
    const inWindow = project.resumeWindowStart !== undefined && now - project.resumeWindowStart < RESUME_WINDOW_MS;
    const count = inWindow ? (project.resumeCount ?? 0) : 0;
    if (count >= RESUME_LIMIT) {
      throw new Error("Too many resumes for this project. Wait a minute and try again.");
    }
    await ctx.db.patch(projectId, {
      resumeWindowStart: inWindow ? project.resumeWindowStart : now,
      resumeCount: count + 1,
    });
  }
  const sessionId = await ctx.db.insert("sessions", {
    projectId,
    userId: user.id,
    agent,
    location: "cloud",
    status: "provisioning",
    branch: "visit/pending",
    lastActiveAt: now,
  });
  const branch = `visit/${sessionId}`;
  await ctx.db.patch(sessionId, { branch });
  await ctx.scheduler.runAfter(0, internal.sessions.launch, { sessionId });
  await recordEvent(ctx, {
    projectId,
    sessionId,
    kind: "session.started",
    detail: `${agent} provisioning ${branch}`,
  });
  await upsertPresence(ctx, projectId, user.id, sessionId, agent);
  return sessionId;
}

async function requireReadySandbox(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  minRole: "viewer" | "editor",
): Promise<string> {
  const info = await ctx.runQuery(internal.sessions.getInternal, { sessionId });
  if (!info) {
    throw new Error(`Session ${sessionId} not found`);
  }
  await ctx.runQuery(internal.access.requireRole, { projectId: info.projectId, minRole });
  if (info.status !== "ready" || !info.sandboxId) {
    throw new Error(`Session ${sessionId} is ${info.status}`);
  }
  return info.sandboxId;
}

export const start = mutation({
  args: {
    projectId: v.id("projects"),
    agent: agentValidator,
  },
  handler: async (ctx, args) => beginSession(ctx, args.projectId, args.agent),
});

export const resume = mutation({
  args: {
    projectId: v.id("projects"),
    agent: v.optional(agentValidator),
  },
  handler: async (ctx, args) => beginSession(ctx, args.projectId, args.agent ?? "claude"),
});

export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    await requireAccess(ctx, session.projectId, "viewer");
    const project = await ctx.db.get(session.projectId);
    const snapshotUrl = project?.lastSnapshot ? await ctx.storage.getUrl(project.lastSnapshot) : null;
    const { envUrl: _envUrl, ...publicSession } = session;
    return { ...publicSession, snapshotUrl };
  },
});

export const stop = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    await requireAccess(ctx, session.projectId, "viewer");
    await clearPresence(ctx, session.projectId, user.id);
    if (await hasFreshPresence(ctx, session.projectId, Date.now() - IDLE_PAUSE_MS)) {
      return args.sessionId;
    }
    if (session.status !== "paused" && session.status !== "stopped") {
      await ctx.db.patch(args.sessionId, { status: "paused", lastActiveAt: Date.now() });
      await recordEvent(ctx, {
        projectId: session.projectId,
        sessionId: args.sessionId,
        kind: "session.paused",
        detail: "pause requested",
      });
    }
    await ctx.scheduler.runAfter(0, internal.sessions.pauseSandbox, { sessionId: args.sessionId });
    return args.sessionId;
  },
});

export const heartbeat = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    await requireAccess(ctx, session.projectId, "viewer");
    if (session.status === "stopped") {
      throw new Error(`Session ${args.sessionId} is stopped`);
    }
    const lastActiveAt = Date.now();
    await ctx.db.patch(args.sessionId, { lastActiveAt });
    await upsertPresence(ctx, session.projectId, user.id, args.sessionId, session.agent);
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
      previewUrl: session.previewUrl ?? null,
      projectSandboxId: project?.sandboxId ?? null,
      backupId: project?.backup ?? null,
    };
  },
});

export const markReady = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    envUrl: v.string(),
    sandboxId: v.string(),
    detail: v.string(),
    previewUrl: v.optional(v.string()),
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
      ...(args.previewUrl ? { previewUrl: args.previewUrl, previewStatus: "live" as const } : {}),
    });
    await ctx.db.patch(session.projectId, { sandboxId: args.sandboxId });
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
    pause: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error(`Session ${args.sessionId} not found`);
    await ctx.db.patch(args.sessionId, {
      ...(args.extensions !== undefined ? { sandboxExtensions: args.extensions } : {}),
      ...(args.pause ? { status: "paused" as const } : args.stop ? { status: "stopped" as const } : {}),
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
    const cutoff = Date.now() - IDLE_PAUSE_MS;
    const sessions = await ctx.db.query("sessions").collect();
    const paused: string[] = [];
    for (const session of sessions) {
      if (session.status !== "ready" || session.lastActiveAt >= cutoff) {
        continue;
      }
      if (await hasFreshPresence(ctx, session.projectId, cutoff)) {
        continue;
      }
      await ctx.db.patch(session._id, { status: "paused" });
      await recordEvent(ctx, {
        projectId: session.projectId,
        sessionId: session._id,
        kind: "session.paused",
        detail: "idle for 5 minutes",
      });
      await ctx.scheduler.runAfter(0, internal.sessions.pauseSandbox, { sessionId: session._id });
      paused.push(session._id);
    }
    return { paused };
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
    const sandboxId = await requireReadySandbox(ctx, args.sessionId, "editor");
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
    const sandboxId = await requireReadySandbox(ctx, args.sessionId, "viewer");
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
    if (session.status === "stopped" || session.status === "paused") {
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

/**
 * Makes sure the project's preview is really running: if nothing answers on its port (a dev server
 * that never started, or one a resume didn't bring back), starts it again. The web office calls this
 * when a project opens, so a stale "live" preview doesn't show E2B's "port closed" page. Viewers can
 * call it: it only starts the project's own preview.
 */
export const ensurePreview = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<{ previewStatus: "live" | "error"; previewUrl?: string; restarted: boolean }> => {
    const sandboxId = await requireReadySandbox(ctx, args.sessionId, "viewer");
    const port = 3000;
    if (await ctx.runAction(internal.sessionSandbox.portOpen, { sandboxId, port })) return { previewStatus: "live", restarted: false };
    await ctx.runMutation(internal.sessions.setPreview, { sessionId: args.sessionId, previewStatus: "starting" });
    try {
      const result: { previewUrl: string; command: string } = await ctx.runAction(internal.sessionSandbox.startPreview, { sandboxId, port });
      await ctx.runMutation(internal.sessions.setPreview, { sessionId: args.sessionId, previewStatus: "live", previewUrl: result.previewUrl, eventKind: "session.preview_ready", detail: result.previewUrl });
      return { previewStatus: "live", previewUrl: result.previewUrl, restarted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "preview failed";
      await ctx.runMutation(internal.sessions.setPreview, { sessionId: args.sessionId, previewStatus: "error", eventKind: "session.preview_error", detail: message.slice(0, 500) });
      return { previewStatus: "error", restarted: true };
    }
  },
});

export const startPreview = action({
  args: {
    sessionId: v.id("sessions"),
    command: v.optional(v.string()),
    port: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ previewUrl: string; previewStatus: "live" }> => {
    const sandboxId = await requireReadySandbox(ctx, args.sessionId, "editor");
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
    const sandboxId = await requireReadySandbox(ctx, args.sessionId, "editor");
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
    await ctx.runMutation(internal.fileChanges.record, {
      sessionId: args.sessionId,
      path: args.path,
      op: "write",
      contentHash: contentHash(args.content),
    });
    return { ok: true as const };
  },
});

export const deleteFile = action({
  args: { sessionId: v.id("sessions"), path: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const sandboxId = await requireReadySandbox(ctx, args.sessionId, "editor");
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
    await ctx.runMutation(internal.fileChanges.record, {
      sessionId: args.sessionId,
      path: args.path,
      op: "delete",
      contentHash: "delete",
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

export const pauseSandbox = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    await ctx.runAction(internal.sessionSandbox.pause, args);
  },
});

export const savePauseArtifacts = internalMutation({
  args: {
    projectId: v.id("projects"),
    snapshot: v.optional(v.id("_storage")),
    backup: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return;
    await ctx.db.patch(args.projectId, {
      ...(args.snapshot ? { lastSnapshot: args.snapshot } : {}),
      ...(args.backup ? { backup: args.backup } : {}),
    });
  },
});
