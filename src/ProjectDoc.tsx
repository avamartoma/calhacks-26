import { useRef, useState } from 'react';
import { ArrowRight, Box, Check, Cloud, Link2, Play } from 'lucide-react';
import type { Agent, CloudPreview, FetchState, Room } from './types';
import { FetchRoster } from './FetchAgents';
import { agentWork, workColors, workLabels } from './Operations';
import { modelLabel } from './identity';
import './project-doc.css';

const statusLabels: Record<string, string> = { working: 'Working', talking: 'Collaborating', done: 'Finished', idle: 'Ready', paused: 'Paused', approval: 'Needs you', error: 'Blocked', ejected: 'Left' };
const engines: Record<string, string> = { claude: 'Claude', 'claude-code': 'Claude Code', cursor: 'Cursor', 'cursor-sdk': 'Cursor', 'codex-cli': 'Codex CLI' };
export const engineName = (a: Agent) => engines[a.provider || ''] || 'Codex';

const firstLine = (text: string, max = 180) => { const line = text.trim().split('\n')[0]; return line.length > max ? line.slice(0, max - 1) + '…' : line; };
/** One line on what the agent is doing: its latest progress update, or its task. */
function summary(a: Agent) {
  const update = [...a.events].reverse().find(e => e.kind === 'update' && e.text.trim());
  return firstLine(update?.text || a.task || 'No work yet.');
}
function ago(time: number) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * The project as a document: what you land on when you zoom into its cloud. It reads like a
 * page (agents and what each is doing, tickets, recent activity, the live preview), and opens
 * an agent's panel, where you chat with it, on click.
 */
export function ProjectDoc({ room, workspaceName, selected, fetch, onAgent, onTask, onStartWork, onFetch, onSky, onOffice }: {
  room: Room; workspaceName?: string; selected?: string | null; fetch?: FetchState;
  onAgent: (id: string) => void; onTask: (id: string) => void; onStartWork: () => void; onFetch: () => void; onSky: () => void; onOffice: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // Leaving fades the page back to cloud white, then the sky pulls back out of the cloud.
  const [leaving, setLeaving] = useState(false);
  const pull = useRef({ amount: 0, at: 0 });
  function leave() { if (leaving) return; setLeaving(true); setTimeout(onSky, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280); }
  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    // Pinching out, or scrolling up past the top of the page, zooms back out to the sky.
    if (e.ctrlKey && e.deltaY > 0) { leave(); return; }
    if (e.currentTarget.scrollTop > 0 || e.deltaY >= 0) { pull.current.amount = 0; return; }
    const now = performance.now();
    if (now - pull.current.at > 500) pull.current.amount = 0;
    pull.current = { amount: pull.current.amount - e.deltaY, at: now };
    if (pull.current.amount > 320) leave();
  }
  const agents = room.agents.filter(a => a.status !== 'ejected').sort((a, b) => Number(!!b.manager) - Number(!!a.manager));
  const tickets = room.workItems.filter(t => !t.archived);
  const done = tickets.filter(t => t.status === 'done').length;
  const activity = room.agents
    .flatMap(a => a.events.filter(e => ['update', 'command', 'file', 'tool', 'error'].includes(e.kind) && e.text.trim()).map(e => ({ ...e, agent: a })))
    .sort((a, b) => b.time - a.time).slice(0, 10);
  const link = `${location.origin}${location.pathname}?project=${encodeURIComponent(room.id)}`;
  async function share() { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { window.prompt('Copy this project link', link); } }

  return <div className={`project-doc ${leaving ? 'leaving' : ''}`} onWheel={onWheel}>
    <article className="doc-page" aria-label={`${room.name} project`}>
      <nav className="doc-crumbs">
        <button onClick={leave}><Cloud size={14} />{workspaceName || 'Workspace'}</button><span>/</span><b>{room.name}</b>
      </nav>
      <header className="doc-header">
        <div>
          <h1>{room.name}</h1>
          <p className="doc-goal">{room.goal || 'No goal yet. Start work to describe what this project is for.'}</p>
          <p className="doc-meta">{room.demo ? 'Demo project · agents are simulated' : room.path}{tickets.length ? ` · ${done}/${tickets.length} tickets verified` : ''}</p>
        </div>
        <div className="doc-actions">
          <button className="secondary" onClick={() => void share()}>{copied ? <Check size={15} /> : <Link2 size={15} />}{copied ? 'Link copied' : 'Copy link'}</button>
          <button className="secondary" onClick={onOffice}><Box size={15} />3D office</button>
          <button className="primary" onClick={onStartWork}><Play size={15} />Start work</button>
        </div>
      </header>

      <section aria-labelledby="doc-fetch">
        <h2 id="doc-fetch">Fetch.ai agents <small>ASI:One</small></h2>
        <p className="doc-quiet">Office, planner, watcher and reviewer run on this computer. Open one to talk to it, plan in Jira, or see what it did here.</p>
        <FetchRoster fetch={fetch} onOpen={onFetch} layout="cards" />
      </section>

      <section aria-labelledby="doc-agents">
        <h2 id="doc-agents">Office desks <small>{agents.length}</small></h2>
        {!agents.length ? <div className="doc-empty"><p>No desk agents yet. Start work and a manager agent plans it, then brings in helpers.</p><button className="primary" onClick={onStartWork}><Play size={15} />Start work</button></div>
          : <div className="doc-agents">{agents.map(a => {
            const ticket = agentWork(room, a);
            const steps = a.plan.length ? `${a.plan.filter(s => s.status === 'completed').length}/${a.plan.length} steps` : '';
            return <button key={a.id} className={`doc-agent status-${a.status} ${selected === a.id ? 'selected' : ''}`} onClick={() => onAgent(a.id)}>
              <span className="doc-agent-top"><i className="doc-dot" /><b>{a.name}</b><span className="doc-role">{a.title || a.role}{a.manager ? ' · Manager' : ''}</span></span>
              <span className="doc-agent-summary">{summary(a)}</span>
              <span className="doc-agent-foot"><span className="doc-engine">{engineName(a)} · {modelLabel(a.effectiveModel || a.model)}</span><span>{statusLabels[a.status] || a.status}</span>{steps && <span>{steps}</span>}{ticket && <span className="doc-ticket">{ticket.title}</span>}</span>
            </button>;
          })}</div>}
      </section>

      {!!tickets.length && <section aria-labelledby="doc-tickets">
        <h2 id="doc-tickets">Tickets <small>{tickets.length}</small></h2>
        <ul className="doc-tickets">{tickets.map(t => { const owner = room.agents.find(a => a.id === t.agentId); return <li key={t.id}><button onClick={() => onTask(t.id)}>
          <span className="doc-ticket-status" style={{ color: workColors[t.status] }}>{workLabels[t.status]}</span><span className="doc-ticket-title">{t.title}</span><span className="doc-ticket-owner">{owner?.name || 'Unassigned'}</span><ArrowRight size={14} />
        </button></li>; })}</ul>
      </section>}

      {!room.demo && room.preview && <SandboxSection sandbox={room.preview} />}

      <section aria-labelledby="doc-activity">
        <h2 id="doc-activity">Recent activity</h2>
        {!activity.length ? <p className="doc-quiet">Nothing yet. Agent progress, commands and file changes appear here as they happen.</p>
          : <ol className="doc-activity">{activity.map(e => <li key={e.id}><time>{ago(e.time)}</time><b>{e.agent.name}</b><span className={`doc-kind kind-${e.kind}`}>{e.kind === 'update' ? 'progress' : e.kind}</span><span className="doc-activity-text">{firstLine(e.text, 160)}</span></li>)}</ol>}
      </section>
    </article>
  </div>;
}

function SandboxSection({ sandbox }: { sandbox: CloudPreview }) {
  const live = sandbox.status === 'live' && !!sandbox.previewUrl;
  return <section aria-labelledby="doc-preview">
    <h2 id="doc-preview">Live preview <small className={`doc-preview-${sandbox.status}`}>{live ? 'Live' : sandbox.status === 'error' ? 'Unavailable' : 'Starting'}</small></h2>
    {live
      ? <iframe className="doc-preview" title="Live preview" src={sandbox.previewUrl} />
      : sandbox.snapshotUrl
        ? <img className="doc-preview" alt="Last preview" src={sandbox.snapshotUrl} />
        : <p className="doc-quiet">{sandbox.detail || 'Opening the cloud environment…'}</p>}
  </section>;
}
