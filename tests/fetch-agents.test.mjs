import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchHub } from '../server/fetch-agents.mjs';

const address = 'agent1q0r5evneykvtpltu348zc0nq6a32lwuaq4ywjt0twxw7kz9945y0qgxn6mk';
const rooms = new Set(['r1']);
const exists = id => rooms.has(id);

function hub() {
  let t = 1000, broadcasts = 0;
  const h = createFetchHub({ changed: () => broadcasts++, now: () => t });
  return { h, tick: ms => { t += ms; }, broadcasts: () => broadcasts };
}

test('agents check in, show online and go offline when they stop', () => {
  const { h, tick, broadcasts } = hub();
  assert.equal(h.snapshot().agents.find(a => a.name === 'reviewer').online, false);
  h.heartbeat({ name: 'reviewer', address, details: { model: false } });
  assert.equal(broadcasts(), 1);
  h.heartbeat({ name: 'reviewer', address, details: { model: false } });
  assert.equal(broadcasts(), 1, 'a routine check-in does not rebroadcast the whole office');
  assert.deepEqual(h.snapshot().agents.find(a => a.name === 'reviewer').details, { model: false });
  tick(25000);
  assert.equal(h.snapshot().agents.find(a => a.name === 'reviewer').online, false);
  assert.throws(() => h.heartbeat({ name: 'intruder', address }), /Invalid/);
  assert.throws(() => h.heartbeat({ name: 'office', address: 'not-an-address' }));
});

test('the page queues jobs that only the named agent can claim and finish', () => {
  const { h } = hub();
  const { job } = h.request({ agent: 'reviewer', kind: 'review', roomId: 'r1', taskId: 't1' }, exists);
  assert.throws(() => h.request({ agent: 'reviewer', kind: 'review', roomId: 'r1', taskId: 't1' }, exists), /already in progress/);
  assert.equal(h.heartbeat({ name: 'planner', address, details: {} }).jobs.length, 0);
  const claimed = h.heartbeat({ name: 'reviewer', address, details: {} }).jobs;
  assert.deepEqual(claimed.map(j => [j.id, j.kind, j.taskId]), [[job.id, 'review', 't1']]);
  assert.equal(h.heartbeat({ name: 'reviewer', address, details: {} }).jobs.length, 0, 'a claimed job is not handed out twice');
  assert.throws(() => h.finish(job.id, { name: 'planner', status: 'done', result: {} }), /Job not found/);
  h.finish(job.id, { name: 'reviewer', status: 'done', result: { text: 'Looks ready' } });
  assert.equal(h.snapshot().jobs[0].status, 'done');
  assert.throws(() => h.finish(job.id, { name: 'reviewer', status: 'done', result: {} }), /Job not found/);
});

test('jobs are limited to what each agent does, in real projects', () => {
  const { h } = hub();
  assert.throws(() => h.request({ agent: 'reviewer', kind: 'plan', roomId: 'r1' }, exists), /does not take/);
  assert.throws(() => h.request({ agent: 'office', kind: 'review', roomId: 'r1' }, exists));
  assert.throws(() => h.request({ agent: 'planner', kind: 'plan', roomId: 'missing' }, exists), /Project not found/);
  assert.throws(() => h.request({ agent: 'planner', kind: 'plan', roomId: 'r1', payload: { idea: 'x'.repeat(30000) } }, exists), /too large/);
  assert.ok(h.request({ agent: 'planner', kind: 'create', roomId: 'r1', payload: { plan: {} } }, exists).job.id);
});

test('the office agent takes chat messages from the page', () => {
  const { h } = hub();
  assert.throws(() => h.request({ agent: 'office', kind: 'chat', roomId: 'r1', payload: {} }, exists), /message/);
  assert.throws(() => h.request({ agent: 'office', kind: 'chat', roomId: 'r1', payload: { text: 'x'.repeat(4001) } }, exists), /message/);
  const first = h.request({ agent: 'office', kind: 'chat', roomId: 'r1', payload: { text: 'status' } }, exists).job;
  const second = h.request({ agent: 'office', kind: 'chat', roomId: 'r1', payload: { text: 'status' } }, exists).job;
  assert.notEqual(first.id, second.id, 'asking twice is two messages, not a duplicate request');
});

test('activity is kept for the page, newest last and bounded', () => {
  const { h } = hub();
  for (let i = 0; i < 130; i++) h.activity({ name: 'watcher', kind: 'blocked', text: `Blocked: task ${i}`, roomId: 'r1', taskId: 't' });
  const log = h.snapshot().activity;
  assert.equal(log.length, 120);
  assert.equal(log.at(-1).text, 'Blocked: task 129');
  assert.throws(() => h.activity({ name: 'watcher', kind: 'x', text: '' }));
});
