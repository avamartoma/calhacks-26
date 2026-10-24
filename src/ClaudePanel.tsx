import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCheck, ExternalLink, KeyRound, LoaderCircle } from 'lucide-react';
import type { Room } from './types';

export interface ClaudeIntegration { configured: boolean; source: 'environment' | 'saved' | null; hint: string | null; models: { id: string; name: string }[] }

export const CLAUDE_KEYS_URL = 'https://platform.claude.com/settings/keys';
const looksLikeKey = (text: string) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(text.trim());

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error);
  return data;
}

/** Connects an Anthropic API key once. Claude then runs office agents like Codex: choose a Claude model for the manager or any agent. */
export function ClaudePanel({ room, claude, onChange, onStartWork, focus = 0 }: { room: Room; claude: ClaudeIntegration | null; onChange: () => void; onStartWork?: () => void; focus?: number }) {
  const [apiKey, setApiKey] = useState('');
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
        <p>Claude agents work in the office like Codex agents: a Claude manager plans, delegates to Claude workers, edits, runs checks and hands off through tickets. Choose a Claude model as the <b>Manager model</b> when you start work, or when you replace any agent.</p>
        {!room.demo && onStartWork && <button className="primary full" onClick={onStartWork}><ArrowRight size={16} /> Start work with Claude</button>}
        {claude.source === 'saved' && <button className="text-button" disabled={busy} onClick={() => void disconnect()}>Disconnect Claude</button>}
      </>}
  </>;
}
