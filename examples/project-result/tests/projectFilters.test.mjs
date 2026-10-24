import test from 'node:test';
import assert from 'node:assert/strict';
import { projects } from '../src/projects.js';
import { DEFAULT_FILTERS, FILTER_STORAGE_KEY, filterProjects, readFilters, saveFilters } from '../src/projectFilters.js';

test('search matches names and descriptions immediately, ignoring case and outer spaces', () => {
  assert.deepEqual(filterProjects(projects, { query: '  PORTAL  ', status: 'All' }).map(p => p.id), ['portal']);
  assert.deepEqual(filterProjects(projects, { query: 'DOCUMENTATION', status: 'All' }).map(p => p.id), ['guide']);
  assert.deepEqual(filterProjects(projects, { query: '', status: 'All' }).map(p => p.id), projects.map(p => p.id));
});

test('Active status combines with search and excludes paused projects', () => {
  assert.deepEqual(filterProjects(projects, { query: '', status: 'Active' }).map(p => p.id), ['portal', 'search', 'guide']);
  assert.deepEqual(filterProjects(projects, { query: 'operations', status: 'Active' }), []);
  assert.deepEqual(filterProjects(projects, { query: 'operations', status: 'All' }).map(p => p.id), ['release']);
});

test('saved query and status round trip through storage', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  saveFilters(storage, { query: 'API', status: 'Active' });
  assert.equal(values.has(FILTER_STORAGE_KEY), true);
  assert.deepEqual(readFilters(storage), { query: 'API', status: 'Active' });
});

test('malformed and invalid saved filters recover safely', () => {
  for (const raw of ['{', 'null', '[]', '"text"']) {
    assert.deepEqual(readFilters({ getItem: () => raw }), DEFAULT_FILTERS);
  }
  assert.deepEqual(readFilters({ getItem: () => JSON.stringify({ query: 17, status: 'Paused' }) }), DEFAULT_FILTERS);
  assert.deepEqual(readFilters({ getItem: () => JSON.stringify({ query: 'guide', status: 'Paused' }) }), { query: 'guide', status: 'All' });
  assert.deepEqual(readFilters(() => { throw new Error('blocked'); }), DEFAULT_FILTERS);
  assert.deepEqual(readFilters({ getItem: () => { throw new Error('blocked'); } }), DEFAULT_FILTERS);
  assert.doesNotThrow(() => saveFilters(() => { throw new Error('blocked'); }, DEFAULT_FILTERS));
  assert.doesNotThrow(() => saveFilters({ setItem: () => { throw new Error('full'); } }, DEFAULT_FILTERS));
});
