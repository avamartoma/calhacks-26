import { useEffect, useRef, useState } from 'react';
import { CheckCheck, ExternalLink, KeyRound, LoaderCircle, Play } from 'lucide-react';
import type { Room } from './types';

export interface ClaudeIntegration { configured: boolean; source: 'environment' | 'saved' | null; hint: string | null; models: { id: string; name: string }[] }

export const CLAUDE_KEYS_URL = 'https://platform.claude.com/settings/keys';
const looksLikeKey = (text: string) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(text.trim());

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error);
  return data;
}

/** Connects an Anthropic API key once, then launches Claude Agent SDK runs at new desks in this room. */
export function ClaudePanel({ room, claude, onChange, focus = 0 }: { room: Room; claude: ClaudeIntegration | null; onChange: () => void; focus?: number }) {
  const [apiKey, setApiKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('claude-opus-5-5');
  const [access, setAccess] = useState<'edit' | 'read'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const keyInput = useRef<HTMLInputElement>(null); const section = useRef<HTMLHeadingElement>(null);
  // Arriving from the top bar: bring Claude into view and put the cursor where the key goes.
  useEffect(() => { if (!focus) return; section.current?.scrollIntoView({ block: 'start' }); keyInput.current?.focus(); }, [focus, claude?.configured]);
  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setError(''); setNotice('');
    try { const message = await fn(); if (message) setNotice(message); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const connect = (key = apiKey) => run(async () => { await post('/api/claude/key', { apiKey: key }); setApiKey(''); onChange(); return 'Claude connected.'; });
  const disconnect = () => run(async () => { await post('/api/claude/key/remove', {}); onChange(); return 'Claude disconnected. The key was removed from this computer.'; });
  const launch = () => run(async () => {
    const body = await post(`/api/rooms/${room.id}/claude/launch`, { prompt, model, access });
    setPrompt(''); return `Launched on ${claude?.models.find(m => m.id === body.model)?.name || body.model}. Follow it at its desk.`;
  });

  return <>
    <h2 ref={section}>Claude</h2>
    {error && <p className="notice error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!claude ? <p>Loading…</p>
      : !claude.configured ? <>
        <p>Claude agents use an Anthropic API key, billed to that account. Copy a key and paste it below; it connects as soon as you paste.</p>
        <a className="secondary full" href={CLAUDE_KEYS_URL} target="_blank" rel="noreferrer"><KeyRound size={16} /> Create an API key <ExternalLink size={14} /></a>
        <form onSubmit={e => { e.preventDefault(); void connect(); }}>
          <label>API key<input ref={keyInput} type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy} onChange={e => setApiKey(e.target.value)} onPaste={e => { const text = e.clipboardData.getData('text').trim(); if (looksLikeKey(text)) { e.preventDefault(); setApiKey(text); void connect(text); } }} placeholder="Paste your key (sk-ant-…)" /></label>
          <button className="primary full" disabled={busy || !apiKey.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <CheckCheck size={16} />} {busy ? 'Checking key…' : 'Connect Claude'}</button>
        </form>
        <p className="muted small">The key is checked with Anthropic, then saved only on this computer. It is never shown again.</p>
      </>
      : <>
        <div className="account-info"><CheckCheck size={22} /><div><b>Claude connected</b><small>{claude.source === 'environment' ? `Using ANTHROPIC_API_KEY (${claude.hint})` : `API key ${claude.hint}`}</small></div></div>
        {room.demo ? <p className="notice">Open a live project room to launch Claude agents.</p> : <>
          <p>Launch a Claude agent at a new desk. It works in <code>{room.path}</code>. Message it at its desk to steer or continue it.</p>
          <label>Task<textarea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe the work" /></label>
          <label>Model<select value={model} onChange={e => setModel(e.target.value)}>{claude.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label>Access<select value={access} onChange={e => setAccess(e.target.value as 'edit' | 'read')}>
            <option value="edit">Edit files and run sandboxed commands</option>
            <option value="read">Read only</option>
          </select></label>
          <button className="primary full" disabled={busy || !prompt.trim()} onClick={() => void launch()}><Play size={16} /> {busy ? 'Launching…' : 'Launch Claude agent'}</button>
        </>}
        {claude.source === 'saved' && <button className="text-button" disabled={busy} onClick={() => void disconnect()}>Disconnect Claude</button>}
      </>}
  </>;
}
