import { useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, BriefcaseBusiness, Check, ChevronDown, Expand, FileCode2, LayoutGrid, LoaderCircle, Monitor, Pause, Play, Send, Sparkles, Wind, X, Zap } from 'lucide-react';
import { HandoffDossier, agentWork, officeApi, workLabels } from './Operations';
import { DiffButton } from './WorkArtifacts';
import { agentSpeech, modelLabel } from './identity';
import { reporterName, selfReported } from './reporters';
import { accessoriesFor, costumeColors, type CostumeKind } from './costume';
import type { Agent, OfficeState, Room } from './types';

// The agent's own panel, opened by clicking its desk in the office: who it is, what it's doing, its
// activity, plan, changes and handoff, and the controls to message, pause, eject or replace it. This is
// the local office's AgentPanel from before the simpler layout, brought back beside the Agents list.

type Action = (fn: () => Promise<unknown>, success?: string) => void;

const statusLabels: Record<string, string> = { working: 'Working', talking: 'Collaborating', done: 'Turn finished', idle: 'Ready', paused: 'Paused', approval: 'Needs you', error: 'Blocked', ejected: 'Ejected' };

function BlobHat({ kind }: { kind: CostumeKind }) {
  const { hat, trim } = costumeColors[kind];
  if (kind === 'manager') return <g><ellipse cx="21" cy="8.2" rx="16" ry="3" fill={hat} /><rect x="12" y="0.6" width="18" height="8" rx="1.4" fill={hat} /><rect x="12" y="5.6" width="18" height="1.8" fill={trim} /></g>;
  if (kind === 'research') return <g><ellipse cx="21" cy="5.5" rx="11" ry="5" fill={hat} /><path d="M9 8h24l-4 4H13z" fill={hat} /></g>;
  if (kind === 'build') return <g><ellipse cx="21" cy="9" rx="16" ry="2.8" fill={hat} /><ellipse cx="21" cy="6" rx="11" ry="5" fill={hat} /><rect x="19.2" y="3.2" width="3.6" height="2.2" fill={trim} /></g>;
  if (kind === 'test') return <g><ellipse cx="21" cy="6" rx="11" ry="4.5" fill={hat} /><ellipse cx="8" cy="10" rx="3.2" ry="4.2" fill={hat} /><ellipse cx="34" cy="10" rx="3.2" ry="4.2" fill={hat} /><path d="M12 8h18l-3 3H15z" fill={trim} /></g>;
  return <g><path d="M8 9h26l-4 3H12z" fill={hat} /><rect x="12" y="2" width="18" height="7" rx="1" fill={hat} /><rect x="12" y="6.2" width="18" height="1.4" fill={trim} /></g>;
}

function Avatar({ agent, size = '' }: { agent: Agent; size?: string }) {
  const displayModel = agent.effectiveModel || agent.model;
  const look = displayModel.toLowerCase().includes('grok') ? ['GROK', '#3d8eb8'] : agent.provider === 'cursor' ? ['CURSOR', '#3d8eb8'] : agent.provider === 'claude' || agent.provider === 'claude-code' ? ['CLAUDE', '#d97757'] : displayModel.includes('astra') ? ['ASTRA', '#e06a3c'] : displayModel.includes('sol') ? ['SOL', '#e2b043'] : displayModel.includes('terra') ? ['TERRA', '#3d9a68'] : displayModel.includes('luna') ? ['LUNA', '#9a62b8'] : ['AUTO', '#3a9a8c'];
  const costume = accessoriesFor(agent);
  return <span className={`avatar blob-avatar ${size} ${agent.status}`} style={{ '--agent-color': look[1] } as CSSProperties}><svg className="blob-body" viewBox="0 0 42 45" aria-hidden="true"><circle cx="21" cy="22" r="19" fill={look[1]} /><g className="blob-eyes"><ellipse cx="16" cy="18" rx="4.1" ry="5.1" fill="#f8f8ef" /><ellipse cx="27" cy="18" rx="4.1" ry="5.1" fill="#f8f8ef" /><ellipse cx="16.4" cy="18.7" rx="1.7" ry="2.3" fill="#34443b" /><ellipse cx="27.4" cy="18.7" rx="1.7" ry="2.3" fill="#34443b" /></g><text x="21" y="32" textAnchor="middle" fill="#34443b" fontSize="5" fontWeight="700">{agent.name.slice(0, 8)}</text>{costume.bow && <g fill={costumeColors[costume.kind].bow}><path d="M9 37.2 16.2 34.2v6.2z" /><path d="M33 37.2 25.8 34.2v6.2z" /><circle cx="21" cy="37.2" r="2.1" /></g>}{costume.coffee && <g><rect x="31" y="20" width="7" height="10" rx="2" fill="#f3eee4" /><rect x="32" y="20.4" width="5" height="2.2" fill="#4a3428" /><path d="M38 23h2.1a2.2 2.2 0 0 1 0 4.4H38" fill="none" stroke="#f3eee4" strokeWidth="1.3" /></g>}</svg>{costume.hat && <svg className="blob-hat" viewBox="0 0 42 45" aria-hidden="true"><BlobHat kind={costume.kind} /></svg>}{agent.manager && <i><BriefcaseBusiness size={9} /></i>}</span>;
}

function Empty({ icon: Icon, text }: { icon: typeof Monitor; text: string }) { return <div className="empty"><Icon size={30} strokeWidth={1.3} /><p>{text}</p></div>; }
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The models an agent can be replaced with: Codex's, and Claude's when Claude is connected. */
function ModelOptions({ data }: { data: OfficeState }) {
  return <><optgroup label="Codex">{!data.connection.models.some(m => m.id === 'gpt-6-sol') && <option value="gpt-6-sol">GPT-6 Sol</option>}<option value="Account default">Account default</option>{data.connection.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>{data.claude?.configured && <optgroup label="Claude">{data.claude.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>}</>;
}

export function AgentDetail({ agent: a, room, data, busy, action, onSelect, onFocus, onClose }: { agent: Agent; room: Room; data: OfficeState; busy: boolean; action: Action; onSelect: (id: string) => void; onFocus: () => void; onClose: () => void }) {
  const [tab, setTab] = useState('activity');
  const [message, setMessage] = useState('');
  const [replace, setReplace] = useState(false);
  const [model, setModel] = useState(a.provider === 'claude' && a.model ? a.model : 'gpt-6-sol');
  const [confirmedStopped, setConfirmedStopped] = useState(false);
  const connected = !!data.connection.account;
  const endpoint = `/rooms/${room.id}/agents/${a.id}`;
  const task = agentWork(room, a);
  const readOnly = !!room.viewOnly;
  let body: ReactNode = null;
  if (tab === 'activity') body = <div className="event-list">{!a.events.length && <Empty icon={Monitor} text="No activity yet." />}{a.events.slice(-25).map(e => <div className={`work-event ${e.kind}`} key={e.id}><div><span>{e.kind === 'update' ? 'PROGRESS' : e.kind.toUpperCase()}</span><time>{time(e.time)}</time></div><p>{e.text}</p></div>)}</div>;
  if (tab === 'handoff') body = <HandoffDossier agent={a} />;
  if (tab === 'plan') body = <div className="plan-list">{a.plan.length ? a.plan.map((p, i) => <div key={i}>{p.status === 'completed' ? <Check size={17} /> : p.status === 'inProgress' ? <LoaderCircle size={17} /> : <span className="plan-circle" />}<span>{p.step}<small>{p.status === 'inProgress' ? 'In progress' : p.status}</small></span></div>) : <Empty icon={LayoutGrid} text="No plan yet." />}</div>;
  if (tab === 'changes') body = a.diff ? <><div className="artifact-actions"><DiffButton title={a.task} entries={[{ text: a.diff, label: 'Latest agent turn' }]} /></div><pre className="diff">{a.diff}</pre></> : <Empty icon={FileCode2} text={room.demo ? 'Sample agents do not change files.' : 'No file diff reported for this turn.'} />;

  return <aside className="agent-detail-panel" aria-label={`${a.name}'s desk`}>
    <button className="icon-button agent-detail-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
    <div className="agent-heading" aria-label={agentSpeech(a)}><Avatar agent={a} size="large" /><div><h2>{a.name}</h2><p>{a.title || a.role}</p></div><button className="icon-button" title="Go to desk" aria-label="Go to desk" onClick={onFocus}><Expand size={18} /></button></div>
    <div className="agent-meta"><span className={`status status-${a.status}`}><i />{statusLabels[a.status]}</span><span>{modelLabel(a.effectiveModel || a.model)}{selfReported(a) && !a.model.includes('not reported') && ' · reported'}</span></div>
    <h3 className="task-heading">{task?.title || a.task}</h3>
    {task && <p className="muted small">Ticket · {workLabels[task.status]}. Its files and diff are in the Agents list.</p>}
    {selfReported(a) && <p className="notice">{a.turnId ? `Execution managed in ${reporterName(a)}. Stop and change models there.` : `${reporterName(a)} assignment closed. Inspect saved work.`}</p>}
    {!readOnly && !selfReported(a) && <details className="compact-disclosure"><summary>Model settings</summary><div className="speed-control"><div><b>{a.fastMode ? 'Fast requested' : 'Standard speed'}</b><small>Next turn</small></div><button className="secondary" disabled={busy || a.status === 'ejected'} onClick={() => action(async () => { await officeApi(endpoint + '/speed', { fast: !a.fastMode }); }, a.fastMode ? 'Standard speed selected for the next turn' : 'Fast mode requested for the next turn')}><Zap size={14} />{a.fastMode ? 'Use standard' : 'Use fast'}</button></div><p className="speed-cost">Fast may use more quota. Crunch overrides this preference.</p></details>}
    {!selfReported(a) && (!!a.tokens || !!a.plan.length) && <div className="agent-metrics"><span><Zap size={13} /> {a.tokens ? a.tokens.toLocaleString() : '—'} tokens</span><span>{a.plan.filter(step => step.status === 'completed').length}/{a.plan.length} plan steps</span></div>}
    <div className="tabs">{(selfReported(a) ? ['activity', 'changes', 'handoff'] : ['activity', 'plan', 'changes', 'handoff']).map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
    {body}
    {!readOnly && !selfReported(a) && a.status !== 'ejected' && <form className="message-form" onSubmit={e => { e.preventDefault(); action(async () => { await officeApi(`${endpoint}/message`, { message }); setMessage(''); }, 'Message delivered'); }}><label className="sr-only" htmlFor="agent-message">Message {a.name}</label><textarea id="agent-message" rows={2} placeholder={a.turnId ? `Guidance for ${a.name}…` : `Start ${a.name} with an instruction…`} value={message} onChange={e => setMessage(e.target.value)} required /><button aria-label={a.turnId ? 'Send guidance' : 'Start agent'} disabled={busy || !message.trim() || room.paused || (!room.demo && !connected && a.provider !== 'claude')}>{a.turnId ? <Send size={17} /> : <Play size={17} />}</button></form>}
    {!readOnly && selfReported(a) && a.turnId && <details className="compact-disclosure"><summary>{reporterName(a)} session ended?</summary><p>Stop it in {reporterName(a)} first. Releasing this desk preserves its work and lets another agent continue.</p><label className="cursor-release-check"><input type="checkbox" checked={confirmedStopped} onChange={e => setConfirmedStopped(e.target.checked)} /> {reporterName(a)} has finished or stopped</label><button className="secondary full" disabled={busy || !confirmedStopped} onClick={() => action(() => officeApi(`/rooms/${room.id}/${a.provider}/${a.id}/release`, { confirmedStopped: true }), 'Assignment released. Saved work needs review.')}>Release assignment</button></details>}
    {!readOnly && <div className="agent-actions">{!selfReported(a) && !['paused', 'ejected', 'done', 'idle', 'error'].includes(a.status) && <button className="secondary" disabled={busy} onClick={() => action(() => officeApi(`${endpoint}/stop`, {}), 'Agent paused')}><Pause size={14} /> Pause</button>}{a.status !== 'ejected' && <button className="eject-button" disabled={busy || (selfReported(a) && !!a.turnId)} onClick={() => action(() => officeApi(`${endpoint}/eject`, {}), `${a.name} left through the window. Handoff saved.`)}><Wind size={16} /> Eject through window <ArrowUpRight size={13} /></button>}</div>}
    {a.replacedBy && <button className="secondary full" onClick={() => onSelect(a.replacedBy!)}>Open replacement <ArrowRight size={14} /></button>}
    {!readOnly && !a.replacedBy && ['paused', 'ejected', 'done', 'idle', 'error'].includes(a.status) && <><button className="secondary full" onClick={() => setReplace(v => !v)}><Sparkles size={16} /> Replace with another model <ChevronDown size={14} /></button>{replace && <form className="replace-form" onSubmit={e => { e.preventDefault(); action(async () => { const result = await officeApi(`${endpoint}/replace`, { model }); onSelect(result.agent.id); }, 'Replacement started with the saved handoff'); }}><label>Replacement model<select value={model} onChange={e => setModel(e.target.value)}><ModelOptions data={data} /></select></label><p className="muted small">Saved context carries over.{selfReported(a) && ' The replacement runs in the office on the model chosen here.'}</p><button className="primary full" disabled={busy || (!room.demo && !connected && !model.startsWith('claude-'))}><Play size={14} /> Start replacement</button></form>}</>}
    {a.threadId && <p className="thread-id">TASK {a.threadId}</p>}
  </aside>;
}
