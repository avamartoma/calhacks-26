import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { grantedRole, requireAccess } from "./access";
import { recordEvent } from "./events";
import { currentUser } from "./identity";
import { keyRow } from "./keyStore";
import { openSession } from "./sessions";

declare const process: { env: Record<string, string | undefined> };

// The built-in agents (office, watcher, reviewer, planner; the ASI:One / Fetch.ai agents). Jobs people
// queue in the web office are done here in Convex by builtinAgents.ts. The same agents can also run
// hosted on Agentverse for ASI:One chat; those reach these functions over HTTPS (http.ts), check in,
// report activity and may claim jobs, and only read or start work on team demo projects.

export const AGENTS = ["office", "watcher", "reviewer", "planner"] as const;
export const JOB_KINDS: Record<string, string[]> = { office: ["chat"], reviewer: ["review"], planner: ["plan", "create", "start"] };
export const ONLINE_MS = 30_000;
const LINES_FOR_JOB = 80;

const agentName = v.union(v.literal("office"), v.literal("watcher"), v.literal("reviewer"), v.literal("planner"));
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** A project and, when the job is about one, a run: what an agent needs to do the job. */
async function context(ctx: QueryCtx, projectId: Id<"projects">, runId?: Id<"agentRuns">) {
  const project = await ctx.db.get(projectId);
  const run = runId ? await ctx.db.get(runId) : null;
  const lines = run ? await ctx.db.query("runLines").withIndex("by_run", (q) => q.eq("runId", run._id)).order("desc").take(LINES_FOR_JOB) : [];
  return {
    project: project ? { id: project._id, name: project.name, description: project.description, slug: project.shareSlug ?? project.slug } : null,
    run: run ? {
      id: run._id, prompt: run.prompt, status: run.status, detail: run.detail ?? null, by: run.userLabel,
      agent: run.agent ?? "claude",
      lines: lines.reverse().map((line) => ({ kind: line.kind, text: clip(line.text, 1500) })),
    } : null,
  };
}

async function startRunAsOwner(ctx: MutationCtx, project: Doc<"projects">, prompt: string, via: string) {
  const text = prompt.trim();
  if (!text) throw new Error("Describe the work to start");
  if (text.length > 8000) throw new Error("Keep the task under 8000 characters");
  // Runs started by an agent use the project owner's own Claude connection, as if they'd started it.
  if (!(await keyRow(ctx, project.ownerId, "claude"))) throw new Error("The project owner hasn't connected Claude in the web office yet");
  const sessionId = await openSession(ctx, project._id, "claude", project.ownerId);
  const runId = await ctx.db.insert("agentRuns", {
    projectId: project._id, agent: "claude", userId: project.ownerId, userLabel: `${via} (Fetch.ai)`, sessionId,
    prompt: text, status: "starting", offset: 0, startedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.agentRunner.launch, { runId });
  await recordEvent(ctx, { projectId: project._id, sessionId, kind: "agent.started", detail: `${via} (Fetch.ai): ${clip(text, 200)}` });
  return runId;
}

// ---- Called by the hosted agents over HTTPS (see http.ts) ----

export const heartbeat = internalMutation({
  args: { name: agentName, address: v.string(), details: v.any() },
  handler: async (ctx, args) => {
    if (!/^agent1[0-9a-z]{20,80}$/.test(args.address)) throw new Error("That isn't an agent address");
    const row = await ctx.db.query("fetchAgents").withIndex("by_name", (q) => q.eq("name", args.name)).unique();
    const fields = { address: args.address, details: args.details ?? {}, lastSeen: Date.now() };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("fetchAgents", { name: args.name, ...fields });
    const queued = await ctx.db.query("fetchJobs").withIndex("by_agent_status", (q) => q.eq("agent", args.name).eq("status", "queued")).take(5);
    const jobs = [];
    for (const job of queued) {
      await ctx.db.patch(job._id, { status: "running", startedAt: Date.now() });
      jobs.push({ id: job._id, kind: job.kind, payload: job.payload, requestedBy: job.requestedBy, ...(await context(ctx, job.projectId, job.runId)) });
    }
    return { jobs };
  },
});

export const activity = internalMutation({
  args: { name: agentName, kind: v.string(), text: v.string(), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    await ctx.db.insert("fetchActivity", { name: args.name, kind: clip(args.kind.trim(), 40) || "note", text: clip(args.text.trim(), 6000), ...(args.projectId ? { projectId: args.projectId } : {}) });
  },
});

export const finish = internalMutation({
  args: { id: v.id("fetchJobs"), name: agentName, status: v.union(v.literal("done"), v.literal("failed")), result: v.any() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job || job.agent !== args.name || job.status !== "running") throw new Error("Job not found");
    if (JSON.stringify(args.result ?? {}).length > 40_000) throw new Error("Job result is too large");
    await ctx.db.patch(job._id, { status: args.status, result: args.result ?? {}, finishedAt: Date.now() });
  },
});

/** Team demo projects and their recent runs, for the office agent's answers and the watcher. */
export const state = internalQuery({
  args: {},
  handler: async (ctx) => {
    const projects = (await ctx.db.query("projects").order("desc").collect()).filter((project) => project.fetchDemo);
    return await Promise.all(projects.map(async (project) => {
      const runs = await ctx.db.query("agentRuns").withIndex("by_project", (q) => q.eq("projectId", project._id)).order("desc").take(8);
      const session = await ctx.db.query("sessions").withIndex("by_project", (q) => q.eq("projectId", project._id)).order("desc").first();
      return {
        id: project._id, name: project.name, description: project.description, slug: project.shareSlug ?? project.slug,
        preview: session?.previewStatus === "live" ? session.previewUrl ?? null : null,
        runs: runs.map((run) => ({ id: run._id, prompt: clip(run.prompt, 300), status: run.status, detail: run.detail ? clip(run.detail, 500) : null, by: run.userLabel, startedAt: run.startedAt, finishedAt: run.finishedAt ?? null })),
      };
    }));
  },
});

export const runReport = internalQuery({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    const project = await ctx.db.get(run.projectId);
    if (!project?.fetchDemo) throw new Error("That run isn't in a team demo project");
    return await context(ctx, run.projectId, run._id);
  },
});

/** The office or planner agent starts work on a team demo project. */
export const dispatch = internalMutation({
  args: { name: agentName, projectId: v.id("projects"), prompt: v.string() },
  handler: async (ctx, args) => {
    if (args.name !== "office" && args.name !== "planner") throw new Error("Only the office and planner agents start work");
    const project = await ctx.db.get(args.projectId);
    if (!project?.fetchDemo) throw new Error("That project isn't a team demo project");
    const runId = await startRunAsOwner(ctx, project, args.prompt, args.name === "office" ? "Office agent" : "Planner agent");
    await ctx.db.insert("fetchActivity", { name: args.name, kind: "dispatch", text: `Started work: ${clip(args.prompt.trim(), 300)}`, projectId: project._id });
    return { runId };
  },
});

/** The office agent asks the reviewer to look at a run (`review` from ASI:One). */
export const requestFromAgent = internalMutation({
  args: { name: agentName, agent: v.string(), kind: v.string(), projectId: v.id("projects"), runId: v.optional(v.id("agentRuns")), payload: v.any() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project?.fetchDemo) throw new Error("That project isn't a team demo project");
    return { job: await queue(ctx, { agent: args.agent, kind: args.kind, projectId: args.projectId, runId: args.runId, payload: args.payload, requestedBy: `${args.name} agent` }) };
  },
});

async function queue(ctx: MutationCtx, job: { agent: string; kind: string; projectId: Id<"projects">; runId?: Id<"agentRuns">; payload: unknown; requestedBy: string; requesterId?: string }) {
  if (!JOB_KINDS[job.agent]?.includes(job.kind)) throw new Error("That agent doesn't take this kind of job");
  if (JSON.stringify(job.payload ?? {}).length > 20_000) throw new Error("That request is too large");
  if (job.kind === "chat") {
    const text = (job.payload as { text?: unknown })?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new Error("Write a message of up to 4000 characters");
  }
  if (job.runId) {
    const run = await ctx.db.get(job.runId);
    if (!run || run.projectId !== job.projectId) throw new Error("Run not found");
  }
  if (job.kind !== "chat") {
    const open = await ctx.db.query("fetchJobs").withIndex("by_project", (q) => q.eq("projectId", job.projectId)).order("desc").take(40);
    if (open.some((row) => row.agent === job.agent && row.kind === job.kind && row.runId === job.runId && (row.status === "queued" || row.status === "running"))) {
      throw new Error("That request is already in progress");
    }
  }
  const jobId = await ctx.db.insert("fetchJobs", { agent: job.agent, kind: job.kind, projectId: job.projectId, ...(job.runId ? { runId: job.runId } : {}), payload: job.payload ?? {}, status: "queued", requestedBy: job.requestedBy, ...(job.requesterId ? { requesterId: job.requesterId } : {}) });
  // The built-in agents take it straight away. A hosted Agentverse agent checking in first would claim it instead.
  await ctx.scheduler.runAfter(0, internal.builtinAgents.run, { jobId });
  return jobId;
}

// ---- Used by the built-in agents (builtinAgents.ts), which run here in Convex ----

/** Marks a queued job as taken and returns what's needed to do it, or null if someone else took it. */
export const claim = internalMutation({
  args: { jobId: v.id("fetchJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "queued") return null;
    await ctx.db.patch(job._id, { status: "running", startedAt: Date.now() });
    const project = await ctx.db.get(job.projectId);
    const runs = await ctx.db.query("agentRuns").withIndex("by_project", (q) => q.eq("projectId", job.projectId)).order("desc").take(8);
    return {
      id: job._id, agent: job.agent, kind: job.kind, payload: job.payload, requestedBy: job.requestedBy,
      requesterId: job.requesterId ?? project?.ownerId ?? "",
      runs: runs.map((run) => ({ id: run._id, prompt: clip(run.prompt, 300), status: run.status, detail: run.detail ? clip(run.detail, 500) : null, by: run.userLabel, agent: run.agent ?? "claude" })),
      ...(await context(ctx, job.projectId, job.runId)),
    };
  },
});

/** A run and its output, for the office agent's `report`. The job was access-checked when it was queued. */
export const runContext = internalQuery({
  args: { projectId: v.id("projects"), runId: v.id("agentRuns") },
  handler: async (ctx, args) => await context(ctx, args.projectId, args.runId),
});

/** The office agent asking the reviewer, on behalf of whoever asked the office agent. */
export const queueFor = internalMutation({
  args: { agent: v.string(), kind: v.string(), projectId: v.id("projects"), runId: v.optional(v.id("agentRuns")), requestedBy: v.string(), requesterId: v.string() },
  handler: async (ctx, args) => await queue(ctx, { ...args, payload: {} }),
});

/** Jobs still waiting, for builtinAgents.drain. */
export const queued = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ids = [];
    for (const name of AGENTS) for (const job of await ctx.db.query("fetchJobs").withIndex("by_agent_status", (q) => q.eq("agent", name).eq("status", "queued")).take(50)) ids.push(job._id);
    return ids;
  },
});

/** A Claude API key the built-in agents can use for this person: their own, if it's an API key. */
export const modelKey = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const row = args.userId ? await keyRow(ctx, args.userId, "claude") : null;
    return row && !row.subscription ? { ciphertext: row.ciphertext, iv: row.iv } : null;
  },
});

/** Starts an agent run for the person who asked, on the first of their connections that's set up. */
export const startFor = internalMutation({
  args: { projectId: v.id("projects"), userId: v.string(), userLabel: v.string(), prompt: v.string(), via: v.string(), prefer: v.optional(v.union(v.literal("codex"), v.literal("claude"), v.literal("cursor"))), model: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const text = args.prompt.trim();
    if (!text) throw new Error("Describe the work to start");
    // The preferred program if the person has it connected, otherwise the first one they do.
    let agent: "claude" | "codex" | "cursor" | null = null;
    for (const provider of [...(args.prefer ? [args.prefer] : []), "claude", "codex", "cursor"] as const) if (!agent && (await keyRow(ctx, args.userId, provider))) agent = provider;
    if (!agent) throw new Error("Connect Codex, Claude or Cursor in Accounts first, so there's an agent to start");
    const sessionId = await openSession(ctx, args.projectId, agent, args.userId);
    const runId = await ctx.db.insert("agentRuns", {
      projectId: args.projectId, agent, userId: args.userId, userLabel: args.userLabel, sessionId,
      prompt: clip(text, 8000), status: "starting", offset: 0, startedAt: Date.now(),
      // The model only goes with the program it was chosen for.
      ...(args.model && agent === args.prefer ? { model: args.model } : {}),
    });
    await ctx.scheduler.runAfter(0, internal.agentRunner.launch, { runId });
    await ctx.db.insert("fetchActivity", { name: args.via, kind: "dispatch", text: `Started work for ${args.userLabel}: ${clip(text, 300)}`, projectId: args.projectId });
    return { runId, agent };
  },
});

// ---- Called by the web office ----

/** The agents, with when each last checked in, and this project's activity and jobs. */
export const snapshot = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireAccess(ctx, args.projectId, "viewer");
    const project = await ctx.db.get(args.projectId);
    const rows = await ctx.db.query("fetchAgents").collect();
    const agents = AGENTS.map((name) => {
      const row = rows.find((item) => item.name === name);
      return { name, address: row?.address ?? "", lastSeen: row?.lastSeen ?? 0, details: row?.details ?? {} };
    });
    const activity = await ctx.db.query("fetchActivity").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).order("desc").take(30);
    const jobs = await ctx.db.query("fetchJobs").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).order("desc").take(30);
    return {
      demo: !!project?.fetchDemo,
      // The agents also run here in Convex, so they're always available; a hosted copy only adds ASI:One chat.
      builtIn: true,
      jira: process.env.JIRA_PROJECT && process.env.JIRA_SITE ? { project: process.env.JIRA_PROJECT.toUpperCase(), site: process.env.JIRA_SITE.replace(/\/$/, "").replace(/^(?!https:\/\/)/, "https://") } : null,
      agents,
      activity: activity.map((row) => ({ id: row._id, at: row._creationTime, name: row.name, kind: row.kind, text: row.text })),
      jobs: jobs.map((job) => ({ id: job._id, at: job._creationTime, agent: job.agent, kind: job.kind, runId: job.runId ?? null, payload: job.payload, status: job.status, result: job.result ?? null, requestedBy: job.requestedBy })),
    };
  },
});

/**
 * Where each built-in agent has worked lately, among projects the caller can see: the sky shows each
 * one on the cloud it last worked on (src/sky/builtins.ts), and nowhere until it's been used.
 */
export const builtinUses = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const visible = new Map<string, boolean>();
    const canSee = async (projectId: Id<"projects">) => {
      if (!visible.has(projectId)) {
        const project = await ctx.db.get(projectId);
        visible.set(projectId, !!project && !!(await grantedRole(ctx, project, user)));
      }
      return visible.get(projectId)!;
    };
    const uses: { name: string; projectId: string; at: number; working: boolean }[] = [];
    for (const job of await ctx.db.query("fetchJobs").order("desc").take(200)) {
      if (await canSee(job.projectId)) uses.push({ name: job.agent, projectId: job.projectId, at: job._creationTime, working: job.status === "queued" || job.status === "running" });
    }
    for (const row of await ctx.db.query("fetchActivity").order("desc").take(300)) {
      if (row.projectId && (await canSee(row.projectId))) uses.push({ name: row.name, projectId: row.projectId, at: row._creationTime, working: false });
    }
    return uses;
  },
});

/** Hands an agent work from the page: a chat message, a review of a run, or a planning job. */
export const request = mutation({
  args: { projectId: v.id("projects"), agent: v.string(), kind: v.string(), runId: v.optional(v.id("agentRuns")), payload: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (user.local) throw new Error("Sign in to work with the built-in agents");
    await requireAccess(ctx, args.projectId, "editor");
    return await queue(ctx, { agent: args.agent, kind: args.kind, projectId: args.projectId, runId: args.runId, payload: args.payload ?? {}, requestedBy: user.name || user.email || "Someone", requesterId: user.id });
  },
});

export const setDemo = mutation({
  args: { projectId: v.id("projects"), on: v.boolean() },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    if (project.ownerId !== user.id) throw new Error("Only the project owner can change this");
    await ctx.db.patch(args.projectId, { fetchDemo: args.on });
    return { ok: true as const };
  },
});
