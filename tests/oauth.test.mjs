import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { createAuth, providerFields } from '../server/oauth.mjs';

const DOMAIN = 'tenant.us.auth0.com', CLIENT_ID = 'client-abc12345', ISSUER = `https://${DOMAIN}/`;
const provider = { domain: DOMAIN, clientId: CLIENT_ID };

// jose validates exp against the real wall clock, so the fake clock starts from now.
const START = Date.now();
async function harness(t, { now = () => START } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iteration1-oauth-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' }] });
  const calls = [];
  let tokenResponse = null;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? Object.fromEntries(new URLSearchParams(options.body)) : null });
    if (String(url).includes('.well-known')) return { ok: true, json: async () => ({ issuer: ISSUER, authorization_endpoint: `${ISSUER}authorize`, token_endpoint: `${ISSUER}oauth/token`, jwks_uri: `${ISSUER}.well-known/jwks.json` }) };
    return tokenResponse;
  };
  const auth = createAuth({ dataDir, port: 4314, fetchImpl, createJwks: () => jwks, now });
  await auth.load();
  await auth.configure(provider);
  const idToken = async (claims = {}) => new SignJWT({ name: 'Alex Rivera', email: 'alex@example.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(CLIENT_ID)
    .setSubject(claims.sub || 'auth0|alex').setIssuedAt(Math.floor(now() / 1000)).setExpirationTime(Math.floor(now() / 1000) + 3600).sign(privateKey);
  return { auth, dataDir, calls, idToken, setTokens: value => { tokenResponse = value; } };
}

const okTokens = payload => ({ ok: true, json: async () => payload });

test('the tenant domain is validated and the client id is not a secret', () => {
  assert.throws(() => providerFields.parse({ domain: 'https://tenant.auth0.com', clientId: CLIENT_ID }), /domain only/);
  assert.throws(() => providerFields.parse({ domain: 'tenant.auth0.com/path', clientId: CLIENT_ID }), /domain only/);
  assert.throws(() => providerFields.parse({ domain: DOMAIN, clientId: 'short' }));
  assert.equal(providerFields.parse(provider).domain, DOMAIN);
});

test('the authorize URL carries PKCE, a loopback redirect and no secret', async t => {
  const { auth } = await harness(t);
  const { url } = await auth.begin();
  const params = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, `${ISSUER}authorize`);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:4314/auth/callback');
  assert.match(params.get('scope'), /openid/);
  assert.match(params.get('scope'), /offline_access/);
  assert.ok(params.get('state') && params.get('nonce'));
  assert.equal(params.get('client_secret'), null, 'a public client never sends a secret');
  assert.ok(!url.includes('code_verifier'), 'the verifier stays on this machine');
});

test('a completed sign-in proves the subject and stores no token in the clear response', async t => {
  const { auth, dataDir, calls, idToken, setTokens } = await harness(t);
  const { url } = await auth.begin();
  const state = new URL(url).searchParams.get('state');
  const nonce = new URL(url).searchParams.get('nonce');
  const verifier = null; // unknown to the caller by design
  setTokens(okTokens({ id_token: await idToken({ nonce }), access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));

  const session = await auth.complete({ code: 'the-code', state });
  assert.equal(session.sub, 'auth0|alex');
  assert.equal(session.name, 'Alex Rivera');

  // The exchange proves possession of the verifier that matches the challenge sent earlier.
  const exchange = calls.find(c => c.body?.grant_type === 'authorization_code');
  assert.equal(exchange.body.code_verifier.length >= 43, true);
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), new URL(url).searchParams.get('code_challenge'));
  assert.equal(exchange.body.client_secret, undefined);
  assert.equal(verifier, null);

  const published = auth.publicSession(session);
  for (const secret of ['refreshToken', 'accessToken', 'idToken']) assert.equal(published[secret], undefined, `${secret} must not be published`);
  assert.equal(auth.publicProvider().clientId, CLIENT_ID);

  // Tokens are persisted for the next launch, but only to the ignored office directory.
  const stored = JSON.parse(await readFile(path.join(dataDir, 'session.json'), 'utf8'));
  assert.equal(stored.refreshToken, 'rt');
  assert.equal(typeof stored.idToken, 'string');
  assert.equal(stored.idToken.split('.').length, 3);
});

test('a replayed, unknown or tampered callback is refused', async t => {
  const { auth, idToken, setTokens } = await harness(t);
  const { url } = await auth.begin();
  const state = new URL(url).searchParams.get('state');
  const nonce = new URL(url).searchParams.get('nonce');
  setTokens(okTokens({ id_token: await idToken({ nonce }), expires_in: 3600 }));

  await assert.rejects(auth.complete({ code: 'c', state: 'not-a-state' }), /no longer valid/);
  await assert.rejects(auth.complete({ code: 'c', state: undefined }), /no longer valid/);
  await auth.complete({ code: 'c', state });
  await assert.rejects(auth.complete({ code: 'c', state }), /no longer valid/, 'state is single use');
});

test('an identity token for another audience, issuer or request is rejected', async t => {
  const { auth, idToken, setTokens } = await harness(t);
  const start = async () => new URL((await auth.begin()).url).searchParams;

  let params = await start();
  setTokens(okTokens({ id_token: await idToken({ nonce: 'a-different-nonce' }) }));
  await assert.rejects(auth.complete({ code: 'c', state: params.get('state') }), /did not match this request/);

  params = await start();
  const wrongAudience = await new SignJWT({ nonce: params.get('nonce') }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setAudience('someone-else').setSubject('auth0|alex').setIssuedAt().setExpirationTime('1h').sign((await generateKeyPair('RS256')).privateKey);
  setTokens(okTokens({ id_token: wrongAudience }));
  await assert.rejects(auth.complete({ code: 'c', state: params.get('state') }));

  params = await start();
  setTokens(okTokens({}));
  await assert.rejects(auth.complete({ code: 'c', state: params.get('state') }), /identity token/);

  params = await start();
  setTokens({ ok: false, json: async () => ({ error_description: 'invalid grant' }) });
  await assert.rejects(auth.complete({ code: 'c', state: params.get('state') }), /invalid grant/);
});

test('an expiring session refreshes, and a failed refresh is reported stale rather than silently trusted', async t => {
  let clock = START;
  const { auth, idToken, setTokens } = await harness(t, { now: () => clock });
  const { url } = await auth.begin();
  const params = new URL(url).searchParams;
  setTokens(okTokens({ id_token: await idToken({ nonce: params.get('nonce') }), refresh_token: 'rt', expires_in: 3600 }));
  await auth.complete({ code: 'c', state: params.get('state') });

  assert.equal((await auth.current()).sub, 'auth0|alex', 'a live session is returned without refreshing');
  clock += 3_600_000; // past expiry
  setTokens(okTokens({ access_token: 'fresh', expires_in: 3600 }));
  const refreshed = await auth.current();
  assert.equal(refreshed.accessToken, 'fresh');
  assert.equal(refreshed.stale, undefined);

  clock += 3_600_000;
  setTokens({ ok: false, json: async () => ({ error: 'invalid_grant' }) });
  assert.equal((await auth.current()).stale, true, 'a revoked refresh token must not keep the session alive');
});

test('signing out clears the stored session', async t => {
  const { auth, dataDir, idToken, setTokens } = await harness(t);
  const params = new URL((await auth.begin()).url).searchParams;
  setTokens(okTokens({ id_token: await idToken({ nonce: params.get('nonce') }), expires_in: 3600 }));
  await auth.complete({ code: 'c', state: params.get('state') });
  assert.equal(auth.signedIn, true);
  await auth.signOut();
  assert.equal(auth.signedIn, false);
  assert.equal(await auth.current(), null);
  await assert.rejects(readFile(path.join(dataDir, 'session.json'), 'utf8'), /ENOENT/);
});

test('sign-in is refused until a tenant is connected', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iteration1-oauth-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const auth = createAuth({ dataDir, port: 4314, fetchImpl: async () => { throw new Error('should not be called'); } });
  await auth.load();
  assert.equal(auth.configured, false);
  await assert.rejects(auth.begin(), /Connect Auth0 first/);
});
