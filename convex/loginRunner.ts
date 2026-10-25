"use node";

// "Sign in with ChatGPT" for Codex. Codex's own device sign-in runs in a short-lived sandbox of its
// own (never a project's): it prints a link and a one-time code, the person enters the code at
// OpenAI, and Codex writes its auth.json, which is stored encrypted for that person's Codex runs.

import { Sandbox } from "e2b";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { encryptKey } from "./lib/keyCrypto";

declare const process: { env: Record<string, string | undefined> };

const HOME = "/tmp/codex-login";
const POLL_MS = 3000;
const SANDBOX_MS = 17 * 60 * 1000;
// The same version the local office pins, keeping its credentials in a file rather than a keychain.
const CODEX = "@openai/codex@0.156.1";
const CODEX_FILE_STORE = '-c cli_auth_credentials_store="file"';

function e2bKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) throw new Error("E2B_API_KEY must be set in the Convex environment");
  return key;
}

async function sh(sandbox: Sandbox, cmd: string, timeoutMs = 60_000) {
  try {
    const result = await sandbox.commands.run(cmd, { timeoutMs });
    return { out: result.stdout, code: result.exitCode };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; exitCode?: number };
    if (typeof failed?.exitCode === "number") return { out: `${failed.stdout ?? ""}${failed.stderr ?? ""}`, code: failed.exitCode };
    throw error;
  }
}

/** The email in Codex's ID token, for showing who is signed in. Display only, so the token isn't verified. */
function emailOf(auth: { tokens?: { id_token?: string } }): string | undefined {
  try {
    const part = (auth.tokens?.id_token ?? "").split(".")[1] ?? "";
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))));
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

async function fail(ctx: ActionCtx, loginId: Id<"logins">, detail: string, sandboxId?: string) {
  await ctx.runMutation(internal.logins.update, { loginId, status: "error", detail: detail.slice(0, 400) });
  if (sandboxId) await ctx.scheduler.runAfter(0, internal.loginRunner.stop, { sandboxId });
}

export const codexStart = internalAction({
  args: { loginId: v.id("logins") },
  handler: async (ctx, args): Promise<void> => {
    let sandbox: Sandbox | null = null;
    try {
      sandbox = await Sandbox.create({ apiKey: e2bKey(), timeoutMs: SANDBOX_MS });
      const kept = await ctx.runMutation(internal.logins.update, { loginId: args.loginId, sandboxId: sandbox.sandboxId });
      if (!kept.open) { await sandbox.kill(); return; }
      const install = await sh(sandbox, `export PATH="$HOME/.local/bin:$PATH"; command -v codex >/dev/null || npm install -g --prefix "$HOME/.local" ${CODEX} >/tmp/codex-install.log 2>&1 || { tail -n 20 /tmp/codex-install.log; exit 1; }`, 240_000);
      if (install.code !== 0) return await fail(ctx, args.loginId, `Couldn't prepare Codex sign-in: ${install.out.trim().slice(-300)}`, sandbox.sandboxId);
      await sandbox.commands.run(`export PATH="$HOME/.local/bin:$PATH"; mkdir -p ${HOME}; CODEX_HOME=${HOME} codex ${CODEX_FILE_STORE} login --device-auth < /dev/null > /tmp/login.out 2>&1; echo $? > /tmp/login.exit`, { background: true });
      // Codex prints the link and code within a few seconds.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const out = (await sh(sandbox, "cat /tmp/login.out 2>/dev/null; true")).out.replace(/\x1b\[[0-9;]*m/g, "");
        const url = out.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0];
        const code = out.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0];
        if (url && code) {
          await ctx.runMutation(internal.logins.update, { loginId: args.loginId, status: "waiting", url, code });
          await ctx.scheduler.runAfter(POLL_MS, internal.loginRunner.codexPoll, { loginId: args.loginId });
          return;
        }
        const exited = (await sh(sandbox, "cat /tmp/login.exit 2>/dev/null; true")).out.trim();
        if (exited) return await fail(ctx, args.loginId, out.trim().split("\n").slice(-3).join(" ") || "Codex sign-in stopped", sandbox.sandboxId);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      await fail(ctx, args.loginId, "Codex didn't show a sign-in code. Try again.", sandbox.sandboxId);
    } catch (error) {
      await fail(ctx, args.loginId, error instanceof Error ? error.message : "Codex sign-in failed", sandbox?.sandboxId);
    }
  },
});

export const codexPoll = internalAction({
  args: { loginId: v.id("logins") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.logins.getInternal, { loginId: args.loginId });
    if (!row || row.status !== "waiting" || !row.sandboxId) {
      if (row?.sandboxId && row.status === "cancelled") await ctx.scheduler.runAfter(0, internal.loginRunner.stop, { sandboxId: row.sandboxId });
      return;
    }
    if (row.expiresAt <= Date.now()) return await fail(ctx, args.loginId, "The code expired. Start again.", row.sandboxId);
    let sandbox: Sandbox;
    try { sandbox = await Sandbox.connect(row.sandboxId, { apiKey: e2bKey() }); }
    catch { return await fail(ctx, args.loginId, "The sign-in was interrupted. Start again."); }
    const auth = (await sh(sandbox, `cat ${HOME}/auth.json 2>/dev/null; true`)).out.trim();
    if (auth) {
      let parsed: { tokens?: { id_token?: string; refresh_token?: string } };
      try { parsed = JSON.parse(auth); } catch { return await fail(ctx, args.loginId, "Codex saved an unreadable sign-in. Start again.", row.sandboxId); }
      if (!parsed.tokens?.refresh_token) return await fail(ctx, args.loginId, "Codex finished without a ChatGPT sign-in. Start again.", row.sandboxId);
      const email = emailOf(parsed);
      await ctx.runMutation(internal.keyStore.put, {
        userId: row.userId, provider: "codex", method: "chatgpt", ...(await encryptKey(auth)), last4: "", subscription: true, ...(email ? { email } : {}),
      });
      await ctx.runMutation(internal.logins.update, { loginId: args.loginId, status: "done" });
      await ctx.scheduler.runAfter(0, internal.loginRunner.stop, { sandboxId: row.sandboxId });
      return;
    }
    const exited = (await sh(sandbox, "cat /tmp/login.exit 2>/dev/null; true")).out.trim();
    if (exited) {
      const out = (await sh(sandbox, "tail -n 4 /tmp/login.out 2>/dev/null; true")).out.replace(/\x1b\[[0-9;]*m/g, "").trim();
      return await fail(ctx, args.loginId, out || "Codex sign-in stopped. Start again.", row.sandboxId);
    }
    await ctx.scheduler.runAfter(POLL_MS, internal.loginRunner.codexPoll, { loginId: args.loginId });
  },
});

export const stop = internalAction({
  args: { sandboxId: v.string() },
  handler: async (_ctx, args): Promise<void> => {
    try { await Sandbox.kill(args.sandboxId, { apiKey: e2bKey() }); } catch { /* Already gone. */ }
  },
});
