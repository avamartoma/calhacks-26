// Signing in to Codex (ChatGPT), Claude and Cursor from Connections, the way the local office does:
// - Claude: authorize on claude.ai, then paste the code it shows (same client and flow as server/provider-login.mjs).
// - Cursor: sign in on cursor.com; Cursor's login is polled here and mints a 90-day key, as its SDK does.
// - Codex: Codex's own device sign-in runs in a short-lived sandbox (loginRunner.ts); you enter its code at OpenAI.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { currentUser, userFromIdentity } from "./identity";
import { providerValidator } from "./keyStore";
import { CLAUDE_REDIRECT, parseClaudeCode } from "./lib/claudeCode";
import { decryptKey, encryptKey } from "./lib/keyCrypto";

const LOGIN_TTL = 15 * 60 * 1000;
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CURSOR_WEBSITE = "https://cursor.com";
const CURSOR_BACKEND = "https://api2.cursor.sh";
const CURSOR_KEY_TTL = 90 * 24 * 60 * 60 * 1000;
const statusValidator = v.union(v.literal("preparing"), v.literal("waiting"), v.literal("done"), v.literal("error"), v.literal("cancelled"));

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = async (verifier: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const sealed = async (value: unknown) => encryptKey(JSON.stringify(value));

/** The newest unfinished sign-in for each provider, without its secrets. */
export const current = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (user.local) return [];
    const rows = await ctx.db.query("logins").withIndex("by_user", (q) => q.eq("userId", user.id)).order("desc").take(12);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.provider)) latest.set(row.provider, row);
    return [...latest.values()]
      .filter((row) => row.status === "preparing" || row.status === "waiting" || (row.status === "error" && Date.now() - row._creationTime < LOGIN_TTL))
      .map((row) => ({ id: row._id, provider: row.provider, status: row.status, url: row.url ?? null, code: row.code ?? null, detail: row.detail ?? null, expiresAt: row.expiresAt }));
  },
});

export const insert = internalMutation({
  args: { userId: v.string(), provider: providerValidator, status: statusValidator, url: v.optional(v.string()), secret: v.optional(v.object({ ciphertext: v.string(), iv: v.string() })) },
  handler: async (ctx, args) => {
    // Starting again replaces any sign-in still open for this provider.
    const open = await ctx.db.query("logins").withIndex("by_user", (q) => q.eq("userId", args.userId)).collect();
    for (const row of open) {
      if (row.provider !== args.provider || (row.status !== "preparing" && row.status !== "waiting")) continue;
      await ctx.db.patch(row._id, { status: "cancelled" });
      if (row.sandboxId) await ctx.scheduler.runAfter(0, internal.loginRunner.stop, { sandboxId: row.sandboxId });
    }
    return await ctx.db.insert("logins", { ...args, expiresAt: Date.now() + LOGIN_TTL });
  },
});

export const update = internalMutation({
  args: { loginId: v.id("logins"), status: v.optional(statusValidator), url: v.optional(v.string()), code: v.optional(v.string()), detail: v.optional(v.string()), sandboxId: v.optional(v.string()) },
  handler: async (ctx, { loginId, ...fields }) => {
    const row = await ctx.db.get(loginId);
    // A cancelled or finished sign-in stays that way.
    if (!row || row.status === "cancelled" || row.status === "done") return { open: false };
    await ctx.db.patch(loginId, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    return { open: true };
  },
});

export const getInternal = internalQuery({
  args: { loginId: v.id("logins") },
  handler: async (ctx, args) => await ctx.db.get(args.loginId),
});

/** Starts signing in. Returns the page to open; Codex's link and code arrive through `current` once its sandbox is ready. */
export const start = action({
  args: { provider: providerValidator },
  handler: async (ctx, args): Promise<{ url: string | null }> => {
    const user = userFromIdentity(await ctx.auth.getUserIdentity());
    if (user.local) throw new Error("Sign in to connect an account");
    if (args.provider === "claude") {
      const state = random(), verifier = random();
      const url = new URL("https://claude.ai/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: CLAUDE_CLIENT_ID, response_type: "code", redirect_uri: CLAUDE_REDIRECT,
        scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
        code_challenge: await challenge(verifier), code_challenge_method: "S256", state, code: "true",
      }).toString();
      await ctx.runMutation(internal.logins.insert, { userId: user.id, provider: "claude", status: "waiting", url: url.href, secret: await sealed({ state, verifier }) });
      return { url: url.href };
    }
    if (args.provider === "cursor") {
      const uuid = crypto.randomUUID(), verifier = random();
      const url = `${CURSOR_WEBSITE}/loginDeepControl?challenge=${await challenge(verifier)}&uuid=${uuid}&mode=login&redirectTarget=sdk`;
      const loginId: Id<"logins"> = await ctx.runMutation(internal.logins.insert, { userId: user.id, provider: "cursor", status: "waiting", url, secret: await sealed({ uuid, verifier }) });
      await ctx.scheduler.runAfter(3000, internal.logins.cursorPoll, { loginId });
      return { url };
    }
    const loginId: Id<"logins"> = await ctx.runMutation(internal.logins.insert, { userId: user.id, provider: "codex", status: "preparing" });
    await ctx.scheduler.runAfter(0, internal.loginRunner.codexStart, { loginId });
    return { url: null };
  },
});

export const cancel = mutation({
  args: { provider: providerValidator },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const rows = await ctx.db.query("logins").withIndex("by_user", (q) => q.eq("userId", user.id)).collect();
    for (const row of rows) {
      if (row.provider !== args.provider || (row.status !== "preparing" && row.status !== "waiting" && row.status !== "error")) continue;
      await ctx.db.patch(row._id, { status: "cancelled" });
      if (row.sandboxId) await ctx.scheduler.runAfter(0, internal.loginRunner.stop, { sandboxId: row.sandboxId });
    }
    return { ok: true as const };
  },
});

/** Finishes "Sign in with Claude" with the code claude.ai showed. Saves Claude Code's own credentials file. */
export const completeClaude = action({
  args: { input: v.string() },
  handler: async (ctx, args) => {
    const user = userFromIdentity(await ctx.auth.getUserIdentity());
    if (user.local) throw new Error("Sign in to connect an account");
    const open = await ctx.runQuery(internal.logins.openFor, { userId: user.id, provider: "claude" });
    if (!open?.secret || open.expiresAt <= Date.now()) throw new Error("This sign-in expired. Start again.");
    const { state, verifier } = JSON.parse(await decryptKey(open.secret)) as { state: string; verifier: string };
    const code = parseClaudeCode(args.input, state);
    const response = await fetch("https://api.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: CLAUDE_CLIENT_ID, code, state, code_verifier: verifier, redirect_uri: CLAUDE_REDIRECT }),
    });
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; account?: { email_address?: string } };
    if (!response.ok || !data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)) throw new Error("Claude didn't accept that code. Start again and paste the new code.");
    // Claude Code's native format, so a run can refresh it in place.
    const credentials = { claudeAiOauth: { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in! * 1000, scopes: data.scope ? data.scope.split(" ") : ["user:inference"] } };
    await ctx.runMutation(internal.keyStore.put, {
      userId: user.id, provider: "claude", method: "claudeAccount", ...(await sealed(credentials)), last4: "", subscription: true,
      ...(data.account?.email_address ? { email: data.account.email_address } : {}),
    });
    await ctx.runMutation(internal.logins.update, { loginId: open._id, status: "done" });
    return { ok: true as const };
  },
});

export const openFor = internalQuery({
  args: { userId: v.string(), provider: providerValidator },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("logins").withIndex("by_user", (q) => q.eq("userId", args.userId)).order("desc").collect();
    return rows.find((row) => row.provider === args.provider && row.status === "waiting") ?? null;
  },
});

async function cursorCall<T>(method: string, accessToken: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${CURSOR_BACKEND}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || `Cursor answered ${response.status}`);
  return data;
}

/** Waits for the Cursor sign-in to finish, then mints this person's key, as the Cursor SDK's login does. */
export const cursorPoll = internalAction({
  args: { loginId: v.id("logins") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.logins.getInternal, { loginId: args.loginId });
    if (!row || row.status !== "waiting" || !row.secret) return;
    if (row.expiresAt <= Date.now()) {
      await ctx.runMutation(internal.logins.update, { loginId: args.loginId, status: "error", detail: "The Cursor sign-in expired. Start again." });
      return;
    }
    const { uuid, verifier } = JSON.parse(await decryptKey(row.secret)) as { uuid: string; verifier: string };
    let tokens: { accessToken?: string; refreshToken?: string } | null = null;
    try {
      const response = await fetch(`${CURSOR_BACKEND}/auth/poll`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ uuid, verifier }) });
      if (response.ok) tokens = await response.json();
    } catch {
      // Not signed in yet, or a hiccup: try again shortly.
    }
    if (!tokens?.accessToken) {
      await ctx.scheduler.runAfter(3000, internal.logins.cursorPoll, { loginId: args.loginId });
      return;
    }
    try {
      const expiresAt = Date.now() + CURSOR_KEY_TTL;
      const { apiKey } = await cursorCall<{ apiKey?: string }>("CreateUserApiKey", tokens.accessToken, { name: "opencloud", expiresAt: String(expiresAt) });
      if (!apiKey) throw new Error("Cursor returned no key");
      const me = await cursorCall<{ email?: string }>("GetMe", tokens.accessToken, {}).catch(() => ({ email: undefined }));
      await ctx.runMutation(internal.keyStore.put, {
        userId: row.userId, provider: "cursor", method: "cursorAccount", ...(await encryptKey(apiKey)), last4: apiKey.slice(-4), subscription: false, expiresAt,
        ...(me.email ? { email: me.email } : {}),
      });
      await ctx.runMutation(internal.logins.update, { loginId: args.loginId, status: "done" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      await ctx.runMutation(internal.logins.update, { loginId: args.loginId, status: "error", detail: `Signed in to Cursor, but creating a key failed: ${reason}. Your team's settings may block personal API keys; you can paste a key instead.` });
    }
  },
});
