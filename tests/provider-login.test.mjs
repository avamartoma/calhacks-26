import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCodexCallback, createClaudeLogin, createCursorLogin, parseCallback } from '../server/provider-login.mjs';

const redirectUri = 'http://localhost:1455/auth/callback';
const authUrl = (state = 'state-1') => `https://auth.openai.com/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
const callback = (state = 'state-1') => `${redirectUri}?code=fixture-code&state=${state}`;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iteration1-provider-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('callback parsing rejects foreign addresses, duplicate parameters, missing state and URL credentials', () => {
  const expected = { redirectUri, state: 'state-1' };
  assert.deepEqual(parseCallback(callback(), expected), { code: 'fixture-code', state: 'state-1' });
  for (const input of [callback('wrong'), 'http://example.com/auth/callback?code=c&state=state-1', callback() + '&code=second', callback() + '&state=second', callback() + '#fragment', callback().replace('localhost', 'user:pass@localhost'), callback().replace('/auth/callback', '/other'), `${redirectUri}?code=c`, '', 'not a URL']) assert.throws(() => parseCallback(input, expected));
  assert.deepEqual(parseCallback('code#state-1', { ...expected, allowCodePair: true }), { code: 'code', state: 'state-1' });
  assert.throws(() => parseCallback('code#state-1', expected));
});

test('Codex relays only validated parameters to its own callback, with no redirect following or replay', async () => {
  const requests = [];
  const login = createCodexCallback({ fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return new Response('OK'); } });
  login.begin(authUrl());
  await assert.rejects(login.complete(callback('wrong')), /different sign-in/);
  assert.equal(requests.length, 0);
  await login.complete(callback() + '&untrusted=value');
  assert.equal(requests[0].url, callback());
  assert.equal(requests[0].options.redirect, 'manual');
  await assert.rejects(login.complete(callback()), /expired/);
  assert.equal(requests.length, 1);
});

test('Codex attempts expire, cancel and serialize redemption; provider errors never expose response bodies', async () => {
  let time = 0, release;
  const login = createCodexCallback({ now: () => time, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  login.begin(authUrl()); time = 15 * 60 * 1000;
  await assert.rejects(login.complete(callback()), /expired/);
  login.begin(authUrl()); login.cancel();
  await assert.rejects(login.complete(callback()), /expired/);
  login.begin(authUrl());
  const completion = login.complete(callback());
  await assert.rejects(login.complete(callback()), /already being completed/);
  release(new Response('SECRET_PROVIDER_RESPONSE', { status: 400 }));
  await assert.rejects(completion, error => !error.message.includes('SECRET_PROVIDER_RESPONSE'));
  for (const uri of ['http://example.com:1455/auth/callback', 'http://127.0.0.1:8080/secret', 'https://localhost:1455/auth/callback']) assert.throws(() => login.begin(`https://auth.openai.com/authorize?state=s&redirect_uri=${encodeURIComponent(uri)}`));
});

test('Claude exchanges a fresh PKCE grant into a private native profile, preserving refresh ownership', async t => {
  const dir = await fixture(t); let request;
  const login = createClaudeLogin({ configDir: dir, now: () => 1000, fetchImpl: async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, scope: 'user:inference user:profile' });
  } });
  const started = login.begin(), url = new URL(started.login.url), state = url.searchParams.get('state');
  assert.equal(started.configured, false);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(login.complete('code#wrong-state'), /different sign-in/);
  assert.equal(request, undefined);
  const finished = await login.complete(`fixture-code#${state}`);
  assert.equal(finished.configured, true); assert.equal(finished.login, null);
  assert.equal(request.url, 'https://api.anthropic.com/v1/oauth/token');
  assert.equal(createHash('sha256').update(request.body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  const file = path.join(dir, '.credentials.json');
  const saved = JSON.parse(await readFile(file, 'utf8')).claudeAiOauth;
  assert.equal(saved.accessToken, 'access-secret'); assert.equal(saved.refreshToken, 'refresh-secret'); assert.equal(saved.expiresAt, 3601000);
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(finished).includes('secret'));
  await assert.rejects(login.complete(`fixture-code#${state}`), /expired/);
  // A native runtime rotates these exact credentials in place, rather than refreshing a copied login.
  saved.accessToken = 'native-refreshed'; saved.refreshToken = 'native-rotated';
  await writeFile(file, JSON.stringify({ claudeAiOauth: saved }));
  const restarted = createClaudeLogin({ configDir: dir });
  assert.equal((await restarted.load()).configured, true);
  await writeFile(path.join(dir, 'conversation.json'), '{}');
  await restarted.disconnect();
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(dir, 'conversation.json'), 'utf8'), '{}');
});

test('Claude cancellation, expiry and simultaneous completion cannot redeem an old grant', async t => {
  const dir = await fixture(t); let time = 0, requests = 0, finish;
  const login = createClaudeLogin({ configDir: dir, now: () => time, fetchImpl: () => { requests++; return new Promise(resolve => { finish = resolve; }); } });
  let attempt = login.begin(); const oldState = new URL(attempt.login.url).searchParams.get('state');
  login.begin();
  await assert.rejects(login.complete(`c#${oldState}`), /different sign-in/);
  login.cancel(); await assert.rejects(login.complete(`c#${oldState}`), /expired/);
  attempt = login.begin(); time += 15 * 60 * 1000;
  await assert.rejects(login.complete(`c#${new URL(attempt.login.url).searchParams.get('state')}`), /expired/);
  attempt = login.begin(); const code = `c#${new URL(attempt.login.url).searchParams.get('state')}`;
  const result = login.complete(code);
  await assert.rejects(login.complete(code), /already being completed/);
  assert.throws(() => login.begin(), /Wait/);
  await assert.rejects(login.disconnect(), /Wait/);
  finish(new Response('SECRET_UPSTREAM_ERROR', { status: 401 }));
  await assert.rejects(result, error => !error.message.includes('SECRET_UPSTREAM_ERROR'));
  assert.equal(requests, 1); assert.equal(login.status().configured, false);
});

function cursorSdk() {
  const calls = [];
  return { calls, importSdk: async () => ({ Cursor: { auth: { login(options) {
    return new Promise((resolve, reject) => {
      calls.push({ options, resolve, reject });
      options.onLoginUrl('https://cursor.com/loginDeepControl?challenge=public');
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    });
  } } } }) };
}

test('Cursor stores a dedicated expiring SDK key, never returns it, and loads it after restart', async t => {
  const dir = await fixture(t), file = path.join(dir, 'cursor.json'), sdk = cursorSdk(); let time = 0;
  const login = createCursorLogin({ file, importSdk: sdk.importSdk, env: () => '', now: () => time });
  const pending = await login.begin(); assert.ok(pending.login.url); assert.equal(pending.configured, false);
  assert.equal(sdk.calls[0].options.store, null); assert.equal(sdk.calls[0].options.openBrowser, false); assert.equal(sdk.calls[0].options.apiKeyName, 'Iteration1');
  sdk.calls[0].resolve({ apiKey: 'cursor-private', apiKeyExpiresAtMs: 100000, email: 'fixture@example.invalid' });
  for (let i = 0; i < 100 && !login.status().configured; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(login.status().configured, true); assert.equal(login.current(), 'cursor-private');
  assert.ok(!JSON.stringify(login.status()).includes('cursor-private'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = createCursorLogin({ file, env: () => '', now: () => time });
  assert.equal((await restarted.load()).configured, true); assert.equal(restarted.current(), 'cursor-private');
  time = 100001; assert.equal(restarted.current(), '');
  await restarted.disconnect(); await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('Cursor cancellation and replaced attempts cannot save late credentials or expose raw errors', async t => {
  const dir = await fixture(t), file = path.join(dir, 'cursor.json'), sdk = cursorSdk();
  const login = createCursorLogin({ file, importSdk: sdk.importSdk, env: () => '' });
  await login.begin(); await login.begin();
  assert.equal(sdk.calls[0].options.signal.aborted, true);
  sdk.calls[1].reject(new Error('SECRET_RAW_DIAGNOSTIC'));
  await settle();
  assert.ok(!JSON.stringify(login.status()).includes('SECRET_RAW_DIAGNOSTIC'));
  await login.begin(); login.cancel(); await settle();
  assert.equal(login.status().configured, false); assert.equal(login.status().login, null);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});
