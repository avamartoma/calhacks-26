import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createCursorDesk } from '../server/cursor.mjs';
import { issueAgentIdentity, verifyAgentToken, revokeIdentity, publicIdentity, identityBySub, creditRun } from '../server/identity.mjs';
import { seed } from '../server/domain.mjs';
import { initOffice } from '../server/orchestration.mjs';

function fixture() {
  const state = seed(path.resolve('.'));
  const room = initOffice(state.rooms[0]); room.demo = false; room.agents = []; room.workItems = []; room.goal = '';
  return { state, room, desk: createCursorDesk({ state, changed() {} }) };
}
const task = { task: 'Make search keyboard accessible', acceptanceCriteria: ['Search is reachable with Tab'] };

test('an issued token is verifiable once, never recoverable and revocable', () => {
  const { state } = fixture();
  const { token, identity } = issueAgentIdentity(state, { label: 'Davin · Cursor' });
  assert.equal(verifyAgentToken(state, token).sub, identity.sub);
  assert.equal(publicIdentity(identity).hash, undefined);
  assert.ok(!JSON.stringify(state.identities).includes(token));
  for (const wrong of [undefined, '', 'fourteenth_agent_' + 'x'.repeat(40), token + 'x', token.slice(0, -1)]) assert.equal(verifyAgentToken(state, wrong), null);
  revokeIdentity(state, identity.sub);
  assert.equal(verifyAgentToken(state, token), null);
  assert.throws(() => revokeIdentity(state, identity.sub), /Unknown/);
});

test('an attributed run reuses its identity, accrues a record and refuses another agent token', () => {
  const { state, room, desk } = fixture();
  const mine = issueAgentIdentity(state, { label: 'Mine' });
  const theirs = issueAgentIdentity(state, { label: 'Theirs' });
  assert.throws(() => desk.start(room, { ...task, token: 'fourteenth_agent_' + 'z'.repeat(40) }), /not recognised/);

  const run = desk.start(room, { ...task, token: mine.token });
  const worker = room.agents.find(a => a.id === run.agentId);
  assert.equal(worker.credentialSub, mine.identity.sub);
  assert.equal(identityBySub(state, mine.identity.sub).record.started, 1);

  assert.throws(() => desk.update(room, run.agentId, { summary: 'Impersonated', token: theirs.token }), /another agent identity/);
  assert.throws(() => desk.update(room, run.agentId, { summary: 'Anonymous' }), /another agent identity/);
  desk.update(room, run.agentId, { summary: 'Real progress', token: mine.token, diff: '+<label>Search</label>' });
  desk.finish(room, run.agentId, { summary: 'Needs verification', outcome: 'review', token: mine.token });
  assert.equal(identityBySub(state, mine.identity.sub).record.review, 1);

  // The next session is the same person at the same desk, with the history intact.
  const second = desk.start(room, { ...task, token: mine.token });
  const returning = room.agents.find(a => a.id === second.agentId);
  assert.equal(returning.name, worker.name); assert.equal(returning.title, worker.title);
  assert.equal(identityBySub(state, mine.identity.sub).record.started, 2);
});
test('operator recovery releases an attributed desk without the absent agent token', () => {
  const { state, room, desk } = fixture();
  const { token, identity } = issueAgentIdentity(state, { label: 'Gone' });
  const run = desk.start(room, { ...task, token });
  const released = desk.release(room, run.agentId, { confirmedStopped: true });
  assert.equal(released.status, 'blocked');
  assert.equal(identityBySub(state, identity.sub).record.blocked, 1);
  assert.equal(room.workItems[0].evidence.at(-1).source, 'user-recovery');
});
test('unattributed runs still work and are reported as unattributed', () => {
  const { room, desk } = fixture();
  const run = desk.start(room, task);
  assert.equal(room.agents.find(a => a.id === run.agentId).credentialSub, null);
  assert.doesNotThrow(() => desk.update(room, run.agentId, { summary: 'No identity configured' }));
});

test('crediting tolerates a missing identity and an unknown outcome', () => {
  const { state } = fixture();
  const { identity } = issueAgentIdentity(state, { label: 'Counted' });
  assert.doesNotThrow(() => creditRun(null, 'review'));
  creditRun(identity, 'nonsense');
  assert.deepEqual(identity.record, { started: 0, review: 0, blocked: 0, verified: 0 });
});
