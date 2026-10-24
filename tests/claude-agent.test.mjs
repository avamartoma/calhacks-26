import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeRunner, createTranslator, accessOptions, claudeLaunchFields } from '../server/claude-agent.mjs';

const assistant = content => ({ type: 'assistant', message: { role: 'assistant', content } });
const toolResult = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const success = { type: 'result', subtype: 'success', is_error: false, result: 'Added the label', total_cost_usd: 0.42, num_turns: 3 };

function fakeSdk({ messages = [success], hold, throwAt } = {}) {
  const calls = { prompt: null, options: null };
  function query({ prompt, options }) {
    calls.prompt = prompt; calls.options = options;
    const signal = options.abortController.signal;
    async function* run() {
      for (const [i, message] of messages.entries()) {
        if (throwAt === i) throw new Error('transport closed');
        yield message;
      }
      if (hold) await new Promise((resolve, reject) => { hold.release = resolve; signal.addEventListener('abort', () => reject(new Error('aborted'))); });
    }
    return run();
  }
  return { sdk: { query }, calls };
}

const input = claudeLaunchFields.parse({ prompt: 'Make search keyboard accessible' });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test('launch fields default to Opus with editing access and reject unknown models', () => {
  assert.equal(input.model, 'claude-opus-5-5');
  assert.equal(input.access, 'edit');
  assert.equal(input.effort, 'high');
  assert.throws(() => claudeLaunchFields.parse({ prompt: 'x', model: 'gpt-6-sol' }));
  assert.throws(() => claudeLaunchFields.parse({ prompt: 'x', cwd: '/' }), 'unknown fields are rejected');
});

test('private reasoning and bookkeeping never become observable work', () => {
  const translate = createTranslator();
  for (const message of [
    assistant([{ type: 'thinking', thinking: 'The user probably wants...' }]),
    assistant([{ type: 'text', text: '   ' }]),
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    { type: 'user', message: { role: 'user', content: 'echo of our own prompt' } },
    toolResult('unknown-call', 'no matching tool_use'),
    success, null, 'nonsense'
  ]) assert.deepEqual(translate(message), [], `${JSON.stringify(message)} must not be published`);
});

test('a tool call is published once its result arrives, by tool kind', () => {
  const translate = createTranslator();
  assert.deepEqual(translate(assistant([{ type: 'text', text: 'Running the tests' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }])), [{ kind: 'update', text: 'Running the tests' }]);
  const [command] = translate(toolResult('t1', [{ type: 'text', text: '12 passing' }]));
  assert.equal(command.kind, 'command'); assert.match(command.text, /npm test/); assert.match(command.text, /12 passing/);
  assert.deepEqual(translate(toolResult('t1', 'again')), [], 'a result is published once');

  translate(assistant([{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/a.ts' } }, { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'x' } }, { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'rm -rf /' } }]));
  assert.equal(translate(toolResult('t2', 'ok'))[0].kind, 'file');
  assert.equal(translate(toolResult('t3', 'ok'))[0].kind, 'tool');
  assert.equal(translate(toolResult('t4', 'denied', true))[0].kind, 'error');
  assert.equal(translate({ ...assistant([]), error: 'rate_limit' })[0].kind, 'error');
  const long = (() => { translate(assistant([{ type: 'tool_use', id: 't5', name: 'Read', input: {} }])); return translate(toolResult('t5', 'x'.repeat(9000)))[0]; })();
  assert.ok(long.text.length < 9000 && /more characters/.test(long.text));
});

test('read-only desks get read tools only; editing desks run commands in a required sandbox', async () => {
  const read = accessOptions('read');
  assert.deepEqual(read.tools, ['Read', 'Glob', 'Grep']);
  assert.equal(read.permissionMode, 'dontAsk');
  assert.equal(read.sandbox, undefined);
  assert.equal((await read.canUseTool('Write')).behavior, 'deny');

  const edit = accessOptions('edit');
  assert.ok(edit.tools.includes('Bash') && edit.tools.includes('Edit'));
  assert.equal(edit.permissionMode, 'acceptEdits');
  assert.equal(edit.sandbox.failIfUnavailable, true, 'never fall back to unconfined commands');
  assert.equal(edit.sandbox.allowUnsandboxedCommands, false);
  assert.equal((await edit.canUseTool('Bash')).behavior, 'allow');
  assert.equal((await edit.canUseTool('WebFetch')).behavior, 'deny');
});

test('a run streams observable work in the project folder and settles with its cost', async () => {
  const { sdk, calls } = fakeSdk({ messages: [
    { type: 'system', subtype: 'init' },
    assistant([{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Adding a label' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.tsx' } }]),
    toolResult('t1', 'ok'),
    success
  ] });
  const published = []; let done;
  const runner = createClaudeRunner({ importSdk: async () => sdk, apiKey: () => 'sk-ant-test' });
  await runner.launch('desk-1', input, { cwd: '/project', onMessage: entry => published.push(entry), onDone: outcome => { done = outcome; } });

  assert.equal(calls.prompt, input.prompt);
  assert.equal(calls.options.cwd, '/project');
  assert.equal(calls.options.model, 'claude-opus-5-5');
  assert.deepEqual(calls.options.settingSources, [], 'the user\'s own Claude settings never shape an office run');
  assert.equal(calls.options.persistSession, false);
  assert.equal(calls.options.env.ANTHROPIC_API_KEY, 'sk-ant-test');

  await settle();
  assert.deepEqual(published.map(entry => entry.kind), ['update', 'file']);
  assert.equal(done.status, 'finished'); assert.equal(done.result, 'Added the label'); assert.equal(done.costUsd, 0.42);
  assert.equal(runner.running('desk-1'), false);
});

test('failed runs and broken streams settle the desk with the reason', async () => {
  let done;
  const failed = createClaudeRunner({ importSdk: async () => fakeSdk({ messages: [{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached the turn limit'] }] }).sdk, apiKey: () => 'k' });
  await failed.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone: outcome => { done = outcome; } });
  await settle();
  assert.equal(done.status, 'error'); assert.equal(done.error, 'Reached the turn limit');

  const published = [];
  const broken = createClaudeRunner({ importSdk: async () => fakeSdk({ messages: [assistant([{ type: 'text', text: 'partial' }]), success], throwAt: 1 }).sdk, apiKey: () => 'k' });
  await broken.launch('desk-2', input, { cwd: '/p', onMessage: entry => published.push(entry), onDone: outcome => { done = outcome; } });
  await settle();
  assert.equal(published.length, 1, 'work published before the break is kept');
  assert.equal(done.status, 'error'); assert.match(done.error, /transport closed/);
  assert.equal(broken.running('desk-2'), false);
});

test('a launch needs a key, refuses a second run at one desk and can be stopped', async () => {
  const keyless = createClaudeRunner({ importSdk: async () => fakeSdk().sdk, apiKey: () => '' });
  await assert.rejects(keyless.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone() {} }), /ANTHROPIC_API_KEY/);

  const hold = {}; let done;
  const runner = createClaudeRunner({ importSdk: async () => fakeSdk({ messages: [], hold }).sdk, apiKey: () => 'k' });
  await assert.rejects(runner.stop('desk-1'), /No Claude run is in flight/);
  await runner.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone: outcome => { done = outcome; } });
  await assert.rejects(runner.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone() {} }), /already has a Claude run/);
  await runner.stop('desk-1');
  await settle();
  assert.equal(done.status, 'cancelled'); assert.equal(done.error, '');
  assert.equal(runner.count(), 0);
});
