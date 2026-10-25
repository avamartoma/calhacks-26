import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireAccess } from "./access";

/** The files a run changed, and where to fetch its patch. Anyone who can view the project can see them. */
export const forRun = query({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    await requireAccess(ctx, run.projectId, "viewer");
    const row = await ctx.db.query("runChanges").withIndex("by_run", (q) => q.eq("runId", args.runId)).unique();
    if (!row) return null;
    return {
      files: row.files ?? null,
      patchUrl: row.patch ? await ctx.storage.getUrl(row.patch) : null,
      truncated: !!row.truncated,
      error: row.error ?? null,
    };
  },
});

/** The project's running sandbox, if it has one. */
export const readySandbox = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const sessions = await ctx.db.query("sessions").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).order("desc").take(10);
    return sessions.find((session) => session.status === "ready" && session.sandboxId)?.sandboxId ?? null;
  },
});

/** Downloads are kept for an hour. */
export const forget = internalMutation({
  args: { id: v.id("_storage") },
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.id);
  },
});

export const baselineFor = internalQuery({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("runChanges").withIndex("by_run", (q) => q.eq("runId", args.runId)).unique();
    return row?.baseline ?? null;
  },
});

export const saveBaseline = internalMutation({
  args: { runId: v.id("agentRuns"), baseline: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    const row = await ctx.db.query("runChanges").withIndex("by_run", (q) => q.eq("runId", args.runId)).unique();
    const fields = { ...(args.baseline ? { baseline: args.baseline } : {}), ...(args.error ? { error: args.error } : {}) };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("runChanges", { runId: args.runId, projectId: run.projectId, ...fields });
  },
});

export const saveChanges = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    files: v.array(v.object({ path: v.string(), added: v.number(), removed: v.number() })),
    patch: v.optional(v.id("_storage")),
    truncated: v.boolean(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("runChanges").withIndex("by_run", (q) => q.eq("runId", args.runId)).unique();
    if (!row) return;
    if (row.patch) await ctx.storage.delete(row.patch);
    await ctx.db.patch(row._id, { files: args.files, truncated: args.truncated, ...(args.patch ? { patch: args.patch } : {}) });
  },
});
