import test from 'node:test';
import assert from 'node:assert/strict';
import { preselect } from '../src/web/github-pick.ts';

const now = Date.parse('2026-10-25T00:00:00Z');
const repo = (id, days, extra = {}) => ({ id, added: false, fork: false, archived: false, pushedAt: new Date(now - days * 86_400_000).toISOString(), ...extra });

test('recent repos of your own start checked; forks, archived, stale and already-added ones do not', () => {
  const chosen = preselect([
    repo(1, 3), repo(2, 40), repo(3, 10, { fork: true }), repo(4, 5, { archived: true }),
    repo(5, 400), repo(6, 1, { added: true }), { ...repo(7, 1), pushedAt: null },
  ], now);
  assert.deepEqual([...chosen].sort(), [1, 2]);
});

test('at most twelve start checked, newest first as GitHub lists them', () => {
  const chosen = preselect(Array.from({ length: 20 }, (_, i) => repo(i + 1, i + 1)), now);
  assert.equal(chosen.size, 12);
  assert.ok(chosen.has(1) && chosen.has(12) && !chosen.has(13));
});
