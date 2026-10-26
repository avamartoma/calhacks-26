"use node";

declare const process: { env: Record<string, string | undefined> };

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { capturePreview } from "./lib/previewShot";
import { getSandboxProvider, sandboxMaxExtensions, sandboxProviderName, sandboxTimeoutMs, type SandboxHandle, type SandboxProvider } from "./lib/sandbox";
import { workspacePath } from "./lib/workspacePath";

function preserveScript(workspaceDir: string): string {
  const quoted = `'${workspaceDir.replace(/'/g, `'\\''`)}'`;
  return `
set -eu
cd ${quoted}
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "wip before sandbox timeout"
fi
git push -u origin HEAD
`;
}

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

function gitToken(): string {
  return process.env.SANDBOX_GIT_TOKEN ?? "";
}

function preserveDelayMs(): number {
  return Math.max(15_000, sandboxTimeoutMs() - 60_000);
}

async function resumeSandbox(provider: SandboxProvider, sandboxId: string): Promise<SandboxHandle | null> {
  if (provider.name !== "e2b") return null;
  const state = await provider.sandboxState(sandboxId);
  if (state === "missing") return null;
  try {
    return await provider.resume(sandboxId);
  } catch (error) {
    console.error(`sandbox ${sandboxId} resume failed: ${error instanceof Error ? error.message : "resume failed"}`);
    return null;
  }
}

async function previewAfterResume(provider: SandboxProvider, handle: SandboxHandle): Promise<{ previewUrl: string } | null> {
  try {
    if (await provider.portOpen(handle.sandboxId, 3000)) return { previewUrl: handle.url };
  } catch {
    // The dev server is not answering. Start it again.
  }
  try {
    return await provider.startPreview(handle.sandboxId, { port: 3000 });
  } catch (error) {
    console.error(`preview restart failed: ${error instanceof Error ? error.message : "preview failed"}`);
    return null;
  }
}

async function finishReady(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  providerName: string,
  handle: SandboxHandle,
  started: number,
  preview: { previewUrl: string } | null,
  via: string,
): Promise<boolean> {
  const ms = Date.now() - started;
  console.log(`session ${sessionId} ready in ${ms}ms via ${providerName} ${handle.url}`);
  const marked = await ctx.runMutation(internal.sessions.markReady, {
    sessionId,
    envUrl: handle.url,
    sandboxId: handle.sandboxId,
    detail: `${providerName} ${handle.url} in ${ms}ms`,
    ...(preview ? { previewUrl: preview.previewUrl } : {}),
  });
  if (!marked.skipped && preview) console.log(`session ${sessionId} open-to-live in ${ms}ms via ${via}`);
  if (!marked.skipped && providerName === "e2b") {
    await ctx.scheduler.runAfter(preserveDelayMs(), internal.sessionSandbox.preserve, { sessionId });
  }
  return !marked.skipped;
}

export const launch = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.sessions.getInternal, { sessionId: args.sessionId });
    if (!info) {
      console.error(`sessionSandbox.launch: session ${args.sessionId} not found`);
      return;
    }
    if (info.status !== "provisioning") {
      console.error(`sessionSandbox.launch: session ${args.sessionId} is ${info.status}, skipping`);
      return;
    }
    const started = Date.now();
    try {
      const provider = getSandboxProvider();
      const resumed = info.projectSandboxId ? await resumeSandbox(provider, info.projectSandboxId) : null;
      if (resumed) {
        const preview = await previewAfterResume(provider, resumed);
        const marked = await finishReady(ctx, args.sessionId, provider.name, resumed, started, preview, "resume");
        if (marked) return;
      }
      if (info.backupId) {
        const blob = await ctx.storage.get(info.backupId as Id<"_storage">);
        if (blob) {
          const handle = await provider.createEmpty();
          await provider.restore(handle.sandboxId, new Uint8Array(await blob.arrayBuffer()));
          let preview: { previewUrl: string } | null = null;
          try {
            preview = await provider.startPreview(handle.sandboxId, { port: 3000 });
          } catch (error) {
            console.error(`session ${args.sessionId} preview after backup failed: ${error instanceof Error ? error.message : "preview failed"}`);
          }
          const marked = await finishReady(ctx, args.sessionId, provider.name, handle, started, preview, "backup");
          if (marked) return;
        }
      }
      const handle = info.repoUrl
        ? await provider.create({
            repoCloneUrl: info.repoUrl,
            branch: info.branch,
            token: gitToken(),
          })
        : await provider.createEmpty();
      const ms = Date.now() - started;
      console.log(`session ${args.sessionId} ready in ${ms}ms via ${provider.name} ${handle.url}`);
      const marked = await ctx.runMutation(internal.sessions.markReady, {
        sessionId: args.sessionId,
        envUrl: handle.url,
        sandboxId: handle.sandboxId,
        detail: `${provider.name} ${handle.url} in ${ms}ms`,
      });
      if (!marked.skipped && provider.name === "e2b") {
        await ctx.scheduler.runAfter(preserveDelayMs(), internal.sessionSandbox.preserve, { sessionId: args.sessionId });
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : "sandbox create failed";
      const message = raw.includes("could not read Username")
        ? "repo not found, or private and no token was provided"
        : raw;
      console.error(`session ${args.sessionId} failed after ${Date.now() - started}ms: ${message}`);
      await ctx.runMutation(internal.sessions.markError, { sessionId: args.sessionId, message });
    }
  },
});

export const destroy = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.sessions.getInternal, { sessionId: args.sessionId });
    const sandboxId = info?.sandboxId;
    if (!sandboxId) {
      console.error(`sessionSandbox.destroy: session ${args.sessionId} has no sandboxId`);
      return;
    }
    try {
      await getSandboxProvider().destroy(sandboxId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "sandbox destroy failed";
      console.error(`sessionSandbox.destroy ${args.sessionId}: ${message}`);
      await ctx.runMutation(internal.sessions.recordTeardownFailure, { sessionId: args.sessionId, message });
    }
  },
});

export const preserve = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.sessions.getInternal, { sessionId: args.sessionId });
    if (!info?.sandboxId || info.status === "stopped" || info.status === "paused") return;
    if (sandboxProviderName() !== "e2b") return;
    const provider = getSandboxProvider();
    let pushed = false;
    let pushError = "";
    try {
      const result = await provider.exec(info.sandboxId, preserveScript(provider.workspaceDir));
      pushed = result.code === 0;
      if (!pushed) pushError = result.stderr.slice(0, 500) || result.stdout.slice(0, 500) || "git push failed";
    } catch (error) {
      pushError = error instanceof Error ? error.message : "git push failed";
    }
    const extensions = info.sandboxExtensions;
    const active = Date.now() - info.lastActiveAt <= ACTIVE_WINDOW_MS;
    const atCap = extensions >= sandboxMaxExtensions();
    if (active && !atCap) {
      try {
        await provider.setTimeout(info.sandboxId, sandboxTimeoutMs());
        await ctx.runMutation(internal.sessions.noteSandbox, {
          sessionId: args.sessionId,
          kind: pushed ? "session.extended" : "session.preserve_failed",
          detail: pushed ? `extended to ${extensions + 1}` : pushError,
          extensions: extensions + 1,
          stop: false,
        });
        await ctx.scheduler.runAfter(preserveDelayMs(), internal.sessionSandbox.preserve, { sessionId: args.sessionId });
        return;
      } catch (error) {
        pushError = error instanceof Error ? error.message : "sandbox extension failed";
      }
    }
    const reason = !active ? "idle for 10 minutes" : atCap ? `sandbox paused after ${extensions} extensions` : "sandbox extension failed";
    await ctx.runMutation(internal.sessions.noteSandbox, {
      sessionId: args.sessionId,
      kind: "session.paused",
      detail: pushError ? `${reason}; ${pushError}` : reason,
      stop: false,
      pause: true,
    });
    await ctx.scheduler.runAfter(0, internal.sessionSandbox.pause, { sessionId: args.sessionId });
  },
});

export const pause = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.sessions.getInternal, { sessionId: args.sessionId });
    const sandboxId = info?.sandboxId ?? info?.projectSandboxId;
    if (!info || !sandboxId || sandboxProviderName() !== "e2b") return;
    const provider = getSandboxProvider();
    try {
      const state = await provider.sandboxState(sandboxId);
      if (state === "running") {
        const shot = info.previewUrl ? await capturePreview(info.previewUrl) : null;
        if (shot) {
          const snapshot = await ctx.storage.store(new Blob([shot], { type: "image/png" }));
          await ctx.runMutation(internal.sessions.savePauseArtifacts, { projectId: info.projectId, snapshot });
        }
        try {
          const archive = await provider.archive(sandboxId);
          if (archive) {
            const backup = await ctx.storage.store(new Blob([archive], { type: "application/gzip" }));
            await ctx.runMutation(internal.sessions.savePauseArtifacts, { projectId: info.projectId, backup });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "backup failed";
          console.error(`session ${args.sessionId} backup failed: ${message}`);
        }
        await provider.pause(sandboxId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "sandbox pause failed";
      console.error(`sessionSandbox.pause ${args.sessionId}: ${message}`);
      await ctx.runMutation(internal.sessions.recordSessionEvent, {
        sessionId: args.sessionId,
        kind: "session.pause_failed",
        detail: message.slice(0, 500),
      });
    }
  },
});

export const exec = internalAction({
  args: {
    sandboxId: v.string(),
    cmd: v.string(),
    cwd: v.optional(v.string()),
    timeoutMs: v.number(),
  },
  handler: async (_ctx, args) => {
    const provider = getSandboxProvider();
    const cwd = workspacePath(args.cwd ?? provider.workspaceDir, provider.workspaceDir, { allowRoot: true });
    return await provider.exec(args.sandboxId, args.cmd, { cwd, timeoutMs: args.timeoutMs });
  },
});

export const readFile = internalAction({
  args: { sandboxId: v.string(), path: v.string() },
  handler: async (_ctx, args) => {
    const provider = getSandboxProvider();
    const path = workspacePath(args.path, provider.workspaceDir);
    const content = await provider.readFile(args.sandboxId, path);
    return { content };
  },
});

/** Whether anything in the sandbox answers on the preview port. */
export const portOpen = internalAction({
  args: { sandboxId: v.string(), port: v.number() },
  handler: async (_ctx, args): Promise<boolean> => {
    try { return await getSandboxProvider().portOpen(args.sandboxId, args.port); } catch { return false; }
  },
});

export const startPreview = internalAction({
  args: {
    sandboxId: v.string(),
    port: v.number(),
    command: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    return await getSandboxProvider().startPreview(args.sandboxId, {
      port: args.port,
      ...(args.command !== undefined ? { command: args.command } : {}),
    });
  },
});

export const writeFile = internalAction({
  args: { sandboxId: v.string(), path: v.string(), content: v.string() },
  handler: async (_ctx, args) => {
    const provider = getSandboxProvider();
    const path = workspacePath(args.path, provider.workspaceDir);
    await provider.writeFile(args.sandboxId, path, args.content);
    return { ok: true as const };
  },
});

export const deleteFile = internalAction({
  args: { sandboxId: v.string(), path: v.string() },
  handler: async (_ctx, args) => {
    const provider = getSandboxProvider();
    const path = workspacePath(args.path, provider.workspaceDir);
    await provider.deleteFile(args.sandboxId, path);
    return { ok: true as const };
  },
});
