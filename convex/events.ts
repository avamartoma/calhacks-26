import { v } from "convex/values";
import { query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export async function recordEvent(
  ctx: MutationCtx,
  event: {
    projectId: Id<"projects">;
    sessionId?: Id<"sessions">;
    kind: string;
    detail: string;
  },
): Promise<void> {
  await ctx.db.insert("events", {
    projectId: event.projectId,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    kind: event.kind,
    detail: event.detail,
  });
}

export const byProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error(`Project ${args.projectId} not found`);
    }
    return await ctx.db
      .query("events")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(100);
  },
});

export const recent = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("events").order("desc").take(50);
  },
});
