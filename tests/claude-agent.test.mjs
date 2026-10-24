import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeRunner, createTranslator, accessOptions, claudeLaunchFields } from '../server/claude-agent.mjs';

const assistant = content => ({ type: 'assistant', message: { role: 'assistant', content } });
const toolResult = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const success = { type: 'result', subtype: 'success', is_error: false, result: 'Added the label', total_cost_usd: 0.42, num_turns: 3 };

/**
 * Stands in for the SDK's query(): reads the prompt stream like Claude Code does and answers
 * each user message with the next scripted turn (a list of messages ending in a result).
 */
function fakeSdk({ turns = [[success]], hold, throwAt, sessionId = 'session-1' } = {}) {
  const calls = { prompts: [], options: null };
  function query({ prompt, options }) {
    calls.options = options;
    const signal = options.abortController.signal;
    async function* run() {
      let turn = 0;
      for await (const user of prompt) {
        calls.prompts.push(user.message.content);
        if (hold && turn === hold.atTurn) await new Promise((resolve, reject) => { hold.release = resolve; signal.addEventListener('abort', () => reject(new Error('aborted'))); });
        for (const [i, message] of (turns[turn] || [success]).entries()) {
          if (throwAt === i) throw new Error('transport closed');
          yield { ...message, session_id: sessionId };
        }
        turn += 1;
      }
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
  const { sdk, calls } = fakeSdk({ turns: [[
    { type: 'system', subtype: 'init' },
    assistant([{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Adding a label' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.tsx' } }]),
    toolResult('t1', 'ok'),
    success
  ]] });
  const published = []; let done; const sessions = [];
  const runner = createClaudeRunner({ importSdk: async () => sdk, apiKey: () => 'sk-ant-test', configDir: () => '/office/claude' });
  await runner.launch('desk-1', input, { cwd: '/project', onSession: id => sessions.push(id), onMessage: entry => published.push(entry), onDone: outcome => { done = outcome; } });

  await settle();
  assert.deepEqual(calls.prompts, [input.prompt]);
  assert.equal(calls.options.cwd, '/project');
  assert.equal(calls.options.model, 'claude-opus-5-5');
  assert.deepEqual(calls.options.settingSources, [], 'the user\'s own Claude settings never shape an office run');
  assert.equal(calls.options.resume, undefined, 'a new desk starts a new session');
  assert.equal(calls.options.env.ANTHROPIC_API_KEY, 'sk-ant-test');
  assert.equal(calls.options.env.CLAUDE_CONFIG_DIR, '/office/claude', 'sessions stay out of the user\'s own Claude history');
  assert.deepEqual(sessions, ['session-1'], 'the session is reported as soon as it is known');
  assert.equal(done.sessionId, 'session-1');
  assert.deepEqual(published.map(entry => entry.kind), ['update', 'file']);
  assert.equal(done.status, 'finished'); assert.equal(done.result, 'Added the label'); assert.equal(done.costUsd, 0.42);
  assert.equal(runner.running('desk-1'), false);
});

test('failed runs and broken streams settle the desk with the reason', async () => {
  let done;
  const failed = createClaudeRunner({ importSdk: async () => fakeSdk({ turns: [[{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached the turn limit'] }]] }).sdk, apiKey: () => 'k' });
  await failed.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone: outcome => { done = outcome; } });
  await settle();
  assert.equal(done.status, 'error'); assert.equal(done.error, 'Reached the turn limit');

  const published = [];
  const broken = createClaudeRunner({ importSdk: async () => fakeSdk({ turns: [[assistant([{ type: 'text', text: 'partial' }]), success]], throwAt: 1 }).sdk, apiKey: () => 'k' });
  await broken.launch('desk-2', input, { cwd: '/p', onMessage: entry => published.push(entry), onDone: outcome => { done = outcome; } });
  await settle();
  assert.equal(published.length, 1, 'work published before the break is kept');
  assert.equal(done.status, 'error'); assert.match(done.error, /transport closed/);
  assert.equal(broken.running('desk-2'), false);
});

test('a browser-connected Claude run uses only the office profile and no inherited OAuth token', async () => {
  const { sdk, calls } = fakeSdk();
  const runner = createClaudeRunner({ importSdk: async () => sdk, apiKey: () => 'unused-api-key', oauth: async () => true, configDir: () => '/office/browser-profile' });
  await runner.launch('browser-desk', input, { cwd: '/project', onMessage() {}, onDone() {} });
  await settle();
  assert.equal(calls.options.env.CLAUDE_CONFIG_DIR, '/office/browser-profile');
  assert.equal(calls.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls.options.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(calls.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('a launch needs a key, refuses a second run at one desk and can be stopped', async () => {
  const keyless = createClaudeRunner({ importSdk: async () => fakeSdk().sdk, apiKey: () => '' });
  await assert.rejects(keyless.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone() {} }), /Connect Claude first/);

  const hold = { atTurn: 0 }; let done;
  const runner = createClaudeRunner({ importSdk: async () => fakeSdk({ hold }).sdk, apiKey: () => 'k' });
  await assert.rejects(runner.stop('desk-1'), /No Claude run is in flight/);
  await runner.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone: outcome => { done = outcome; } });
  await assert.rejects(runner.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone() {} }), /already has a Claude run/);
  await runner.stop('desk-1');
  await settle();
  assert.equal(done.status, 'cancelled'); assert.equal(done.error, '');
  assert.equal(runner.count(), 0);
  assert.equal(runner.send('desk-1', 'too late'), false, 'a stopped desk takes no messages');
});

test('messages sent mid-run reach the same run, like steering a Codex turn', async () => {
  const hold = { atTurn: 0 }; let done;
  const { sdk, calls } = fakeSdk({ hold, turns: [[success], [{ ...success, result: 'Also added tests' }]] });
  const runner = createClaudeRunner({ importSdk: async () => sdk, apiKey: () => 'k' });
  await runner.launch('desk-1', input, { cwd: '/p', onMessage() {}, onDone: outcome => { done = outcome; } });
  await settle();
  assert.equal(runner.send('desk-1', 'Also add tests'), true);
  hold.release(); await settle();
  assert.deepEqual(calls.prompts, [input.prompt, 'Also add tests'], 'one run answers both messages');
  assert.equal(done.status, 'finished'); assert.equal(done.result, 'Also added tests');
  assert.deepEqual(done.unsent, []);
  assert.equal(runner.running('desk-1'), false, 'the run ends once everything sent is answered');
});

test('a follow-up after a run ends resumes the saved session', async () => {
  const { sdk, calls } = fakeSdk();
  const runner = createClaudeRunner({ importSdk: async () => sdk, apiKey: () => 'k' });
  assert.equal(runner.send('desk-1', 'hello'), false, 'no run in flight: the caller starts a follow-up');
  const launched = await runner.launch('desk-1', { ...input, prompt: 'Now add tests' }, { cwd: '/p', resume: 'session-1', onMessage() {}, onDone() {} });
  await settle();
  assert.equal(launched.resumed, true);
  assert.equal(calls.options.resume, 'session-1', 'the agent keeps its earlier context');
});
