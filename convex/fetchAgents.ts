import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAccess } from "./access";
import { recordEvent } from "./events";
import { currentUser } from "./identity";
import { keyRow } from "./keyStore";
import { openSession } from "./sessions";

// The four ASI:One (Fetch.ai) agents, hosted on Agentverse, work with the web office through here,
// the same way the local ones work with server/fetch-agents.mjs: they check in, report what they did,
// and take the jobs people queue for them. Office and planner can also start work, but only on
// projects their owners marked as team demo projects.

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

async function queue(ctx: MutationCtx, job: { agent: string; kind: string; projectId: Id<"projects">; runId?: Id<"agentRuns">; payload: unknown; requestedBy: string }) {
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
  return await ctx.db.insert("fetchJobs", { agent: job.agent, kind: job.kind, projectId: job.projectId, ...(job.runId ? { runId: job.runId } : {}), payload: job.payload ?? {}, status: "queued", requestedBy: job.requestedBy });
}

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
      agents,
      activity: activity.map((row) => ({ id: row._id, at: row._creationTime, name: row.name, kind: row.kind, text: row.text })),
      jobs: jobs.map((job) => ({ id: job._id, at: job._creationTime, agent: job.agent, kind: job.kind, runId: job.runId ?? null, payload: job.payload, status: job.status, result: job.result ?? null, requestedBy: job.requestedBy })),
    };
  },
});

/** Hands an agent work from the page: a chat message, a review of a run, or a planning job. */
export const request = mutation({
  args: { projectId: v.id("projects"), agent: v.string(), kind: v.string(), runId: v.optional(v.id("agentRuns")), payload: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (user.local) throw new Error("Sign in to work with the Fetch.ai agents");
    await requireAccess(ctx, args.projectId, "editor");
    const project = await ctx.db.get(args.projectId);
    // Starting work goes through the planner on the owner's connection, so it needs a team demo project.
    if (args.kind === "start" && !project?.fetchDemo) throw new Error("Mark this as a team demo project to let the planner start work");
    return await queue(ctx, { agent: args.agent, kind: args.kind, projectId: args.projectId, runId: args.runId, payload: args.payload ?? {}, requestedBy: user.name || user.email || "Someone" });
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
