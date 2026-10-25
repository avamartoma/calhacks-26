import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireAccess } from "./access";
import { recordEvent } from "./events";
import { currentUser } from "./identity";
import { connectionProblem, keyRow, providerValidator } from "./keyStore";
import { beginSession } from "./sessions";

const MAX_PROMPT = 8000;
const MAX_ACTIVE_PER_PROJECT = 3;
const LINE_LIMIT = 4000;

const active = (run: Doc<"agentRuns">) => run.status === "starting" || run.status === "running";
const NAMES = { codex: "Codex", claude: "Claude", cursor: "Cursor" } as const;

/**
 * Starts a Codex, Claude Code or Cursor agent on this project, in its cloud sandbox, on the
 * caller's own key for that provider. Needs edit access. agentRunner.launch takes it from here.
 */
export const start = mutation({
  args: { projectId: v.id("projects"), prompt: v.string(), agent: v.optional(providerValidator) },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (user.local) throw new Error("Sign in to start an agent");
    await requireAccess(ctx, args.projectId, "editor");
    const prompt = args.prompt.trim();
    if (!prompt) throw new Error("Describe what the agent should do");
    if (prompt.length > MAX_PROMPT) throw new Error(`Keep the task under ${MAX_PROMPT} characters`);
    const agent = args.agent ?? "claude";
    const problem = connectionProblem(await keyRow(ctx, user.id, agent), NAMES[agent]);
    if (problem) throw new Error(problem);
    const runs = await ctx.db.query("agentRuns").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect();
    if (runs.filter(active).length >= MAX_ACTIVE_PER_PROJECT) {
      throw new Error(`${MAX_ACTIVE_PER_PROJECT} agents are already working on this project. Wait for one to finish.`);
    }
    const sessionId = await beginSession(ctx, args.projectId, agent);
    const userLabel = user.name || user.email || "Someone";
    const runId = await ctx.db.insert("agentRuns", {
      projectId: args.projectId,
      agent,
      userId: user.id,
      userLabel,
      sessionId,
      prompt,
      status: "starting",
      offset: 0,
      startedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.agentRunner.launch, { runId });
    await recordEvent(ctx, { projectId: args.projectId, sessionId, kind: "agent.started", detail: `${userLabel} (${NAMES[agent]}): ${prompt.slice(0, 200)}` });
    return runId;
  },
});

/** Runs on this project, newest first, each with its latest line. */
export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireAccess(ctx, args.projectId, "viewer");
    const user = await currentUser(ctx);
    const runs = await ctx.db.query("agentRuns").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).order("desc").take(20);
    return await Promise.all(runs.map(async (run) => {
      const last = await ctx.db.query("runLines").withIndex("by_run", (q) => q.eq("runId", run._id)).order("desc").first();
      return {
        id: run._id,
        agent: run.agent ?? "claude",
        prompt: run.prompt,
        status: run.status,
        detail: run.detail ?? null,
        userLabel: run.userLabel,
        mine: run.userId === user.id,
        costUsd: run.costUsd ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        lastLine: last ? { kind: last.kind, text: last.text.slice(0, 280) } : null,
      };
    }));
  },
});

export const lines = query({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    await requireAccess(ctx, run.projectId, "viewer");
    const rows = await ctx.db.query("runLines").withIndex("by_run", (q) => q.eq("runId", args.runId)).order("desc").take(300);
    return rows.reverse().map((row) => ({ id: row._id, at: row.at, kind: row.kind, text: row.text }));
  },
});

export const stop = mutation({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    await requireAccess(ctx, run.projectId, "editor");
    if (!active(run)) return { ok: true as const };
    await ctx.db.patch(run._id, { status: "stopped", detail: "Stopped", finishedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.agentRunner.kill, { runId: run._id });
    // What it changed before it was stopped, once the process is gone.
    await ctx.scheduler.runAfter(5000, internal.runChanges.capture, { runId: run._id });
    return { ok: true as const };
  },
});

export const getInternal = internalQuery({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const session = run.sessionId ? await ctx.db.get(run.sessionId) : null;
    return {
      run,
      session: session ? { status: session.status, sandboxId: session.sandboxId ?? null } : null,
    };
  },
});

export const markRunning = internalMutation({
  args: { runId: v.id("agentRuns"), pid: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "starting") return { stillWanted: false };
    await ctx.db.patch(args.runId, { status: "running", pid: args.pid });
    return { stillWanted: true };
  },
});

export const append = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    offset: v.number(),
    lines: v.array(v.object({ kind: v.union(v.literal("text"), v.literal("tool"), v.literal("result"), v.literal("error")), text: v.string() })),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    const at = Date.now();
    for (const line of args.lines) await ctx.db.insert("runLines", { runId: args.runId, at, kind: line.kind, text: line.text.slice(0, LINE_LIMIT) });
    await ctx.db.patch(args.runId, { offset: args.offset });
    if (run.sessionId) await ctx.db.patch(run.sessionId, { lastActiveAt: at });
  },
});

export const finish = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    status: v.union(v.literal("done"), v.literal("error"), v.literal("stopped")),
    detail: v.optional(v.string()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    // A stop from the office wins over the runner noticing the process ended.
    const status = run.status === "stopped" ? "stopped" : args.status;
    await ctx.db.patch(args.runId, {
      status,
      finishedAt: run.finishedAt ?? Date.now(),
      ...(args.detail !== undefined && run.status !== "stopped" ? { detail: args.detail.slice(0, 500) } : {}),
      ...(args.costUsd !== undefined ? { costUsd: args.costUsd } : {}),
    });
    await recordEvent(ctx, {
      projectId: run.projectId,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      kind: `agent.${status}`,
      detail: `${run.userLabel}: ${(args.detail ?? run.prompt).slice(0, 200)}`,
    });
    await ctx.scheduler.runAfter(0, internal.runChanges.capture, { runId: args.runId });
  },
});

/**
 * For checking the runner from the CLI (`npx convex run agentRuns:testStart`): runs `command`
 * in place of Claude Code, with no key. Internal, so no browser can call it.
 */
export const testStart = internalMutation({
  args: { projectId: v.id("projects"), command: v.string(), agent: v.optional(providerValidator) },
  handler: async (ctx, args) => {
    const sessionId = await beginSession(ctx, args.projectId, "claude");
    const runId = await ctx.db.insert("agentRuns", {
      projectId: args.projectId, agent: args.agent ?? "claude", userId: "test", userLabel: "Test", sessionId,
      prompt: "test run", status: "starting", offset: 0, startedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.agentRunner.launch, { runId, testCommand: args.command });
    return runId;
  },
});
