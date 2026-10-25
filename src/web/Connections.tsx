import { useRef, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { Check, Copy, ExternalLink, LoaderCircle, X } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import '../integrations.css';

// The same three providers, in the same order and with the same names, as the local office's Connections.
export type Provider = 'codex' | 'claude' | 'cursor';
export const providers: Provider[] = ['codex', 'claude', 'cursor'];
export const providerNames: Record<Provider, string> = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor' };

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');

// How each provider signs in, worded like the local office's Connections.
const signIn: Record<Provider, { button: string; account: string; plan: string }> = {
  codex: { button: 'Sign in with ChatGPT', account: 'ChatGPT', plan: 'Codex agents use your ChatGPT plan.' },
  claude: { button: 'Sign in with Claude', account: 'Claude', plan: 'Claude agents use your Claude plan.' },
  cursor: { button: 'Sign in with Cursor', account: 'Cursor', plan: 'Cursor agents use your Cursor account.' },
};

const keyGuides: Record<Provider, { label: string; placeholder: string; link: string; linkText: string; extra?: string }> = {
  codex: { label: 'OpenAI API key', placeholder: 'sk-…', link: 'https://platform.openai.com/api-keys', linkText: 'Get a key from OpenAI' },
  claude: {
    label: 'API key or subscription token', placeholder: 'sk-ant-…', link: 'https://console.anthropic.com/settings/keys', linkText: 'Get an API key from Anthropic',
    extra: 'A token from running claude setup-token in a terminal works too.',
  },
  cursor: { label: 'Cursor API key', placeholder: 'key_…', link: 'https://cursor.com/dashboard?tab=integrations', linkText: 'Get a key from your Cursor dashboard' },
};

export const useConnections = () => useQuery(api.keyStore.status, {});
const useLogins = () => useQuery(api.logins.current, {});

function KeyForm({ provider, onSaved }: { provider: Provider; onSaved: () => void }) {
  const save = useAction(api.keys.save);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guide = keyGuides[provider];
  return <form className="key-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await save({ provider, key }); setKey(''); onSaved(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }}>
    <label>{guide.label}<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={guide.placeholder} required /></label>
    <button className="secondary" disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'Save key'}</button>
    <a className="text-link" href={guide.link} target="_blank" rel="noreferrer">{guide.linkText}</a>
    {guide.extra && <p className="web-note">{guide.extra}</p>}
    {error && <p className="web-error" role="alert">{error}</p>}
  </form>;
}

/** A sign-in that's under way: Codex's code to enter, Claude's code to paste, or Cursor finishing on its site. */
function PendingLogin({ provider, login }: { provider: Provider; login: NonNullable<ReturnType<typeof useLogins>>[number] }) {
  const cancel = useMutation(api.logins.cancel);
  const complete = useAction(api.logins.completeClaude);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const cancelButton = <button type="button" className="text-button" onClick={() => void cancel({ provider })}>Cancel sign-in</button>;
  if (login.status === 'preparing') return <div className="web-login"><p><LoaderCircle className="spin" size={14} /> Preparing Codex sign-in. This takes about half a minute.</p>{cancelButton}</div>;
  if (provider === 'codex' && login.url && login.code) return <div className="web-login">
    <ol>
      <li>Open <a href={login.url} target="_blank" rel="noreferrer">{login.url.replace(/^https:\/\//, '')} <ExternalLink size={12} /></a> and sign in to ChatGPT.</li>
      <li>Enter this code:
        <span className="web-device-code"><b>{login.code}</b><button type="button" className="icon-button" aria-label="Copy code" onClick={() => void navigator.clipboard.writeText(login.code!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></span>
      </li>
    </ol>
    <p className="web-note"><LoaderCircle className="spin" size={12} /> This finishes by itself once you've entered the code. It expires in 15 minutes.</p>
    {cancelButton}
  </div>;
  if (provider === 'claude') return <form className="web-login" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await complete({ input: code }); setCode(''); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }}>
    <p>Authorize in the Claude tab, then paste the code it shows here.</p>
    <label>Authorization code<input value={code} onChange={e => setCode(e.target.value)} placeholder="Paste the code, including the part after #" autoComplete="off" required /></label>
    <button className="primary" disabled={busy || !code.trim()}>{busy ? 'Signing in…' : 'Complete sign-in'}</button>
    {login.url && <a className="text-link" href={login.url} target="_blank" rel="noreferrer">Open the Claude sign-in page again</a>}
    {error && <p className="web-error" role="alert">{error}</p>}
    {cancelButton}
  </form>;
  return <div className="web-login">
    <p><LoaderCircle className="spin" size={14} /> Finish signing in on Cursor's site. This connects by itself when you're done.</p>
    {login.url && <a className="text-link" href={login.url} target="_blank" rel="noreferrer">Open the Cursor sign-in page again</a>}
    {cancelButton}
  </div>;
}

function ProviderPanel({ provider }: { provider: Provider }) {
  const status = useConnections();
  const logins = useLogins();
  const start = useAction(api.logins.start);
  const remove = useMutation(api.keyStore.remove);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');
  const current = status?.providers[provider];
  const login = logins?.find(item => item.provider === provider);
  if (!status) return null;
  if (!status.signedIn) return <p className="web-note">Sign in to connect an account.</p>;

  async function begin() {
    setError('');
    // Opened during the click so the browser doesn't block it; Codex shows a code here instead.
    const tab = provider === 'codex' ? null : window.open('', '_blank');
    try {
      const { url } = await start({ provider });
      if (tab && url) { tab.opener = null; tab.location.href = url; } else tab?.close();
      setReplacing(false);
    } catch (e) { tab?.close(); setError(message(e)); }
  }

  if (login && (login.status === 'preparing' || login.status === 'waiting')) return <PendingLogin provider={provider} login={login} />;
  if (current?.connected && !replacing) {
    const how = current.method === 'apiKey'
      ? (current.subscription ? `your Claude token ending in ${current.last4}` : `your key ending in ${current.last4}`)
      : `${signIn[provider].account}${current.email ? ` as ${current.email}` : ''}`;
    return <div className="key-saved">
      <p>Connected with {how}. Your {providerNames[provider]} agents use it; nobody else's do.</p>
      {current.expiresAt && <p className="web-note">Renews on sign-in. Current access lasts until {new Date(current.expiresAt).toLocaleDateString()}.</p>}
      <div className="key-actions"><button className="text-button" onClick={() => setReplacing(true)}>Change</button><button className="text-button danger" onClick={() => void remove({ provider })}>Disconnect {providerNames[provider]}</button></div>
    </div>;
  }
  return <div className="web-connect">
    {current && !current.connected && current.method && <p className="web-error">Your {providerNames[provider]} sign-in expired. Sign in again.</p>}
    <p>{signIn[provider].plan}</p>
    <button className="primary" onClick={() => void begin()}>{signIn[provider].button}</button>
    {login?.status === 'error' && <p className="web-error" role="alert">{login.detail || 'Sign-in failed. Try again.'}</p>}
    {error && <p className="web-error" role="alert">{error}</p>}
    <details className="compact-disclosure"><summary>Use an API key instead</summary><KeyForm provider={provider} onSaved={() => setReplacing(false)} /></details>
    {replacing && <button className="text-button" onClick={() => setReplacing(false)}>Keep the current connection</button>}
  </div>;
}

/** Codex, Claude and Cursor, as tabs, like the local office's Connections panel. */
export function ConnectionTabs({ initial = 'codex' }: { initial?: Provider }) {
  const status = useConnections();
  const logins = useLogins();
  const [selected, setSelected] = useState<Provider>(initial);
  const tabs = useRef<Partial<Record<Provider, HTMLButtonElement | null>>>({});
  const label = (provider: Provider) => {
    const pending = logins?.find(item => item.provider === provider && (item.status === 'preparing' || item.status === 'waiting'));
    return pending ? 'Signing in…' : status?.providers[provider].connected ? 'Connected' : 'Not connected';
  };
  return <>
    <div className="provider-tabs" role="tablist" aria-label="Provider accounts">
      {providers.map(provider => <button key={provider} ref={element => { tabs.current[provider] = element; }} type="button" role="tab" aria-selected={selected === provider} tabIndex={selected === provider ? 0 : -1} onClick={() => setSelected(provider)} onKeyDown={event => {
        const index = providers.indexOf(provider);
        const next = event.key === 'ArrowRight' ? providers[(index + 1) % providers.length] : event.key === 'ArrowLeft' ? providers[(index + providers.length - 1) % providers.length] : undefined;
        if (next) { event.preventDefault(); setSelected(next); tabs.current[next]?.focus(); }
      }}><span>{providerNames[provider]}</span><small>{label(provider)}</small></button>)}
    </div>
    <section className="provider-content" role="tabpanel"><ProviderPanel key={selected} provider={selected} /></section>
  </>;
}

export function ConnectionsPanel({ onClose }: { onClose: () => void }) {
  return <aside className="web-panel connections-web" aria-label="Connections">
    <header><h2>Connections</h2><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
    <p className="connections-intro">Manage the accounts used by your agents.</p>
    <ConnectionTabs />
  </aside>;
}
