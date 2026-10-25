import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { userFromIdentity } from "./identity";
import { providerValidator } from "./keyStore";
import { encryptKey } from "./lib/keyCrypto";

const clean = (message: string) => ({ ok: false as const, message });

/** Checks a key with its provider where that's possible. Returns why it was refused, or null. */
async function check(provider: "codex" | "claude" | "cursor", key: string): Promise<{ subscription: boolean } | { ok: false; message: string }> {
  if (provider === "claude") {
    // A Claude Pro/Max token from `claude setup-token` only works inside Claude Code, so it can't be checked here.
    if (/^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/.test(key)) return { subscription: true };
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return clean("That isn't a Claude key. An API key starts with sk-ant-api, and a subscription token from claude setup-token starts with sk-ant-oat.");
    const response = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    if (response.status === 401 || response.status === 403) return clean("Anthropic didn't accept this key. Check it and try again.");
    if (!response.ok) return clean(`Couldn't check the key with Anthropic (${response.status}). Try again in a moment.`);
    return { subscription: false };
  }
  if (provider === "codex") {
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return clean("That isn't an OpenAI API key. It starts with sk-.");
    const response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (response.status === 401 || response.status === 403) return clean("OpenAI didn't accept this key. Check it and try again.");
    if (!response.ok) return clean(`Couldn't check the key with OpenAI (${response.status}). Try again in a moment.`);
    return { subscription: false };
  }
  // Cursor's agent checks its key when it starts, and says so in the run if it's wrong.
  if (!/^\S{20,}$/.test(key)) return clean("That doesn't look like a Cursor API key.");
  return { subscription: false };
}

/**
 * Saves the signed-in person's key for Codex, Claude or Cursor. Agents they start with that
 * provider run on it; nobody else's runs use it, and it is never sent back to a browser.
 */
export const save = action({
  args: { provider: providerValidator, key: v.string() },
  handler: async (ctx, args) => {
    const user = userFromIdentity(await ctx.auth.getUserIdentity());
    if (user.local) throw new Error("Sign in to connect an account");
    const key = args.key.trim();
    const result = await check(args.provider, key);
    if ("ok" in result) throw new Error(result.message);
    await ctx.runMutation(internal.keyStore.put, { userId: user.id, provider: args.provider, method: "apiKey", ...(await encryptKey(key)), last4: key.slice(-4), subscription: result.subscription });
    return { ok: true as const, last4: key.slice(-4) };
  },
});
