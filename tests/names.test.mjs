import test from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../server/domain.mjs';
import { chooseIdentity, claimIdentity, nameRoom, nameStoredRoom, successorName, replacementName, namePools } from '../server/names.mjs';
import { createDemo, stepDemo } from '../server/orchestration.mjs';

test('the same agent id always receives the same display name', () => {
  const first = chooseIdentity({ id: 'desk-alpha', role: 'Research' }, []);
  const second = chooseIdentity({ id: 'desk-alpha', role: 'Research' }, []);
  assert.deepEqual(first, second);
  assert.ok(namePools.Research.some(entry => entry.name === first.name && entry.title === first.title));
});

test('active agents in one room do not share a display name', () => {
  const room = { agents: [] };
  for (let i = 0; i < namePools.Research.length; i++) {
    const worker = agent('temp', 'Research', 'Inspect', i, { id: `research-${i}`, status: 'working' });
    delete worker.title;
    room.agents.push(worker);
    claimIdentity(worker, room);
  }
  const names = room.agents.map(worker => worker.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => namePools.Research.some(entry => entry.name === name)));
});

test('unnamed agents are named once and keep that name', () => {
  const worker = agent('Morgan', 'Manager', 'Coordinate', 0, { id: 'manager-fixed', manager: true, status: 'working' });
  delete worker.title;
  const room = { agents: [worker] };
  nameRoom(room);
  assert.ok(namePools.Manager.some(entry => entry.name === worker.name && entry.title === worker.title));
  const kept = { name: worker.name, title: worker.title };
  nameRoom(room);
  assert.deepEqual({ name: worker.name, title: worker.title }, kept);
});

test('replacement names take the next Roman numeral and keep the title', () => {
  assert.equal(successorName('Tess'), 'Tess II');
  assert.equal(successorName('Tess II'), 'Tess III');
  assert.equal(successorName('Tess III'), 'Tess IV');
  const room = { agents: [] };
  const first = agent('Tess', 'Test design', 'Hunt bugs', 0, { id: 'tess', status: 'ejected', title: 'Bug Hunter' });
  room.agents.push(first);
  const next = agent(successorName(first.name), first.role, first.task, 1, { id: 'tess-2', status: 'working', title: first.title });
  room.agents.push(next);
  nameRoom(room);
  assert.equal(next.name, 'Tess II');
  assert.equal(next.title, 'Bug Hunter');
  assert.equal(first.title, 'Bug Hunter');
});

test('an exhausted pool falls back to Name 2', () => {
  const room = { agents: namePools.Generic.map((entry, index) => ({ id: `held-${index}`, name: entry.name, title: entry.title, role: 'Systems', status: 'working' })) };
  const extra = agent('temp', 'Systems', 'Help', 0, { id: 'systems-extra', status: 'working' });
  delete extra.title;
  room.agents.push(extra);
  claimIdentity(extra, room);
  assert.match(extra.name, /^(Mo|Pip|Lou) 2$/);
  assert.ok(namePools.Generic.some(entry => entry.title === extra.title));
});

test('assigned names survive a restart', () => {
  const worker = agent('temp', 'Accessibility', 'Check keys', 0, { id: 'ally-desk', status: 'working' });
  delete worker.title;
  const room = { agents: [worker], timeline: [{ frame: { agents: [{ ...worker, name: 'Alex' }] } }], checkpoints: [{ frame: { agents: [{ id: worker.id, name: '', role: 'Accessibility', status: 'working' }] } }] };
  delete room.timeline[0].frame.agents[0].title;
  nameStoredRoom(room);
  const saved = JSON.parse(JSON.stringify(room));
  nameStoredRoom(saved);
  assert.equal(saved.agents[0].id, 'ally-desk');
  assert.deepEqual(saved.agents.map(person => ({ id: person.id, name: person.name, title: person.title })), room.agents.map(person => ({ id: person.id, name: person.name, title: person.title })));
  assert.equal(saved.timeline[0].frame.agents[0].name, saved.agents[0].name);
  assert.equal(saved.timeline[0].frame.agents[0].title, saved.agents[0].title);
  assert.equal(saved.checkpoints[0].frame.agents[0].name, saved.agents[0].name);
  assert.ok(namePools.Accessibility.some(entry => entry.name === saved.agents[0].name));
});

test('a taken replacement suffix advances to the next Roman numeral', () => {
  const first = { id: 'tess', name: 'Tess', title: 'Bug Hunter', role: 'Test design', status: 'ejected' };
  const held = { id: 'other', name: 'Tess II', title: 'Bug Hunter', role: 'Test design', status: 'working' };
  assert.equal(replacementName(first, { agents: [first, held] }), 'Tess III');
});

test('the guided demo draws names from role pools and keeps them on replacement', () => {
  const room = createDemo('.');
  for (const worker of room.agents) {
    assert.notEqual(worker.id, worker.name);
    assert.ok(poolName(worker), `${worker.role} should use its pool`);
  }
  const manager = room.agents.find(worker => worker.manager);
  stepDemo(room);
  for (const [role, pool] of [['Product · API scout', 'API discovery'], ['Quality · Test designer', 'Test design'], ['Quality · Accessibility', 'Accessibility']]) {
    const worker = room.agents.find(person => person.role === role);
    assert.ok(namePools[pool].some(entry => entry.name === worker.name && entry.title === worker.title));
  }
  assert.ok(!room.agents.some(worker => ['Nova', 'Jules', 'Riley', 'Morgan', 'Alex', 'Sam'].includes(worker.name)));
  stepDemo(room);
  stepDemo(room);
  const next = room.agents.find(worker => worker.replaces === manager.id);
  assert.equal(next.name, successorName(manager.name));
  assert.equal(next.title, manager.title);
  assert.notEqual(next.id, manager.id);
});

function poolName(worker) {
  const pools = worker.manager || /\bmanager\b/i.test(worker.role) ? namePools.Manager : /review/i.test(worker.role) ? namePools.Review : /research/i.test(worker.role) ? namePools.Research : null;
  return pools?.some(entry => entry.name === worker.name && entry.title === worker.title);
}
