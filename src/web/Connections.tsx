import { useRef, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { X } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import '../integrations.css';

// The same three providers, in the same order and with the same names, as the local office's Connections.
export type Provider = 'codex' | 'claude' | 'cursor';
export const providers: Provider[] = ['codex', 'claude', 'cursor'];
export const providerNames: Record<Provider, string> = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor' };

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');

const guides: Record<Provider, { intro: string; label: string; placeholder: string; link: string; linkText: string; extra?: string }> = {
  codex: {
    intro: 'Codex agents run on your OpenAI API key.',
    label: 'OpenAI API key', placeholder: 'sk-…',
    link: 'https://platform.openai.com/api-keys', linkText: 'Get a key from OpenAI',
    extra: 'Signing in with a ChatGPT account works in the local office only.',
  },
  claude: {
    intro: 'Claude agents run on your Anthropic API key, or on your Claude Pro or Max plan.',
    label: 'API key or subscription token', placeholder: 'sk-ant-…',
    link: 'https://console.anthropic.com/settings/keys', linkText: 'Get an API key from Anthropic',
    extra: 'On a Claude plan instead? Run claude setup-token in a terminal and paste the token it prints.',
  },
  cursor: {
    intro: 'Cursor agents run on your Cursor API key.',
    label: 'Cursor API key', placeholder: 'key_…',
    link: 'https://cursor.com/dashboard?tab=integrations', linkText: 'Get a key from your Cursor dashboard',
  },
};

export const useConnections = () => useQuery(api.keyStore.status, {});

function ProviderForm({ provider }: { provider: Provider }) {
  const status = useConnections();
  const save = useAction(api.keys.save);
  const remove = useMutation(api.keyStore.remove);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);
  const guide = guides[provider];
  const current = status?.providers[provider];
  if (!status) return null;
  if (!status.signedIn) return <p className="web-note">Sign in to connect an account.</p>;
  if (current?.connected && !replacing) return <div className="key-saved">
    <p>Connected with {current.subscription ? 'your Claude plan' : 'your key'} ending in <b>{current.last4}</b>. Your {providerNames[provider]} agents use it; nobody else's do.</p>
    <div className="key-actions"><button className="text-button" onClick={() => setReplacing(true)}>Replace</button><button className="text-button danger" onClick={() => void remove({ provider })}>Disconnect {providerNames[provider]}</button></div>
  </div>;
  return <form className="key-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await save({ provider, key }); setKey(''); setReplacing(false); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }}>
    <p>{guide.intro} It's stored encrypted and only used for agents you start.</p>
    <label>{guide.label}<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={guide.placeholder} required /></label>
    <button className="primary" disabled={busy || !key.trim()}>{busy ? 'Checking…' : `Connect ${providerNames[provider]}`}</button>
    <a className="text-link" href={guide.link} target="_blank" rel="noreferrer">{guide.linkText}</a>
    {guide.extra && <p className="web-note">{guide.extra}</p>}
    {error && <p className="web-error" role="alert">{error}</p>}
  </form>;
}

/** Codex, Claude and Cursor, as tabs, like the local office's Connections panel. */
export function ConnectionTabs({ initial = 'codex' }: { initial?: Provider }) {
  const status = useConnections();
  const [selected, setSelected] = useState<Provider>(initial);
  const tabs = useRef<Partial<Record<Provider, HTMLButtonElement | null>>>({});
  return <>
    <div className="provider-tabs" role="tablist" aria-label="Provider accounts">
      {providers.map(provider => <button key={provider} ref={element => { tabs.current[provider] = element; }} type="button" role="tab" aria-selected={selected === provider} tabIndex={selected === provider ? 0 : -1} onClick={() => setSelected(provider)} onKeyDown={event => {
        const index = providers.indexOf(provider);
        const next = event.key === 'ArrowRight' ? providers[(index + 1) % providers.length] : event.key === 'ArrowLeft' ? providers[(index + providers.length - 1) % providers.length] : undefined;
        if (next) { event.preventDefault(); setSelected(next); tabs.current[next]?.focus(); }
      }}><span>{providerNames[provider]}</span><small>{status?.providers[provider].connected ? 'Connected' : 'Not connected'}</small></button>)}
    </div>
    <section className="provider-content" role="tabpanel"><ProviderForm key={selected} provider={selected} /></section>
  </>;
}

export function ConnectionsPanel({ onClose }: { onClose: () => void }) {
  return <aside className="web-panel connections-web" aria-label="Connections">
    <header><h2>Connections</h2><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
    <p className="connections-intro">Manage the accounts used by your agents.</p>
    <ConnectionTabs />
  </aside>;
}
