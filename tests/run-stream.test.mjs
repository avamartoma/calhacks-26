import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStream } from '../convex/lib/runStream.ts';

const line = value => JSON.stringify(value);

test('Claude Code stream-json becomes messages, tool uses and a result', () => {
  const text = [
    line({ type: 'system', subtype: 'init', session_id: 's' }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: ' Looking at the project. ' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm   test' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts', old_string: 'a' } }] } }),
    line({ type: 'result', subtype: 'success', is_error: false, result: 'Added the endpoint.', total_cost_usd: 0.042 }),
  ].join('\n');
  const { lines, result } = parseStream(text);
  assert.deepEqual(lines, [
    { kind: 'text', text: 'Looking at the project.' },
    { kind: 'tool', text: 'Bash: npm test' },
    { kind: 'tool', text: 'Edit: src/app.ts' },
    { kind: 'result', text: 'Added the endpoint.' },
  ]);
  assert.deepEqual(result, { isError: false, text: 'Added the endpoint.', costUsd: 0.042 });
});

test('a failed run and stray output are still shown', () => {
  const { lines, result } = parseStream(['Invalid API key · Please run /login', line({ type: 'result', subtype: 'error_max_turns', is_error: true })].join('\n'));
  assert.deepEqual(lines, [{ kind: 'text', text: 'Invalid API key · Please run /login' }, { kind: 'error', text: 'Stopped: error_max_turns' }]);
  assert.equal(result.isError, true);
});

test('Codex events become messages, commands, edits and a result', () => {
  const text = [
    line({ type: 'thread.started', thread_id: 't' }),
    line({ type: 'turn.started' }),
    line({ type: 'item.completed', item: { id: '0', type: 'reasoning', text: 'thinking' } }),
    line({ type: 'item.started', item: { id: '1', type: 'command_execution', command: 'npm test', status: 'in_progress' } }),
    line({ type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 } }),
    line({ type: 'item.completed', item: { id: '2', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] } }),
    line({ type: 'item.completed', item: { id: '3', type: 'agent_message', text: 'Added the health endpoint.' } }),
    line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join('\n');
  const { lines, result } = parseStream(text, 'codex');
  assert.deepEqual(lines, [
    { kind: 'tool', text: 'Shell: npm test' },
    { kind: 'tool', text: 'Edit: src/a.ts, src/b.ts' },
    { kind: 'text', text: 'Added the health endpoint.' },
    { kind: 'result', text: 'Done' },
  ]);
  assert.deepEqual(result, { isError: false, text: 'Added the health endpoint.' });
});

test('a failed Codex turn is an error', () => {
  const { lines, result } = parseStream(line({ type: 'turn.failed', error: { message: 'Incorrect API key provided' } }), 'codex');
  assert.deepEqual(lines, [{ kind: 'error', text: 'Incorrect API key provided' }]);
  assert.equal(result.isError, true);
});

test('Cursor stream-json shows its messages, tool calls and result', () => {
  const text = [
    line({ type: 'system', subtype: 'init', model: 'auto' }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking the routes.' }] } }),
    line({ type: 'tool_call', subtype: 'started', call_id: 'a', tool_call: { shellToolCall: { args: { command: 'ls src' } } } }),
    line({ type: 'tool_call', subtype: 'completed', call_id: 'a', tool_call: { shellToolCall: { args: { command: 'ls src' }, result: {} } } }),
    line({ type: 'tool_call', subtype: 'started', call_id: 'b', tool_call: { editToolCall: { args: { path: 'src/routes.ts' } } } }),
    line({ type: 'result', subtype: 'success', is_error: false, result: 'Added /health.' }),
  ].join('\n');
  const { lines, result } = parseStream(text, 'cursor');
  assert.deepEqual(lines, [
    { kind: 'text', text: 'Checking the routes.' },
    { kind: 'tool', text: 'Shell: ls src' },
    { kind: 'tool', text: 'Edit: src/routes.ts' },
    { kind: 'result', text: 'Added /health.' },
  ]);
  assert.equal(result.isError, false);
});

test("Codex's retries are left out, and its error keeps only the reason", () => {
  const failure = 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-fake-****0000. You can find your API key at https://platform.openai.com/account/api-keys., url: https://api.openai.com/v1/responses, cf-ray: a4ff, request id: req_1';
  const text = [
    line({ type: 'error', message: `Reconnecting... 2/5 (${failure})` }),
    line({ type: 'error', message: `Falling back from WebSockets to HTTPS transport. ${failure}` }),
    line({ type: 'error', message: failure }),
    line({ type: 'turn.failed', error: { message: failure } }),
  ].join('\n');
  const { lines, result } = parseStream(text, 'codex');
  const reason = 'Incorrect API key provided: sk-fake-****0000. You can find your API key at https://platform.openai.com/account/api-keys.';
  assert.deepEqual(lines, [{ kind: 'error', text: reason }]);
  assert.deepEqual(result, { isError: true, text: reason });
});

test('each agent reports the conversation a follow-up resumes', () => {
  assert.equal(parseStream(line({ type: 'system', subtype: 'init', session_id: '6d1f2c9a-claude-session' }), 'claude').session, '6d1f2c9a-claude-session');
  assert.equal(parseStream(line({ type: 'system', subtype: 'init', session_id: 'cursor-chat-123456' }), 'cursor').session, 'cursor-chat-123456');
  assert.equal(parseStream(line({ type: 'thread.started', thread_id: '0199a2b3-codex-thread' }), 'codex').session, '0199a2b3-codex-thread');
  assert.equal(parseStream(line({ type: 'system', subtype: 'init', session_id: 'bad id; rm -rf /' }), 'claude').session, null);
  assert.equal(parseStream(line({ type: 'assistant', message: { content: [] } }), 'claude').session, null);
});
