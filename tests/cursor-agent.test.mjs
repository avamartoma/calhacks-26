import test from 'node:test';
import assert from 'node:assert/strict';
import { createCursorRunner, publicMessage, launchFields } from '../server/cursor-agent.mjs';

class FakeRun {
  constructor(messages, result) { this.id = 'run-1'; this.messages = messages; this.result = result; this.cancelled = false; this.waited = false; }
  async *stream() { for (const message of this.messages) yield message; }
  supports(op) { return op === 'cancel'; }
  unsupportedReason() { return undefined; }
  async wait() { this.waited = true; return this.result; }
  async cancel() { this.cancelled = true; }
}

function fakeSdk({ messages = [], result = { id: 'run-1', status: 'finished', result: 'Done' }, createFails, sendFails } = {}) {
  const calls = { options: null, prompt: null, disposed: 0 };
  const run = new FakeRun(messages, result);
  class CursorAgentError extends Error {}
  const Agent = { async create(options) {
    calls.options = options;
    if (createFails) throw new CursorAgentError(createFails);
    return { agentId: 'agent-1', async send(prompt) { calls.prompt = prompt; if (sendFails) throw new Error(sendFails); return run; }, async [Symbol.asyncDispose]() { calls.disposed += 1; } };
  } };
  return { sdk: { Agent, CursorAgentError }, calls, run };
}

const input = { prompt: 'Make search keyboard accessible', model: 'composer-2.5', runtime: 'local', autoCreatePR: false };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test('private reasoning and bookkeeping never become observable work', () => {
  for (const message of [
    { type: 'thinking', text: 'The user probably wants...' },
    { type: 'usage', usage: { totalTokens: 10 } },
    { type: 'request', request_id: 'r' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'echo of our own prompt' }] } },
    { type: 'system', subtype: 'init' },
    { type: 'status', status: 'RUNNING' },
    { type: 'tool_call', name: 'shell', status: 'running' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] } },
    null, 'nonsense'
  ]) assert.equal(publicMessage(message), null, `${JSON.stringify(message)} must not be published`);
});

test('messages map onto the office vocabulary by tool kind', () => {
  assert.deepEqual(publicMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added a label' }, { type: 'tool_use', id: '1', name: 'edit', input: {} }] } }), { kind: 'update', text: 'Added a label' });
  assert.equal(publicMessage({ type: 'tool_call', name: 'shell', status: 'completed', args: { command: 'npm test' }, result: 'ok' }).kind, 'command');
  assert.equal(publicMessage({ type: 'tool_call', name: 'edit', status: 'completed' }).kind, 'file');
  assert.equal(publicMessage({ type: 'tool_call', name: 'grep', status: 'completed' }).kind, 'tool');
  assert.equal(publicMessage({ type: 'tool_call', name: 'shell', status: 'error', result: 'boom' }).kind, 'error');
  assert.equal(publicMessage({ type: 'status', status: 'ERROR', message: 'ran out of credits' }).text, 'ran out of credits');
  assert.equal(publicMessage({ type: 'status', status: 'CANCELLED' }).kind, 'system');
  assert.equal(publicMessage({ type: 'task', status: 'started', text: 'Reviewing' }).text, 'started: Reviewing');
  const long = publicMessage({ type: 'tool_call', name: 'read', status: 'completed', result: 'x'.repeat(9000), truncated: { result: true } });
  assert.ok(long.text.length < 9000 && /more characters/.test(long.text) && /truncated by the runtime/.test(long.text));
});

test('a launch names its runtime explicitly and a cloud run needs a repository', () => {
  assert.equal(launchFields.parse({ prompt: 'x', model: 'composer-2.5' }).runtime, 'local');
  assert.throws(() => launchFields.parse({ prompt: 'x', model: 'composer-2.5', runtime: 'cloud' }), /repository URL/);
  assert.equal(launchFields.parse({ prompt: 'x', model: 'composer-2.5', runtime: 'cloud', repoUrl: 'https://github.com/o/r' }).repoUrl, 'https://github.com/o/r');
});

test('a local run streams observable work, waits for its outcome and disposes', async () => {
  const { sdk, calls, run } = fakeSdk({ messages: [
    { type: 'thinking', text: 'private' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added a label' }] } },
    { type: 'tool_call', name: 'shell', status: 'completed', args: { command: 'npm test' }, result: '1 passing' }
  ] });
  const published = []; let done;
  const runner = createCursorRunner({ importSdk: async () => sdk, apiKey: () => 'cursor_test' });
  const launched = await runner.launch('desk-1', input, { cwd: '/project', onMessage: entry => published.push(entry), onDone: outcome => { done = outcome; } });

  assert.equal(launched.runtime, 'local');
  assert.deepEqual(calls.options.local, { cwd: '/project', settingSources: [] });
  assert.equal(calls.options.cloud, undefined, 'a local launch never carries cloud options');
  assert.equal(calls.options.model.id, 'composer-2.5');
  assert.equal(calls.prompt, input.prompt);

  await settle();
  assert.deepEqual(published.map(entry => entry.kind), ['update', 'command']);
  assert.equal(done.status, 'finished');
  assert.ok(run.waited, 'wait is what distinguishes finished from cancelled');
  assert.equal(calls.disposed, 1);
  assert.equal(runner.running('desk-1'), false);
});

test('a cloud run clones a repo and suppresses the reviewer request', async () => {
  const { sdk, calls } = fakeSdk();
  const runner = createCursorRunner({ importSdk: async () => sdk, apiKey: () => 'cursor_test' });
  await runner.launch('desk-1', { ...input, runtime: 'cloud', repoUrl: 'https://github.com/o/r', autoCreatePR: true }, { onMessage() {}, onDone() {} });
  assert.deepEqual(calls.options.cloud, { repos: [{ url: 'https://github.com/o/r' }], autoCreatePR: true, skipReviewerRequest: true });
  assert.equal(calls.options.local, undefined, 'a cloud launch never falls back to this machine');
  await settle();
});

test('a run that fails mid-flight is reported separately from one that never started', async () => {
  const runner = createCursorRunner({ importSdk: async () => fakeSdk({ createFails: 'bad key' }).sdk, apiKey: () => 'cursor_test' });
  await assert.rejects(runner.launch('desk-1', input, { onMessage() {}, onDone() {} }), /could not start: bad key/);
  assert.equal(runner.running('desk-1'), false, 'a desk is free again after a startup failure');

  let done;
  const failed = createCursorRunner({ importSdk: async () => fakeSdk({ result: { id: 'run-1', status: 'error', error: { message: 'tests failed' } } }).sdk, apiKey: () => 'cursor_test' });
  await failed.launch('desk-2', input, { onMessage() {}, onDone: outcome => { done = outcome; } });
  await settle();
  assert.equal(done.status, 'error'); assert.equal(done.error, 'tests failed');
});

test('a launch needs a key, refuses a second run at one desk and can be cancelled', async () => {
  const keyless = createCursorRunner({ importSdk: async () => fakeSdk().sdk, apiKey: () => '' });
  await assert.rejects(keyless.launch('desk-1', input, { onMessage() {}, onDone() {} }), /CURSOR_API_KEY/);

  const { sdk, run } = fakeSdk({ result: { id: 'run-1', status: 'cancelled' } });
  // Hold the stream open so the desk is still occupied when the stop arrives.
  let release; const inFlight = new Promise(resolve => { release = resolve; });
  run.stream = async function* () { await inFlight; };
  const runner = createCursorRunner({ importSdk: async () => sdk, apiKey: () => 'cursor_test' });
  await assert.rejects(runner.stop('desk-1'), /No Cursor run is in flight/);
  await runner.launch('desk-1', input, { onMessage() {}, onDone() {} });
  await assert.rejects(runner.launch('desk-1', input, { onMessage() {}, onDone() {} }), /already has a Cursor run/);
  await runner.stop('desk-1');
  assert.ok(run.cancelled);
  release(); await settle();
  assert.equal(runner.count(), 0);

  const unstoppable = fakeSdk();
  unstoppable.run.supports = () => false;
  unstoppable.run.unsupportedReason = () => 'This run was rehydrated after its event store closed.';
  unstoppable.run.stream = async function* () { await new Promise(resolve => setTimeout(resolve, 50)); };
  const detached = createCursorRunner({ importSdk: async () => unstoppable.sdk, apiKey: () => 'cursor_test' });
  await detached.launch('desk-2', input, { onMessage() {}, onDone() {} });
  await assert.rejects(detached.stop('desk-2'), /rehydrated/);
  await settle();
});

test('a stream that breaks still settles the desk', async () => {
  const { sdk, run } = fakeSdk();
  run.stream = async function* () { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }; throw new Error('transport closed'); };
  run.wait = async () => { throw new Error('transport closed'); };
  let done; const published = [];
  const runner = createCursorRunner({ importSdk: async () => sdk, apiKey: () => 'cursor_test' });
  await runner.launch('desk-1', input, { onMessage: entry => published.push(entry), onDone: outcome => { done = outcome; } });
  await settle();
  assert.equal(published.length, 1, 'work published before the break is kept');
  assert.equal(done.status, 'error'); assert.match(done.error, /transport closed/);
  assert.equal(runner.running('desk-1'), false);
});
