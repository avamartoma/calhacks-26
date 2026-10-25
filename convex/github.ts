import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { userFromIdentity } from "./identity";

declare const process: { env: Record<string, string | undefined> };

export type GithubRepo = {
  id: number; name: string; fullName: string; description: string; url: string; cloneUrl: string;
  language: string | null; fork: boolean; archived: boolean; pushedAt: string | null; added: boolean;
};

/**
 * Someone's public GitHub repos, newest first, each marked if it's already on their sky.
 * People who signed in with GitHub get their own; anyone else can name a GitHub username.
 * The team's GitHub token, when set, only raises GitHub's rate limit for this public listing.
 */
export const repos = action({
  args: { username: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ username: string; repos: GithubRepo[] }> => {
    const identity = await ctx.auth.getUserIdentity();
    const user = userFromIdentity(identity);
    if (user.local) throw new Error("Sign in to add your GitHub repos");
    const fromLogin = user.id.startsWith("github|") ? identity?.nickname?.trim() : undefined;
    const username = (args.username?.trim() || fromLogin || "").replace(/^@/, "");
    if (!username) throw new Error("Enter your GitHub username");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(username)) throw new Error("That isn't a GitHub username");
    const token = process.env.SANDBOX_GIT_TOKEN;
    const response = await fetch(`https://api.github.com/users/${username}/repos?type=owner&sort=pushed&per_page=100`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "opencloud", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (response.status === 404) throw new Error(`GitHub has no user called ${username}`);
    if (response.status === 403 || response.status === 429) throw new Error("GitHub is limiting requests right now. Try again in a few minutes.");
    if (!response.ok) throw new Error(`Couldn't reach GitHub (${response.status}). Try again in a moment.`);
    const list = (await response.json()) as {
      id: number; name: string; full_name: string; description: string | null; html_url: string; clone_url: string;
      language: string | null; fork: boolean; archived: boolean; pushed_at: string | null; private: boolean;
    }[];
    const added = new Set(await ctx.runQuery(internal.projects.githubIds, { ownerId: user.id }));
    return {
      username,
      repos: list.filter((repo) => !repo.private).map((repo) => ({
        id: repo.id, name: repo.name, fullName: repo.full_name, description: repo.description ?? "", url: repo.html_url,
        cloneUrl: repo.clone_url, language: repo.language, fork: repo.fork, archived: repo.archived, pushedAt: repo.pushed_at,
        added: added.has(repo.id),
      })),
    };
  },
});
