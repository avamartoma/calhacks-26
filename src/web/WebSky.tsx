import { useEffect, useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useMutation, useQuery } from 'convex/react';
import { Cloud, Plus, X } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { AccountBadge } from '../AccountBadge';
import { WorkspaceRail } from '../WorkspaceRail';
import type { Room, Workspace } from '../types';
import { SkyView, type SkyProject } from '../sky/SkyView';
import { seedOf } from '../sky/sky-math';
import { builtinBlobs, taskRole } from '../sky/builtins';
import { takeTransfer } from './CloneAgent';

const engines: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
import { ConnectionsPanel } from './Connections';
import { GithubRepos } from './GithubRepos';
import { NewProject } from './NewProject';
import { NewWorkspace, WorkspaceMembers } from './WorkspaceMembers';

export type SkyRow = NonNullable<ReturnType<typeof useSkyRows>>[number];
export const useSkyRows = () => useQuery(api.projects.sky, {});

const agentStatus = (status: string) => status === 'starting' || status === 'running' ? 'working' : status === 'error' ? 'error' : 'done';

export function describe(row: SkyRow) {
  const working = row.runs.filter(run => run.status === 'starting' || run.status === 'running').length;
  const agents = working ? `${working} agent${working === 1 ? '' : 's'} working` : row.runs.length ? 'Agents idle' : 'No agents yet';
  const preview = row.session?.previewStatus === 'live' ? 'Preview live' : 'Paused';
  return row.mine ? `${agents} · ${preview}` : `${row.owner ? `${row.owner.split('@')[0]}'s project` : 'Shared with you'} · ${row.role === 'editor' ? 'Can edit' : 'View only'}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');

/**
 * The signed-in person's sky: the projects in the workspace chosen on the rail up front, and
 * projects shared with them behind, as in the local office.
 */
export function WebSky({ go }: { go: (path: string) => void }) {
  const allRows = useSkyRows();
  const workspaces = useQuery(api.workspaces.list, {});
  const ensure = useMutation(api.workspaces.ensure);
  const createWorkspace = useMutation(api.workspaces.create);
  const updateWorkspace = useMutation(api.workspaces.update);
  const removeWorkspace = useMutation(api.workspaces.remove);
  const moveProject = useMutation(api.workspaces.moveProject);
  const place = useMutation(api.workspaces.place);
  const { user, logout } = useAuth0();
  const [creating, setCreating] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState(() => localStorage.getItem('opencloud-workspace') || '');
  // Makes your first personal workspace, and the public one if it doesn't exist yet.
  const missing = !!workspaces && (!workspaces.some(workspace => workspace.kind === 'personal') || !workspaces.some(workspace => workspace.kind === 'public'));
  useEffect(() => { if (missing) void ensure({}).catch(() => {}); }, [missing]);
  const current = workspaces?.find(workspace => workspace.id === chosen) || workspaces?.[0];
  const choose = (id: string) => { setChosen(id); localStorage.setItem('opencloud-workspace', id); };
  const act = (fn: () => Promise<unknown>) => { setError(''); fn().catch(e => setError(message(e))); };
  // A shared or public workspace's sky is everything in it. A personal one is your projects there,
  // with projects shared with you one by one behind them.
  const rows = allRows && current
    ? allRows.filter(row => current.kind === 'personal' ? (row.mine ? row.workspaceId === current.id : row.workspaceId === null) : row.workspaceId === current.id)
    : allRows;
  // The rail's "working" badge counts agents per workspace, from the same rows.
  const railRooms = useMemo(() => (allRows || []).map(row => ({ workspaceId: row.workspaceId, archived: false, demo: false, agents: row.runs.map(run => ({ status: agentStatus(run.status) })) })) as unknown as Room[], [allRows]);
  const railWorkspaces: Workspace[] = (workspaces || []).map(workspace => ({ ...workspace, image: workspace.image ?? undefined }));
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [membersOf, setMembersOf] = useState<string | null>(null);
  const membersWorkspace = workspaces?.find(workspace => workspace.id === membersOf);
  const everyone = workspaces?.find(workspace => workspace.kind === 'public');
  // An agent just cloned into another project travels across the sky (src/web/CloneAgent.tsx leaves this).
  const [transfer] = useState(takeTransfer);
  // The built-in agents each sit on the cloud they last worked on, once they've been used.
  const uses = useQuery(api.fetchAgents.builtinUses, {});
  const builtins = useMemo(() => builtinBlobs(uses || []), [uses]);
  const projects = useMemo<SkyProject[]>(() => {
    let mine = 0, shared = 0;
    return (rows || []).map(row => {
      const index = row.mine ? mine++ : shared++;
      const angle = row.mine ? index * 2.4 : index * 2.399963 + .6;
      const radius = row.mine ? 80 * Math.sqrt(index) : 420 + 230 * Math.sqrt(index);
      const seed = seedOf(row.id);
      return {
        // Everything on your web sky is a project you can view, so every cloud opens.
        id: row.id, name: row.name, description: describe(row), mine: row.mine, enterable: true, owner: row.owner?.split('@')[0],
        agents: [
          ...row.agents.filter(agent => agent.id !== transfer?.agentId).map(agent => ({ name: agent.name, role: agent.role, status: 'idle' })),
          ...row.runs.map(run => ({ name: `${engines[run.agent] ?? 'Claude'} · ${run.userLabel}`, role: taskRole(run.prompt), status: agentStatus(run.status) })),
          ...(builtins.get(row.id) ?? []),
        ],
        x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * (row.mine ? .8 : .6), depth: row.mine ? 1 : .45 + .35 * seed, seed,
        ...(row.placed ? { placed: row.placed } : {}),
      };
    });
  }, [rows, builtins, transfer]);
  const account = user ? { sub: user.sub || '', label: user.name || user.email || 'You', email: user.email, picture: user.picture } : null;
  const githubLogin = !!user?.sub?.startsWith('github|');
  // Signing in with GitHub the first time offers your repos once; New project always has them.
  const offerKey = `opencloud-github-offered:${user?.sub}`;
  const [offer, setOffer] = useState(() => githubLogin && !localStorage.getItem(offerKey));
  const closeOffer = () => { localStorage.setItem(offerKey, '1'); setOffer(false); };
  return <div className={`app quiet-office opencloud web-office sky-shell has-rail ${account ? 'has-account' : ''}`}>
    <WorkspaceRail workspaces={railWorkspaces} current={railWorkspaces.find(workspace => workspace.id === current?.id)} rooms={railRooms} busy={false}
      onChoose={choose}
      onCreate={name => act(async () => choose(await createWorkspace({ name })))}
      onRename={(id, name) => act(() => updateWorkspace({ id: id as Id<'workspaces'>, name }))}
      onPicture={(id, image) => act(() => updateWorkspace({ id: id as Id<'workspaces'>, image }))}
      onRemove={id => act(async () => { const result = await removeWorkspace({ id: id as Id<'workspaces'> }); if (id === current?.id) choose(result.movedTo); })}
      onAdd={() => setNewWorkspace(true)} onMembers={setMembersOf} />
    <main className="workspace">
      <div className="opencloud-actions">
        <button className="sky-return" aria-pressed={accountsOpen} onClick={() => setAccountsOpen(open => !open)}>Accounts</button>
        {current?.canAddProjects !== false && <button className="sky-return" onClick={() => setCreating(true)}><Plus size={16} /> New project</button>}
        {current && <span className="web-title web-workspace">{current.name}<small>{current.kind === 'public' ? 'Everyone signed in sees these projects' : current.kind === 'shared' ? (current.canAddProjects ? 'Shared · everyone here sees these projects' : 'Shared · only the creator adds projects here') : 'Only you see this workspace'}</small></span>}
        {current?.kind === 'shared' && <button className="sky-return" onClick={() => setMembersOf(current.id)}>Members</button>}
      </div>
      <div className="world">
        {account && <AccountBadge account={account} onSignOut={() => void logout({ logoutParams: { returnTo: window.location.origin } })} />}
        {rows && <SkyView key={current?.id} projects={projects} returnFrom={transfer?.from} transfer={transfer} onEnter={id => go(`/project/${encodeURIComponent(id)}`)} onMove={(id, x, y) => void place({ projectId: id as Id<'projects'>, x, y }).catch(() => {})} />}
        {error && <p className="web-toast" role="alert">{error}<button aria-label="Dismiss" onClick={() => setError('')}><X size={14} /></button></p>}
        {rows && !rows.length && !creating && !offer && <div className="sky-hint"><Cloud size={16} /><span>No projects yet. Upload a folder or link a GitHub repo to start.</span><button className="primary" onClick={() => setCreating(true)}>New project</button></div>}
        {newWorkspace && <NewWorkspace onClose={() => setNewWorkspace(false)} onCreated={id => { setNewWorkspace(false); choose(id); }} />}
        {membersWorkspace && <WorkspaceMembers workspace={membersWorkspace} onClose={() => setMembersOf(null)} onLeft={() => { setMembersOf(null); choose(''); }} />}
        {creating && <NewProject githubLogin={githubLogin} workspace={current} onClose={() => setCreating(false)} onCreated={id => { if (current) void moveProject({ projectId: id as Id<'projects'>, workspaceId: current.id }).catch(() => {}); go(`/project/${encodeURIComponent(id)}`); }} />}
        {offer && !creating && <aside className="web-panel github-offer" aria-label="Add your GitHub repos">
          <header><h2>Add your GitHub repos</h2><button className="icon-button" aria-label="Not now" onClick={closeOffer}><X size={16} /></button></header>
          <GithubRepos githubLogin workspace={everyone || current} onAdded={() => { closeOffer(); if (everyone) choose(everyone.id); }} />
          <button className="text-button" onClick={closeOffer}>Not now</button>
        </aside>}
        {accountsOpen && <ConnectionsPanel onClose={() => setAccountsOpen(false)} />}
      </div>
    </main>
  </div>;
}
