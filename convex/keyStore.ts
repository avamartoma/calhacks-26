import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { currentUser } from "./identity";

/** Whether the signed-in person has saved an Anthropic key. Never returns the key. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (user.local) return { signedIn: false, hasKey: false, last4: null };
    const row = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", user.id)).unique();
    return { signedIn: true, hasKey: !!row, last4: row?.last4 ?? null };
  },
});

export const remove = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const row = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", user.id)).unique();
    if (row) await ctx.db.delete(row._id);
    return { ok: true as const };
  },
});

export const put = internalMutation({
  args: { userId: v.string(), ciphertext: v.string(), iv: v.string(), last4: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", args.userId)).unique();
    const fields = { ciphertext: args.ciphertext, iv: args.iv, last4: args.last4, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("userKeys", { userId: args.userId, ...fields });
  },
});

export const get = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", args.userId)).unique();
    return row ? { ciphertext: row.ciphertext, iv: row.iv } : null;
  },
});
