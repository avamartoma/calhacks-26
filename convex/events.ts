import { v } from "convex/values";
import { query, type MutationCtx } from "./_generated/server";
import { grantedRole, requireAccess } from "./access";
import { currentUser } from "./identity";
import type { Doc, Id } from "./_generated/dataModel";

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
    await requireAccess(ctx, args.projectId, "viewer");
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
    const user = await currentUser(ctx);
    const events = await ctx.db.query("events").order("desc").collect();
    const allowed = new Map<string, boolean>();
    const visible: Doc<"events">[] = [];
    for (const event of events) {
      let canView = allowed.get(event.projectId);
      if (canView === undefined) {
        const project = await ctx.db.get(event.projectId);
        canView = project ? (await grantedRole(ctx, project, user)) !== null : false;
        allowed.set(event.projectId, canView);
      }
      if (!canView) continue;
      visible.push(event);
      if (visible.length >= 50) break;
    }
    return visible;
  },
});
