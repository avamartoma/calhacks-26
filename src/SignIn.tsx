import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { localHour, paletteAt } from './sky/time-of-day';
import './sign-in.css';

const rgb = (color: number[]) => `rgb(${color.map(value => Math.round(value * 255)).join(',')})`;

async function post(route: string, body?: unknown) {
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'The request failed.');
  return payload;
}

/**
 * Shown before the sky until someone signs in with Auth0. Sign-in opens in a new tab, which
 * closes itself when it finishes; the office then sends the signed-in account over its event
 * stream and the sky opens. Without an Auth0 tenant yet, this asks for one, and the office can
 * be used signed out until then.
 */
export function SignIn({ ready, redirectUri, onSkip }: { ready: boolean; redirectUri: string; onSkip: () => void }) {
  const palette = paletteAt(localHour());
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [domain, setDomain] = useState('');
  const [clientId, setClientId] = useState('');
  useEffect(() => { if (!waiting) return; const timer = setTimeout(() => setWaiting(false), 120000); return () => clearTimeout(timer); }, [waiting]);

  async function signIn() {
    setError('');
    // Opened before the request so the browser treats it as part of the click and does not block it.
    const tab = window.open('', '_blank');
    try {
      const { url } = await post('/api/auth/login');
      if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
      setWaiting(true);
    } catch (e) { tab?.close(); setError((e as Error).message); }
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    setError('');
    try { await post('/api/auth/provider', { domain: domain.trim(), clientId: clientId.trim() }); }
    catch (e) { setError((e as Error).message); }
  }

  return <main className="sign-in" style={{ background: `linear-gradient(${rgb(palette.zenith)}, ${rgb(palette.horizon)})` }}>
    <section className="sign-in-card" aria-labelledby="sign-in-title">
      <span className="brand-mark">oc</span>
      <h1 id="sign-in-title">Sign in to opencloud</h1>
      {ready ? <>
        <button className="primary full" disabled={waiting} onClick={() => void signIn()}>
          {waiting ? <><LoaderCircle className="spin" size={16} /> Finish signing in in the new tab</> : 'Sign in'}
        </button>
        {waiting && <button className="text-button" onClick={() => void signIn()}>Open the sign-in page again</button>}
      </> : <form onSubmit={connect}>
        <p>Add your team’s Auth0 tenant to turn on sign-in. The domain and client id are public; nothing secret is stored.</p>
        <label>Tenant domain<input value={domain} onChange={e => setDomain(e.target.value)} placeholder="your-tenant.us.auth0.com" required /></label>
        <label>Client id<input value={clientId} onChange={e => setClientId(e.target.value)} required /></label>
        <button className="primary full" disabled={!domain.trim() || !clientId.trim()}>Turn on sign-in</button>
        <p className="sign-in-note">Allow this callback URL in the Auth0 application: <code>{redirectUri}</code></p>
        <button type="button" className="text-button" onClick={onSkip}>Continue without an account</button>
      </form>}
      {error && <p className="sign-in-error" role="alert">{error}</p>}
    </section>
  </main>;
}
