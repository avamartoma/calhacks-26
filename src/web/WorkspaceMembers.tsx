import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { X } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');
type Role = 'viewer' | 'editor';
const roleNames: Record<Role, string> = { viewer: 'Can view', editor: 'Can edit' };

function RoleSelect({ value, onChange, editorAllowed = true }: { value: Role; onChange: (role: Role) => void; editorAllowed?: boolean }) {
  return <select value={value} onChange={e => onChange(e.target.value as Role)} aria-label="Role">
    <option value="viewer">{roleNames.viewer}</option>
    {editorAllowed && <option value="editor">{roleNames.editor}</option>}
  </select>;
}

/** The two things a shared workspace's creator decides about its members. */
function Permissions({ projects, invites, onProjects, onInvites, disabled }: { projects: boolean; invites: boolean; onProjects: (on: boolean) => void; onInvites: (on: boolean) => void; disabled?: boolean }) {
  return <fieldset className="workspace-permissions" disabled={disabled}>
    <legend>Members can</legend>
    <label className="web-check"><input type="checkbox" checked={projects} onChange={e => onProjects(e.target.checked)} /><span>Add their own projects<small>Otherwise only you add projects here.</small></span></label>
    <label className="web-check"><input type="checkbox" checked={invites} onChange={e => onInvites(e.target.checked)} /><span>Invite other people<small>Viewers can invite viewers; editors can invite editors.</small></span></label>
  </fieldset>;
}

/** A new workspace, either just yours or shared with people you invite by email. */
export function NewWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const create = useMutation(api.workspaces.create);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [projects, setProjects] = useState(true);
  const [invites, setInvites] = useState(false);
  const [people, setPeople] = useState<{ email: string; role: Role }[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = () => { const next = email.trim().toLowerCase(); if (next && !people.some(person => person.email === next)) setPeople([...people, { email: next, role }]); setEmail(''); };
  return <form className="new-project web-new-project new-workspace" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    const pending = email.trim() ? [...people, { email: email.trim().toLowerCase(), role }] : people;
    try { onCreated(await create({ name: name.trim(), shared, ...(shared ? { allowMemberProjects: projects, allowMemberInvites: invites, members: pending } : {}) })); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }}>
    <h2>New workspace</h2>
    <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder="Design team" required autoFocus /></label>
    <div className="web-tabs" role="radiogroup" aria-label="Who's in it">
      <button type="button" role="radio" aria-checked={!shared} aria-selected={!shared} onClick={() => setShared(false)}>Only me</button>
      <button type="button" role="radio" aria-checked={shared} aria-selected={shared} onClick={() => setShared(true)}>Shared with people</button>
    </div>
    {shared ? <>
      <p className="web-note">People you invite see this workspace on their rail when they sign in with that email, along with every project in it.</p>
      <div className="workspace-invite">
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="teammate@email.com" />
        <RoleSelect value={role} onChange={setRole} />
        <button type="button" className="secondary" disabled={!email.trim()} onClick={add}>Add</button>
      </div>
      {people.length > 0 && <ul className="workspace-people">{people.map(person => <li key={person.email}><span>{person.email}</span><small>{roleNames[person.role]}</small><button type="button" className="icon-button" aria-label={`Remove ${person.email}`} onClick={() => setPeople(people.filter(other => other.email !== person.email))}><X size={13} /></button></li>)}</ul>}
      <Permissions projects={projects} invites={invites} onProjects={setProjects} onInvites={setInvites} />
    </> : <p className="web-note">Only you see this workspace. You can still share single projects from inside them.</p>}
    {error && <p className="web-error" role="alert">{error}</p>}
    <div className="new-project-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create workspace'}</button></div>
  </form>;
}

export type WorkspaceInfo = { id: string; name: string; kind: string; role: string; admin: boolean; canInvite: boolean; allowMemberProjects: boolean; allowMemberInvites: boolean };

/** Who's in a shared workspace. Its creator manages people and permissions; members can invite when allowed, and leave. */
export function WorkspaceMembers({ workspace, onClose, onLeft }: { workspace: WorkspaceInfo; onClose: () => void; onLeft: () => void }) {
  const id = workspace.id as Id<'workspaces'>;
  const data = useQuery(api.workspaces.members, { id });
  const invite = useMutation(api.workspaces.invite);
  const remove = useMutation(api.workspaces.removeMember);
  const update = useMutation(api.workspaces.update);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [note, setNote] = useState('');
  const act = (fn: () => Promise<unknown>, done?: string) => { setNote(''); fn().then(() => done && setNote(done)).catch(e => setNote(message(e))); };
  const you = data?.members.find(member => member.you);
  const editorAllowed = workspace.admin || workspace.role === 'editor';
  return <aside className="web-panel workspace-members" aria-label={`${workspace.name} members`}>
    <header><h2>{workspace.name}</h2><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
    <p className="web-note">Shared workspace. Everyone here sees every project in it; editors can also start agents, on their own keys.</p>
    <ul className="workspace-people">
      <li><span>{data?.owner || 'Creator'}</span><small>Creator{workspace.admin ? ' (you)' : ''}</small></li>
      {data?.members.map(member => <li key={member.email}>
        <span>{member.email}{member.you ? ' (you)' : ''}</span>
        {workspace.admin
          ? <RoleSelect value={member.role} onChange={next => act(() => invite({ id, email: member.email, role: next }))} />
          : <small>{roleNames[member.role]}</small>}
        {workspace.admin && <button className="icon-button" aria-label={`Remove ${member.email}`} onClick={() => act(() => remove({ id, email: member.email }))}><X size={13} /></button>}
      </li>)}
    </ul>
    {workspace.canInvite
      ? <form className="workspace-invite" onSubmit={event => { event.preventDefault(); const who = email.trim(); act(() => invite({ id, email: who, role }), `Invited ${who}`); setEmail(''); }}>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="teammate@email.com" required />
          <RoleSelect value={role} onChange={setRole} editorAllowed={editorAllowed} />
          <button className="primary">Invite</button>
        </form>
      : <p className="web-note">Only the creator can invite people here.</p>}
    {workspace.admin && <Permissions projects={workspace.allowMemberProjects} invites={workspace.allowMemberInvites}
      onProjects={on => act(() => update({ id, allowMemberProjects: on }))} onInvites={on => act(() => update({ id, allowMemberInvites: on }))} />}
    {!workspace.admin && <p className="web-note">{workspace.allowMemberProjects ? 'Members can add their own projects here.' : 'Only the creator adds projects here.'}</p>}
    {note && <p className="web-note">{note}</p>}
    {you && !workspace.admin && <button className="text-button danger" onClick={() => act(async () => { await remove({ id, email: you.email }); onLeft(); })}>Leave this workspace</button>}
  </aside>;
}
