import { useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { X } from 'lucide-react';
import { api } from '../../convex/_generated/api';

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');

/** Saving, replacing or removing the person's own Anthropic API key, which their agents run on. */
export function KeyForm({ compact = false }: { compact?: boolean }) {
  const status = useQuery(api.keyStore.status, {});
  const save = useAction(api.keys.save);
  const remove = useMutation(api.keyStore.remove);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  if (!status) return null;
  if (!status.signedIn) return <p className="web-note">Sign in to add a key.</p>;
  if (status.hasKey && !editing) return <div className="key-saved">
    <p>Your agents use your key ending in <b>{status.last4}</b>.</p>
    <div className="key-actions"><button className="text-button" onClick={() => setEditing(true)}>Replace</button><button className="text-button danger" onClick={() => void remove({})}>Remove</button></div>
  </div>;
  return <form className="key-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await save({ key }); setKey(''); setEditing(false); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }}>
    {!compact && <p>Agents run on your own Anthropic API key. It's checked with Anthropic, stored encrypted, and only used for agents you start.</p>}
    <label>Anthropic API key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-ant-…" required /></label>
    <button className="primary" disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'Save key'}</button>
    <a className="text-link" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Get a key from the Anthropic Console</a>
    {error && <p className="web-error" role="alert">{error}</p>}
  </form>;
}

export function KeyPanel({ onClose }: { onClose: () => void }) {
  return <aside className="web-panel key-panel" aria-label="Anthropic key">
    <header><h2>Anthropic key</h2><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
    <KeyForm />
  </aside>;
}
