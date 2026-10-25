import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { currentUser } from "./identity";

export const providerValidator = v.union(v.literal("codex"), v.literal("claude"), v.literal("cursor"));
export type Provider = "codex" | "claude" | "cursor";
export const PROVIDERS: Provider[] = ["codex", "claude", "cursor"];

const providerOf = (row: Doc<"userKeys">): Provider => row.provider ?? "claude";

export async function keyRow(ctx: QueryCtx, userId: string, provider: Provider) {
  const rows = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  return rows.find((row) => providerOf(row) === provider) ?? null;
}

/** Which of Codex, Claude and Cursor the signed-in person has connected. Never returns a key. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const empty = { connected: false, last4: null as string | null, subscription: false };
    const providers = { codex: { ...empty }, claude: { ...empty }, cursor: { ...empty } };
    if (user.local) return { signedIn: false, providers };
    const rows = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", user.id)).collect();
    for (const row of rows) providers[providerOf(row)] = { connected: true, last4: row.last4, subscription: !!row.subscription };
    return { signedIn: true, providers };
  },
});

export const remove = mutation({
  args: { provider: providerValidator },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const row = await keyRow(ctx, user.id, args.provider);
    if (row) await ctx.db.delete(row._id);
    return { ok: true as const };
  },
});

export const put = internalMutation({
  args: { userId: v.string(), provider: providerValidator, ciphertext: v.string(), iv: v.string(), last4: v.string(), subscription: v.boolean() },
  handler: async (ctx, args) => {
    const row = await keyRow(ctx, args.userId, args.provider);
    const fields = { provider: args.provider, ciphertext: args.ciphertext, iv: args.iv, last4: args.last4, subscription: args.subscription, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("userKeys", { userId: args.userId, ...fields });
  },
});

export const get = internalQuery({
  args: { userId: v.string(), provider: providerValidator },
  handler: async (ctx, args) => {
    const row = await keyRow(ctx, args.userId, args.provider);
    return row ? { ciphertext: row.ciphertext, iv: row.iv, subscription: !!row.subscription } : null;
  },
});
