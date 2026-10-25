import { useState, type ReactNode } from 'react';
import type { Agent, FetchState, OfficeIdentity, Room } from './types';
import { FetchPanel, TicketAgents } from './FetchAgents';
import { agentCharge, modelLabel } from './identity';
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

  return <aside className="agent-side" aria-label="Office">
    {share}
    <header><b>Agents</b><span>{agents.length}</span></header>
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
  </aside>;
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
      <form onSubmit={event => { event.preventDefault(); action(async () => { await officeApi(`/rooms/${room.id}/agents/${agent.id}/message`, { message: note.trim() }); setNote(''); }, 'Message sent'); }}>
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

function TicketRow({ room, item, agent, fetch, onSelect }: { room: Room; item: WorkItemFiles; agent: Agent; fetch?: FetchState; onSelect: (id: string) => void }) {
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

