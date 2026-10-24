import { z } from 'zod';

// Cursor agents the office launches itself, as opposed to a Cursor IDE session that
// reports in through MCP. These can be stopped, carry a model the office chose, and
// stream observable work. The SDK is imported on first launch so the companion still
// starts on a Node version the SDK does not support.
export const launchFields = z.object({
  prompt: z.string().trim().min(1).max(12000),
  model: z.string().trim().min(1).max(120),
  runtime: z.enum(['local', 'cloud']).default('local'),
  repoUrl: z.string().trim().max(500).url().optional(),
  autoCreatePR: z.boolean().default(false)
}).strict().refine(input => input.runtime === 'local' || input.repoUrl, { message: 'A cloud run needs the repository URL to clone.', path: ['repoUrl'] });

const FILE_TOOLS = new Set(['edit', 'write', 'delete', 'applyAgentDiff']);
const textOf = blocks => blocks.filter(block => block?.type === 'text').map(block => block.text).join('').trim();
function describe(value, limit = 4000) {
  if (value === undefined || value === null) return '';
  const body = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  return body.length > limit ? body.slice(0, limit) + `\n… ${body.length - limit} more characters` : body;
}

/**
 * Translate one SDK stream message into the office's observable-work vocabulary,
 * the same contract `publicItem` applies to Codex. Thinking is dropped here rather
 * than filtered downstream: private reasoning must not reach a published run doc.
 */
export function publicMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.type === 'assistant') { const body = textOf(message.message?.content || []); return body ? { kind: 'update', text: body } : null; }
  if (message.type === 'task') { const body = [message.status, message.text].filter(Boolean).join(': '); return body ? { kind: 'update', text: body } : null; }
  if (message.type === 'tool_call') {
    if (message.status === 'running') return null; // A call is published once it has an outcome.
    const kind = message.name === 'shell' ? 'command' : FILE_TOOLS.has(message.name) ? 'file' : 'tool';
    const args = describe(message.args), result = describe(message.result);
    const truncated = message.truncated?.args || message.truncated?.result ? '\n(truncated by the runtime)' : '';
    return { kind: message.status === 'error' ? 'error' : kind, text: [`${message.name} · ${message.status}`, args, result].filter(Boolean).join('\n') + truncated };
  }
  if (message.type === 'status') {
    if (message.status === 'ERROR') return { kind: 'error', text: message.message || 'The Cursor run reported an error.' };
    if (['CANCELLED', 'EXPIRED'].includes(message.status)) return { kind: 'system', text: `Run ${message.status.toLowerCase()}.` };
    return null;
  }
  return null; // thinking, usage, request, user echo and init are not observable work.
}

export function createCursorRunner({ importSdk = () => import('@cursor/sdk'), apiKey = () => process.env.CURSOR_API_KEY } = {}) {
  const runs = new Map();
  async function launch(id, input, { cwd, mcpServers, onMessage, onDone }) {
    if (runs.has(id)) throw new Error('This desk already has a Cursor run in flight. Stop it before launching another.');
    const key = await apiKey();
    if (!key) throw new Error('Connect Cursor in Connections → Cursor, or set CURSOR_API_KEY before launching a Cursor agent.');
    const { Agent, CursorAgentError } = await importSdk();
    // Runtime is always explicit: the SDK silently defaults to local, which would run
    // a cloud-intended job against this machine's checkout.
    const options = { apiKey: key, model: { id: input.model }, mcpServers,
      ...(input.runtime === 'cloud'
        ? { cloud: { repos: [{ url: input.repoUrl }], autoCreatePR: input.autoCreatePR, skipReviewerRequest: true } }
        : { local: { cwd, settingSources: [] } }) };
    let agent;
    try { agent = await Agent.create(options); }
    catch (error) { throw new Error(error instanceof CursorAgentError ? `Cursor agent could not start: ${error.message}` : error.message); }
    let run;
    try { run = await agent.send(input.prompt); }
    catch (error) { await dispose(agent); throw new Error(`Cursor agent could not start: ${error.message}`); }
    runs.set(id, { agent, run });
    void pump(id, agent, run, onMessage, onDone);
    return { runId: run.id, agentId: agent.agentId, runtime: input.runtime };
  }
  async function pump(id, agent, run, onMessage, onDone) {
    let failure = null;
    try { for await (const message of run.stream()) { const item = publicMessage(message); if (item) onMessage(item); } }
    catch (error) { failure = error.message; }
    let result;
    // `wait` is what distinguishes finished from errored or cancelled, and releases the run's watchers.
    try { result = await run.wait(); } catch (error) { failure ||= error.message; }
    runs.delete(id);
    await dispose(agent);
    const status = result?.status || (failure ? 'error' : 'finished');
    onDone({ status, result: result?.result || '', error: result?.error?.message || failure || '', git: result?.git || null, runId: run.id });
  }
  async function dispose(agent) { try { await agent?.[Symbol.asyncDispose]?.(); } catch { /* disposal must not mask the run's own outcome */ } }
  async function stop(id) {
    const entry = runs.get(id);
    if (!entry) throw new Error('No Cursor run is in flight at this desk.');
    if (!entry.run.supports('cancel')) throw new Error(entry.run.unsupportedReason('cancel') || 'This run cannot be cancelled from here.');
    await entry.run.cancel();
    return { stopping: true };
  }
  return { launch, stop, running: id => runs.has(id), count: () => runs.size };
}
