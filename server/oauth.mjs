import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

// Authorization Code with PKCE against Auth0. The office is a public client: there is no
// client secret on this machine, the verifier never leaves it, and the browser redirect
// lands on loopback. The OIDC `sub` becomes the credentialSub every run is attributed to.
const SCOPE = 'openid profile email offline_access';
const base64url = buffer => buffer.toString('base64url');
const challengeFor = verifier => base64url(createHash('sha256').update(verifier).digest());

export const providerFields = z.object({
  domain: z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, 'Use the Auth0 domain only, without https:// or a path.'),
  clientId: z.string().trim().min(8).max(100),
  audience: z.string().trim().max(200).optional()
}).strict();

/** Domain and client id are public for a PKCE client; only tokens are secret. */
export function createAuth({ dataDir, port, fetchImpl = fetch, createJwks = createRemoteJWKSet, now = () => Date.now() }) {
  const configFile = path.join(dataDir, 'auth0.json');
  const sessionFile = path.join(dataDir, 'session.json');
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const pending = new Map();
  let provider = null, session = null, metadata = null, jwks = null;

  async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
  // Written 0600 and replaced atomically: refresh tokens are long-lived credentials.
  async function writeJson(file, value) { await writeFile(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(file + '.tmp', file); }

  async function load() {
    provider = fromEnv() || await readJson(configFile);
    session = await readJson(sessionFile);
    return { provider, session };
  }
  function fromEnv() {
    const domain = process.env.ITERATION1_AUTH0_DOMAIN, clientId = process.env.ITERATION1_AUTH0_CLIENT_ID;
    return domain && clientId ? providerFields.parse({ domain, clientId, ...(process.env.ITERATION1_AUTH0_AUDIENCE ? { audience: process.env.ITERATION1_AUTH0_AUDIENCE } : {}) }) : null;
  }
  async function configure(body) {
    if (fromEnv()) throw new Error('Auth0 is configured by environment variables. Change those instead.');
    provider = providerFields.parse(body);
    await writeJson(configFile, provider);
    metadata = null; jwks = null;
    return provider;
  }
  function requireProvider() {
    if (!provider) throw new Error('Connect Auth0 first: add the tenant domain and client id in the Cursor panel.');
    return provider;
  }
  async function discover() {
    const { domain } = requireProvider();
    if (metadata) return metadata;
    const res = await fetchImpl(`https://${domain}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Auth0 discovery failed (${res.status}). Check the tenant domain.`);
    metadata = await res.json();
    jwks = createJwks(new URL(metadata.jwks_uri));
    return metadata;
  }

  async function begin() {
    const { clientId, audience } = requireProvider();
    const { authorization_endpoint } = await discover();
    const verifier = base64url(randomBytes(32)), state = base64url(randomBytes(32)), nonce = base64url(randomBytes(16));
    pending.set(state, { verifier, nonce, createdAt: now() });
    for (const [key, entry] of pending) if (now() - entry.createdAt > 10 * 60 * 1000) pending.delete(key);
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPE, state, nonce,
      code_challenge: challengeFor(verifier), code_challenge_method: 'S256', ...(audience ? { audience } : {}) }).toString();
    return { url: url.href };
  }

  // `state` is the CSRF defence for the callback, which cannot be cookie-gated: the
  // redirect arrives from auth0.com and a sameSite=strict cookie would not be sent.
  function consume(state) {
    const expected = typeof state === 'string' ? state : '';
    for (const [key, entry] of pending) {
      const a = Buffer.from(key), b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) { pending.delete(key); return entry; }
    }
    throw new Error('That sign-in link is no longer valid. Start the sign-in again from the office.');
  }

  async function complete({ code, state }) {
    const { verifier, nonce } = consume(state);
    const { clientId } = requireProvider();
    const { token_endpoint } = await discover();
    if (typeof code !== 'string' || !code) throw new Error('Auth0 did not return an authorization code.');
    const tokens = await exchange(token_endpoint, { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier });
    const claims = await verifyIdToken(tokens.id_token, nonce);
    session = {
      sub: claims.sub, name: claims.name || claims.nickname || claims.email || claims.sub, email: claims.email || '', picture: claims.picture || '',
      refreshToken: tokens.refresh_token || null, accessToken: tokens.access_token || null,
      expiresAt: tokens.expires_in ? now() + tokens.expires_in * 1000 : null, signedInAt: now()
    };
    await writeJson(sessionFile, session);
    return session;
  }

  async function exchange(endpoint, body) {
    const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(15000) });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Auth0 rejected the sign-in: ${payload.error_description || payload.error || res.status}`);
    return payload;
  }

  async function verifyIdToken(idToken, nonce) {
    if (!idToken) throw new Error('Auth0 did not return an identity token.');
    const { domain, clientId } = requireProvider();
    await discover();
    // Pinning RS256 keeps an attacker from downgrading the algorithm to one we would verify with the public key.
    const { payload } = await jwtVerify(idToken, jwks, { issuer: metadata.issuer || `https://${domain}/`, audience: clientId, algorithms: ['RS256'], clockTolerance: 60 });
    if (nonce && payload.nonce !== nonce) throw new Error('The sign-in response did not match this request. Try signing in again.');
    return payload;
  }

  /** Refresh shortly before expiry so a long Cursor run does not lose its identity mid-turn. */
  async function current() {
    if (!session) return null;
    if (!session.expiresAt || session.expiresAt - now() > 60000 || !session.refreshToken) return session;
    try {
      const { token_endpoint } = await discover();
      const { clientId } = requireProvider();
      const tokens = await exchange(token_endpoint, { grant_type: 'refresh_token', client_id: clientId, refresh_token: session.refreshToken });
      session = { ...session, accessToken: tokens.access_token || session.accessToken, refreshToken: tokens.refresh_token || session.refreshToken, expiresAt: tokens.expires_in ? now() + tokens.expires_in * 1000 : null };
      await writeJson(sessionFile, session);
    } catch { session = { ...session, stale: true }; }
    return session;
  }

  async function signOut() {
    session = null; pending.clear();
    await rm(sessionFile, { force: true });
  }

  /** Never includes tokens: this is what the browser and the MCP server are allowed to see. */
  const publicSession = value => value && { sub: value.sub, name: value.name, email: value.email, picture: value.picture, signedInAt: value.signedInAt, stale: !!value.stale };
  const publicProvider = () => provider && { domain: provider.domain, clientId: provider.clientId, fromEnv: !!fromEnv() };

  return { load, configure, begin, complete, current, signOut, publicSession, publicProvider, redirectUri,
    get configured() { return !!provider; }, get signedIn() { return !!session; } };
}
