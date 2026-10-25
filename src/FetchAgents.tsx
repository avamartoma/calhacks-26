import { useEffect, useState } from 'react';
import { ChevronRight, ClipboardList, Copy, ExternalLink, Eye, LoaderCircle, MessageSquare, Radar, ShieldCheck } from 'lucide-react';
import { officeApi } from './Operations';
import type { FetchActivity, FetchAgent, FetchAgentName, FetchJob, FetchState, Room, WorkItem } from './types';
import './fetch-agents.css';

const ONLINE_MS = 20000;
const roles: Record<FetchAgentName, { title: string; role: string; icon: typeof Eye }> = {
  office: { title: 'Office agent', role: 'Answers you in ASI:One', icon: MessageSquare },
  planner: { title: 'Planner', role: 'Plans work in Jira', icon: ClipboardList },
  watcher: { title: 'Watcher', role: 'Notices changes in this office', icon: Radar },
  reviewer: { title: 'Reviewer', role: 'Checks evidence against criteria', icon: ShieldCheck }
};
const order: FetchAgentName[] = ['office', 'planner', 'watcher', 'reviewer'];

/** Re-renders every few seconds so an agent that stops checking in turns offline. */
function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
const online = (a: FetchAgent | undefined, now: number) => !!a && a.lastSeen > 0 && now - a.lastSeen < ONLINE_MS;
const agentOf = (fetch: FetchState | undefined, name: FetchAgentName) => fetch?.agents.find(a => a.name === name);
const ago = (t: number, now: number) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

function status(a: FetchAgent | undefined, now: number) {
  if (!online(a, now)) return a?.lastSeen ? `Offline · last seen ${ago(a.lastSeen, now)}` : 'Not running';
  const d = a!.details;
  if (a!.name === 'office') return d.pairingLocked ? 'Pairing locked' : `${d.owners || 0} paired in ASI:One`;
  if (a!.name === 'watcher') return d.watching ? 'Watching' : 'Reconnecting';
  if (a!.name === 'planner') return d.jira ? `Jira ${d.jira}` : 'Jira not set up';
  return d.model ? 'Judging with ASI:One' : 'Office checks only';
}

/** Review text uses **bold** and one item per line, as in ASI:One; render it the same way here. */
function Lines({ text }: { text: string }) {
  return <div className="fetch-lines">{text.split('\n').map((line, i) => line.trim() ? <p key={i}>{line.split(/(\*\*[^*]+\*\*)/).map((part, j) => part.startsWith('**') && part.endsWith('**') ? <b key={j}>{part.slice(2, -2)}</b> : part)}</p> : <br key={i} />)}</div>;
}

/** The four Fetch.ai agents as a roster: used on the Agents panel and the project document. */
export function FetchRoster({ fetch, onOpen, layout = 'list' }: { fetch?: FetchState; onOpen: () => void; layout?: 'list' | 'cards' }) {
  const now = useNow();
  const items = order.map(name => {
    const a = agentOf(fetch, name), Icon = roles[name].icon, live = online(a, now);
    const title = roles[name].title, role = roles[name].role, line = status(a, now);
    if (layout === 'cards') return <button key={name} className={`doc-agent ${live ? 'status-working' : ''}`} onClick={onOpen} aria-label={`${title}: ${line}`}>
      <span className="doc-agent-top"><i className="doc-dot" /><b>{title}</b><span className="doc-role">{role}</span></span>
      <span className="doc-agent-summary">{line}</span>
      <span className="doc-agent-foot"><span className="doc-engine">Fetch.ai · ASI:One</span><span>{live ? 'Online' : 'Offline'}</span></span>
    </button>;
    return <button key={name} className="agent-row" onClick={onOpen} aria-label={`${title}: ${line}`}>
      <Icon size={18} /><span><b>{title}</b><p>{role}</p><small>{line}</small></span><i className={`fetch-dot ${live ? 'on' : ''}`} /><ChevronRight size={16} />
    </button>;
  });
  return layout === 'cards'
    ? <div className="doc-agents">{items}</div>
    : <section className="fetch-roster" aria-label="Fetch.ai agents">
      <h3>Fetch.ai · ASI:One</h3>
      <p className="quiet-copy">Agents you run on this computer. Open one to copy its address, plan in Jira, or see what it did in this project.</p>
      {items}
    </section>;
}

/** The four agents, inside the project rail. */
export function FetchRail({ fetch, onOpen }: { fetch?: FetchState; onOpen: () => void }) {
  const now = useNow();
  return <div className="fetch-rail" aria-label="ASI:One agents">
    <button className="fetch-rail-title" onClick={onOpen}>ASI:One agents</button>
    <div className="fetch-rail-grid">{order.map(name => { const a = agentOf(fetch, name); return <button key={name} className="fetch-rail-agent" onClick={onOpen} title={`${roles[name].role} · ${status(a, now)}`} aria-label={`${roles[name].title}: ${status(a, now)}`}>
      <i className={online(a, now) ? 'on' : ''} /><span>{name === 'office' ? 'Office' : roles[name].title}</span>
    </button>; })}</div>
  </div>;
}

async function queue(agent: 'reviewer' | 'planner', kind: string, roomId: string, extra: { taskId?: string; payload?: Record<string, unknown> } = {}) {
  return (await officeApi('/fetch/jobs', { agent, kind, roomId, ...extra })).job as FetchJob;
}
const jobById = (fetch: FetchState | undefined, id: string | null) => id ? fetch?.jobs.find(j => j.id === id) : undefined;
const pending = (job?: FetchJob) => !!job && (job.status === 'queued' || job.status === 'running');
const failure = (job?: FetchJob) => job?.status === 'failed' ? String(job.result?.error || 'The agent could not finish this.') : '';

interface Story { summary: string; description: string; acceptance_criteria: string[] }
interface Plan { epic: { summary: string; description: string }; stories: Story[] }

function JiraPlanner({ fetch, room, now }: { fetch?: FetchState; room: Room; now: number }) {
  const planner = agentOf(fetch, 'planner'), site = String(planner?.details.site || ''), project = String(planner?.details.jira || '');
  const [idea, setIdea] = useState(''), [error, setError] = useState('');
  const [planJob, setPlanJob] = useState<string | null>(null), [createJob, setCreateJob] = useState<string | null>(null), [startJobs, setStartJobs] = useState<Record<string, string>>({});
  const drafted = jobById(fetch, planJob), created = jobById(fetch, createJob);
  const plan = drafted?.status === 'done' ? drafted.result?.plan as Plan : undefined;
  const issues = created?.status === 'done' ? created.result?.issues as { key: string; summary: string }[] : undefined;
  const ask = (fn: () => Promise<void>) => { setError(''); fn().catch(e => setError((e as Error).message)); };
  if (!online(planner, now)) return <p className="quiet-copy">Start the agents (<code>agents/run_all.py</code>) to plan work in Jira from here.</p>;
  if (!project) return <p className="quiet-copy">Jira isn't set up. Run <code>agents/configure.py</code> on this computer, then restart the agents.</p>;
  return <div className="fetch-planner">
    <label>What should the team build?<textarea rows={3} value={idea} placeholder="Search box reachable by keyboard; Enter submits; show a no-results message" onChange={e => setIdea(e.target.value)} /></label>
    <button className="primary" disabled={idea.trim().length < 6 || pending(drafted)} onClick={() => ask(async () => { setCreateJob(null); setStartJobs({}); setPlanJob((await queue('planner', 'plan', room.id, { payload: { idea } })).id); })}>{pending(drafted) ? <><LoaderCircle className="spin" size={14} /> Drafting…</> : `Draft stories for ${project}`}</button>
    {(error || failure(drafted) || failure(created)) && <p className="notice error" role="alert">{error || failure(drafted) || failure(created)}</p>}
    {plan && !issues && <div className="fetch-plan">
      <b>{plan.epic.summary}</b>{drafted?.result?.modeled === false && <small> · one story per line; add an ASI:One key for written stories</small>}
      <ol>{plan.stories.map((s, i) => <li key={i}>{s.summary}<ul>{s.acceptance_criteria.map((c, j) => <li key={j}>{c}</li>)}</ul></li>)}</ol>
      <button className="primary" disabled={pending(created)} onClick={() => ask(async () => setCreateJob((await queue('planner', 'create', room.id, { payload: { plan } })).id))}>{pending(created) ? <><LoaderCircle className="spin" size={14} /> Creating…</> : `Create ${plan.stories.length} stories in Jira`}</button>
    </div>}
    {issues && <ul className="fetch-issues">{issues.map(issue => { const job = jobById(fetch, startJobs[issue.key] || null); return <li key={issue.key}>
      <a href={`${site}/browse/${issue.key}`} target="_blank" rel="noreferrer">{issue.key} <ExternalLink size={11} /></a><span>{issue.summary}</span>
      {job?.status === 'done' ? <em>Started</em> : <button className="secondary" disabled={pending(job)} onClick={() => ask(async () => { const started = await queue('planner', 'start', room.id, { payload: { key: issue.key } }); setStartJobs(s => ({ ...s, [issue.key]: started.id })); })}>{pending(job) ? 'Starting…' : 'Start'}</button>}
      {failure(job) && <small className="error">{failure(job)}</small>}
    </li>; })}</ul>}
  </div>;
}

/** The full view: who is running, Jira planning and what the agents did in this project. */
export function FetchPanel({ fetch, room, onTask }: { fetch?: FetchState; room: Room; onTask: (id: string) => void }) {
  const now = useNow();
  const [copied, setCopied] = useState('');
  const activity = (fetch?.activity || []).filter(a => !a.roomId || a.roomId === room.id).slice(-30).reverse();
  const task = (a: FetchActivity) => a.taskId ? room.workItems.find(t => t.id === a.taskId) : undefined;
  return <div className="fetch-panel">
    <h2>ASI:One agents</h2>
    <p className="quiet-copy">Four Fetch.ai agents run on this computer and are registered on Agentverse. The office and planner agents answer you in ASI:One; the watcher and reviewer work behind them. They cannot approve commands or mark work verified.</p>
    <div className="fetch-cards">{order.map(name => { const a = agentOf(fetch, name), Icon = roles[name].icon; return <div key={name} className={`fetch-card ${online(a, now) ? 'on' : ''}`}>
      <header><Icon size={16} /><b>{roles[name].title}</b><i /></header>
      <p>{roles[name].role}</p><small>{status(a, now)}</small>
      {a?.address && <button className="text-button" onClick={() => { void navigator.clipboard.writeText(a.address).then(() => setCopied(name)); }}><Copy size={12} /> {copied === name ? 'Copied' : 'Copy address'}</button>}
    </div>; })}</div>
    {!fetch?.agents.some(a => online(a, now)) && <p className="notice">None of the agents is running. Start them with <code>.office/runtime/agent-venv/Scripts/python agents/run_all.py</code>.</p>}
    <h3>Plan in Jira</h3>
    <JiraPlanner fetch={fetch} room={room} now={now} />
    <h3>Activity</h3>
    {activity.length ? <ol className="fetch-activity">{activity.map(a => { const t = task(a); return <li key={a.id}>
      <span className="fetch-who">{roles[a.name].title}</span><small>{ago(a.time, now)}</small>
      {a.kind === 'review' ? <details><summary>{a.text.split('\n')[0].replace(/\*\*/g, '')}</summary><Lines text={a.text} /></details> : <p>{a.text}</p>}
      {t && <button className="text-button" onClick={() => onTask(t.id)}>Open ticket</button>}
    </li>; })}</ol> : <p className="quiet-copy">Nothing yet. The watcher reports here when tasks block, reach review or finish.</p>}
  </div>;
}

/** On a ticket: the reviewer's latest verdict, a way to ask for one, and the Jira issue it came from. */
export function TicketAgents({ fetch, room, item }: { fetch?: FetchState; room: Room; item: WorkItem }) {
  const now = useNow();
  const [jobId, setJobId] = useState<string | null>(null), [error, setError] = useState('');
  const reviewer = agentOf(fetch, 'reviewer'), planner = agentOf(fetch, 'planner');
  const latest = [...(fetch?.activity || [])].reverse().find(a => a.name === 'reviewer' && a.kind === 'review' && a.taskId === item.id);
  const job = jobById(fetch, jobId);
  const key = item.title.match(/^\s*([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/)?.[1];
  const site = String(planner?.details.site || ''), project = String(planner?.details.jira || '');
  const jira = key && site && key.startsWith(project + '-') ? `${site}/browse/${key}` : '';
  if (!latest && !online(reviewer, now) && !jira) return null;
  return <section className="ticket-agents" aria-label="ASI:One agents">
    <header><ShieldCheck size={14} /><b>Reviewer</b>{jira && <a href={jira} target="_blank" rel="noreferrer">{key} in Jira <ExternalLink size={11} /></a>}</header>
    {latest ? <><small>{ago(latest.time, now)}</small><Lines text={latest.text} /></> : <p className="quiet-copy">No review yet{item.status === 'review' ? '. It reviews tickets when they reach review.' : '.'}</p>}
    {online(reviewer, now) ? <button className="secondary" disabled={pending(job)} onClick={() => { setError(''); queue('reviewer', 'review', room.id, { taskId: item.id }).then(j => setJobId(j.id)).catch(e => setError((e as Error).message)); }}>{pending(job) ? <><LoaderCircle className="spin" size={14} /> Reviewing…</> : latest ? 'Review again' : 'Ask the reviewer'}</button>
      : <small>The reviewer isn't running.</small>}
    {(error || failure(job)) && <p className="notice error" role="alert">{error || failure(job)}</p>}
  </section>;
}
