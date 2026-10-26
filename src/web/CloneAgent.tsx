import { useState } from 'react';
import { useMutation } from 'convex/react';
import { Copy } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { kindOf } from '../sky/agents';
import type { SkyTransfer } from '../sky/SkyView';

// "Clone to my project": copies an agent into another of your projects, then shows it travelling
// there. The office goes back to the sky, which zooms out of this project, sends a blob in the
// agent's color across to the other cloud, and flies into it with the new agent selected.

const TRANSFER = 'opencloud-transfer', ARRIVE = 'opencloud-arrive-agent';
const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');

/** The transfer the sky should show, once: it's only good for a minute after the clone. */
export function takeTransfer(): (SkyTransfer & { agentId: string }) | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TRANSFER) || 'null');
    sessionStorage.removeItem(TRANSFER);
    return saved && Date.now() - saved.at < 60_000 ? saved : null;
  } catch { return null; }
}

/** The agent to select when its project opens after a clone, once. */
export function takeArrival(projectId: string): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ARRIVE) || 'null');
    if (!saved || saved.projectId !== projectId || Date.now() - saved.at > 120_000) return null;
    sessionStorage.removeItem(ARRIVE);
    return saved.agentId;
  } catch { return null; }
}

export interface CloneTarget { id: string; name: string }

export function CloneButton({ source, fromProjectId, targets, go }: { source: { agentId: Id<'projectAgents'> } | { runId: Id<'agentRuns'> }; fromProjectId: string; targets: CloneTarget[]; go: (path: string) => void }) {
  const clone = useMutation(api.projectAgents.clone);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = targets.filter(item => item.id !== fromProjectId);
  if (!open) return <button className="text-button web-clone-open" onClick={() => { setOpen(true); setTarget(choices[0]?.id ?? ''); }}><Copy size={12} /> Clone to my project</button>;
  if (!choices.length) return <p className="web-note">Make a project of your own first, then clone agents into it.</p>;
  return <div className="web-clone">
    <select value={target} onChange={e => setTarget(e.target.value)} aria-label="Project to clone into">{choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    <button className="primary" disabled={busy || !target} onClick={async () => {
      setBusy(true); setError('');
      try {
        const result = await clone({ targetProjectId: target as Id<'projects'>, ...source });
        sessionStorage.setItem(TRANSFER, JSON.stringify({ from: result.fromProjectId, to: result.toProjectId, agentId: result.agentId, color: kindOf(result.role).color, at: Date.now() }));
        sessionStorage.setItem(ARRIVE, JSON.stringify({ projectId: result.toProjectId, agentId: result.agentId, at: Date.now() }));
        go('/');
      } catch (e) { setError(message(e)); setBusy(false); }
    }}>{busy ? 'Cloning…' : 'Clone'}</button>
    <button className="text-button" onClick={() => setOpen(false)}>Cancel</button>
    {error && <p className="web-error" role="alert">{error}</p>}
  </div>;
}
