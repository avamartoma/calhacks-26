import { useState } from 'react';
import { Play } from 'lucide-react';
import type { Room } from './types';

export interface ClaudeIntegration { configured: boolean; models: { id: string; name: string }[] }

/** Launches a Claude Agent SDK run at a new desk in this room. */
export function ClaudePanel({ room, claude }: { room: Room; claude: ClaudeIntegration | null }) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('claude-opus-5-5');
  const [access, setAccess] = useState<'edit' | 'read'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [launched, setLaunched] = useState('');
  async function launch() {
    setBusy(true); setError(''); setLaunched('');
    try {
      const res = await fetch(`/api/rooms/${room.id}/claude/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, model, access }) });
      const body = await res.json(); if (!res.ok) throw new Error(body.error);
      setPrompt(''); setLaunched(`Launched on ${claude?.models.find(m => m.id === body.model)?.name || body.model}. Follow it at its desk.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <h2>Claude</h2>
    {error && <p className="notice error" role="alert">{error}</p>}
    {launched && <p className="notice" role="status">{launched}</p>}
    {room.demo ? <p className="notice">Open a live project room to launch Claude agents.</p>
      : !claude ? <p>Loading…</p>
      : !claude.configured ? <p className="notice">Set <code>ANTHROPIC_API_KEY</code> before starting Iteration1 to launch Claude agents. Create a key at platform.claude.com.</p>
      : <>
        <p>Launch a Claude agent at a new desk. It works in <code>{room.path}</code> and can be stopped from its desk.</p>
        <label>Task<textarea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe the work" /></label>
        <label>Model<select value={model} onChange={e => setModel(e.target.value)}>{claude.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label>Access<select value={access} onChange={e => setAccess(e.target.value as 'edit' | 'read')}>
          <option value="edit">Edit files and run sandboxed commands</option>
          <option value="read">Read only</option>
        </select></label>
        <button className="primary full" disabled={busy || !prompt.trim()} onClick={() => void launch()}><Play size={16} /> {busy ? 'Launching…' : 'Launch Claude agent'}</button>
        <p className="muted small">Uses your Anthropic API key; usage is billed to that account.</p>
      </>}
  </>;
}
