import { useEffect, useRef, useState } from 'react';
import { CheckCheck, ExternalLink, LoaderCircle } from 'lucide-react';

interface Connection {
  configured: boolean;
  source?: string | null;
  email?: string | null;
  expiresAt?: number | null;
  login?: { url: string; expiresAt: number } | null;
  error?: string | null;
}

export function CallbackForm({ onComplete, label = 'Callback URL', hint = 'Copy the complete localhost URL from the address bar, even if the browser says it could not connect.' }: { onComplete: (callback: string) => Promise<unknown>; label?: string; hint?: string }) {
  const [callback, setCallback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hintId = `callback-${label.replaceAll(' ', '-').toLowerCase()}-hint`;
  return <form className="provider-callback" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('');
    void onComplete(callback.trim()).then(() => setCallback('')).catch(e => setError(e instanceof Error ? e.message : 'Could not complete sign-in. Try again.')).finally(() => setBusy(false));
  }}>
    <label>{label}<input type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={callback} disabled={busy} onChange={event => setCallback(event.target.value)} aria-describedby={hintId} required /></label>
    <p id={hintId} className="muted small">{hint}</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    <button className="primary full" disabled={busy || !callback.trim()}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? 'Completing sign-in…' : 'Complete sign-in'}</button>
  </form>;
}

/** Only login links and public status enter React state. Credentials stay on the server. */
export function ProviderConnection({ provider, onChange }: { provider: 'claude' | 'cursor'; onChange?: () => void }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const revision = useRef(0);
  const [pollEpoch, setPollEpoch] = useState(0);
  const changeHandler = useRef(onChange); changeHandler.current = onChange;
  const title = provider === 'claude' ? 'Claude' : 'Cursor';
  const base = `/api/providers/${provider}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(base, { signal: controller.signal, cache: 'no-store' }).then(async res => {
      if (!res.ok) throw new Error();
      const status: Connection = await res.json(); if (!controller.signal.aborted) setConnection(status);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load the connection. Reopen this panel to retry.'); });
    return () => { revision.current++; controller.abort(); };
  }, [base]);
  useEffect(() => {
    if (!connection?.login) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const version = revision.current;
    async function poll() {
      try {
        const response = await fetch(base, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        const status: Connection = await response.json();
        if (!controller.signal.aborted && revision.current === version) {
          setError('');
          setConnection(status);
          if (!status.login) {
            if (status.error) setError(status.error);
            else if (status.configured) { setNotice(`${title} connected.`); changeHandler.current?.(); }
            else setError('Sign-in expired. Start a new sign-in.');
          }
        }
      } catch { if (!controller.signal.aborted && revision.current === version) setError('Connection interrupted. Trying again…'); }
      if (!controller.signal.aborted && revision.current === version) timer = setTimeout(() => void poll(), 2000);
    }
    timer = setTimeout(() => void poll(), 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, connection?.login?.url, title, pollEpoch]);
  async function mutate(action: string, body: unknown = {}) {
    revision.current++;
    setPollEpoch(value => value + 1);
    const response = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The request failed.');
    setConnection(data); changeHandler.current?.();
    return data as Connection;
  }
  async function perform(action: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const status = await mutate(action);
      if (action === 'login' && status.login?.url) window.open(status.login.url, '_blank', 'noopener,noreferrer');
      if (action === 'disconnect') setNotice('Saved credentials removed from this app.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update the connection.'); }
    finally { setBusy(false); }
  }
  return <section className="provider-connection" aria-label={`${title} account connection`}>
    {error && <p className="notice error" role="alert">{error}</p>}
    {(connection?.error && connection.error !== error) && <p className="notice error" role="alert">{connection.error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {connection?.configured && <p className="account-info"><CheckCheck size={20} /><span><b>{connection.email || `${title} account connected`}</b>{connection.source === 'environment' && <small>Using CURSOR_API_KEY</small>}</span></p>}
    {connection?.login ? <>
      <p>Finish signing in on {title}’s website.</p>
      <a className="secondary full" href={connection.login.url} target="_blank" rel="noreferrer">Open {title} sign-in <ExternalLink size={16} /></a>
      {provider === 'claude'
        ? <CallbackForm label="Claude authorization code or callback URL" hint="After authorizing, paste the code including #state, or the complete callback URL. It is used once." onComplete={callback => mutate('complete', { callback }).then(() => { setNotice('Claude connected.'); })} />
        : <p className="muted small" role="status">Waiting for Cursor. This page updates automatically.</p>}
      <button className="text-button" disabled={busy} onClick={() => void perform('cancel')}>Cancel sign-in</button>
    </> : <>
      {!connection?.configured && <p>Sign in through your browser. No existing {title === 'Claude' ? 'Claude Code' : 'Cursor'} installation or login is needed on your computer.</p>}
      <button className={connection?.configured ? 'secondary full' : 'primary full'} disabled={busy || !connection} onClick={() => void perform('login')}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? 'Starting sign-in…' : connection?.configured ? `Reconnect ${title}` : `Sign in with ${title}`}</button>
      {connection?.configured && connection.source !== 'environment' && <button className="text-button" disabled={busy} onClick={() => void perform('disconnect')}>Disconnect {title} from Iteration1</button>}
    </>}
    <p className="muted small">{provider === 'cursor' ? 'Creates a dedicated API key for Iteration1. Usage is billed to your Cursor account. Keys expire and can be revoked in Cursor settings.' : 'Creates a separate Claude Code profile for Iteration1. Claude Code keeps its credentials refreshed. Usage follows your Claude account’s limits and billing.'}</p>
  </section>;
}
