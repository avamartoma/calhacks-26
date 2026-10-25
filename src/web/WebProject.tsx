import { useEffect, useMemo, useRef, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { Check, Cloud, Copy, Download, ExternalLink, Play, Square, X } from 'lucide-react';
import { diffFiles } from '../office-panel';
import './office-extras.css';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import hosted from '../../hosted.json';
import { OfficeScene } from '../scene';
import { PreviewDock } from '../PreviewDock';
import { localHour, paletteAt } from '../sky/time-of-day';
import type { Agent, Room } from '../types';
import { ConnectionTabs, ConnectionsPanel, providerNames, providers, useConnections, type Provider } from './Connections';
import { describe, useSkyRows, type SkyRow } from './WebSky';
import { FetchPanel } from './FetchWeb';

type Run = NonNullable<ReturnType<typeof useRuns>>[number];
const useRuns = (projectId: Id<'projects'>) => useQuery(api.agentRuns.list, { projectId });
const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');
const working = (run: Run) => run.status === 'starting' || run.status === 'running';
const statusLabel: Record<string, string> = { starting: 'Starting', running: 'Working', done: 'Done', error: 'Failed', stopped: 'Stopped' };
// How the local office labels each kind of desk.
const deskTitle: Record<Provider, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor' };
const deskProvider: Record<Provider, Agent['provider']> = { codex: 'codex-cli', claude: 'claude-code', cursor: 'cursor-sdk' };
const statusColor: Record<string, string> = { starting: '#b88732', running: '#477ead', done: '#38826c', error: '#b55c48', stopped: '#8a969f' };

/** The office for one project: its agents at their desks, built from Convex for the 3D scene. */
function roomFor(row: SkyRow, runs: Run[]): Room {
  const agents: Agent[] = runs.filter((run, index) => working(run) || index < 6).map(run => ({
    id: run.id, name: run.userLabel.split(/[\s@]/)[0] || 'Agent', title: deskTitle[run.agent], role: providerNames[run.agent], task: run.prompt, model: run.agent,
    provider: deskProvider[run.agent], status: working(run) ? 'working' : run.status === 'error' ? 'error' : 'done', color: '#c96442', progress: 0, plan: [], tokens: 0,
    events: run.lastLine ? [{ id: `${run.id}:last`, kind: 'update', text: run.lastLine.text, time: run.startedAt }] : [],
  }));
  return {
    id: row.id, name: row.name, path: '', tag: 'CLOUD', demo: false, goal: row.description, viewOnly: row.role !== 'editor',
    timeline: [], checkpoints: [], workItems: [], messages: [], skills: [], budget: 3, paused: false, agents,
  };
}

export function WebProject({ id, go }: { id: string; go: (path: string) => void }) {
  const rows = useSkyRows();
  const row = rows?.find(item => item.id === id);
  if (rows && !row) return <main className="loading"><h1>This project isn't available</h1><p>It may have been removed, or it hasn't been shared with you.</p><button className="primary" onClick={() => go('/')}>Back to the sky</button></main>;
  if (!row) return <main className="loading" />;
  return <ProjectOffice row={row} go={go} />;
}

function ProjectOffice({ row, go }: { row: SkyRow; go: (path: string) => void }) {
  const projectId = row.id as Id<'projects'>;
  const runs = useRuns(projectId);
  const resume = useMutation(api.sessions.resume);
  const heartbeat = useMutation(api.sessions.heartbeat);
  const [sessionId, setSessionId] = useState<Id<'sessions'> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const editor = row.role === 'editor';

  // Opening the office opens the project's sandbox, and keeps it awake while the page is open.
  useEffect(() => {
    let cancelled = false;
    resume({ projectId }).then(id => { if (!cancelled) setSessionId(id); }).catch(e => { if (!cancelled) setError(message(e)); });
    return () => { cancelled = true; };
  }, [projectId]);
  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => void heartbeat({ sessionId }).catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, [sessionId]);

  const room = useMemo(() => roomFor(row, runs || []), [row, runs]);
  useEffect(() => {
    if (!container.current) return;
    try {
      const office = new OfficeScene(container.current, id => setSelected(id));
      office.onLeaveProject = () => go('/');
      const palette = paletteAt(localHour());
      office.setBackdrop({ zenith: palette.zenith, horizon: palette.horizon, cloud: palette.cloudLight });
      office.setPanelWidth(0);
      office.setRendering(true);
      scene.current = office;
    } catch { setError('This browser could not start 3D graphics.'); }
    return () => { scene.current?.dispose(); scene.current = null; };
  }, []);
  useEffect(() => {
    if (!scene.current) return;
    scene.current.setSky([room]);
    scene.current.openProject(room);
    scene.current.update(room, selected);
  }, [room, selected]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement).closest('input,textarea')) go('/'); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const preview = row.session?.previewStatus === 'live' && row.session.previewUrl
    ? { status: 'live' as const, previewUrl: row.session.previewUrl }
    : {
        status: (row.session?.previewStatus === 'error' ? 'error' : 'starting') as 'error' | 'starting',
        ...(row.snapshotUrl ? { snapshotUrl: row.snapshotUrl } : {}),
        // PreviewDock says "Starting preview…" only when given a session, so only pass one while a preview really is starting.
        ...(row.session?.previewStatus === 'starting' && sessionId ? { sessionId } : {}),
        detail: row.session?.status === 'provisioning' ? 'Starting the sandbox' : row.session?.previewStatus === 'error' ? 'The preview failed to start' : 'No preview is running',
      };

  return <div className="app quiet-office opencloud web-office project-shell">
    <main className="workspace">
      <div className="opencloud-actions">
        <button className="sky-return" aria-pressed={accountsOpen} onClick={() => { setAccountsOpen(open => !open); setShareOpen(false); setFetchOpen(false); }}>Accounts</button>
        <button className="sky-return" aria-pressed={shareOpen} onClick={() => { setShareOpen(open => !open); setAccountsOpen(false); setFetchOpen(false); }}><ExternalLink size={16} /> Share</button>
        <button className="sky-return" aria-pressed={fetchOpen} onClick={() => { setFetchOpen(open => !open); setAccountsOpen(false); setShareOpen(false); }}>ASI:One agents</button>
        {editor && <DownloadButton projectId={projectId} />}
        <button className="sky-return" onClick={() => go('/')}><Cloud size={16} /> Sky</button>
        <span className="web-title">{row.name}<small>{describe(row)}</small></span>
      </div>
      <div className="world">
        <div ref={container} className="world-canvas" />
        <div className="cloud-arrival" style={{ background: `rgb(${paletteAt(localHour()).cloudLight.map(v => Math.round(v * 255)).join(',')})` }} />
        <AgentsPanel projectId={projectId} runs={runs} editor={editor} selected={selected} onSelect={setSelected} />
        {shareOpen && <SharePanel row={row} onClose={() => setShareOpen(false)} />}
        {accountsOpen && <ConnectionsPanel onClose={() => setAccountsOpen(false)} />}
        {fetchOpen && <FetchPanel projectId={projectId} runs={runs || []} editor={editor} mine={row.mine} onClose={() => setFetchOpen(false)} />}
        <PreviewDock cloud={preview} />
        {editor && sessionId && row.session?.status === 'ready' && !row.session.previewUrl && <StartPreview sessionId={sessionId} />}
        {error && <p className="web-toast" role="alert">{error}<button aria-label="Dismiss" onClick={() => setError('')}><X size={14} /></button></p>}
      </div>
    </main>
  </div>;
}

function StartPreview({ sessionId }: { sessionId: Id<'sessions'> }) {
  const start = useAction(api.sessions.startPreview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="web-start-preview">
    <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await start({ sessionId }); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>{busy ? 'Starting the preview…' : 'Start preview'}</button>
    {error && <small title={error}>{error.slice(0, 120)}</small>}
  </div>;
}

function AgentsPanel({ projectId, runs, editor, selected, onSelect }: { projectId: Id<'projects'>; runs: Run[] | undefined; editor: boolean; selected: string | null; onSelect: (id: string | null) => void }) {
  const connections = useConnections();
  const connected = providers.filter(provider => connections?.providers[provider].connected);
  const [chosen, setChosen] = useState<Provider | null>(() => localStorage.getItem('opencloud-agent') as Provider | null);
  const agent = chosen && connected.includes(chosen) ? chosen : connected[0];
  const start = useMutation(api.agentRuns.start);
  const stop = useMutation(api.agentRuns.stop);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <aside className="agent-side web-side" aria-label="Agents">
    <header><b>Agents</b><span>{runs?.filter(working).length || 0} working</span></header>
    {editor && (agent
      ? <form className="web-start" onSubmit={async event => {
          event.preventDefault(); setBusy(true); setError('');
          try { const runId = await start({ projectId, prompt, agent }); setPrompt(''); onSelect(runId); } catch (e) { setError(message(e)); } finally { setBusy(false); }
        }}>
          <div className="web-tabs web-agent-picker" role="radiogroup" aria-label="Agent">
            {providers.map(provider => <button key={provider} type="button" role="radio" aria-checked={agent === provider} aria-selected={agent === provider} disabled={!connected.includes(provider)} title={connected.includes(provider) ? undefined : `Connect ${providerNames[provider]} in Accounts`} onClick={() => { setChosen(provider); localStorage.setItem('opencloud-agent', provider); }}>{providerNames[provider]}</button>)}
          </div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} maxLength={8000} placeholder="What should an agent do? For example: add a dark mode toggle to the settings page" />
          <button className="primary" disabled={busy || !prompt.trim()}><Play size={14} /> {busy ? 'Starting…' : 'Start agent'}</button>
          {error && <p className="web-error" role="alert">{error}</p>}
        </form>
      : connections && <div className="web-key-needed"><b>Connect Codex, Claude or Cursor to start agents</b><ConnectionTabs initial="claude" /></div>)}
    {!editor && <p className="web-note">You can watch this project's agents. Ask the owner for edit access to start your own.</p>}
    {runs && !runs.length && <p className="web-note">No agents have worked here yet.</p>}
    <ul className="web-runs">
      {runs?.map(run => <li key={run.id} className={selected === run.id ? 'open' : ''}>
        <button className="web-run" onClick={() => onSelect(selected === run.id ? null : run.id)}>
          <i style={{ background: statusColor[run.status] }} />
          <span><b>{run.followUpOf && <em className="web-reply-mark">Reply · </em>}{run.prompt.split('\n')[0].slice(0, 90)}</b><small>{run.userLabel} · {providerNames[run.agent]} · {statusLabel[run.status]}{run.costUsd !== null ? ` · $${run.costUsd.toFixed(2)}` : ''}</small></span>
        </button>
        {selected === run.id ? <RunLog runId={run.id} /> : run.lastLine && <p className="web-last">{run.lastLine.text}</p>}
        {editor && run.mine && working(run) && <button className="text-button danger" onClick={() => void stop({ runId: run.id })}><Square size={12} /> Stop</button>}
        {editor && selected === run.id && run.canFollowUp && <FollowUp runId={run.id} agent={providerNames[run.agent]} onSent={onSelect} />}
      </li>)}
    </ul>
  </aside>;
}

function RunLog({ runId }: { runId: Id<'agentRuns'> }) {
  const lines = useQuery(api.agentRuns.lines, { runId });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [lines?.length]);
  if (!lines) return null;
  if (!lines.length) return <p className="web-last">Getting the sandbox ready…</p>;
  return <>
    <div className="web-log">{lines.map(line => <p key={line.id} className={`web-line ${line.kind}`}>{line.text}</p>)}<div ref={end} /></div>
    <RunChanges runId={runId} />
  </>;
}

/** Messages a finished agent; it picks up its conversation where it left off, as a new run. */
function FollowUp({ runId, agent, onSent }: { runId: Id<'agentRuns'>; agent: string; onSent: (id: string) => void }) {
  const followUp = useMutation(api.agentRuns.followUp);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="web-followup" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { const next = await followUp({ runId, message: text }); setText(''); onSent(next); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }}>
    <textarea value={text} onChange={e => setText(e.target.value)} rows={2} maxLength={8000} placeholder={`Reply to ${agent}: ask for a change, or say what to do next`} />
    <button className="secondary" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Reply'}</button>
    {error && <p className="web-error" role="alert">{error}</p>}
  </form>;
}

/** The files a run changed, each opening its diff, like a ticket's files in the local office. */
function RunChanges({ runId }: { runId: Id<'agentRuns'> }) {
  const changes = useQuery(api.runChangesStore.forRun, { runId });
  const [patch, setPatch] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!changes?.patchUrl) return;
    let cancelled = false;
    fetch(changes.patchUrl).then(response => response.text()).then(text => { if (!cancelled) setPatch(text); }).catch(() => {});
    return () => { cancelled = true; };
  }, [changes?.patchUrl]);
  if (!changes) return null;
  if (!changes.files) return changes.error ? <p className="web-last">{changes.error}</p> : null;
  const bodies = new Map(diffFiles(patch ?? '').map(file => [file.path, file.body]));
  return <div className="web-changes">
    <b>{changes.files.length ? `Changed ${changes.files.length} file${changes.files.length === 1 ? '' : 's'}` : 'No files changed'}</b>
    <ul>{changes.files.map(file => <li key={file.path}>
      <button type="button" aria-expanded={open === file.path} onClick={() => setOpen(current => current === file.path ? null : file.path)}>
        <span>{file.path}</span><small><i className="added">+{file.added}</i> <i className="removed">−{file.removed}</i></small>
      </button>
      {open === file.path && (bodies.get(file.path)
        ? <pre className="agent-side-diff">{bodies.get(file.path)!.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-added' : line.startsWith('-') && !line.startsWith('---') ? 'diff-removed' : ''}>{line || ' '}{'\n'}</span>)}</pre>
        : <p className="web-last">{patch === null ? 'Loading the diff…' : changes.truncated ? 'This diff was too large to keep.' : 'No text diff for this file.'}</p>)}
    </li>)}</ul>
  </div>;
}

function DownloadButton({ projectId }: { projectId: Id<'projects'> }) {
  const download = useAction(api.runChanges.download);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <button className="sky-return" disabled={busy} title={error || 'Download the project as a .tar.gz'} onClick={async () => {
    setBusy(true); setError('');
    try { const { url } = await download({ projectId }); window.location.assign(url); } catch (e) { setError(message(e)); alert(message(e)); } finally { setBusy(false); }
  }}><Download size={15} /> {busy ? 'Packing…' : 'Download'}</button>;
}

function SharePanel({ row, onClose }: { row: SkyRow; onClose: () => void }) {
  const setVisibility = useMutation(api.sharing.setVisibility);
  const invite = useMutation(api.sharing.invite);
  const emails = useQuery(api.sharing.emailEnabled, {});
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const link = `${hosted.shareOrigin}/project/${row.id}`;
  return <aside className="web-panel share-web" aria-label="Share">
    <header><h2>Share</h2><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
    <div className="web-link"><code>{link}</code><button className="secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div>
    {row.mine ? <>
      <label className="web-check"><input type="checkbox" checked={row.visibility === 'public'} onChange={e => void setVisibility({ projectId: row.id as Id<'projects'>, visibility: e.target.checked ? 'public' : 'private' })} /> Anyone signed in can view</label>
      <form className="web-invite" onSubmit={async event => {
        event.preventDefault(); setNote('');
        try { await invite({ projectId: row.id as Id<'projects'>, email, role }); setNote(emails ? `Shared with ${email.trim()}. We've emailed them a link.` : `Shared with ${email.trim()}.`); setEmail(''); } catch (e) { setNote(message(e)); }
      }}>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="teammate@email.com" required />
        <select value={role} onChange={e => setRole(e.target.value as 'viewer' | 'editor')}><option value="viewer">Can view</option><option value="editor">Can edit</option></select>
        <button className="primary">Invite</button>
      </form>
      {note && <p className="web-note">{note}</p>}
      <p className="web-note">{emails ? 'People you invite get an email with a link, and see this project on their sky once they sign in with that address.' : 'People you invite see this project on their sky once they sign in with that email. Invite emails aren’t set up yet, so let them know.'} Editors can start agents on their own key.</p>
    </> : <p className="web-note">Only the owner can change who has access.</p>}
  </aside>;
}
