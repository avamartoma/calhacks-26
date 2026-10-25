"use node";

// Runs Codex, Claude Code or Cursor inside a project's E2B sandbox for one agentRuns row. launch
// waits for the sandbox, installs the agent's CLI once, and starts it in the background writing its
// JSON events to a file. poll reads that file every few seconds into runLines until the process exits.

import { Sandbox } from "e2b";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { decryptKey } from "./lib/keyCrypto";
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
const AGENTS: Record<Agent, { name: string; bin: string; install: string; start: string }> = {
  claude: {
    name: "Claude Code",
    bin: "claude",
    install: 'npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code',
    start: 'claude -p "$TASK" --output-format stream-json --verbose --dangerously-skip-permissions',
  },
  codex: {
    name: "Codex",
    bin: "codex",
    install: 'npm install -g --prefix "$HOME/.local" @openai/codex@0.156.1',
    // A Codex home per run, so one person's sessions never mix with another's in a shared sandbox.
    start: 'CODEX_HOME="/tmp/codex-$RUN" && mkdir -p "$CODEX_HOME" && export CODEX_HOME && codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$TASK"',
  },
  cursor: {
    name: "Cursor",
    bin: "cursor-agent",
    install: "curl -fsSL https://cursor.com/install | bash",
    start: 'cursor-agent -p --output-format stream-json --force --trust "$TASK"',
  },
};

const installScript = (agent: Agent) => `
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "${WORKSPACE}"
if ! command -v ${AGENTS[agent].bin} >/dev/null 2>&1; then
  (${AGENTS[agent].install}) >/tmp/${agent}-install.log 2>&1 || { tail -n 20 /tmp/${agent}-install.log; exit 1; }
fi
${AGENTS[agent].bin} --version
`;

const startScript = (agent: Agent) => `
export PATH="$HOME/.local/bin:$PATH"
cd "${WORKSPACE}"
(${AGENTS[agent].start}) < /dev/null > "$OUT" 2> "$ERR"
echo $? > "$EXIT"
`;

/** The variables that carry a person's key into their agent. */
function keyEnv(agent: Agent, key: string, subscription: boolean): Record<string, string> {
  if (agent === "codex") return { CODEX_API_KEY: key, OPENAI_API_KEY: key };
  if (agent === "cursor") return { CURSOR_API_KEY: key };
  return subscription ? { CLAUDE_CODE_OAUTH_TOKEN: key } : { ANTHROPIC_API_KEY: key };
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
      const script = args.testCommand ? `cd "${WORKSPACE}" 2>/dev/null; (${args.testCommand}) > "$OUT" 2> "$ERR"; echo $? > "$EXIT"` : startScript(agent);
      await ctx.runAction(internal.runChanges.baseline, { runId: args.runId, sandboxId: info.session.sandboxId });
      const handle = await sandbox.commands.run(script, {
        background: true,
        envs: {
          TASK: row.prompt,
          RUN: args.runId,
          OUT: paths.out, ERR: paths.err, EXIT: paths.exit,
          IS_SANDBOX: "1",
          ...(stored ? keyEnv(agent, await decryptKey(stored), stored.subscription) : {}),
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
    if (complete) await ctx.runMutation(internal.agentRuns.append, { runId: args.runId, offset, lines: parsed.lines });
    const exit = (await run(sandbox, `cat "${paths.exit}" 2>/dev/null; true`)).stdout.trim();
    const caughtUp = complete.length === read.stdout.length && read.stdout.length < READ_CHUNK;
    if (exit && caughtUp) {
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
    } catch {
      // The sandbox is already gone, so the agent is too.
    }
  },
});
