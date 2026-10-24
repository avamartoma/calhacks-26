import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { recordEvent } from "./events";
import { assertNonEmpty, placeValidator } from "./validators";

export const create = mutation({
  args: {
    sessionId: v.id("sessions"),
    from: placeValidator,
    to: placeValidator,
    ref: v.string(),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    if (args.from === args.to) {
      throw new Error("handoff from and to must differ");
    }
    const ref = assertNonEmpty(args.ref, "ref");
    const note = assertNonEmpty(args.note, "note");
    const handoffId = await ctx.db.insert("handoffs", {
      sessionId: args.sessionId,
      from: args.from,
      to: args.to,
      ref,
      note,
    });
    await ctx.db.patch(args.sessionId, { location: args.to, lastActiveAt: Date.now() });
    await recordEvent(ctx, {
      projectId: session.projectId,
      sessionId: args.sessionId,
      kind: "handoff.created",
      detail: `${args.from} -> ${args.to} ${ref}: ${note}`,
    });
    return handoffId;
  },
});

export const latest = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const [handoff] = await ctx.db
      .query("handoffs")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(1);
    return handoff ?? null;
  },
});
