import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeRunner, createTranslator, accessOptions, isClaudeModel } from '../server/claude-agent.mjs';
import { todosToPlan, officeToolNames, projectDiff } from '../server/claude-office.mjs';

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

const input = { prompt: 'Make search keyboard accessible', model: 'claude-opus-5-5', access: 'edit', effort: 'high' };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test('Claude models are told apart from Codex models', () => {
  assert.ok(isClaudeModel('claude-opus-5-5') && isClaudeModel('claude-haiku-5-5'));
  assert.ok(!isClaudeModel('gpt-6-sol') && !isClaudeModel('Account default') && !isClaudeModel(undefined));
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
  assert.deepEqual(read.tools, ['Read', 'Glob', 'Grep', 'TodoWrite'], 'read-only desks can still publish a plan');
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

test('office tools are allowed by their MCP names, and nothing else is', async () => {
  const names = officeToolNames([{ name: 'office_delegate' }, { name: 'office_status' }]);
  assert.deepEqual(names, ['mcp__office__office_delegate', 'mcp__office__office_status']);
  const options = accessOptions('read', names);
  assert.ok(options.allowedTools.includes('mcp__office__office_status'));
  assert.equal((await options.canUseTool('mcp__office__office_delegate')).behavior, 'allow');
  assert.equal((await options.canUseTool('mcp__other__anything')).behavior, 'deny');
  assert.equal((await options.canUseTool('Bash')).behavior, 'deny', 'a read-only desk still cannot run commands');
});

test('tool calls and results reach the evidence hooks', () => {
  const uses = [], results = [];
  const translate = createTranslator({ onToolUse: block => uses.push(block.name), onToolResult: (call, result) => results.push([call.name, result]) });
  translate(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]));
  translate(toolResult('t1', [{ type: 'text', text: '3 passing' }], true));
  assert.deepEqual(uses, ['Bash']);
  assert.deepEqual(results, [['Bash', { output: '3 passing', isError: true }]]);
});

test('a TodoWrite list becomes the office plan', () => {
  assert.deepEqual(todosToPlan([{ content: 'Read the code', status: 'completed' }, { content: 'Add tests', status: 'in_progress' }, { content: 'Ship', status: 'pending' }]),
    [{ step: 'Read the code', status: 'completed' }, { step: 'Add tests', status: 'inProgress' }, { step: 'Ship', status: 'pending' }]);
  assert.equal(todosToPlan(undefined), null);
});

test('the project diff covers edited and new files, and is empty outside Git', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os'); const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iteration1-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await projectDiff(dir), '');
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  git('init', '-q'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  await writeFile(path.join(dir, 'a.txt'), 'one\n'); git('add', 'a.txt'); git('commit', '-qm', 'base');
  await writeFile(path.join(dir, 'a.txt'), 'two\n'); await writeFile(path.join(dir, 'new.txt'), 'fresh\n');
  const diff = await projectDiff(dir);
  assert.match(diff, /-one/); assert.match(diff, /\+two/); assert.match(diff, /new\.txt/); assert.match(diff, /\+fresh/);
});
