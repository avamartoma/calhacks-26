import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createCursorDesk } from '../server/cursor.mjs';
import { runDoc, addComment, runFeed, attributionOf } from '../server/run-doc.mjs';
import { seed } from '../server/domain.mjs';
import { initOffice } from '../server/orchestration.mjs';

function fixture() {
  const state = seed(path.resolve('.'));
  const room = initOffice(state.rooms[0]); room.demo = false; room.agents = []; room.workItems = []; room.goal = '';
  return { state, room, desk: createCursorDesk({ state, changed() {} }) };
}
const task = { task: 'Make search keyboard accessible', acceptanceCriteria: ['Search is reachable with Tab'] };

test('a run doc projects blocks with stable ids and labels every claim', () => {
  const { room, desk } = fixture();
  const run = desk.start(room, task);
  desk.update(room, run.agentId, { summary: 'Added a visible label', files: ['Search.tsx'], diff: '+<label>Search</label>', tests: 'Reported: 1 passing test' });
  const doc = runDoc(room, room.workItems[0]);
  assert.equal(doc.blocks[0].kind, 'brief');
  assert.deepEqual(doc.blocks[0].criteria, task.acceptanceCriteria);
  assert.equal(doc.agent.provider, 'cursor');
  assert.equal(doc.verification.verified, false);
  const reported = doc.blocks.filter(b => b.attribution === 'self-reported');
  assert.equal(reported.length, 2); // The diff and the claimed test output, neither verified.
  assert.ok(doc.blocks.every(block => block.id));
  assert.equal(new Set(doc.blocks.map(b => b.id)).size, doc.blocks.length);
  // Ids survive further publishing, which is what keeps a comment anchored.
  const anchor = reported[0].id;
  desk.update(room, run.agentId, { summary: 'More progress' });
  assert.ok(runDoc(room, room.workItems[0]).blocks.some(block => block.id === anchor));
});

test('a finished run gains an outcome block that lists what is still missing', () => {
  const { room, desk } = fixture();
  const run = desk.start(room, task);
  desk.finish(room, run.agentId, { summary: 'Execution finished', outcome: 'review' });
  const outcome = runDoc(room, room.workItems[0]).blocks.at(-1);
  assert.equal(outcome.kind, 'outcome');
  assert.equal(outcome.status, 'review');
  assert.ok(outcome.gaps.length, 'a self-reported finish is not a verified task');
});

test('attribution separates a current observed check from a stale or claimed one', () => {
  const item = { reviewState: { version: 'abc' } };
  const observed = { kind: 'test', source: 'observed-command', passed: true, stableWorkspace: true, cwdVerified: true, workspaceVersion: 'abc' };
  assert.equal(attributionOf(observed, item), 'verified');
  assert.equal(attributionOf({ ...observed, workspaceVersion: 'stale' }, item), 'observed');
  assert.equal(attributionOf({ ...observed, passed: false }, item), 'observed');
  assert.equal(attributionOf({ kind: 'test', source: 'cursor-reported' }, item), 'self-reported');
  assert.equal(attributionOf({ kind: 'log', source: 'user-recovery' }, item), 'operator');
  assert.equal(attributionOf({ kind: 'diff' }, item), 'office-recorded');
});

test('comments anchor to a real block and are bounded', () => {
  const { room, desk } = fixture();
  const run = desk.start(room, task);
  desk.update(room, run.agentId, { summary: 'Progress', diff: '+label' });
  const item = room.workItems[0];
  const target = runDoc(room, item).blocks.find(block => block.kind === 'diff');
  const comment = addComment(room, item, { blockId: target.id, author: 'Davin', text: 'Does this keep the placeholder?' });
  assert.equal(runDoc(room, item).comments[0].id, comment.id);
  assert.throws(() => addComment(room, item, { blockId: 'not-a-block', author: 'Davin', text: 'Hi' }), /no longer part/);
  assert.throws(() => addComment(room, item, { blockId: target.id, author: 'Davin', text: '' }));
  item.comments = Array.from({ length: 200 }, () => ({ id: 'x' }));
  assert.throws(() => addComment(room, item, { blockId: target.id, author: 'Davin', text: 'One too many' }), /limit/);
});

test('the feed is reverse-chronological, skips the sample office and omits block bodies', () => {
  const { state, room, desk } = fixture();
  const first = desk.start(room, task);
  desk.finish(room, first.agentId, { summary: 'First run', outcome: 'review' });
  const second = desk.start(room, { ...task, task: 'Second run' });
  // Both runs land in the same millisecond here; date them apart so order is actually asserted.
  room.workItems.find(i => i.agentId === first.agentId).updatedAt -= 60000;
  const sample = initOffice({ ...structuredClone(room), id: 'sample-office', demo: true });
  sample.workItems.forEach(item => { item.updatedAt = Date.now() + 60000; });
  state.rooms.push(sample);
  const feed = runFeed(state);
  assert.deepEqual(feed.map(entry => entry.id), [second, first].map(run => room.workItems.find(i => i.agentId === run.agentId).id));
  assert.ok(feed.every(entry => !entry.blocks && entry.blockCount > 0));
  assert.ok(sample.workItems.length, 'the sample office has the newest runs');
  assert.ok(feed.every(entry => entry.roomId === room.id), 'but it never appears in the public feed');
});
