import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOGIN_TTL = 15 * 60 * 1000;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Parse data, never a URL to fetch. The expected redirect and state belong to the server. */
export function parseCallback(input, { redirectUri, state, allowCodePair = false }) {
  if (typeof input !== 'string' || !input.trim() || input.length > 8192) throw new Error('Paste the complete callback URL from this sign-in.');
  const text = input.trim();
  let code, returnedState;
  if (allowCodePair && !text.includes('://') && text.split('#').length === 2) {
    [code, returnedState] = text.split('#');
  } else {
    let url;
    try { url = new URL(text); } catch { throw new Error('Paste the complete callback URL from this sign-in.'); }
    const expected = new URL(redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw new Error('That callback address does not match this sign-in.');
    if (url.searchParams.has('error')) throw new Error('Authorization was declined. Start sign-in again.');
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) throw new Error('The callback must contain one authorization code and state.');
    code = url.searchParams.get('code'); returnedState = url.searchParams.get('state');
  }
  if (!code || code.length > 4096 || /[\s\x00-\x1f]/.test(code)) throw new Error('The callback is missing a valid authorization code.');
  if (!state || !same(state, returnedState)) throw new Error('This callback belongs to a different sign-in. Open the current sign-in link and try again.');
  return { code, state: returnedState };
}

export async function savePrivateJson(file, data) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = path.join(dir, `.login-${randomBytes(16).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Codex owns the token exchange, profile and all refreshes. Only relay to its saved loopback callback. */
export function createCodexCallback({ fetchImpl = fetch, now = Date.now } = {}) {
  let pending = null;
  return {
    isCompleting: () => !!pending?.busy,
    begin(authUrl) {
      if (pending?.busy) throw new Error('Wait for the current callback to finish.');
      pending = null;
      const url = new URL(authUrl);
      const uri = url.searchParams.get('redirect_uri'), state = url.searchParams.get('state');
      if (!uri || !state) return null; // Older runtimes can still finish automatically.
      const redirect = new URL(uri);
      if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/auth/callback') throw new Error('Codex returned an unsupported callback address.');
      pending = { redirectUri: uri, state, expiresAt: now() + LOGIN_TTL, busy: false };
      return { expiresAt: pending.expiresAt };
    },
    cancel() { pending = null; },
    async complete(input) {
      const attempt = pending;
      if (!attempt || attempt.expiresAt <= now()) { pending = null; throw new Error('Sign-in expired. Start a new sign-in.'); }
      if (attempt.busy) throw new Error('This callback is already being completed.');
      const { code, state } = parseCallback(input, attempt);
      const target = new URL(attempt.redirectUri);
      target.searchParams.set('code', code); target.searchParams.set('state', state);
      attempt.busy = true;
      try {
        // Never follow redirects or fetch the address supplied by the browser.
        const response = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        const location = response.headers.get('location');
        const successRedirect = response.status === 302 && location && new URL(location, target).origin === target.origin && new URL(location, target).pathname === '/success';
        if (!response.ok && !successRedirect) throw new Error('Codex did not accept this callback. Start sign-in again.');
      } catch { throw new Error('Codex could not complete this callback. Start sign-in again.'); }
      finally { if (pending === attempt) pending = null; }
      return { completed: true };
    }
  };
}

// Public native-client identifier. No client secret is embedded or required for PKCE.
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_REDIRECT = 'https://platform.claude.com/oauth/code/callback';

/** A fresh Claude Code grant in an app-owned profile. The unmodified Claude runtime owns refresh. */
export function createClaudeLogin({ configDir, fetchImpl = fetch, now = Date.now, clientId = process.env.ITERATION1_CLAUDE_CLIENT_ID || CLAUDE_CLIENT_ID } = {}) {
  const file = path.join(configDir, '.credentials.json');
  let pending = null, configured = false, error = null;
  async function load() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8')).claudeAiOauth;
      configured = typeof data?.accessToken === 'string' && !!data.accessToken && typeof data?.refreshToken === 'string' && !!data.refreshToken && Number.isFinite(data?.expiresAt);
    } catch { configured = false; }
    return status();
  }
  function status() {
    if (pending && pending.expiresAt <= now() && !pending.busy) { pending = null; error = 'Sign-in expired. Start a new sign-in.'; }
    return { configured, login: pending ? { url: pending.url, expiresAt: pending.expiresAt } : null, error };
  }
  return {
    configDir, load, status, isCompleting: () => !!pending?.busy,
    begin() {
      if (pending?.busy) throw new Error('Wait for the current sign-in to finish.');
      error = null;
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      const url = new URL('https://claude.ai/oauth/authorize');
      url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: CLAUDE_REDIRECT, scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, code: 'true' }).toString();
      pending = { url: url.href, verifier, state, redirectUri: CLAUDE_REDIRECT, expiresAt: now() + LOGIN_TTL, busy: false };
      return status();
    },
    cancel() { if (pending?.busy) throw new Error('Wait for sign-in to finish.'); pending = null; error = null; return status(); },
    async complete(input) {
      const attempt = pending;
      if (!attempt || attempt.expiresAt <= now()) { pending = null; throw new Error('Sign-in expired. Start a new sign-in.'); }
      if (attempt.busy) throw new Error('This callback is already being completed.');
      const { code, state } = parseCallback(input, { ...attempt, allowCodePair: true });
      attempt.busy = true;
      try {
        const response = await fetchImpl('https://api.anthropic.com/v1/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: clientId, code, state, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri }), redirect: 'error', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('Authorization was not accepted.');
        const data = await response.json();
        if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Incomplete token response.');
        // Native format lets Claude Code rotate its tokens in place. We never refresh a second copy.
        await savePrivateJson(file, { claudeAiOauth: { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: now() + data.expires_in * 1000, scopes: typeof data.scope === 'string' ? data.scope.split(' ') : ['user:inference'] } });
        configured = true; error = null;
      } catch { throw new Error('Claude could not complete sign-in. Start a new sign-in and paste the new code.'); }
      finally { if (pending === attempt) pending = null; }
      return status();
    },
    async disconnect() {
      if (pending?.busy) throw new Error('Wait for sign-in to finish.');
      pending = null;
      await rm(file, { force: true }); configured = false; error = null;
      return status();
    }
  };
}

/** Cursor's SDK mints an expiring app key and discards the broad login tokens. */
export function createCursorLogin({ file, importSdk = () => import('@cursor/sdk'), now = Date.now, changed = () => {}, env = () => process.env.CURSOR_API_KEY } = {}) {
  let credentials = null, pending = null, error = null;
  let writes = Promise.resolve();
  function transaction(fn) { const result = writes.then(fn); writes = result.catch(() => {}); return result; }
  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      credentials = typeof saved.apiKey === 'string' && saved.apiKey && Number.isFinite(saved.apiKeyExpiresAtMs) ? { apiKey: saved.apiKey, apiKeyExpiresAtMs: saved.apiKeyExpiresAtMs, email: typeof saved.email === 'string' ? saved.email : null } : null;
    }
    catch { credentials = null; }
    return status();
  }
  const current = () => env() || (credentials && credentials.apiKeyExpiresAtMs > now() ? credentials.apiKey : '') || '';
  function status() {
    return { configured: !!current(), source: env() ? 'environment' : current() ? 'browser' : null, email: credentials?.email || null, expiresAt: credentials?.apiKeyExpiresAtMs || null, login: pending?.url ? { url: pending.url, expiresAt: pending.expiresAt } : null, error };
  }
  function cancel() { if (pending) { pending.controller.abort(); clearTimeout(pending.timer); pending = null; } }
  return {
    load, status, current,
    async begin() {
      cancel(); error = null;
      const controller = new AbortController();
      const attempt = { controller, expiresAt: now() + LOGIN_TTL, url: null, timer: null };
      pending = attempt;
      attempt.timer = setTimeout(() => { if (pending === attempt) { cancel(); error = 'Sign-in expired. Start a new sign-in.'; changed(); } }, LOGIN_TTL);
      attempt.timer.unref();
      try {
        const { Cursor } = await importSdk();
        if (pending !== attempt) throw new Error('Sign-in cancelled.');
        await new Promise((resolve, reject) => {
          const ready = setTimeout(() => reject(new Error('Cursor did not provide a sign-in link.')), 15000); ready.unref();
          const onAbort = () => { clearTimeout(ready); reject(new Error('Sign-in cancelled.')); };
          controller.signal.addEventListener('abort', onAbort, { once: true });
          void Promise.resolve().then(() => Cursor.auth.login({ store: null, openBrowser: false, apiKeyName: 'Iteration1', signal: controller.signal, onLoginUrl(url) {
            if (pending !== attempt) return;
            if (new URL(url).protocol !== 'https:') throw new Error('Invalid sign-in link.');
            attempt.url = url; clearTimeout(ready); resolve(); changed();
          } })).then(async result => {
            if (pending !== attempt || controller.signal.aborted) return;
            if (typeof result.apiKey !== 'string' || !result.apiKey || !Number.isFinite(result.apiKeyExpiresAtMs) || result.apiKeyExpiresAtMs <= now()) throw new Error('Incomplete login response.');
            const saved = { apiKey: result.apiKey, apiKeyExpiresAtMs: result.apiKeyExpiresAtMs, email: result.email || null };
            await transaction(async () => {
              if (pending !== attempt || controller.signal.aborted) return;
              await savePrivateJson(file, saved);
              if (pending === attempt && !controller.signal.aborted) { credentials = saved; error = null; }
            });
            resolve();
          }).catch(() => { if (pending === attempt && !controller.signal.aborted) error = 'Cursor could not complete sign-in. Start a new sign-in.'; reject(new Error('Cursor could not complete sign-in.')); }).finally(() => {
            clearTimeout(ready); clearTimeout(attempt.timer); controller.signal.removeEventListener('abort', onAbort);
            if (pending === attempt) pending = null;
            changed();
          });
        });
      } catch {
        if (pending === attempt) { cancel(); error = 'Cursor could not start sign-in. Try again.'; changed(); }
        throw new Error('Cursor could not start sign-in. Try again.');
      }
      return status();
    },
    cancel() { cancel(); changed(); return status(); },
    async disconnect() { cancel(); await transaction(async () => { await rm(file, { force: true }); credentials = null; }); error = null; changed(); return status(); }
  };
}
