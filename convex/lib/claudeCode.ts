// Checking what someone pastes after "Sign in with Claude", as server/provider-login.mjs does locally.

export const CLAUDE_REDIRECT = "https://platform.claude.com/oauth/code/callback";

/** Accepts the `code#state` claude.ai shows, or the whole callback address. Never fetches what was pasted. */
export function parseClaudeCode(input: string, expectedState: string): string {
  const text = input.trim();
  let code = "", state = "";
  if (!text.includes("://") && text.split("#").length === 2) [code, state] = text.split("#");
  else {
    let url: URL;
    try { url = new URL(text); } catch { throw new Error("Paste the code Claude showed you."); }
    const expected = new URL(CLAUDE_REDIRECT);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error("That address isn't from this Claude sign-in.");
    if (url.searchParams.has("error")) throw new Error("Claude sign-in was declined. Start again.");
    code = url.searchParams.get("code") ?? ""; state = url.searchParams.get("state") ?? "";
  }
  if (!code || code.length > 4096 || /[\s\x00-\x1f]/.test(code)) throw new Error("That code is incomplete. Copy all of it, including the part after #.");
  if (state !== expectedState) throw new Error("This code belongs to a different sign-in. Start again and paste the new code.");
  return code;
}

