import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Cloud, ExternalLink, LoaderCircle, Plus, X } from 'lucide-react';
import '@fontsource/urbanist/400.css';
import '@fontsource/urbanist/500.css';
import '@fontsource/urbanist/600.css';
import '@fontsource/urbanist/700.css';
import '@fontsource/urbanist/800.css';
import { OfficeScene } from './scene';
import type { Altitude, OfficeState, Room } from './types';
import { AgentSide } from './AgentSide';
import { AgentDetail } from './AgentDetail';
import { PreviewDock } from './PreviewDock';
import { ConflictNotice } from './ConflictNotice';
import { SharePanel } from './SharePanel';
import { ConnectAgent } from './ConnectAgent';
import { IntegrationsPanel, type ConnectionProvider } from './IntegrationsPanel';
import { SkyView, type SkyProject } from './sky/SkyView';
import { seedOf } from './sky/sky-math';
import { agentKinds } from './sky/agents';
import { builtinBlobs, taskRole } from './sky/builtins';
import { placeholderNeighbors } from './sky/neighbors';
import { cloudStatus, cloudStatusLabel, liveAgentCount, sharedProjectRoom } from './office-panel';
import { WorkspaceRail } from './WorkspaceRail';
import { SignIn } from './SignIn';
import { AccountBadge } from './AccountBadge';
import { localHour, paletteAt } from './sky/time-of-day';
import './style.css';
import './quiet-office.css';
import './workspace.css';

async function api(url: string, body?: unknown, method = 'POST') {
  const response = await fetch(`/api${url}`, { method: body === undefined && method === 'POST' ? 'GET' : method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

function AccountsPanel({ room, connection, focus, onClose }: { room?: Room; connection: OfficeState['connection']; focus: { provider: ConnectionProvider; request: number } | null; onClose: () => void }) {
  return <aside className="accounts-panel" aria-label="Accounts">
    <button type="button" className="text-button accounts-close" onClick={onClose}><X size={14} /> Close</button>
    {room
      ? <IntegrationsPanel room={room} connection={connection} focus={focus} onContinue={onClose} />
      : <div className="integrations-panel connections-panel"><h2>Accounts</h2><p>Create a project first. Codex, Claude, and Cursor sign-in is saved for that office.</p></div>}
  </aside>;
}

export default function App() {
  const [data, setData] = useState<OfficeState | null>(null);
  const [roomId, setRoomId] = useState(localStorage.getItem('iteration1-live-room') || localStorage.getItem('iteration1-room') || '');
  const [workspaceId, setWorkspaceId] = useState(localStorage.getItem('iteration1-workspace') || '');
  const [altitude, setAltitude] = useState<Altitude>(() => new URLSearchParams(location.search).get('project') ? 'project' : 'sky');
  const [sharedId, setSharedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  // Clicking an agent opens its own panel; closing it keeps the agent highlighted in the Agents list.
  const [detailOpen, setDetailOpen] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [sceneError, setSceneError] = useState('');
  const [sceneReady, setSceneReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [arrival, setArrival] = useState(0);
  const [signedOut, setSignedOut] = useState(() => sessionStorage.getItem('opencloud-signed-out') === '1');
  const [connectionFocus, setConnectionFocus] = useState<{ provider: ConnectionProvider; request: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const skyReturn = useRef<string | null>(null);
  const workspaces = data?.workspaces || [];
  const workspace = workspaces.find(item => item.id === workspaceId) || workspaces[0];
  const ownedRooms = (data?.rooms || []).filter(room => !room.archived && (room.workspaceId === workspace?.id || (!room.workspaceId && workspace?.id === workspaces[0]?.id)));
  const shared = useMemo(() => {
    const list: { room: Room; ownRoomId: string }[] = [];
    for (const room of ownedRooms) {
      const remote = room.team?.remote;
      if (!remote || list.some(item => item.room.id === `shared:${remote.id}`)) continue;
      list.push({ room: sharedProjectRoom(remote, remote.owner), ownRoomId: room.id });
    }
    return list;
  }, [ownedRooms]);
  const skyRooms = [...ownedRooms, ...shared.map(item => item.room)];
  const sharedOpen = shared.find(item => item.room.id === sharedId) || null;
  const owned = ownedRooms.find(room => room.id === roomId) || ownedRooms.find(room => !room.demo) || ownedRooms[0];
  const room = sharedOpen?.room || (altitude === 'project' ? owned : undefined);
  const ownRoomId = sharedOpen?.ownRoomId || owned?.id || '';
  const waitingIds = useMemo(() => new Set((data?.approvals || []).map(item => item.roomId)), [data?.approvals]);
  // The built-in agents each sit on the cloud they last worked on, once they've been used.
  const builtins = useMemo(() => builtinBlobs([
    ...(data?.fetchAgents?.jobs || []).map(job => ({ name: job.agent, projectId: job.roomId, at: job.createdAt, working: job.status === 'queued' || job.status === 'running' })),
    ...(data?.fetchAgents?.activity || []).map(item => ({ name: item.name, projectId: item.roomId || '', at: item.time, working: false })),
  ]), [data?.fetchAgents]);
  const skyProjects = useMemo<SkyProject[]>(() => [
    ...skyRooms.map((item, index) => {
      const waiting = waitingIds.has(item.id) || item.agents.some(agent => agent.status === 'approval');
      const count = liveAgentCount(item);
      const angle = index * 2.4;
      const radius = 80 * Math.sqrt(index);
      return {
        id: item.id,
        name: item.name,
        description: `${count} agent${count === 1 ? '' : 's'} · ${cloudStatusLabel(cloudStatus(item, waiting, !!item.viewOnly))}`,
        detail: cloudStatusLabel(cloudStatus(item, waiting, !!item.viewOnly)),
        agents: [
          // Colored by type: from the agent's title or role when that says, otherwise from its task.
          ...item.agents.filter(agent => agent.status !== 'ejected').map(agent => ({ name: [agent.name, agent.title].filter(Boolean).join(' · '), role: agentKinds.some(kind => kind.match.test(agent.title || agent.role)) ? agent.title || agent.role : taskRole(`${agent.role} ${agent.task}`), status: agent.status, manager: !!agent.manager })),
          ...(builtins.get(item.id) ?? []),
        ],
        mine: true,
        placed: item.viewOnly ? undefined : item.cloud?.sky,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius * .8,
        depth: 1,
        seed: seedOf(item.id),
      };
    }),
    ...placeholderNeighbors(),
  ], [skyRooms, waitingIds, builtins]);

  const showSky = useCallback(() => {
    skyReturn.current = sharedId || roomId || null;
    setAltitude('sky');
    setSharedId(null);
    setSelection(null);
    setCreating(false);
    setShareOpen(false);
    setAccountsOpen(false);
    scene.current?.setWalk(false);
  }, [sharedId, roomId]);
  const openAccounts = useCallback((provider?: ConnectionProvider) => {
    setConnectionFocus(current => provider ? { provider, request: (current?.request || 0) + 1 } : current);
    setAccountsOpen(true);
    setShareOpen(false);
    setCreating(false);
  }, []);
  const openProject = useCallback((id: string) => {
    if (id.startsWith('sample-')) return;
    setSelection(null);
    setCreating(false);
    setShareOpen(false);
    if (id.startsWith('shared:')) setSharedId(id);
    else { setSharedId(null); setRoomId(id); }
    setAltitude('project');
  }, []);
  const select = useCallback((id: string) => {
    setSelection(id);
    setDetailOpen(true);
    scene.current?.focus(id);
  }, []);
  const chooseWorkspace = useCallback((id: string) => { setWorkspaceId(id); showSky(); }, [showSky]);

  useEffect(() => { api('/state').then(setData).catch(e => setError(e.message)); const stream = new EventSource('/api/events'); stream.onmessage = event => { setData(JSON.parse(event.data)); }; stream.onerror = () => {}; return () => stream.close(); }, []);
  useEffect(() => { if (workspace) { localStorage.setItem('iteration1-workspace', workspace.id); if (workspace.id !== workspaceId) setWorkspaceId(workspace.id); } }, [workspace?.id, workspaceId]);
  useEffect(() => { if (altitude === 'project' && !room) setAltitude('sky'); }, [altitude, room]);
  useEffect(() => {
    if (altitude !== 'project' || !room || room.demo || room.archived || room.viewOnly) return;
    const id = room.id;
    void api(`/rooms/${id}/cloud/open`, {}).catch(() => {});
    return () => { void api(`/rooms/${id}/cloud/close`, {}).catch(() => {}); };
  }, [altitude, room?.id, room?.demo, room?.archived, room?.viewOnly]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('project');
    if (!id || !data) return;
    const target = data.rooms.find(item => item.id === id && !item.archived);
    if (target) { if (target.workspaceId) setWorkspaceId(target.workspaceId); setRoomId(id); setSharedId(null); setAltitude('project'); }
    else setError('That project link does not open a project in this office.');
    history.replaceState(null, '', location.pathname);
  }, [!!data]);
  useEffect(() => {
    if (altitude === 'sky') {
      if (scene.current) { scene.current.dispose(); scene.current = null; setSceneReady(false); }
      return;
    }
    if (sceneError || !container.current || scene.current) return;
    try {
      scene.current = new OfficeScene(container.current, select);
      scene.current.onEnterProject = openProject;
      scene.current.onLeaveProject = showSky;
      scene.current.onPlaceCloud = (id, spot) => { if (!id.startsWith('shared:')) api(`/rooms/${id}/cloud`, spot).catch(e => setError((e as Error).message)); };
      scene.current.onGraphicsLost = () => { setSceneReady(false); setSceneError('The browser lost its graphics connection.'); };
      setSceneReady(true);
    } catch (e) { console.error('Office graphics initialization failed', e); setSceneError('The browser could not start 3D graphics.'); }
  }, [!!data, altitude, select, sceneError, openProject, showSky]);
  useEffect(() => () => { scene.current?.dispose(); scene.current = null; }, []);
  // The office sits in the same time-of-day sky as the workspace, fading into its cloud's color.
  useEffect(() => {
    if (!sceneReady) return;
    const apply = () => { const palette = paletteAt(localHour()); scene.current?.setBackdrop({ zenith: palette.zenith, horizon: palette.horizon, cloud: palette.cloudLight }); };
    apply();
    const timer = setInterval(apply, 60000);
    return () => clearInterval(timer);
  }, [sceneReady]);
  useEffect(() => { if (room && altitude === 'project') scene.current?.update({ ...room, workItems: room.workItems.filter(item => !item.archived) }, selection); }, [room, selection, sceneReady, altitude]);
  useEffect(() => { scene.current?.setSky(skyRooms, workspace?.color, waitingIds); }, [skyRooms, workspace?.color, sceneReady, waitingIds]);
  useEffect(() => {
    if (!scene.current) return;
    scene.current.setRendering(altitude === 'project');
    scene.current.setPanelWidth(0);
    if (altitude === 'project' && room) scene.current.openProject(room);
  }, [altitude, room?.id, room, sceneReady]);
  useEffect(() => { if (owned && !owned.demo && !owned.archived) localStorage.setItem('iteration1-live-room', owned.id); }, [owned?.id, owned?.demo, owned?.archived]);
  useEffect(() => { if (roomId) localStorage.setItem('iteration1-room', roomId); }, [roomId]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select')) return;
      if (event.key === 'Escape' && accountsOpen) { setAccountsOpen(false); return; }
      if (event.key === 'Escape' && altitude === 'project') showSky();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [altitude, showSky, accountsOpen]);

  async function action(fn: () => Promise<unknown>, success?: string) {
    setBusy(true); setError('');
    try { await fn(); if (success) setToast(success); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!data) return <main className="loading"><div className="brand-mark">oc</div><h1>{error ? 'opencloud is offline' : 'Loading opencloud'}</h1><p>{error || ''}</p>{error ? <button className="primary" onClick={() => window.location.reload()}>Retry connection</button> : <LoaderCircle className="spin" size={20} />}</main>;

  if (!data.account && !(signedOut && !data.signIn?.ready)) return <SignIn ready={!!data.signIn?.ready} redirectUri={data.signIn?.redirectUri || ''} onSkip={() => { sessionStorage.setItem('opencloud-signed-out', '1'); setSignedOut(true); }} />;

  return <div className={`app quiet-office opencloud has-rail ${data.account ? 'has-account' : ''} ${altitude === 'sky' ? 'sky-shell' : 'project-shell'}`}>
    <WorkspaceRail workspaces={workspaces} current={workspace} rooms={data.rooms} busy={busy} onChoose={chooseWorkspace} onCreate={name => action(async () => { const result = await api('/workspaces', { name }); chooseWorkspace(result.workspace.id); }, 'Workspace created')} onPicture={(id, image) => action(() => api(`/workspaces/${id}`, { image }, 'PATCH'), image ? 'Workspace picture updated' : 'Workspace picture removed')} onRename={(id, name) => action(() => api(`/workspaces/${id}`, { name }, 'PATCH'), 'Workspace renamed')} onRemove={id => action(async () => { await api(`/workspaces/${id}`, undefined, 'DELETE'); if (id === workspace?.id) setWorkspaceId(''); }, 'Projects moved to the remaining workspace')} />
    <main className="workspace">
      <div className="opencloud-actions">
        {workspaces.length > 1 && <label className="workspace-switch">Workspace<select aria-label="Workspace" value={workspace?.id || ''} onChange={event => chooseWorkspace(event.target.value)}>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <button className="sky-return" aria-pressed={accountsOpen} onClick={() => accountsOpen ? setAccountsOpen(false) : openAccounts()}>Accounts</button>
        {altitude === 'project' && room && !room.demo && !room.viewOnly && <button className="sky-return" aria-pressed={shareOpen} onClick={() => { setShareOpen(open => !open); setAccountsOpen(false); }}><ExternalLink size={16} /> Share</button>}
        {altitude === 'project' && <button className="sky-return" onClick={showSky}><Cloud size={16} /> Sky</button>}
        {altitude === 'sky' && <button className="sky-return" onClick={() => setCreating(true)}><Plus size={16} /> New project</button>}
      </div>
      <div className="world">
        <div ref={container} className="world-canvas" />
        {altitude === 'sky' && data.account && <AccountBadge account={data.account} />}
        {altitude === 'sky' && <SkyView projects={skyProjects} returnFrom={skyReturn.current} onMove={(id, x, y) => { if (!id.startsWith('shared:') && !id.startsWith('sample-')) api(`/rooms/${id}/cloud`, { x, y, sky: true }).catch(e => setError((e as Error).message)); }} onEnter={id => { if (!id.startsWith('sample-')) setArrival(count => count + 1); openProject(id); }} />}
        {arrival > 0 && altitude === 'project' && <div key={arrival} className="cloud-arrival" style={{ background: `rgb(${paletteAt(localHour()).cloudLight.map(value => Math.round(value * 255)).join(',')})` }} />}
        {altitude === 'sky' && !skyRooms.length && <div className="sky-hint"><Cloud size={16} /><span>This workspace has no projects yet</span><button className="primary" onClick={() => setCreating(true)}>New project</button></div>}
        {altitude === 'sky' && creating && <form className="new-project" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); action(async () => { const result = await api('/rooms', { name: String(form.get('name')), path: String(form.get('path')), demo: false, workspaceId: workspace?.id }); openProject(result.room.id); setCreating(false); }, 'Project created'); }}>
          <h2>New project</h2>
          <label>Name<input name="name" required maxLength={60} autoFocus placeholder="Customer portal" /></label>
          <label>Project folder<input name="path" required placeholder="C:\Projects\my-project" /></label>
          <div className="new-project-actions"><button type="button" className="secondary" onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={busy}>Create project</button></div>
        </form>}
        {altitude === 'project' && sceneError && <div className="scene-fallback" role="status"><p>{sceneError}</p><button className="primary" onClick={() => { scene.current?.dispose(); scene.current = null; setSceneReady(false); setSceneError(''); }}>Retry 3D</button></div>}
        {altitude === 'project' && room && !room.demo && !room.viewOnly && <><PreviewDock cloud={room.preview} /><ConflictNotice conflicts={room.preview?.conflicts} /></>}
        {altitude === 'project' && room && <AgentSide room={room} identities={data.identities || []} ownRoomId={ownRoomId} busy={busy} selectedId={selection} models={[...(data.connection.account ? data.connection.models : []), ...(data.claude?.configured ? data.claude.models : [])]} fetch={data.fetchAgents} action={action} onSelect={select} onCloned={(id, agentId) => { setSharedId(null); setRoomId(id); setAltitude('project'); setSelection(agentId); setShareOpen(false); }} share={shareOpen && !room.demo && !room.viewOnly ? <><SharePanel projectId={room.preview?.projectId} projectName={room.name} roomId={room.id} previewUrl={room.preview?.status === 'live' ? room.preview.previewUrl : undefined} /><ConnectAgent projectId={room.preview?.projectId} /></> : undefined} />}
      </div>
      {altitude === 'project' && room && detailOpen && !accountsOpen && (() => {
        const agent = room.agents.find(item => item.id === selection);
        return agent ? <AgentDetail key={agent.id} agent={agent} room={room} data={data} busy={busy} action={action} onSelect={select} onFocus={() => scene.current?.focus(agent.id)} onClose={() => setDetailOpen(false)} /> : null;
      })()}
      {accountsOpen && <AccountsPanel room={(altitude === 'project' && room && !room.viewOnly ? room : ownedRooms.find(item => !item.demo && !item.archived)) || ownedRooms[0]} connection={data.connection} focus={connectionFocus} onClose={() => setAccountsOpen(false)} />}
    </main>
    {(toast || error) && <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <X size={18} /> : <Check size={18} />}<span>{error || toast}</span><button aria-label="Dismiss notification" onClick={() => { setToast(''); setError(''); }}><X size={16} /></button></div>}
  </div>;
}
