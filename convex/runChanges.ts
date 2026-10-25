"use node";

// What an agent run changed in its project's sandbox. baseline commits the workspace to a shadow
// git history (its own GIT_DIR, so the project's own git is never touched) just before the agent
// starts; capture diffs against that commit once the run ends. download packs the workspace.

import { Sandbox } from "e2b";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { numstat } from "./lib/numstat";
import { getSandboxProvider } from "./lib/sandbox";

declare const process: { env: Record<string, string | undefined> };

const MAX_PATCH_BYTES = 400_000;
const DOWNLOAD_TTL_MS = 60 * 60 * 1000;

// Build output and dependencies stay out of the snapshot, like an upload.
const SHADOW = `
export GIT_DIR=/home/user/.opencloud-changes GIT_WORK_TREE=/home/user/workspace
command -v git >/dev/null 2>&1 || exit 3
if [ ! -d "$GIT_DIR" ]; then
  git init -q && git config user.email changes@opencloud && git config user.name opencloud
  printf 'node_modules/\\n.next/\\ndist/\\nbuild/\\n.turbo/\\n.cache/\\n__pycache__/\\n.venv/\\n' > "$GIT_DIR/info/exclude"
fi
`;

const BASELINE = `${SHADOW}
git add -A >/dev/null 2>&1
git commit -q --allow-empty --no-verify -m "before $RUN" >/dev/null 2>&1
git rev-parse HEAD
`;

// Staged, so new files count too; nothing is committed, so the next run's baseline is still a snapshot.
const CAPTURE = `${SHADOW}
git add -A >/dev/null 2>&1
git diff --cached --numstat "$BASE"
echo "@@opencloud-patch@@"
git diff --cached "$BASE" | head -c ${MAX_PATCH_BYTES + 1}
`;

function e2bKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) throw new Error("E2B_API_KEY must be set in the Convex environment");
  return key;
}

async function shell(sandboxId: string, script: string, envs: Record<string, string>) {
  const sandbox = await Sandbox.connect(sandboxId, { apiKey: e2bKey() });
  try {
    const result = await sandbox.commands.run(script, { envs, timeoutMs: 60_000 });
    return { code: result.exitCode, stdout: result.stdout };
  } catch (error) {
    const failed = error as { exitCode?: number; stdout?: string };
    if (typeof failed?.exitCode === "number") return { code: failed.exitCode, stdout: failed.stdout ?? "" };
    throw error;
  }
}

export const baseline = internalAction({
  args: { runId: v.id("agentRuns"), sandboxId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    try {
      const result = await shell(args.sandboxId, BASELINE, { RUN: args.runId });
      const sha = result.stdout.trim().split("\n").pop() ?? "";
      if (result.code === 0 && /^[0-9a-f]{40}$/.test(sha)) await ctx.runMutation(internal.runChangesStore.saveBaseline, { runId: args.runId, baseline: sha });
      else await ctx.runMutation(internal.runChangesStore.saveBaseline, { runId: args.runId, error: result.code === 3 ? "This sandbox has no git, so changes can't be tracked." : "Couldn't snapshot the project before the run." });
    } catch (error) {
      // A missing snapshot only means no diff for this run; the agent still starts.
      await ctx.runMutation(internal.runChangesStore.saveBaseline, { runId: args.runId, error: error instanceof Error ? error.message.slice(0, 200) : "Couldn't snapshot the project" });
    }
  },
});

export const capture = internalAction({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args): Promise<void> => {
    const base = await ctx.runQuery(internal.runChangesStore.baselineFor, { runId: args.runId });
    const info = await ctx.runQuery(internal.agentRuns.getInternal, { runId: args.runId });
    if (!base || !info?.session?.sandboxId) return;
    try {
      const result = await shell(info.session.sandboxId, CAPTURE, { BASE: base });
      if (result.code !== 0) return;
      const [stats, patch = ""] = result.stdout.split("@@opencloud-patch@@\n");
      const truncated = new TextEncoder().encode(patch).length > MAX_PATCH_BYTES;
      const stored = patch.trim() ? await ctx.storage.store(new Blob([patch], { type: "text/plain" })) : undefined;
      await ctx.runMutation(internal.runChangesStore.saveChanges, { runId: args.runId, files: numstat(stats), truncated, ...(stored ? { patch: stored } : {}) });
    } catch (error) {
      console.error(`run ${args.runId} changes: ${error instanceof Error ? error.message : "capture failed"}`);
    }
  },
});

/**
 * Packs the project's workspace as a .tar.gz to download: tracked files when it's a git repo,
 * everything but dependencies otherwise. Needs edit access and a running sandbox.
 */
export const download = action({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ url: string }> => {
    await ctx.runQuery(internal.access.requireRole, { projectId: args.projectId, minRole: "editor" });
    const sandboxId = await ctx.runQuery(internal.runChangesStore.readySandbox, { projectId: args.projectId });
    if (!sandboxId) throw new Error("The project's sandbox isn't running. Open the project and try again in a moment.");
    const bytes = await getSandboxProvider().archive(sandboxId);
    if (!bytes) throw new Error("Couldn't pack the project. It may be over 8 MB without dependencies.");
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const id = await ctx.storage.store(new Blob([buffer], { type: "application/gzip" }));
    await ctx.scheduler.runAfter(DOWNLOAD_TTL_MS, internal.runChangesStore.forget, { id });
    const url = await ctx.storage.getUrl(id);
    if (!url) throw new Error("Couldn't prepare the download");
    return { url };
  },
});
