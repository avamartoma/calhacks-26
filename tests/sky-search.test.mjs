import test from 'node:test';
import assert from 'node:assert/strict';
import { keywordMatches } from '../src/sky/search.ts';

const sky = [
  { id: 'a', name: 'Notes API', description: '2 agents · Paused', agents: [{ name: 'Sage', role: 'Doc Digger' }, { name: 'Claude · Ava', role: 'Build' }] },
  { id: 'b', name: 'Weather CLI', description: 'Forecasts in the terminal', agents: [{ role: 'Built-in Reviewer' }] },
  { id: 'c', name: 'Billing service', description: 'Stripe webhooks', agents: [] },
  { id: 'you', name: 'You', kind: 'you' },
];
const ids = query => keywordMatches(sky, query).map(r => r.p.id);

test('matches project names and descriptions, any case and word order', () => {
  assert.deepEqual(ids('notes'), ['a']);
  assert.deepEqual(ids('CLI weather'), ['b']);
  assert.deepEqual(ids('stripe'), ['c']);
  assert.deepEqual(ids('notes stripe'), []);
  assert.deepEqual(ids('   '), []);
});

test('matches agent names and types, and says which agent', () => {
  assert.deepEqual(keywordMatches(sky, 'sage'), [{ p: sky[0], match: 'Agent: Sage' }]);
  assert.deepEqual(keywordMatches(sky, 'claude'), [{ p: sky[0], match: 'Agent: Claude · Ava' }]);
  assert.deepEqual(keywordMatches(sky, 'reviewer'), [{ p: sky[1], match: 'Agent: Reviewer' }]);
  assert.deepEqual(ids('weather reviewer'), ['b']);
});

test('a project whose name matches comes before one matched through an agent', () => {
  const both = [{ id: 'x', name: 'Docs site', agents: [] }, { id: 'y', name: 'Other', agents: [{ name: 'Docs bot', role: 'Writing' }] }];
  assert.deepEqual(keywordMatches(both, 'docs').map(r => r.p.id), ['x', 'y']);
});

test('never returns you', () => assert.deepEqual(ids('you'), []));
