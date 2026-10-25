"use node";

// Runs Codex, Claude Code or Cursor inside a project's E2B sandbox for one agentRuns row. launch
// waits for the sandbox, installs the agent's CLI once, and starts it in the background writing its
// JSON events to a file. poll reads that file every few seconds into runLines until the process exits.

import { Sandbox } from "e2b";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { decryptKey, encryptKey } from "./lib/keyCrypto";
import { parseStream } from "./lib/runStream";
import { sandboxProviderName } from "./lib/sandbox";

declare const process: { env: Record<string, string | undefined> };

const WORKSPACE = "/home/user/workspace";
const POLL_MS = 3000;
const READY_WAIT_MS = 150_000;
const MAX_RUN_MS = 30 * 60 * 1000;
const READ_CHUNK = 300_000;

/** Stops the shell that runs the agent and the agent under it. */
const stop = (pid: number) => `pkill -TERM -P ${pid} 2>/dev/null; kill ${pid} 2>/dev/null; true`;
/** The end of an error log, without the timestamps and log levels some agents print. */
const lastLines = (text: string) => text.split("\n").map((line) => line.replace(/^\S+Z\s+(ERROR|WARN|INFO)\s+\S+:\s*/, "").replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean).slice(-4).join("\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const files = (runId: string) => ({ out: `/tmp/run-${runId}.jsonl`, err: `/tmp/run-${runId}.err`, exit: `/tmp/run-${runId}.exit` });

function e2bKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) throw new Error("E2B_API_KEY must be set in the Convex environment");
  return key;
}

async function run(sandbox: Sandbox, cmd: string, opts: { envs?: Record<string, string>; timeoutMs?: number } = {}) {
  try {
    const result = await sandbox.commands.run(cmd, { cwd: WORKSPACE, ...opts });
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; exitCode?: number };
    if (typeof failed?.exitCode === "number") return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.exitCode };
    throw error;
  }
}

type Agent = "codex" | "claude" | "cursor";

// Each agent's program, installed into the sandbox once and run headless. The task and key arrive
// as environment variables, never inside the command text. Codex is the version the local office pins.
// `resume` continues the agent's own conversation ($SESSION) with a follow-up as $TASK.
const AGENTS: Record<Agent, { name: string; bin: string; install: string; start: string; resume: string }> = {
  claude: {
    name: "Claude Code",
    bin: "claude",
    install: 'npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code',
    start: 'claude -p "$TASK" --output-format stream-json --verbose --dangerously-skip-permissions',
    resume: 'claude -p "$TASK" --resume "$SESSION" --output-format stream-json --verbose --dangerously-skip-permissions',
  },
  codex: {
    name: "Codex",
    bin: "codex",
    install: 'npm install -g --prefix "$HOME/.local" @openai/codex@0.156.1',
    // A Codex home per conversation, so one person's sessions never mix with another's in a shared sandbox.
    start: 'CODEX_HOME="/tmp/codex-$THREAD" && mkdir -p "$CODEX_HOME" && export CODEX_HOME && codex -c cli_auth_credentials_store="file" exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$TASK"',
    resume: 'CODEX_HOME="/tmp/codex-$THREAD" && mkdir -p "$CODEX_HOME" && export CODEX_HOME && codex -c cli_auth_credentials_store="file" exec resume --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$SESSION" "$TASK"',
  },
  cursor: {
    name: "Cursor",
    bin: "cursor-agent",
    install: "curl -fsSL https://cursor.com/install | bash",
    start: 'cursor-agent -p --output-format stream-json --force --trust "$TASK"',
    resume: 'cursor-agent -p --resume "$SESSION" --output-format stream-json --force --trust "$TASK"',
  },
};

/** A conversation's folders are named after its first run, so follow-ups find its history. */
const threadOf = (row: { _id: Id<"agentRuns">; parentRunId?: Id<"agentRuns"> }) => row.parentRunId ?? row._id;

const installScript = (agent: Agent) => `
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "${WORKSPACE}"
if ! command -v ${AGENTS[agent].bin} >/dev/null 2>&1; then
  (${AGENTS[agent].install}) >/tmp/${agent}-install.log 2>&1 || { tail -n 20 /tmp/${agent}-install.log; exit 1; }
fi
${AGENTS[agent].bin} --version
`;

const startScript = (agent: Agent, resuming: boolean) => `
export PATH="$HOME/.local/bin:$PATH"
cd "${WORKSPACE}"
(${resuming ? AGENTS[agent].resume : AGENTS[agent].start}) < /dev/null > "$OUT" 2> "$ERR"
echo $? > "$EXIT"
`;

type Stored = { ciphertext: string; iv: string; subscription: boolean; method: "apiKey" | "chatgpt" | "claudeAccount" | "cursorAccount" };

/**
 * A signed-in ChatGPT or Claude account is that tool's own credentials file, copied into a folder
 * only this conversation uses. The tool refreshes it in place, and saveCredentials keeps the new copy.
 */
const credentialFile = (method: Stored["method"], thread: string) =>
  method === "chatgpt" ? `/tmp/codex-${thread}/auth.json` : method === "claudeAccount" ? `/tmp/claude-${thread}/.credentials.json` : null;

/** The variables that carry a person's key or sign-in into their agent. */
function keyEnv(agent: Agent, stored: Stored, secret: string, thread: string): Record<string, string> {
  if (stored.method === "chatgpt") return {};
  if (stored.method === "claudeAccount") return { CLAUDE_CONFIG_DIR: `/tmp/claude-${thread}` };
  if (agent === "codex") return { CODEX_API_KEY: secret, OPENAI_API_KEY: secret };
  if (agent === "cursor") return { CURSOR_API_KEY: secret };
  return stored.subscription ? { CLAUDE_CODE_OAUTH_TOKEN: secret } : { ANTHROPIC_API_KEY: secret };
}

/**
 * After a run, keeps a refreshed sign-in and removes the run's private copy of it. The rest of the
 * conversation's folder (its session history) stays, so a follow-up can resume it; the next run
 * writes a fresh credentials file before it starts.
 */
async function saveCredentials(ctx: ActionCtx, sandbox: Sandbox, row: { _id: Id<"agentRuns">; parentRunId?: Id<"agentRuns">; userId: string; agent?: Agent }) {
  const agent: Agent = row.agent ?? "claude";
  const thread = threadOf(row);
  const stored = await ctx.runQuery(internal.keyStore.get, { userId: row.userId, provider: agent });
  const file = stored ? credentialFile(stored.method, thread) : null;
  try {
    if (stored && file && (stored.method === "chatgpt" || stored.method === "claudeAccount")) {
      const now = (await run(sandbox, `cat "${file}" 2>/dev/null; true`)).stdout.trim();
      const before = (await decryptKey(stored)).trim();
      if (now && now !== before && JSON.parse(now)) {
        await ctx.runMutation(internal.keyStore.refresh, { userId: row.userId, provider: agent, method: stored.method, before: stored.ciphertext, ...(await encryptKey(now)) });
      }
    }
  } catch {
    // Keep the stored sign-in; the next run refreshes it again.
  }
  await run(sandbox, `rm -f "/tmp/codex-${thread}/auth.json" "/tmp/claude-${thread}/.credentials.json"; true`);
}

async function fail(ctx: ActionCtx, runId: Id<"agentRuns">, detail: string) {
  await ctx.runMutation(internal.agentRuns.append, { runId, offset: 0, lines: [{ kind: "error", text: detail }] });
  await ctx.runMutation(internal.agentRuns.finish, { runId, status: "error", detail });
}

export const launch = internalAction({
  args: { runId: v.id("agentRuns"), testCommand: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    if (sandboxProviderName() !== "e2b") return await fail(ctx, args.runId, "Cloud agents need the E2B sandbox provider");
    const started = Date.now();
    let info = await ctx.runQuery(internal.agentRuns.getInternal, { runId: args.runId });
    while (info && info.run.status === "starting" && !(info.session?.status === "ready" && info.session.sandboxId)) {
      if (info.session?.status === "error") return await fail(ctx, args.runId, "The project's sandbox failed to start");
      if (Date.now() - started > READY_WAIT_MS) return await fail(ctx, args.runId, "The project's sandbox took too long to start");
      await sleep(2000);
      info = await ctx.runQuery(internal.agentRuns.getInternal, { runId: args.runId });
    }
    if (!info || info.run.status !== "starting" || !info.session?.sandboxId) return;
    const { run: row } = info;
    const agent: Agent = row.agent ?? "claude";
    try {
      const stored = await ctx.runQuery(internal.keyStore.get, { userId: row.userId, provider: agent });
      if (!stored && !args.testCommand) return await fail(ctx, args.runId, `Connect ${AGENTS[agent].name} first`);
      const sandbox = await Sandbox.connect(info.session.sandboxId, { apiKey: e2bKey() });
      if (!args.testCommand) {
        const install = await run(sandbox, installScript(agent), { timeoutMs: 240_000 });
        if (install.code !== 0) return await fail(ctx, args.runId, `Couldn't install ${AGENTS[agent].name} in the sandbox: ${(install.stdout + install.stderr).trim().slice(-400)}`);
      }
      const paths = files(args.runId);
      const thread = threadOf(row);
      const secret = stored ? await decryptKey(stored) : "";
      const file = stored ? credentialFile(stored.method, thread) : null;
      if (file) {
        await sandbox.files.write(file, secret);
        await run(sandbox, `chmod 700 "$(dirname "${file}")"; chmod 600 "${file}"`);
      }
      const script = args.testCommand ? `cd "${WORKSPACE}" 2>/dev/null; (${args.testCommand}) > "$OUT" 2> "$ERR"; echo $? > "$EXIT"` : startScript(agent, !!row.resumeSession);
      await ctx.runAction(internal.runChanges.baseline, { runId: args.runId, sandboxId: info.session.sandboxId });
      const handle = await sandbox.commands.run(script, {
        background: true,
        envs: {
          TASK: row.prompt,
          RUN: args.runId,
          THREAD: thread,
          ...(row.resumeSession ? { SESSION: row.resumeSession } : {}),
          OUT: paths.out, ERR: paths.err, EXIT: paths.exit,
          IS_SANDBOX: "1",
          ...(stored ? keyEnv(agent, stored, secret, thread) : {}),
        },
      });
      const marked = await ctx.runMutation(internal.agentRuns.markRunning, { runId: args.runId, pid: handle.pid });
      await handle.disconnect();
      if (!marked.stillWanted) {
        await run(sandbox, stop(handle.pid));
        return;
      }
      await ctx.scheduler.runAfter(POLL_MS, internal.agentRunner.poll, { runId: args.runId });
    } catch (error) {
      await fail(ctx, args.runId, error instanceof Error ? error.message.slice(0, 400) : "The agent failed to start");
    }
  },
});

export const poll = internalAction({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args): Promise<void> => {
    const info = await ctx.runQuery(internal.agentRuns.getInternal, { runId: args.runId });
    if (!info || info.run.status !== "running" || !info.session?.sandboxId) return;
    const { run: row } = info;
    const paths = files(args.runId);
    let sandbox: Sandbox;
    try { sandbox = await Sandbox.connect(info.session.sandboxId, { apiKey: e2bKey() }); }
    catch { return await fail(ctx, args.runId, "The project's sandbox stopped while the agent was working"); }
    const read = await run(sandbox, `[ -f "${paths.out}" ] && tail -c +${row.offset + 1} "${paths.out}" | head -c ${READ_CHUNK}; true`);
    const end = read.stdout.lastIndexOf("\n");
    const complete = end >= 0 ? read.stdout.slice(0, end + 1) : "";
    const parsed = parseStream(complete, row.agent ?? "claude");
    const offset = row.offset + new TextEncoder().encode(complete).length;
    if (complete) await ctx.runMutation(internal.agentRuns.append, { runId: args.runId, offset, lines: parsed.lines, ...(parsed.session ? { session: parsed.session } : {}) });
    const exit = (await run(sandbox, `cat "${paths.exit}" 2>/dev/null; true`)).stdout.trim();
    const caughtUp = complete.length === read.stdout.length && read.stdout.length < READ_CHUNK;
    if (exit && caughtUp) {
      await saveCredentials(ctx, sandbox, row);
      const code = Number(exit);
      const result = parsed.result;
      if (code === 0 && !result?.isError) {
        await ctx.runMutation(internal.agentRuns.finish, { runId: args.runId, status: "done", detail: result?.text ?? "Done", ...(result?.costUsd !== undefined ? { costUsd: result.costUsd } : {}) });
        return;
      }
      const stderr = (await run(sandbox, `tail -c 1500 "${paths.err}" 2>/dev/null; true`)).stdout.trim();
      const detail = result?.isError ? result.text : lastLines(stderr) || `${AGENTS[row.agent ?? "claude"].name} exited with code ${exit}`;
      if (!result) await ctx.runMutation(internal.agentRuns.append, { runId: args.runId, offset, lines: [{ kind: "error", text: detail }] });
      await ctx.runMutation(internal.agentRuns.finish, { runId: args.runId, status: "error", detail, ...(result?.costUsd !== undefined ? { costUsd: result.costUsd } : {}) });
      return;
    }
    if (Date.now() - row.startedAt > MAX_RUN_MS) {
      if (row.pid) await run(sandbox, stop(row.pid));
      await saveCredentials(ctx, sandbox, row);
      return await fail(ctx, args.runId, "Stopped after 30 minutes");
    }
    await ctx.scheduler.runAfter(POLL_MS, internal.agentRunner.poll, { runId: args.runId });
  },
});

export const kill = internalAction({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args): Promise<void> => {
    const info = await ctx.runQuery(internal.agentRuns.getInternal, { runId: args.runId });
    if (!info?.session?.sandboxId || !info.run.pid) return;
    try {
      const sandbox = await Sandbox.connect(info.session.sandboxId, { apiKey: e2bKey() });
      await run(sandbox, stop(info.run.pid));
      await saveCredentials(ctx, sandbox, info.run);
    } catch {
      // The sandbox is already gone, so the agent is too.
    }
  },
});
