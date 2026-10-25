import { useState, type ComponentType, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { ArrowRight, Play, RotateCcw, Send, Square, Trash2 } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

// The team in the web office: each agent with the tickets it's doing underneath. The project manager
// takes requests and splits them into tickets for each role (convex/tickets.ts). A ticket passed from
// one agent to another notes the handoff. Archived tickets go to the folder at the bottom.

export type Ticket = NonNullable<ReturnType<typeof useTickets>>[number];
export const useTickets = (projectId: Id<'projects'>) => useQuery(api.tickets.list, { projectId });
type TeamAgent = { id: Id<'projectAgents'>; name: string; role: string; manager: boolean };
type Log = ComponentType<{ runId: Id<'agentRuns'> }>;

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');
export const ticketLabel: Record<Ticket['status'], string> = { planning: 'Planning', todo: 'To do', working: 'Working', done: 'Done', failed: 'Failed' };
const ticketColor: Record<Ticket['status'], string> = { planning: '#b88732', todo: '#8a969f', working: '#477ead', done: '#38826c', failed: '#b55c48' };
const ticketOrder: Record<Ticket['status'], number> = { working: 0, planning: 1, todo: 2, failed: 3, done: 4 };
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Tickets in the order an agent's list shows them: what's happening now first, then newest. */
export const sortTickets = (tickets: Ticket[]) => tickets.slice().sort((a, b) => ticketOrder[a.status] - ticketOrder[b.status] || b.createdAt - a.createdAt);

/** Asking the project manager for something: it plans, hands out tickets and brings in agents. */
export function AskManager({ projectId, manager }: { projectId: Id<'projects'>; manager?: TeamAgent }) {
  const request = useMutation(api.tickets.request);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = manager?.name ?? 'the project manager';
  return <form className="web-start web-ask" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await request({ projectId, text }); setText(''); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }}>
    <label htmlFor="web-ask-text">Ask {name}{manager ? ', the project manager' : ''}</label>
    <textarea id="web-ask-text" value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={8000} placeholder="What should the team do? For example: add a dark mode toggle to the settings page" />
    <button className="primary" disabled={busy || text.trim().length < 3}><Send size={14} /> {busy ? 'Sending…' : `Send to ${manager?.name ?? 'project manager'}`}</button>
    <small className="web-note">{name} splits it into tickets for each role, hands them out, and brings in an agent for any role the team doesn't have yet.</small>
    {error && <p className="web-error" role="alert">{error}</p>}
  </form>;
}

/** One ticket under its agent: open it for the details, its handoffs and its agent's run. */
export function TicketItem({ ticket, team, editor, Log }: { ticket: Ticket; team: TeamAgent[]; editor: boolean; Log: Log }) {
  const start = useMutation(api.tickets.start);
  const handOff = useMutation(api.tickets.handOff);
  const archive = useMutation(api.tickets.archive);
  const stop = useMutation(api.agentRuns.stop);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const act = (fn: () => Promise<unknown>) => { setError(''); fn().catch(e => setError(message(e))); };
  const last = ticket.handoffs[ticket.handoffs.length - 1];
  // Handed on by a teammate rather than given out by the manager when it was planned.
  const passed = ticket.handoffs.length > 1 || (!!last && !team.find(agent => agent.name === last.from)?.manager);
  const others = team.filter(agent => agent.id !== ticket.agentId && !agent.manager);
  return <li className={`web-ticket ${open ? 'open' : ''}`}>
    <div className="web-ticket-head">
      <button type="button" className="web-ticket-title" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <i style={{ background: ticketColor[ticket.status] }} />
        <span><b>{ticket.title}</b>
          <small>{ticketLabel[ticket.status]}{passed && last ? <> · handed off from {last.from} <ArrowRight size={10} /> {last.to}</> : last ? ` · from ${last.from}` : ''}</small>
        </span>
      </button>
      {editor && !ticket.archivedAt && <button type="button" className="icon-button web-ticket-trash" aria-label="Move ticket to the archive" title="Archive" onClick={() => act(() => archive({ ticketId: ticket.id, archived: true }))}><Trash2 size={13} /></button>}
    </div>
    {ticket.note && <p className="web-ticket-note">{ticket.note}</p>}
    {open && <div className="web-ticket-body">
      <p className="web-ticket-text">{ticket.description}</p>
      {!!ticket.handoffs.length && <ul className="web-handoffs" aria-label="Handoffs">
        {ticket.handoffs.map((handoff, index) => <li key={index}><b>{handoff.from}</b> <ArrowRight size={11} /> <b>{handoff.to}</b> <small>{time(handoff.at)}</small>{handoff.note && <span>{handoff.note}</span>}</li>)}
      </ul>}
      {ticket.result && ticket.status !== 'working' && <p className="web-ticket-text"><b>Result:</b> {ticket.result}</p>}
      {ticket.runId && <Log runId={ticket.runId} />}
      {editor && <div className="web-lasting-actions">
        {(ticket.status === 'todo' || ticket.status === 'failed' || ticket.status === 'done') && ticket.agentId && <button className="text-button" onClick={() => act(() => start({ ticketId: ticket.id }))}><Play size={12} /> {ticket.status === 'todo' ? 'Start' : 'Run again'}</button>}
        {ticket.status === 'working' && ticket.runId && ticket.runMine && <button className="text-button danger" onClick={() => act(() => stop({ runId: ticket.runId! }))}><Square size={12} /> Stop</button>}
        {ticket.status !== 'working' && ticket.status !== 'planning' && !!others.length && <span className="web-handoff-pick">
          <select value={to} onChange={e => setTo(e.target.value)} aria-label="Hand off to"><option value="">Hand off to…</option>{others.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}</select>
          <button className="text-button" disabled={!to} onClick={() => act(async () => { await handOff({ ticketId: ticket.id, toAgentId: to as Id<'projectAgents'> }); setTo(''); })}>Hand off</button>
        </span>}
      </div>}
    </div>}
    {error && <p className="web-error" role="alert">{error}</p>}
  </li>;
}

/** The archive folder at the bottom: archived tickets, to restore or delete for good. */
/** Archived tickets, plus any finished runs the office passes in as children (`runs` counts them). */
export function TicketArchive({ tickets, team, editor, runs = 0, children }: { tickets: Ticket[]; team: TeamAgent[]; editor: boolean; runs?: number; children?: ReactNode }) {
  const archive = useMutation(api.tickets.archive);
  const remove = useMutation(api.tickets.remove);
  const [error, setError] = useState('');
  const act = (fn: () => Promise<unknown>) => { setError(''); fn().catch(e => setError(message(e))); };
  if (!tickets.length && !runs) return null;
  return <details className="web-archive">
    <summary><Trash2 size={13} /> Archive <span>{tickets.length + runs}</span></summary>
    <ul>
      {tickets.slice().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)).map(ticket => <li key={ticket.id}>
        <span><b>{ticket.title}</b><small>{team.find(agent => agent.id === ticket.agentId)?.name ?? 'Unassigned'} · {ticketLabel[ticket.status]}</small></span>
        {editor && <>
          <button className="icon-button" aria-label="Restore ticket" title="Restore" onClick={() => act(() => archive({ ticketId: ticket.id, archived: false }))}><RotateCcw size={13} /></button>
          <button className="icon-button danger" aria-label="Delete ticket for good" title="Delete for good" onClick={() => { if (confirm(`Delete “${ticket.title}” for good?`)) act(() => remove({ ticketId: ticket.id })); }}><Trash2 size={13} /></button>
        </>}
      </li>)}
    </ul>
    {children}
    {error && <p className="web-error" role="alert">{error}</p>}
  </details>;
}
