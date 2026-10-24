import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { currentUser, LOCAL_USER_ID } from "./identity";
import { fileChangeOpValidator } from "./validators";

export const record = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    path: v.string(),
    op: fileChangeOpValidator,
    contentHash: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return { ok: false as const };
    await ctx.db.insert("fileChanges", {
      projectId: session.projectId,
      sessionId: args.sessionId,
      path: args.path,
      author: session.userId,
      contentHash: args.contentHash,
      op: args.op,
      at: Date.now(),
    });
    return { ok: true as const };
  },
});

export const since = query({
  args: { projectId: v.id("projects"), after: v.number() },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error(`Project ${args.projectId} not found`);
    const owns = project.ownerId === user.id || (user.local && project.ownerId === LOCAL_USER_ID);
    if (!owns) throw new Error("Only the project owner can sync cloud files");
    const rows = await ctx.db
      .query("fileChanges")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(200);
    return rows.filter((row) => row.at > args.after).reverse();
  },
});
