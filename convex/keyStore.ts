import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { currentUser } from "./identity";

export const providerValidator = v.union(v.literal("codex"), v.literal("claude"), v.literal("cursor"));
export const methodValidator = v.union(v.literal("apiKey"), v.literal("chatgpt"), v.literal("claudeAccount"), v.literal("cursorAccount"));
export type Provider = "codex" | "claude" | "cursor";
export type Method = "apiKey" | "chatgpt" | "claudeAccount" | "cursorAccount";
export const PROVIDERS: Provider[] = ["codex", "claude", "cursor"];

const providerOf = (row: Doc<"userKeys">): Provider => row.provider ?? "claude";
const methodOf = (row: Doc<"userKeys">): Method => row.method ?? "apiKey";

export async function keyRow(ctx: QueryCtx, userId: string, provider: Provider) {
  const rows = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  return rows.find((row) => providerOf(row) === provider) ?? null;
}

/** Why a saved connection can't run an agent right now, or null when it can. */
export function connectionProblem(row: Doc<"userKeys"> | null, name: string): string | null {
  if (!row) return `Connect ${name} first`;
  if (row.expiresAt !== undefined && row.expiresAt <= Date.now()) return `Your ${name} sign-in expired. Sign in again in Accounts.`;
  return null;
}

/** Which of Codex, Claude and Cursor the signed-in person has connected, and how. Never returns a secret. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    type Entry = { connected: boolean; method: Method | null; last4: string | null; subscription: boolean; email: string | null; expiresAt: number | null };
    const empty = (): Entry => ({ connected: false, method: null, last4: null, subscription: false, email: null, expiresAt: null });
    const providers: Record<Provider, Entry> = { codex: empty(), claude: empty(), cursor: empty() };
    if (user.local) return { signedIn: false, providers };
    const rows = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", user.id)).collect();
    for (const row of rows) {
      providers[providerOf(row)] = {
        connected: row.expiresAt === undefined || row.expiresAt > Date.now(),
        method: methodOf(row),
        last4: methodOf(row) === "apiKey" ? row.last4 : null,
        subscription: !!row.subscription,
        email: row.email ?? null,
        expiresAt: row.expiresAt ?? null,
      };
    }
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
  args: {
    userId: v.string(), provider: providerValidator, method: methodValidator,
    ciphertext: v.string(), iv: v.string(), last4: v.string(), subscription: v.boolean(),
    email: v.optional(v.string()), expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await keyRow(ctx, args.userId, args.provider);
    const fields = {
      provider: args.provider, method: args.method, ciphertext: args.ciphertext, iv: args.iv, last4: args.last4,
      subscription: args.subscription, email: args.email, expiresAt: args.expiresAt, updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("userKeys", { userId: args.userId, ...fields });
  },
});

/** After a run, a signed-in account's refreshed credentials replace the stored ones, unless they changed meanwhile. */
export const refresh = internalMutation({
  args: { userId: v.string(), provider: providerValidator, method: methodValidator, before: v.string(), ciphertext: v.string(), iv: v.string() },
  handler: async (ctx, args) => {
    const row = await keyRow(ctx, args.userId, args.provider);
    if (!row || methodOf(row) !== args.method || row.ciphertext !== args.before) return;
    await ctx.db.patch(row._id, { ciphertext: args.ciphertext, iv: args.iv, updatedAt: Date.now() });
  },
});

export const get = internalQuery({
  args: { userId: v.string(), provider: providerValidator },
  handler: async (ctx, args) => {
    const row = await keyRow(ctx, args.userId, args.provider);
    return row ? { ciphertext: row.ciphertext, iv: row.iv, subscription: !!row.subscription, method: methodOf(row) } : null;
  },
});
