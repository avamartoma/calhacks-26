import { z } from 'zod';

// Claude agents the office launches through the Claude Agent SDK. Like a launched Cursor
// run, the office picks the model, records the stream as observed work, and can stop it.
// The SDK is imported on first launch so the companion boots without it.
export const claudeModels = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' }
];

export const claudeLaunchFields = z.object({
  prompt: z.string().trim().min(1).max(12000),
  model: z.enum(claudeModels.map(m => m.id)).default('claude-opus-5-5'),
  access: z.enum(['read', 'edit']).default('edit'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high')
}).strict();

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const EDIT_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'Bash'];
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * Tool access for one run. Read runs get read-only tools and are never asked anything.
 * Edit runs may change files, and Bash runs in the OS sandbox, which confines writes to the
 * project folder; if the sandbox is unavailable the run fails instead of running unconfined.
 */
export function accessOptions(access) {
  const tools = access === 'edit' ? EDIT_TOOLS : READ_TOOLS;
  const allowed = new Set(tools);
  return {
    tools,
    allowedTools: tools,
    permissionMode: access === 'edit' ? 'acceptEdits' : 'dontAsk',
    ...(access === 'edit' ? { sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } } : {}),
    // Nobody is watching a terminal, so anything outside the grant is denied rather than prompted.
    canUseTool: async name => allowed.has(name) ? { behavior: 'allow' } : { behavior: 'deny', message: `${name} is not available to this ${access === 'edit' ? 'editing' : 'read-only'} desk.` }
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
export function createTranslator() {
  const pending = new Map();
  return function publicMessages(message) {
    if (!message || typeof message !== 'object') return [];
    if (message.type === 'assistant') {
      const out = [];
      if (message.error) out.push({ kind: 'error', text: `Claude reported an error: ${message.error}` });
      const text = (message.message?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('').trim();
      if (text) out.push({ kind: 'update', text });
      for (const block of message.message?.content || []) if (block?.type === 'tool_use') pending.set(block.id, block);
      return out;
    }
    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      const out = [];
      for (const block of message.message.content) {
        if (block?.type !== 'tool_result') continue;
        const call = pending.get(block.tool_use_id); if (!call) continue;
        pending.delete(block.tool_use_id);
        const kind = block.is_error ? 'error' : call.name === 'Bash' ? 'command' : FILE_TOOLS.has(call.name) ? 'file' : 'tool';
        const args = call.name === 'Bash' ? call.input?.command : describe(call.input);
        out.push({ kind, text: [`${call.name} · ${block.is_error ? 'error' : 'completed'}`, args, describe(resultText(block.content))].filter(Boolean).join('\n') });
      }
      return out;
    }
    return []; // init, status, partial, retry and result messages are bookkeeping, not work.
  };
}

export function createClaudeRunner({ importSdk = () => import('@anthropic-ai/claude-agent-sdk'), apiKey = () => process.env.ANTHROPIC_API_KEY } = {}) {
  const runs = new Map();
  async function launch(id, input, { cwd, onMessage, onDone }) {
    if (runs.has(id)) throw new Error('This desk already has a Claude run in flight. Stop it before launching another.');
    const key = apiKey();
    if (!key) throw new Error('Set ANTHROPIC_API_KEY before launching a Claude agent. Create a key at platform.claude.com.');
    const { query } = await importSdk();
    const abortController = new AbortController();
    const options = {
      cwd, model: input.model, effort: input.effort, abortController,
      // Only the project folder and this office's instructions shape the run, never the user's own Claude settings.
      settingSources: [], persistSession: false,
      env: { ...process.env, ANTHROPIC_API_KEY: key },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: input.access === 'edit'
        ? 'You are working at a desk in Iteration1. Keep changes focused on the request, run the relevant checks, and finish with a short summary of what changed and how you verified it.'
        : 'You are a read-only specialist at a desk in Iteration1. Inspect and report findings with file paths. Do not try to edit files.' },
      ...accessOptions(input.access)
    };
    let run;
    try { run = query({ prompt: input.prompt, options }); }
    catch (error) { throw new Error(`Claude agent could not start: ${error.message}`); }
    const entry = { run, abortController, stopping: false };
    runs.set(id, entry);
    void pump(id, entry, onMessage, onDone);
    return { model: input.model, access: input.access };
  }
  async function pump(id, entry, onMessage, onDone) {
    const translate = createTranslator();
    let result = null, failure = null;
    try {
      for await (const message of entry.run) {
        if (message?.type === 'result') { result = message; continue; }
        for (const item of translate(message)) onMessage(item);
      }
    } catch (error) { failure = error.message; }
    runs.delete(id);
    const status = entry.stopping ? 'cancelled' : result?.subtype === 'success' && !result.is_error ? 'finished' : 'error';
    onDone({
      status,
      result: result?.subtype === 'success' ? result.result || '' : '',
      error: status === 'error' ? (result?.errors?.join('\n') || failure || (result ? `Claude run ended: ${result.subtype}` : 'The Claude run ended without a result.')) : '',
      costUsd: result?.total_cost_usd ?? null,
      turns: result?.num_turns ?? null
    });
  }
  async function stop(id) {
    const entry = runs.get(id);
    if (!entry) throw new Error('No Claude run is in flight at this desk.');
    entry.stopping = true;
    // Aborting ends the Claude Code process; the pump then settles the desk as cancelled.
    entry.abortController.abort();
    return { stopping: true };
  }
  return { launch, stop, running: id => runs.has(id), count: () => runs.size };
}
