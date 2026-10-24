import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { editPaths } from './cloud-sync.mjs';

// Claude as an office engine, through the Claude Agent SDK. A Claude agent is a full office
// member: it takes the same instructions and office tools as a Codex agent, its stream is
// recorded as observed work, it can be steered mid-turn, resumed later and stopped.
// The SDK is imported on first use so the companion boots without it.
export const claudeModels = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' }
];

export const isClaudeModel = model => claudeModels.some(m => m.id === model);

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite'];
const EDIT_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'Bash'];
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * Tool access for one run. Read runs get read-only tools and are never asked anything.
 * Edit runs may change files, and Bash runs in the OS sandbox, which confines writes to the
 * project folder; if the sandbox is unavailable the run fails instead of running unconfined.
 * `extraTools` names additional tools to allow, such as the office's MCP tools.
 */
export function accessOptions(access, extraTools = [], beforeEdit) {
  const tools = access === 'edit' ? EDIT_TOOLS : READ_TOOLS;
  const allowed = new Set([...tools, ...extraTools]);
  return {
    tools,
    allowedTools: [...allowed],
    permissionMode: access === 'edit' ? 'acceptEdits' : 'dontAsk',
    ...(access === 'edit' ? { sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } } : {}),
    // Nobody is watching a terminal, so anything outside the grant is denied rather than prompted.
    canUseTool: async (name, input) => {
      if (!allowed.has(name)) return { behavior: 'deny', message: `${name} is not available to this ${access === 'edit' ? 'editing' : 'read-only'} desk.` };
      const paths = editPaths(name, input);
      if (beforeEdit && paths.length) {
        const denial = await beforeEdit(paths);
        if (denial) return { behavior: 'deny', message: denial };
      }
      return { behavior: 'allow' };
    }
  };
}

function describe(value, limit = 4000) {
  if (value === undefined || value === null) return '';
  const body = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  return body.length > limit ? body.slice(0, limit) + `\n… ${body.length - limit} more characters` : body;
}
const resultText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : describe(content);

/**
 * Translates the SDK stream into the office's observable-work vocabulary. A tool call is
 * published once its result arrives, so `pending` holds tool_use blocks by id until then.
 * Thinking blocks are dropped here: private reasoning must not reach a published run doc.
 */
export function createTranslator({ onToolUse, onToolResult } = {}) {
  const pending = new Map();
  return function publicMessages(message) {
    if (!message || typeof message !== 'object') return [];
    if (message.type === 'assistant') {
      const out = [];
      if (message.error) out.push({ kind: 'error', text: `Claude reported an error: ${message.error}` });
      const text = (message.message?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('').trim();
      if (text) out.push({ kind: 'update', text });
      for (const block of message.message?.content || []) if (block?.type === 'tool_use') { pending.set(block.id, block); onToolUse?.(block); }
      return out;
    }
    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      const out = [];
      for (const block of message.message.content) {
        if (block?.type !== 'tool_result') continue;
        const call = pending.get(block.tool_use_id); if (!call) continue;
        pending.delete(block.tool_use_id);
        onToolResult?.(call, { output: resultText(block.content), isError: !!block.is_error });
        const kind = block.is_error ? 'error' : call.name === 'Bash' ? 'command' : FILE_TOOLS.has(call.name) ? 'file' : 'tool';
        const args = call.name === 'Bash' ? call.input?.command : describe(call.input);
        out.push({ kind, text: [`${call.name} · ${block.is_error ? 'error' : 'completed'}`, args, describe(resultText(block.content))].filter(Boolean).join('\n') });
      }
      return out;
    }
    return []; // init, status, partial, retry and result messages are bookkeeping, not work.
  };
}

const userMessage = text => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });

/**
 * The prompt stream for one run. It stays open so messages can be added mid-run, like
 * steering a Codex turn, and closes once Claude has answered everything it was sent.
 */
function inputQueue(first) {
  const items = [first]; let wake = null; let closed = false;
  return {
    push(text) { items.push(text); wake?.(); },
    close() { closed = true; wake?.(); },
    get closed() { return closed; },
    get pending() { return items.length; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield userMessage(items.shift()); continue; }
        if (closed) return;
        await new Promise(resolve => { wake = resolve; }); wake = null;
      }
    }
  };
}

export function createClaudeRunner({
  // OFFICE_CLAUDE_SDK points tests at a deterministic stand-in, as OFFICE_CODEX_BIN does for Codex.
  importSdk = () => import(process.env.OFFICE_CLAUDE_SDK ? pathToFileURL(process.env.OFFICE_CLAUDE_SDK).href : '@anthropic-ai/claude-agent-sdk'),
  apiKey = () => process.env.ANTHROPIC_API_KEY,
  oauth = async () => false,
  // Sessions are kept apart from the user's own Claude Code history, as Codex keeps its own home.
  configDir = () => process.env.OFFICE_CLAUDE_HOME || path.join(homedir(), '.iteration1', 'claude')
} = {}) {
  const runs = new Map();
  /** Starts a run. With `resume`, it continues an earlier session, so the agent keeps its context. */
  async function launch(id, input, { cwd, resume, instructions, mcpServers, extraTools = [], beforeEdit, onSession, onMessage, onToolUse, onToolResult, onDone }) {
    if (runs.has(id)) throw new Error('This desk already has a Claude run in flight. Stop it before launching another.');
    const useOAuth = await oauth();
    const key = useOAuth ? null : apiKey();
    if (!key && !useOAuth) throw new Error('Connect Claude first: open Connections → Claude and sign in or add your Anthropic API key.');
    const { query } = await importSdk();
    const abortController = new AbortController();
    const prompt = inputQueue(input.prompt);
    const options = {
      cwd, model: input.model, effort: input.effort, abortController,
      ...(resume ? { resume } : {}),
      // Only the project folder and this office's instructions shape the run, never the user's own Claude settings.
      settingSources: [],
      // Auth comes from this profile or its explicit key. Never inherit a different CLI's token.
      env: { ...process.env, ANTHROPIC_API_KEY: key || undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CONFIG_DIR: configDir() },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions || (input.access === 'edit'
        ? 'You are working at a desk in Iteration1. Keep changes focused on the request, run the relevant checks, and finish with a short summary of what changed and how you verified it. The user may send follow-up messages; treat each as a continuation of the same work.'
        : 'You are a read-only specialist at a desk in Iteration1. Inspect and report findings with file paths. Do not try to edit files. The user may send follow-up messages; treat each as a continuation of the same work.') },
      ...(mcpServers ? { mcpServers } : {}),
      ...accessOptions(input.access, extraTools, beforeEdit)
    };
    let run;
    try { run = query({ prompt, options }); }
    catch (error) { throw new Error(`Claude agent could not start: ${error.message}`); }
    const entry = { run, prompt, abortController, stopping: false, late: [], sessionId: resume || null };
    runs.set(id, entry);
    void pump(id, entry, { onSession, onMessage, onToolUse, onToolResult, onDone });
    return { model: input.model, access: input.access, resumed: !!resume };
  }
  async function pump(id, entry, { onSession, onMessage, onToolUse, onToolResult, onDone }) {
    const translate = createTranslator({ onToolUse, onToolResult });
    let result = null, failure = null;
    try {
      for await (const message of entry.run) {
        if (message?.session_id && message.session_id !== entry.sessionId) { entry.sessionId = message.session_id; onSession?.(entry.sessionId); }
        if (message?.type === 'result') {
          result = message;
          // Everything sent so far has been answered: end the run. Later messages resume the session.
          if (!entry.prompt.pending) entry.prompt.close();
          continue;
        }
        for (const item of translate(message)) onMessage(item);
      }
    } catch (error) { failure = error.message; }
    entry.prompt.close();
    runs.delete(id);
    const status = entry.stopping ? 'cancelled' : result?.subtype === 'success' && !result.is_error ? 'finished' : 'error';
    onDone({
      status,
      result: result?.subtype === 'success' ? result.result || '' : '',
      error: status === 'error' ? (result?.errors?.join('\n') || failure || (result ? `Claude run ended: ${result.subtype}` : 'The Claude run ended without a result.')) : '',
      costUsd: result?.total_cost_usd ?? null,
      turns: result?.num_turns ?? null,
      tokens: result?.usage ? (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0) + (result.usage.cache_read_input_tokens || 0) + (result.usage.cache_creation_input_tokens || 0) : null,
      sessionId: entry.sessionId,
      // Messages that arrived as the run was closing; the caller continues the session with them.
      unsent: entry.late
    });
  }
  /** Adds a message to a run in flight. Returns false when no run is in flight at this desk. */
  function send(id, text) {
    const entry = runs.get(id);
    if (!entry || entry.stopping) return false;
    if (entry.prompt.closed) entry.late.push(text); else entry.prompt.push(text);
    return true;
  }
  async function stop(id) {
    const entry = runs.get(id);
    if (!entry) throw new Error('No Claude run is in flight at this desk.');
    entry.stopping = true;
    // Aborting ends the Claude Code process; the pump then settles the desk as cancelled.
    entry.abortController.abort();
    return { stopping: true };
  }
  return { launch, send, stop, sdk: importSdk, running: id => runs.has(id), count: () => runs.size };
}
