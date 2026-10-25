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
