import { useState } from 'react';
import { ArrowRight, CheckCheck, ExternalLink, LoaderCircle, RotateCcw } from 'lucide-react';
import type { OfficeState } from './types';
import { CallbackForm } from './ProviderConnection';

async function post(route: string, body: unknown = {}) {
  const response = await fetch(`/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

export function CodexConnection({ connection, onContinue }: { connection: OfficeState['connection']; onContinue?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function perform(operation: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await operation(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update the connection.'); }
    finally { setBusy(false); }
  }
  const signIn = () => perform(async () => {
    const login = await post('/codex/sign-in');
    if (login.authUrl && !login.opened) window.open(login.authUrl, '_blank', 'noopener,noreferrer');
  });
  const step = connection.signIn?.step;
  return <>
    <h3 className="provider-title">Codex</h3>
    {connection.account ? <>
      <div className="account-info"><CheckCheck size={22} /><div><b>{connection.account.email || 'Codex account connected'}</b><small>{connection.account.planType || connection.account.type}</small></div></div>
      {onContinue && <button className="primary full" onClick={onContinue}><ArrowRight size={16} /> Return to project</button>}
      <button className="secondary full" disabled={busy} onClick={() => void perform(() => post('/connect'))}><RotateCcw size={14} /> Refresh connection</button>
      <button className="text-button" disabled={busy} onClick={() => void perform(() => post('/codex/disconnect'))}>Disconnect Codex from Iteration1</button>
    </> : step === 'installing' ? <p className="notice" role="status"><LoaderCircle size={16} className="spin" /> Installing the Codex runtime…</p>
      : step === 'browser' ? <>
        <p role="status">Finish signing in with ChatGPT. This panel updates automatically.</p>
        {connection.signIn?.authUrl && <a className="secondary full" href={connection.signIn.authUrl} target="_blank" rel="noreferrer">Open ChatGPT sign-in <ExternalLink size={16} /></a>}
        {connection.signIn?.manualCallback && <CallbackForm onComplete={callback => post('/codex/callback', { callback })} />}
        <button className="text-button" disabled={busy} onClick={() => void perform(() => post('/codex/cancel'))}>Cancel sign-in</button>
        <button className="text-button" disabled={busy} onClick={() => void signIn()}>Start sign-in again</button>
      </> : <>
        <p>Sign in with ChatGPT to run Codex agents in this office.</p>
        <button className="primary full" disabled={busy} onClick={() => void signIn()}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? 'Starting sign-in…' : 'Sign in with ChatGPT'}</button>
        <p className="muted small">Iteration1 uses a separate profile. Your Codex desktop and CLI logins stay in their own profiles.</p>
      </>}
    {connection.account && connection.sandboxStatus && connection.sandboxStatus !== 'ready' && <div className="notice"><b>Enable project editing</b><p>Set up the Windows sandbox. Windows may ask for administrator approval.</p><button className="secondary full" disabled={busy || connection.sandboxSetupPending} onClick={() => void perform(() => post('/sandbox/setup'))}>{connection.sandboxSetupPending ? 'Setting up sandbox…' : 'Set up Windows sandbox'}</button></div>}
    {(error || connection.error) && <p className="notice error" role="alert">{error || connection.error}</p>}
  </>;
}
