import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { userFromIdentity } from "./identity";
import { encryptKey } from "./lib/keyCrypto";

/**
 * Saves the signed-in person's Anthropic API key, after checking with Anthropic that it works.
 * Agents they start run on it; nobody else's runs use it, and it is never sent back to a browser.
 */
export const save = action({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const user = userFromIdentity(await ctx.auth.getUserIdentity());
    if (user.local) throw new Error("Sign in to save a key");
    const key = args.key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("That doesn't look like an Anthropic API key. It starts with sk-ant-.");
    const check = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (check.status === 401 || check.status === 403) throw new Error("Anthropic didn't accept this key. Check it and try again.");
    if (!check.ok) throw new Error(`Couldn't check the key with Anthropic (${check.status}). Try again in a moment.`);
    await ctx.runMutation(internal.keyStore.put, { userId: user.id, ...(await encryptKey(key)), last4: key.slice(-4) });
    return { ok: true as const, last4: key.slice(-4) };
  },
});
