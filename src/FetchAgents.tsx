import { useEffect, useRef, useState } from 'react';
import { ChevronRight, ClipboardList, Copy, ExternalLink, Eye, LoaderCircle, MessageSquare, Radar, Send, ShieldCheck } from 'lucide-react';
import { officeApi } from './Operations';
import type { FetchActivity, FetchAgent, FetchAgentName, FetchJob, FetchState, Room, WorkItem } from './types';
import { fetchNames } from './fetch-characters';
import './fetch-agents.css';

const ONLINE_MS = 20000;
const roles: Record<FetchAgentName, { title: string; role: string; icon: typeof Eye }> = {
  office: { title: 'Office', role: 'Chat', icon: MessageSquare },
  planner: { title: 'Planner', role: 'Jira', icon: ClipboardList },
  watcher: { title: 'Watcher', role: 'Watches', icon: Radar },
  reviewer: { title: 'Reviewer', role: 'Reviews', icon: ShieldCheck }
};
const order = fetchNames;

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
  if (!online(a, now)) return 'Offline';
  const d = a!.details;
  if (a!.name === 'office') return d.pairingLocked ? 'Locked' : 'Online';
  if (a!.name === 'watcher') return d.watching ? 'Online' : 'Reconnecting';
  if (a!.name === 'planner') return d.jira ? 'Online' : 'Needs Jira';
  return 'Online';
}

/** Review text uses **bold** and one item per line, as in ASI:One; render it the same way here. */
function Lines({ text }: { text: string }) {
  return <div className="fetch-lines">{text.split('\n').map((line, i) => line.trim() ? <p key={i}>{line.split(/(\*\*[^*]+\*\*)/).map((part, j) => part.startsWith('**') && part.endsWith('**') ? <b key={j}>{part.slice(2, -2)}</b> : part)}</p> : <br key={i} />)}</div>;
}

/** Fetch agents this project hasn't used yet. Used ones sit with the office characters instead. */
export function FetchRoster({ fetch, onOpen, hide = [], layout = 'list' }: { fetch?: FetchState; onOpen: (name: FetchAgentName) => void; hide?: FetchAgentName[]; layout?: 'list' | 'cards' }) {
  const now = useNow();
  const left = fetchNames.filter(name => !hide.includes(name));
  if (!left.length) return null;
  const items = left.map(name => {
    const a = agentOf(fetch, name), Icon = roles[name].icon, live = online(a, now);
    const title = roles[name].title, role = roles[name].role, line = status(a, now);
    if (layout === 'cards') return <button key={name} className={`doc-agent ${live ? 'status-working' : ''}`} onClick={() => onOpen(name)} aria-label={`${title}: ${line}`}>
      <span className="doc-agent-top"><i className="doc-dot" /><b>{title}</b><span className="doc-role">{role}</span></span>
      <span className="doc-agent-foot"><span>{line}</span></span>
    </button>;
    return <button key={name} className="agent-row" onClick={() => onOpen(name)} aria-label={`${title}: ${line}`}>
      <Icon size={18} /><span><b>{title}</b><p>{line}</p></span><i className={`fetch-dot ${live ? 'on' : ''}`} /><ChevronRight size={16} />
    </button>;
  });
  return layout === 'cards'
    ? <div className="doc-agents">{items}</div>
    : <section className="fetch-roster" aria-label="Fetch agents">{items}</section>;
}

/** Unused Fetch agents, inside the project rail. Used ones sit as gray office characters. */
export function FetchRail({ fetch, onOpen, hide = [] }: { fetch?: FetchState; onOpen: (name?: FetchAgentName) => void; hide?: FetchAgentName[] }) {
  const now = useNow();
  const left = fetchNames.filter(name => !hide.includes(name));
  return <div className="fetch-rail" aria-label="Fetch agents">
    <button className="fetch-rail-title" onClick={() => onOpen()}>Fetch</button>
    {!!left.length && <div className="fetch-rail-grid">{left.map(name => { const a = agentOf(fetch, name); return <button key={name} className="fetch-rail-agent" onClick={() => onOpen(name)} title={`${roles[name].role} · ${status(a, now)}`} aria-label={`${roles[name].title}: ${status(a, now)}`}>
      <i className={online(a, now) ? 'on' : ''} /><span>{name === 'office' ? 'Office' : roles[name].title}</span>
    </button>; })}</div>}
  </div>;
}

async function queue(agent: FetchJob['agent'], kind: string, roomId: string, extra: { taskId?: string; payload?: Record<string, unknown> } = {}) {
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
  if (!online(planner, now)) return <p className="quiet-copy">Start the agents to plan here.</p>;
  if (!project) return <p className="quiet-copy">Jira isn’t set up yet.</p>;
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

/** Talk to the office agent from the app: the same commands as in ASI:One, about this project. */
function OfficeChat({ fetch, room }: { fetch?: FetchState; room: Room }) {
  const [text, setText] = useState(''), [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const chats = (fetch?.jobs || []).filter(j => j.agent === 'office' && j.kind === 'chat' && j.roomId === room.id);
  const waiting = chats.some(pending);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [chats.length, chats.at(-1)?.status]);
  const send = (message: string) => {
    if (!message.trim()) return;
    setError('');
    queue('office', 'chat', room.id, { payload: { text: message.trim() } }).then(() => setText('')).catch(e => setError((e as Error).message));
  };
  return <div className="fetch-chat">
    <div className="fetch-chat-log" aria-live="polite">
      {!chats.length && <p className="quiet-copy">Ask about this project: status, approvals, alerts, a report on a task, or start a mission.</p>}
      {chats.map(job => <div key={job.id} className="fetch-chat-turn">
        <p className="fetch-chat-you">{String(job.payload.text || '')}</p>
        {pending(job) ? <p className="fetch-chat-agent"><LoaderCircle className="spin" size={13} /> {job.status === 'queued' ? 'Sending…' : 'Thinking…'}</p>
          : job.status === 'failed' ? <p className="fetch-chat-agent error">{failure(job)}</p>
          : <div className="fetch-chat-agent"><Lines text={String(job.result?.text || '')} /></div>}
      </div>)}
      <div ref={end} />
    </div>
    <div className="fetch-chat-quick">{['status', 'approvals', 'alerts', 'help'].map(command => <button key={command} type="button" className="secondary" disabled={waiting} onClick={() => send(command)}>{command}</button>)}</div>
    <form onSubmit={e => { e.preventDefault(); send(text); }}>
      <input value={text} maxLength={4000} placeholder="Message the office agent" onChange={e => setText(e.target.value)} />
      <button className="primary" disabled={waiting || !text.trim()}><Send size={14} /></button>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

/** Pick a ticket and the reviewer checks it against its acceptance criteria. */
function ReviewPicker({ fetch, room, now }: { fetch?: FetchState; room: Room; now: number }) {
  const [error, setError] = useState('');
  const tickets = room.workItems.filter(item => !item.archived);
  if (!tickets.length) return <p className="quiet-copy">No tickets to review yet.</p>;
  return <ul className="fetch-reviews">{tickets.map(item => {
    const job = [...(fetch?.jobs || [])].reverse().find(j => j.agent === 'reviewer' && j.taskId === item.id);
    const latest = [...(fetch?.activity || [])].reverse().find(a => a.name === 'reviewer' && a.kind === 'review' && a.taskId === item.id);
    return <li key={item.id}>
      <div><b>{item.title}</b>
        <button className="secondary" disabled={pending(job)} onClick={() => { setError(''); queue('reviewer', 'review', room.id, { taskId: item.id }).catch(e => setError((e as Error).message)); }}>{pending(job) ? <><LoaderCircle className="spin" size={13} /> Reviewing…</> : latest ? 'Review again' : 'Review'}</button>
      </div>
      {failure(job) && <small className="error">{failure(job)}</small>}
      {latest && <details><summary>{latest.text.split('\n')[0].replace(/\*\*/g, '')} · {ago(latest.time, now)}</summary><Lines text={latest.text} /></details>}
    </li>;
  })}{error && <p className="notice error" role="alert">{error}</p>}</ul>;
}

/** What the watcher noticed in this project. */
function WatcherFeed({ fetch, room, now }: { fetch?: FetchState; room: Room; now: number }) {
  const seen = (fetch?.activity || []).filter(a => a.name === 'watcher' && (!a.roomId || a.roomId === room.id)).slice(-20).reverse();
  if (!seen.length) return <p className="quiet-copy">Watching. It reports here when tasks block, finish, need review or wait for approval.</p>;
  return <ol className="fetch-activity">{seen.map(a => <li key={a.id}><small>{ago(a.time, now)}</small><p>{a.text}</p></li>)}</ol>;
}

/** The full view: click an agent to connect to it and work with it; below, what the agents did in this project. */
export function FetchPanel({ fetch, room, onTask }: { fetch?: FetchState; room: Room; onTask: (id: string) => void }) {
  const now = useNow(2000);
  const [open, setOpen] = useState<FetchAgentName | null>(null), [copied, setCopied] = useState(''), [error, setError] = useState('');
  const launcher = fetch?.launcher;
  const connecting = !!launcher?.running && !fetch?.agents.some(a => online(a, now));
  const connect = () => { setError(''); officeApi('/fetch/start', {}).catch(e => setError((e as Error).message)); };
  const choose = (name: FetchAgentName) => {
    const next = open === name ? null : name;
    setOpen(next);
    if (next && !online(agentOf(fetch, next), now) && !launcher?.running) connect();
  };
  const activity = (fetch?.activity || []).filter(a => !a.roomId || a.roomId === room.id).slice(-30).reverse();
  const task = (a: FetchActivity) => a.taskId ? room.workItems.find(t => t.id === a.taskId) : undefined;
  const chosen = open ? agentOf(fetch, open) : undefined, live = online(chosen, now);
  return <div className="fetch-panel">
    <h2>Fetch agents</h2>
    <div className="fetch-cards">{order.map(name => { const a = agentOf(fetch, name), Icon = roles[name].icon; return <button key={name} type="button" aria-pressed={open === name} className={`fetch-card ${online(a, now) ? 'on' : ''} ${open === name ? 'open' : ''}`} onClick={() => choose(name)}>
      <header><Icon size={16} /><b>{roles[name].title}</b><i /></header>
      <p>{roles[name].role}</p><small>{connecting && !online(a, now) ? 'Connecting…' : status(a, now)}</small>
    </button>; })}</div>
    {open && <section className="fetch-detail" aria-label={roles[open].title}>
      <header><b>{roles[open].title}</b>
        {chosen?.address && <button className="text-button" onClick={() => { void navigator.clipboard.writeText(chosen.address).then(() => setCopied(open)); }}><Copy size={12} /> {copied === open ? 'Copied' : 'ASI:One address'}</button>}
      </header>
      {!live ? <div className="fetch-connect">
        {connecting ? <p><LoaderCircle className="spin" size={14} /> Starting the agents… this takes about 20 seconds.</p>
          : <><p className="quiet-copy">{error || launcher?.error || 'Not running.'}</p><button className="primary" disabled={launcher?.ready === false} onClick={connect}>Connect</button></>}
      </div>
        : open === 'office' ? <OfficeChat fetch={fetch} room={room} />
        : open === 'planner' ? <JiraPlanner fetch={fetch} room={room} now={now} />
        : open === 'reviewer' ? <ReviewPicker fetch={fetch} room={room} now={now} />
        : <WatcherFeed fetch={fetch} room={room} now={now} />}
    </section>}
    <h3>Activity</h3>
    {activity.length ? <ol className="fetch-activity">{activity.map(a => { const t = task(a); return <li key={a.id}>
      <span className="fetch-who">{roles[a.name].title}</span><small>{ago(a.time, now)}</small>
      {a.kind === 'review' ? <details><summary>{a.text.split('\n')[0].replace(/\*\*/g, '')}</summary><Lines text={a.text} /></details> : <p>{a.text}</p>}
      {t && <button className="text-button" onClick={() => onTask(t.id)}>Open ticket</button>}
    </li>; })}</ol> : <p className="quiet-copy">Nothing yet.</p>}
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
    {latest ? <><small>{ago(latest.time, now)}</small><Lines text={latest.text} /></> : <p className="quiet-copy">No review yet.</p>}
    {online(reviewer, now) ? <button className="secondary" disabled={pending(job)} onClick={() => { setError(''); queue('reviewer', 'review', room.id, { taskId: item.id }).then(j => setJobId(j.id)).catch(e => setError((e as Error).message)); }}>{pending(job) ? <><LoaderCircle className="spin" size={14} /> Reviewing…</> : latest ? 'Review again' : 'Ask the reviewer'}</button>
      : <small>The reviewer isn't running.</small>}
    {(error || failure(job)) && <p className="notice error" role="alert">{error || failure(job)}</p>}
  </section>;
}
