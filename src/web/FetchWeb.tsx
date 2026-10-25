import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { ClipboardList, ExternalLink, LoaderCircle, MessageSquare, Radar, Send, ShieldCheck } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import '../fetch-agents.css';

// The ASI:One (Fetch.ai) agents in the web office, hosted on Agentverse. Same four agents, names and
// jobs as the local office's panel (src/FetchAgents.tsx), reading and queueing through Convex.

type Snapshot = NonNullable<ReturnType<typeof useSnapshot>>;
type Job = Snapshot['jobs'][number];
type Name = 'office' | 'planner' | 'watcher' | 'reviewer';
type Plan = { epic: { summary: string }; stories: { summary: string; acceptance_criteria: string[] }[] };
const useSnapshot = (projectId: Id<'projects'>) => useQuery(api.fetchAgents.snapshot, { projectId });

const ONLINE_MS = 30000;
const roles: Record<Name, { title: string; role: string; icon: typeof Radar }> = {
  office: { title: 'Office', role: 'Chat', icon: MessageSquare },
  planner: { title: 'Planner', role: 'Jira', icon: ClipboardList },
  watcher: { title: 'Watcher', role: 'Watches', icon: Radar },
  reviewer: { title: 'Reviewer', role: 'Reviews', icon: ShieldCheck },
};
const order: Name[] = ['office', 'planner', 'watcher', 'reviewer'];
const pending = (job?: Job | null) => job?.status === 'queued' || job?.status === 'running';
const failure = (job?: Job | null) => job?.status === 'failed' ? String((job.result as { error?: unknown } | null)?.error || 'The agent could not finish this.') : '';
const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');

function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(timer); }, [ms]);
  return now;
}

/** Review and chat text use **bold** and one item per line, as in ASI:One. */
function Lines({ text }: { text: string }) {
  return <div className="fetch-lines">{text.split('\n').map((line, i) => line.trim() ? <p key={i}>{line.split(/(\*\*[^*]+\*\*)/).map((part, j) => part.startsWith('**') && part.endsWith('**') ? <b key={j}>{part.slice(2, -2)}</b> : part)}</p> : <br key={i} />)}</div>;
}

/** The Fetch.ai tab of the Agents panel: the office, planner, watcher and reviewer. */
export function FetchAgents({ projectId, runs, editor, mine }: { projectId: Id<'projects'>; runs: { id: Id<'agentRuns'>; prompt: string; status: string }[]; editor: boolean; mine: boolean }) {
  const snapshot = useSnapshot(projectId);
  const setDemo = useMutation(api.fetchAgents.setDemo);
  const now = useNow();
  const [open, setOpen] = useState<Name>('office');
  if (!snapshot) return null;
  const agent = (name: Name) => snapshot.agents.find(item => item.name === name);
  // Built in: they run in the backend whenever they're asked, so they're always available.
  const online = (name: Name) => { const row = agent(name); return snapshot.builtIn || (!!row && row.lastSeen > 0 && now - row.lastSeen < ONLINE_MS); };
  return <div className="fetch-web fetch-embedded" aria-label="Fetch.ai agents">
    <p className="web-note">Four Fetch.ai agents that come with every project. They answer with Claude when you've connected a Claude API key under Accounts.</p>
    <div className="web-tabs fetch-web-tabs" role="tablist">
      {order.map(name => { const Icon = roles[name].icon; return <button key={name} role="tab" aria-selected={open === name} onClick={() => setOpen(name)}><Icon size={14} /> {roles[name].title}<i className={`fetch-dot ${online(name) ? 'on' : ''}`} /></button>; })}
    </div>
    {!online(open) && <p className="web-note">The {roles[open].title.toLowerCase()} agent isn't checking in right now. Work you queue waits until it's back.</p>}
    {open === 'office' && <OfficeChat projectId={projectId} jobs={snapshot.jobs} editor={editor} />}
    {open === 'reviewer' && <Reviewer projectId={projectId} jobs={snapshot.jobs} runs={runs} editor={editor} />}
    {open === 'planner' && <Planner projectId={projectId} jobs={snapshot.jobs} editor={editor} jira={snapshot.jira} />}
    {open === 'watcher' && <Activity items={snapshot.activity.filter(item => item.name === 'watcher')} empty="Nothing noticed yet. The watcher notes each agent run on this project as it starts, finishes or fails." />}
    {mine && <label className="web-check fetch-demo"><input type="checkbox" checked={snapshot.demo} onChange={e => void setDemo({ projectId, on: e.target.checked })} /> Also let the agents on ASI:One (Fetch.ai) read this project and start work on your Claude connection</label>}
    {open !== 'watcher' && snapshot.activity.length > 0 && <details className="compact-disclosure"><summary>Recent agent activity · {snapshot.activity.length}</summary><Activity items={snapshot.activity} empty="" /></details>}
  </div>;
}

function useQueue(projectId: Id<'projects'>) {
  const request = useMutation(api.fetchAgents.request);
  const [error, setError] = useState('');
  const send = async (agent: Name, kind: string, extra: { runId?: Id<'agentRuns'>; payload?: Record<string, unknown> } = {}) => {
    setError('');
    try { return await request({ projectId, agent, kind, ...extra }); } catch (e) { setError(message(e)); return null; }
  };
  return { send, error };
}

function OfficeChat({ projectId, jobs, editor }: { projectId: Id<'projects'>; jobs: Job[]; editor: boolean }) {
  const { send, error } = useQueue(projectId);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const chats = jobs.filter(job => job.agent === 'office' && job.kind === 'chat').slice().reverse();
  const waiting = chats.some(pending);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [chats.length, chats.at(-1)?.status]);
  const ask = (value: string) => { if (value.trim()) void send('office', 'chat', { payload: { text: value.trim() } }).then(id => { if (id) setText(''); }); };
  return <div className="fetch-chat">
    <div className="fetch-chat-log" aria-live="polite">
      {!chats.length && <p className="web-note">Ask about this project: status, a report on a run, or start a mission.</p>}
      {chats.map(job => <div key={job.id} className="fetch-chat-turn">
        <p className="fetch-chat-you">{String((job.payload as { text?: unknown })?.text || '')}</p>
        {pending(job) ? <p className="fetch-chat-agent"><LoaderCircle className="spin" size={13} /> {job.status === 'queued' ? 'Sending…' : 'Thinking…'}</p>
          : job.status === 'failed' ? <p className="fetch-chat-agent error">{failure(job)}</p>
          : <div className="fetch-chat-agent"><Lines text={String((job.result as { text?: unknown } | null)?.text || '')} /></div>}
      </div>)}
      <div ref={end} />
    </div>
    {editor ? <>
      <div className="fetch-chat-quick">{['status', 'report', 'help'].map(command => <button key={command} type="button" className="secondary" disabled={waiting} onClick={() => ask(command)}>{command}</button>)}</div>
      <form onSubmit={event => { event.preventDefault(); ask(text); }}>
        <input value={text} maxLength={4000} placeholder="Message the office agent" onChange={e => setText(e.target.value)} />
        <button className="primary" disabled={waiting || !text.trim()} aria-label="Send"><Send size={14} /></button>
      </form>
    </> : <p className="web-note">Editors of this project can message the office agent.</p>}
    {error && <p className="web-error" role="alert">{error}</p>}
  </div>;
}

function Reviewer({ projectId, jobs, runs, editor }: { projectId: Id<'projects'>; jobs: Job[]; runs: { id: Id<'agentRuns'>; prompt: string; status: string }[]; editor: boolean }) {
  const { send, error } = useQueue(projectId);
  const finished = runs.filter(run => run.status === 'done' || run.status === 'error').slice(0, 8);
  if (!finished.length) return <p className="web-note">When an agent finishes a run, ask the reviewer whether its output supports what was asked.</p>;
  return <ul className="fetch-reviews">
    {finished.map(run => {
      const job = jobs.find(item => item.agent === 'reviewer' && item.runId === run.id);
      return <li key={run.id}>
        <b>{run.prompt.split('\n')[0].slice(0, 90)}</b>
        {job && !pending(job) && job.status === 'done' && <Lines text={String((job.result as { text?: unknown } | null)?.text || '')} />}
        {job && failure(job) && <p className="web-error">{failure(job)}</p>}
        {editor && <button className="secondary" disabled={pending(job)} onClick={() => void send('reviewer', 'review', { runId: run.id })}>{pending(job) ? <><LoaderCircle className="spin" size={13} /> Reviewing…</> : job ? 'Review again' : 'Ask the reviewer'}</button>}
      </li>;
    })}
    {error && <p className="web-error" role="alert">{error}</p>}
  </ul>;
}

function Planner({ projectId, jobs, editor, jira }: { projectId: Id<'projects'>; jobs: Job[]; editor: boolean; jira: { project: string; site: string } | null }) {
  const { send, error } = useQueue(projectId);
  const [idea, setIdea] = useState('');
  const [planId, setPlanId] = useState<string | null>(null), [createId, setCreateId] = useState<string | null>(null), [starts, setStarts] = useState<Record<string, string>>({});
  const byId = (id: string | null) => (id ? jobs.find(job => job.id === id) ?? null : null);
  const drafted = byId(planId), created = byId(createId);
  const plan = drafted?.status === 'done' ? (drafted.result as { plan?: Plan } | null)?.plan : undefined;
  const issues = created?.status === 'done' ? (created.result as { issues?: { key: string; summary: string }[] } | null)?.issues : undefined;
  const project = jira?.project ?? '', site = jira?.site ?? '';
  if (!editor) return <p className="web-note">Editors of this project can plan work with the planner.</p>;
  return <div className="fetch-planner">
    <label>What should the team build?<textarea rows={3} value={idea} placeholder="Search box reachable by keyboard; Enter submits; show a no-results message" onChange={e => setIdea(e.target.value)} /></label>
    <button className="primary" disabled={idea.trim().length < 6 || pending(drafted)} onClick={() => void send('planner', 'plan', { payload: { idea } }).then(id => { if (id) { setPlanId(id); setCreateId(null); setStarts({}); } })}>{pending(drafted) ? <><LoaderCircle className="spin" size={14} /> Drafting…</> : project ? `Draft stories for ${project}` : 'Draft stories'}</button>
    {(error || failure(drafted) || failure(created)) && <p className="web-error" role="alert">{error || failure(drafted) || failure(created)}</p>}
    {plan && !issues && <div className="fetch-plan">
      <b>{plan.epic.summary}</b>
      <ol>{plan.stories.map((story, i) => <li key={i}>{story.summary}<ul>{story.acceptance_criteria.map((item, j) => <li key={j}>{item}</li>)}</ul></li>)}</ol>
      {project
        ? <button className="primary" disabled={pending(created)} onClick={() => void send('planner', 'create', { payload: { plan } }).then(id => id && setCreateId(id))}>{pending(created) ? <><LoaderCircle className="spin" size={14} /> Creating…</> : `Create ${plan.stories.length} stories in Jira`}</button>
        : <p className="web-note">To create these in Jira, add JIRA_SITE, JIRA_EMAIL, JIRA_TOKEN and JIRA_PROJECT to Convex. Or start one now from the office chat: <code>mission {plan.stories[0]?.summary}</code></p>}
    </div>}
    {issues && <ul className="fetch-issues">{issues.map(issue => { const job = byId(starts[issue.key] || null); return <li key={issue.key}>
      <a href={`${site}/browse/${issue.key}`} target="_blank" rel="noreferrer">{issue.key} <ExternalLink size={11} /></a><span>{issue.summary}</span>
      {job?.status === 'done' ? <em>Started</em> : <button className="secondary" disabled={pending(job)} onClick={() => void send('planner', 'start', { payload: { key: issue.key } }).then(id => id && setStarts(current => ({ ...current, [issue.key]: id })))}>{pending(job) ? 'Starting…' : 'Start'}</button>}
      {failure(job) && <small className="error">{failure(job)}</small>}
    </li>; })}</ul>}
  </div>;
}

function Activity({ items, empty }: { items: Snapshot['activity']; empty: string }) {
  if (!items.length) return empty ? <p className="web-note">{empty}</p> : null;
  return <ul className="fetch-activity">{items.map(item => <li key={item.id}><b>{roles[item.name as Name]?.title || item.name}</b> <span>{new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><Lines text={item.text} /></li>)}</ul>;
}
