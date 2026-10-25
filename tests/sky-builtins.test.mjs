import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinBlobs, taskRole } from '../src/sky/builtins.ts';
import { kindOf } from '../src/sky/agents.ts';

test('a built-in agent appears only once used, on the cloud it last worked on', () => {
  assert.equal(builtinBlobs([]).size, 0);
  const blobs = builtinBlobs([
    { name: 'reviewer', projectId: 'a', at: 1, working: false },
    { name: 'reviewer', projectId: 'b', at: 5, working: true },
    { name: 'office', projectId: 'a', at: 3, working: false },
  ]);
  assert.deepEqual(blobs.get('a'), [{ role: 'Built-in Office', status: 'idle' }]);
  assert.deepEqual(blobs.get('b'), [{ role: 'Built-in Reviewer', status: 'working' }]);
});

test('built-in agents are gray and coding agents are colored by their task', () => {
  const [blob] = builtinBlobs([{ name: 'planner', projectId: 'a', at: 1, working: false }]).get('a');
  assert.equal(kindOf(blob.role).id, 'builtin');
  assert.equal(kindOf(taskRole('Write the README for the API')).id, 'writing');
  assert.equal(kindOf(taskRole('Review the login change for security issues')).id, 'review');
  assert.equal(kindOf(taskRole('make something blue')).id, 'build');
  assert.notEqual(kindOf(taskRole('anything at all')).id, 'other');
});
