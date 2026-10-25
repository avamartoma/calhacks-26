import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearch, keywordScore, roomDocs, searchRequest } from '../server/search.mjs';

// A stand-in model: each text becomes a unit vector over three topics, so "meaning" is predictable.
const topics = [/pay|bill|invoice|money/i, /access|keyboard|screen reader/i, /stock|warehouse|forecast/i];
const fakeLoad = calls => async () => async texts => { calls.push(texts.length); return texts.map(text => { const v = topics.map(t => t.test(text) ? 1 : 0); const n = Math.hypot(...v) || 1; return v.map(x => x / n); }); };
const items = [
  { id: 'billing', docs: [{ text: 'Billing Service Migration. Move invoices to the new API', label: '' }] },
  { id: 'audit', docs: [{ text: 'Mobile Accessibility Audit', label: '' }, { text: 'Ada, Frontend: keyboard focus for the search box', label: 'Agent Ada' }] },
  { id: 'stock', docs: [{ text: 'Warehouse Forecasting', label: '' }] },
];

test('ranks by meaning and says what matched', async () => {
  const search = createSearch({ cacheDir: '', load: fakeLoad([]) });
  const money = await search.search('money', items);
  assert.equal(money.mode, 'semantic');
  assert.deepEqual(money.results.map(r => r.id), ['billing'], 'shares no words with the query, still found');
  const keys = await search.search('keyboard', items);
  assert.equal(keys.results[0].id, 'audit');
  assert.equal(keys.results[0].match, 'Agent Ada', 'the agent matched, not the project name');
});

test('embeds each text once', async () => {
  const calls = [];
  const search = createSearch({ cacheDir: '', load: fakeLoad(calls) });
  await search.search('money', items);
  await search.search('money', items);
  assert.deepEqual(calls, [5], 'the second search reuses every vector');
});

test('falls back to matching words when the model cannot load', async () => {
  const search = createSearch({ cacheDir: '', load: async () => { throw new Error('offline'); }, log: () => {} });
  const result = await search.search('warehouse forecasting', items);
  assert.equal(result.mode, 'keyword');
  assert.deepEqual(result.results.map(r => r.id), ['stock']);
  assert.deepEqual(search.status(), { state: 'error', error: 'offline' });
});

test('a project is found by its agents and open tickets, not removed ones', () => {
  const docs = roomDocs({ name: 'Shop', goal: 'Sell things', agents: [{ name: 'Ada', role: 'Frontend', task: 'Cart page', status: 'working' }, { name: 'Gone', role: 'x', task: 'y', status: 'ejected' }], workItems: [{ title: 'Checkout', description: 'Pay by card', acceptanceCriteria: ['Card works'] }, { title: 'Old', description: '', archived: true }] });
  assert.deepEqual(docs.map(d => d.label), ['', 'Agent Ada', 'Ticket · Checkout']);
  assert.equal(docs[2].text, 'Checkout. Pay by card Card works');
});

test('word matching and request limits', () => {
  assert.equal(keywordScore('billing api', 'Billing Service API'), 1);
  assert.equal(keywordScore('billing rocket', 'Billing Service'), .5);
  assert.throws(() => searchRequest.parse({ query: '', items: [] }));
  assert.throws(() => searchRequest.parse({ query: 'x', items: Array.from({ length: 151 }, (_, i) => ({ id: String(i), text: '' })) }));
  assert.throws(() => searchRequest.parse({ query: 'x', items: [{ id: 'a', text: 'y'.repeat(401) }] }));
});
