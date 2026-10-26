import { useState, type ReactNode } from 'react';
import type { Agent, FetchState, OfficeIdentity, Room } from './types';
import { FetchPanel, TicketAgents } from './FetchAgents';
import { agentCharge, agentLine, modelLabel } from './identity';
import { officeApi, WorkDetail, workColors, workLabels, type Action } from './Operations';
import { HandoffsPanel } from './HandoffsPanel';
import { agentIsMine, diffFiles, ownerLabel, ticketDiff, type FileDiff } from './office-panel';

const agentStatus: Record<string, string> = { working: 'Working', talking: 'Collaborating', done: 'Turn finished', idle: 'Ready', paused: 'Paused', approval: 'Needs you', error: 'Blocked', ejected: 'Ejected' };

export function AgentSide({ room, identities, ownRoomId, busy, selectedId, models, fetch, action, onSelect, onCloned, share }: {
  room: Room;
  identities: OfficeIdentity[];
  ownRoomId: string;
  busy: boolean;
  selectedId: string | null;
  models: { id: string; name: string }[];
  fetch?: FetchState;
  action: Action;
  onSelect: (id: string) => void;
  onCloned: (roomId: string, agentId: string) => void;
  share?: ReactNode;
}) {
  const agents = room.agents.filter(agent => agent.status !== 'ejected');
  const selected = agents.find(agent => agent.id === selectedId) || null;
  const viewingShared = !!room.viewOnly;
  const [tab, setTab] = useState<'agents' | 'tickets' | 'handoffs'>('agents');
  const tickets = room.workItems.filter(item => !item.archived);
  // Opening an agent from a ticket or a handoff shows it on the Agents tab.
  const openAgent = (id: string) => { setTab('agents'); onSelect(id); };

  return <aside className="agent-side" aria-label="Office">
    {share}
    <nav className="agent-side-tabs" aria-label="Office views">
      <button type="button" aria-pressed={tab === 'agents'} onClick={() => setTab('agents')}>Agents <span>{agents.length}</span></button>
      <button type="button" aria-pressed={tab === 'tickets'} onClick={() => setTab('tickets')}>Tickets <span>{tickets.filter(item => item.status !== 'done').length}</span></button>
      <button type="button" aria-pressed={tab === 'handoffs'} onClick={() => setTab('handoffs')}>Handoffs <span>{room.messages.length}</span></button>
    </nav>
    {tab === 'tickets' && <TicketBoard room={room} agents={viewingShared ? [] : agents.filter(agent => agentIsMine(agent, identities))} identities={identities} preferId={selected?.id} busy={busy} fetch={fetch} action={action} onSelect={openAgent} />}
    {tab === 'handoffs' && <HandoffsPanel room={room} onAgent={openAgent} onTask={() => setTab('tickets')} />}
    {tab === 'agents' && <>
    {!agents.length && <p className="agent-side-note">No agents in this office.</p>}
    <ul className="agent-side-list">
      {agents.map(agent => {
        const mine = !viewingShared && agentIsMine(agent, identities);
        const owner = viewingShared ? (room.goal.replace(/'s project$/, '') || 'Shared') : ownerLabel(agent, identities);
        return <li key={agent.id}>
          <button type="button" className={agent.id === selected?.id ? 'selected' : ''} onClick={() => onSelect(agent.id)}>
            <b>{agentCharge(agent)}</b>
            <small>{owner} · {modelLabel(agent.effectiveModel || agent.model)} · {agentStatus[agent.status] || agent.status}</small>
          </button>
        </li>;
      })}
    </ul>
    {selected && <SelectedAgent key={selected.id} room={room} agent={selected} identities={identities} ownRoomId={ownRoomId} busy={busy} models={models} fetch={fetch} action={action} onSelect={onSelect} onCloned={onCloned} />}
    {fetch && !room.viewOnly && <FetchPanel fetch={fetch} room={room} onTask={() => {}} />}
    </>}
  </aside>;
}

/** Turns a chat message into a ticket owned by the agent, then hands the message to that agent. */
async function assignTicket(roomId: string, agentId: string, text: string) {
  const line = text.split('\n')[0].trim();
  const title = (line.length > 120 ? `${line.slice(0, 119)}…` : line).padEnd(3, '.');
  await officeApi(`/rooms/${roomId}/work`, { title, description: text.padEnd(3, '.'), acceptanceCriteria: ['The requested outcome is done'], agentId });
  await officeApi(`/rooms/${roomId}/agents/${agentId}/message`, { message: text });
}

const ticketOrder: Record<string, number> = { working: 0, queued: 1, review: 2, blocked: 3, ready: 4, done: 5 };

function TicketBoard({ room, agents, identities, preferId, busy, fetch, action, onSelect }: {
  room: Room; agents: Agent[]; identities: OfficeIdentity[]; preferId?: string; busy: boolean; fetch?: FetchState; action: Action; onSelect: (id: string) => void;
}) {
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState(() => agents.find(agent => agent.id === preferId)?.id || agents[0]?.id || '');
  const owner = agents.some(agent => agent.id === agentId) ? agentId : agents[0]?.id || '';
  const items = room.workItems.filter(item => !item.archived).sort((a, b) => (ticketOrder[a.status] ?? 9) - (ticketOrder[b.status] ?? 9) || b.updatedAt - a.updatedAt);
  return <section className="agent-side-detail" aria-label="Tickets">
    {!!agents.length && <form onSubmit={event => { event.preventDefault(); action(async () => { await assignTicket(room.id, owner, text.trim()); setText(''); }, 'Ticket assigned'); }}>
      <label>New ticket<textarea value={text} onChange={event => setText(event.target.value)} rows={3} maxLength={12000} placeholder="What should get done" required /></label>
      <label>Assign to
        <select value={owner} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agentLine(agent)}</option>)}</select>
      </label>
      <button className="secondary" disabled={busy || text.trim().length < 3 || !owner}>Assign</button>
    </form>}
    {!items.length && <p className="agent-side-note">No tickets yet. {agents.length ? 'Write one above, or direct an agent, and it shows up here.' : ''}</p>}
    {items.map(item => {
      const agent = room.agents.find(entry => entry.id === item.agentId);
      return <div key={item.id}>
        <TicketRow room={room} item={item} agent={agent} fetch={fetch} onSelect={onSelect} />
        <p className="agent-side-note">{agent ? <button type="button" onClick={() => onSelect(agent.id)}>{agentLine(agent)}</button> : 'Unassigned'}{agent && ` · ${ownerLabel(agent, identities)}`}</p>
      </div>;
    })}
  </section>;
}

function SelectedAgent({ room, agent, identities, ownRoomId, busy, models, fetch, action, onSelect, onCloned }: {
  room: Room; agent: Agent; identities: OfficeIdentity[]; ownRoomId: string; busy: boolean; models: { id: string; name: string }[]; fetch?: FetchState; action: Action; onSelect: (id: string) => void; onCloned: (roomId: string, agentId: string) => void;
}) {
  const mine = !room.viewOnly && agentIsMine(agent, identities);
  const owner = room.viewOnly ? room.goal.replace(/'s project$/, '') || 'Shared' : ownerLabel(agent, identities);
  const [note, setNote] = useState('');
  const tickets = room.workItems.filter(item => item.agentId === agent.id && !item.archived);
  const paused = ['paused', 'idle', 'error', 'done'].includes(agent.status);
  const options = models.some(model => model.id === agent.model) || !agent.model ? models : [{ id: agent.model, name: modelLabel(agent.model) }, ...models];

  return <div className="agent-side-detail">
    <h2>{agentCharge(agent)}</h2>
    {mine ? <>
      <label>Model
        <select value={agent.model} disabled={busy} onChange={event => action(async () => { await officeApi(`/rooms/${room.id}/agents/${agent.id}/model`, { model: event.target.value }); }, 'Model saved for the next turn')}>
          {options.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      <button type="button" className="secondary" disabled={busy} onClick={() => action(() => officeApi(`/rooms/${room.id}/agents/${agent.id}/${paused ? 'resume' : 'stop'}`, {}), paused ? 'Agent resumed' : 'Agent paused')}>{paused ? 'Resume' : 'Pause'}</button>
      <form onSubmit={event => { event.preventDefault(); action(async () => { await assignTicket(room.id, agent.id, note.trim()); setNote(''); }, 'Ticket assigned and sent'); }}>
        <label>Direct this agent<textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={12000} placeholder="What this agent should do next" required /></label>
        <button className="secondary" disabled={busy || !note.trim()}>Send</button>
      </form>
    </> : <>
      <p className="agent-side-note">{owner} · {modelLabel(agent.effectiveModel || agent.model)} · {agentStatus[agent.status] || agent.status}</p>
      <p>{agent.task}</p>
      <button type="button" className="secondary" disabled={busy || !ownRoomId} onClick={() => action(async () => {
        const result = await officeApi(`/rooms/${ownRoomId}/agents/clone`, {
          ...(room.viewOnly ? {} : { agentId: agent.id }),
          model: agent.effectiveModel || agent.model,
          role: agent.role,
          task: agent.task,
          context: agent.handoffPacket?.instruction || agent.task,
        });
        onCloned(ownRoomId, result.agent.id);
      }, 'Cloned into your project')}>Clone to my project</button>
    </>}
    <h3>Tickets</h3>
    {!tickets.length && <p className="agent-side-note">No tickets for this agent.</p>}
    {tickets.map(item => <TicketRow key={item.id} room={room} item={item} agent={agent} fetch={fetch} onSelect={onSelect} />)}
    <HandoffsPanel room={room} fromId={agent.id} onAgent={onSelect} onTask={() => {}} />
  </div>;
}

function TicketRow({ room, item, agent, fetch, onSelect }: { room: Room; item: WorkItemFiles; agent?: Agent; fetch?: FetchState; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const files = diffFiles(ticketDiff(item, agent), item.files || []);
  const shown = file ? files.find(entry => entry.path === file) : null;
  return <div className="agent-side-ticket">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span style={{ color: workColors[item.status] }}>{workLabels[item.status]}</span>
      <b>{item.title}</b>
      <small>{files.length} file{files.length === 1 ? '' : 's'}</small>
    </button>
    {open && <div className="agent-side-ticket-detail">
      <WorkDetail room={room} itemId={item.id} hideHeading readOnly onSelect={onSelect} onTask={() => {}} />
      {fetch && <TicketAgents fetch={fetch} room={room} item={item} />}
      <ul>
        {files.map(entry => <li key={entry.path}><button type="button" onClick={() => setFile(current => current === entry.path ? null : entry.path)}>{entry.path} <small>+{entry.added} / −{entry.removed}</small></button></li>)}
        {!files.length && <li>No changed files.</li>}
      </ul>
      {shown && <DiffView entry={shown} />}
    </div>}
  </div>;
}

type WorkItemFiles = Room['workItems'][number];

function DiffView({ entry }: { entry: FileDiff }) {
  if (!entry.body) return <p className="agent-side-note">No diff recorded for this file.</p>;
  return <pre className="agent-side-diff" aria-label={`Diff for ${entry.path}`}>{entry.body.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-added' : line.startsWith('-') && !line.startsWith('---') ? 'diff-removed' : ''}>{line || ' '}{'\n'}</span>)}</pre>;
}

