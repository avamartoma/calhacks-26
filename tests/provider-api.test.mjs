import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('browser callback completes a hosted-style Codex login without any provider network calls', { timeout: 30000 }, async t => {
  const root = path.resolve('.'), dir = await mkdtemp(path.join(os.tmpdir(), 'iteration1-provider-api-'));
  const base = 'http://127.0.0.1:44338';
  await mkdir(path.join(dir, 'claude'));
  await writeFile(path.join(dir, 'claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'CLAUDE_ACCESS_SENTINEL', refreshToken: 'CLAUDE_REFRESH_SENTINEL', expiresAt: Date.now() + 3600000 } }));
  await writeFile(path.join(dir, 'cursor.json'), JSON.stringify({ apiKey: 'CURSOR_KEY_SENTINEL', apiKeyExpiresAtMs: Date.now() + 3600000 }));
  const child = spawn(process.execPath, ['server/index.mjs', '--production'], { cwd: root, env: { ...process.env, PORT: '44338', OFFICE_TEAM_PORT: '44438', OFFICE_DATA_DIR: dir, OFFICE_CODEX_HOME: path.join(dir, 'codex'), OFFICE_CLAUDE_HOME: path.join(dir, 'claude'), OFFICE_CLAUDE_KEY_FILE: path.join(dir, 'key.json'), OFFICE_CURSOR_AUTH_FILE: path.join(dir, 'cursor.json'), OFFICE_CODEX_BIN: process.execPath, OFFICE_CODEX_ARGS: JSON.stringify([path.join(root, 'tests/fake-codex.mjs')]), OFFICE_FIXTURE_SIGNED_OUT: '1', OFFICE_FIXTURE_MANUAL_SIGN_IN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    await rm(dir, { recursive: true, force: true });
  });
  let errors = ''; child.stderr.on('data', data => errors += data);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errors || 'Startup timeout')), 10000);
    child.stdout.on('data', data => { if (String(data).includes('Iteration1 office')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(errors || 'Server exited')); });
  });
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const request = async (route, body) => {
    const res = await fetch(base + '/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, headers: res.headers, data: await res.json() };
  };
  assert.equal((await fetch(base + '/api/providers/claude')).status, 401);
  for (const route of ['/state', '/integrations', '/providers/cursor', '/providers/claude']) {
    const res = await request(route);
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.data).includes('_SENTINEL'), `Secrets must not appear in ${route}`);
  }
  assert.equal((await request('/providers/claude')).headers.get('cache-control'), 'no-store');
  const started = await request('/codex/sign-in', {});
  assert.equal(started.status, 200); assert.equal(started.data.opened, false);
  const auth = new URL(started.data.authUrl);
  const callback = new URL(auth.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture-code' }).toString();
  const state = (await request('/state')).data;
  assert.equal(state.connection.account, null); assert.equal(state.connection.signIn.manualCallback, true);
  assert.equal((await request('/codex/callback', { callback: callback.href.replace('fixture-state', 'wrong') })).status, 409);
  const completed = await request('/codex/callback', { callback: callback.href });
  assert.equal(completed.status, 200, JSON.stringify(completed.data)); assert.equal(completed.data.connected, true);
  assert.equal((await request('/state')).data.connection.account.email, 'fixture@example.invalid');
  assert.equal((await request('/codex/callback', { callback: callback.href })).status, 409, 'no replay');
  await request('/codex/disconnect', {});
  assert.equal((await request('/state')).data.connection.account, null);
  const second = await request('/codex/sign-in', {}); assert.equal(second.status, 200);
  assert.equal((await request('/codex/cancel', {})).status, 200);
  assert.equal((await request('/state')).data.connection.signIn, null);
  assert.equal((await request('/codex/callback', { callback: callback.href })).status, 409);

  const claude = await request('/providers/claude/login', {});
  assert.equal(claude.status, 200); assert.equal(claude.data.configured, true);
  assert.equal(new URL(claude.data.login.url).hostname, 'claude.ai');
  assert.ok(!JSON.stringify(claude.data).includes('verifier'));
  assert.equal((await request('/providers/claude/complete', { callback: 'code#wrong' })).status, 409);
  await request('/providers/claude/cancel', {});
  assert.equal((await request('/providers/claude')).data.login, null);
  await request('/providers/claude/disconnect', {});
  assert.equal((await request('/providers/claude')).data.configured, false);
  await request('/providers/cursor/disconnect', {});
  // An explicit environment key still takes precedence, if one was supplied by the test host.
  if (!process.env.CURSOR_API_KEY) assert.equal((await request('/providers/cursor')).data.configured, false);
});
