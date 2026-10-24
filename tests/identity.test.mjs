import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createCursorDesk } from '../server/cursor.mjs';
import { upsertIdentity, identityBySub, creditRun, initIdentities } from '../server/identity.mjs';
import { seed } from '../server/domain.mjs';
import { initOffice } from '../server/orchestration.mjs';

function fixture() {
  const state = seed(path.resolve('.'));
  const room = initOffice(state.rooms[0]); room.demo = false; room.agents = []; room.workItems = []; room.goal = '';
  let signedIn = null;
  const desk = createCursorDesk({ state, changed() {}, currentIdentity: () => signedIn });
  return { state, room, desk, signIn: profile => { signedIn = profile ? upsertIdentity(state, profile) : null; return signedIn; } };
}
const alex = { sub: 'auth0|alex', name: 'Alex Rivera', email: 'alex@example.com' };
const blair = { sub: 'auth0|blair', name: 'Blair Chen', email: 'blair@example.com' };
const task = { task: 'Make search keyboard accessible', acceptanceCriteria: ['Search is reachable with Tab'] };

test('an account is recorded once and keeps its history across sign-ins', () => {
  const { state, signIn } = fixture();
  const first = signIn(alex);
  creditRun(first, 'started');
  const again = signIn({ ...alex, name: 'Alex R.' });
  assert.equal(initIdentities(state).length, 1, 'the same subject is not duplicated');
  assert.equal(again.label, 'Alex R.', 'a renamed profile updates');
  assert.equal(again.record.started, 1, 'but the track record survives');
  assert.equal(identityBySub(state, 'auth0|nobody'), null);
  assert.equal(upsertIdentity(state, { name: 'No subject' }), null);
});

test('a run is attributed to the signed-in account and reuses its desk identity', () => {
  const { state, room, desk, signIn } = fixture();
  signIn(alex);
  const run = desk.start(room, task);
  const worker = room.agents.find(a => a.id === run.agentId);
  assert.equal(worker.credentialSub, alex.sub);
  assert.equal(identityBySub(state, alex.sub).record.started, 1);

  desk.update(room, run.agentId, { summary: 'Real progress', diff: '+<label>Search</label>' });
  desk.finish(room, run.agentId, { summary: 'Needs verification', outcome: 'review' });
  assert.equal(identityBySub(state, alex.sub).record.review, 1);

  const second = desk.start(room, task);
  const returning = room.agents.find(a => a.id === second.agentId);
  assert.equal(returning.name, worker.name, 'the same account returns to the same desk');
  assert.equal(returning.title, worker.title);
});

test('signing out or switching accounts cannot report on an open run', () => {
  const { room, desk, signIn } = fixture();
  signIn(alex);
  const run = desk.start(room, task);

  signIn(null);
  assert.throws(() => desk.update(room, run.agentId, { summary: 'Signed out' }), /another signed-in account/);
  signIn(blair);
  assert.throws(() => desk.update(room, run.agentId, { summary: 'Different person' }), /another signed-in account/);
  signIn(alex);
  assert.doesNotThrow(() => desk.update(room, run.agentId, { summary: 'The owner returns' }));
});

test('operator recovery releases an abandoned desk with nobody signed in', () => {
  const { state, room, desk, signIn } = fixture();
  signIn(alex);
  const run = desk.start(room, task);
  signIn(null);
  const released = desk.release(room, run.agentId, { confirmedStopped: true });
  assert.equal(released.status, 'blocked');
  assert.equal(identityBySub(state, alex.sub).record.blocked, 1);
  assert.equal(room.workItems[0].evidence.at(-1).source, 'user-recovery');
});

test('signed-out runs still work and are reported as unattributed', () => {
  const { room, desk } = fixture();
  const run = desk.start(room, task);
  assert.equal(room.agents.find(a => a.id === run.agentId).credentialSub, null);
  assert.doesNotThrow(() => desk.update(room, run.agentId, { summary: 'Nobody signed in' }));
});

test('crediting tolerates a missing identity and an unknown outcome', () => {
  const { state, signIn } = fixture();
  const identity = signIn(alex);
  assert.doesNotThrow(() => creditRun(null, 'review'));
  creditRun(identity, 'nonsense');
  assert.deepEqual(identityBySub(state, alex.sub).record, { started: 0, review: 0, blocked: 0, verified: 0 });
});
