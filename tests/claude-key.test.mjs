import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeKeyStore } from '../server/claude-key.mjs';

const KEY = 'sk-ant-api03-' + 'a'.repeat(40) + 'WXYZ';
async function tempFile(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iteration1-claude-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'anthropic-key.json');
}

test('a pasted key is checked, saved privately, survives a restart and can be removed', async t => {
  const file = await tempFile(t); const checked = [];
  const store = createClaudeKeyStore({ file, env: () => '', verify: async key => { checked.push(key); } });
  await store.load();
  assert.deepEqual(store.status(), { configured: false, source: null, hint: null });

  const status = await store.save(`  ${KEY}\n`);
  assert.deepEqual(checked, [KEY], 'the key is verified before it is kept');
  assert.deepEqual(status, { configured: true, source: 'saved', hint: '…WXYZ' });
  assert.ok(!JSON.stringify(status).includes(KEY.slice(0, 20)), 'status never carries the key itself');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600, 'only this user can read the key file');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).apiKey, KEY);

  const restarted = createClaudeKeyStore({ file, env: () => '' });
  await restarted.load();
  assert.equal(restarted.current(), KEY);

  assert.equal((await restarted.remove()).configured, false);
  await assert.rejects(stat(file));
});

test('a key Anthropic rejects, or one that is not a key, is never saved', async t => {
  const file = await tempFile(t);
  const store = createClaudeKeyStore({ file, env: () => '', verify: async () => { throw new Error('Anthropic did not accept that key.'); } });
  await assert.rejects(store.save(KEY), /did not accept/);
  await assert.rejects(stat(file));
  await assert.rejects(store.save('sk-proj-not-anthropic'), /Keys start with sk-ant-/);
  assert.equal(store.status().configured, false);
});

test('ANTHROPIC_API_KEY in the environment takes precedence over a saved key', async t => {
  const file = await tempFile(t);
  const store = createClaudeKeyStore({ file, env: () => 'sk-ant-env-' + 'b'.repeat(30), verify: async () => {} });
  assert.deepEqual(store.status(), { configured: true, source: 'environment', hint: '…bbbb' });
  await assert.rejects(store.save(KEY), /set in the environment/);
});

test('an unreadable key file means signed out, not a crash', async t => {
  const file = await tempFile(t);
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'not json');
  const store = createClaudeKeyStore({ file, env: () => '' });
  await store.load();
  assert.equal(store.status().configured, false);
});
