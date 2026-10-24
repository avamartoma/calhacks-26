import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, AudioLines, Bell, Box, BriefcaseBusiness, Building2, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Coffee, Command, Compass, DoorOpen, Expand, ExternalLink, Eye, FileCode2, Folder, Glasses, Grip, GitBranch, Layers, LayoutGrid, LoaderCircle, MessageSquare, Minus, Monitor, MousePointer2, Pause, Play, Plus, Radio, RotateCcw, Send, Settings2, ShieldCheck, Sparkles, Terminal, Users, Wind, X, Zap } from 'lucide-react';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/sora/400.css';
import '@fontsource/sora/500.css';
import '@fontsource/sora/600.css';
import { MissionControl, OfficePulse, ModesPanel, ReplayPanel, HandoffDossier, agentWork, officeApi, workColors, workLabels } from './Operations';
import { WhipOverlay, WhipIcon } from './WhipOverlay';
import { OfficeScene } from './scene';
import { CompactOffice } from './CompactOffice';
import { DemoDirector } from './DemoDirector';
import { RecordingStudio } from './RecordingStudio';
import { PermissionsPanel } from './PermissionsPanel';
import { DiffButton } from './WorkArtifacts';
import { TaskWorkspace } from './TaskWorkspace';
import { ManagerInbox, ProjectRooms, attentionTickets } from './ManagerPanels';
import './manager.css';
import { Dashboard } from './Dashboard';
import { HandoffsPanel } from './HandoffsPanel';
import { IntegrationsPanel } from './IntegrationsPanel';
import { TeamPanel } from './TeamPanel';
import { TeamMap } from './TeamMap';
import { createDemoTeammate, demoTeammateNames, withDemoTeammate } from './demo-teammates';
import type { Agent, OfficeState, Room, Tool } from './types';
import { agentLine, agentSpeech, modelLabel } from './identity';
import { accessoriesFor, costumeColors, type CostumeKind } from './costume';
import './style.css';
import './quiet-office.css';
import './workspace.css';

async function api(url: string, body?: unknown, method = 'POST') {
  const response = await fetch(`/api${url}`, { method: body === undefined && method === 'POST' ? 'GET' : method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The request failed.'); return data;
}
const statusLabels: Record<string, string> = { working: 'Working', talking: 'Collaborating', done: 'Turn finished', idle: 'Ready', paused: 'Paused', approval: 'Needs you', error: 'Blocked', ejected: 'Ejected' };
const skillDescriptions: Record<string, { title: string; description: string; icon: typeof Users }> = {
  'office-manager': { title: 'Office manager', description: 'Bounded delegation. One implementation owner. Less duplicate work.', icon: Users },
  'office-handoff': { title: 'Context handoffs', description: 'Carry evidence, decisions, and unfinished work between agents.', icon: MessageSquare },
  'office-review': { title: 'Independent review', description: 'A second set of eyes on acceptance criteria and regressions.', icon: ShieldCheck }
};
const hotbar: { tool: Tool; icon: typeof Users; title: string; key: string }[] = [
  { tool: 'office', icon: Building2, title: 'Overview', key: '1' }, { tool: 'agents', icon: Users, title: 'Agents', key: '2' },
  { tool: 'dashboard', icon: LayoutGrid, title: 'Tickets', key: '3' }, { tool: 'messages', icon: Coffee, title: 'Handoffs', key: '4' },
  { tool: 'skills', icon: Sparkles, title: 'Skills', key: '5' }, { tool: 'tools', icon: Terminal, title: 'Tools', key: '6' },
  { tool: 'approvals', icon: Bell, title: 'Inbox', key: '7' }, { tool: 'settings', icon: Settings2, title: 'Settings', key: '8' }
];
function BlobHat({ kind }: { kind: CostumeKind }) {
  const { hat, trim } = costumeColors[kind];
  if (kind === 'manager') return <g><ellipse cx="21" cy="8.2" rx="16" ry="3" fill={hat} /><rect x="12" y="0.6" width="18" height="8" rx="1.4" fill={hat} /><rect x="12" y="5.6" width="18" height="1.8" fill={trim} /></g>;
  if (kind === 'research') return <g><ellipse cx="21" cy="5.5" rx="11" ry="5" fill={hat} /><path d="M9 8h24l-4 4H13z" fill={hat} /></g>;
  if (kind === 'build') return <g><ellipse cx="21" cy="9" rx="16" ry="2.8" fill={hat} /><ellipse cx="21" cy="6" rx="11" ry="5" fill={hat} /><rect x="19.2" y="3.2" width="3.6" height="2.2" fill={trim} /></g>;
  if (kind === 'test') return <g><ellipse cx="21" cy="6" rx="11" ry="4.5" fill={hat} /><ellipse cx="8" cy="10" rx="3.2" ry="4.2" fill={hat} /><ellipse cx="34" cy="10" rx="3.2" ry="4.2" fill={hat} /><path d="M12 8h18l-3 3H15z" fill={trim} /></g>;
  return <g><path d="M8 9h26l-4 3H12z" fill={hat} /><rect x="12" y="2" width="18" height="7" rx="1" fill={hat} /><rect x="12" y="6.2" width="18" height="1.4" fill={trim} /></g>;
}
function Avatar({ agent, size = '' }: { agent: Agent; size?: string }) {
  const displayModel=agent.effectiveModel || agent.model;
  const look = displayModel.toLowerCase().includes('grok') ? ['GROK', '#3d8eb8'] : agent.provider === 'cursor' ? ['CURSOR', '#3d8eb8'] : displayModel.includes('astra') ? ['ASTRA', '#e06a3c'] : displayModel.includes('sol') ? ['SOL', '#e2b043'] : displayModel.includes('terra') ? ['TERRA', '#3d9a68'] : displayModel.includes('luna') ? ['LUNA', '#9a62b8'] : ['AUTO', '#3a9a8c'];
  const costume = accessoriesFor(agent);
  return <span className={`avatar blob-avatar ${size} ${agent.status}`} style={{ '--agent-color': look[1] } as React.CSSProperties}><svg className="blob-body" viewBox="0 0 42 45" aria-hidden="true"><circle cx="21" cy="22" r="19" fill={look[1]} /><g className="blob-eyes"><ellipse cx="16" cy="18" rx="4.1" ry="5.1" fill="#f8f8ef" /><ellipse cx="27" cy="18" rx="4.1" ry="5.1" fill="#f8f8ef" /><ellipse cx="16.4" cy="18.7" rx="1.7" ry="2.3" fill="#34443b" /><ellipse cx="27.4" cy="18.7" rx="1.7" ry="2.3" fill="#34443b" /></g><text x="21" y="32" textAnchor="middle" fill="#34443b" fontSize="5" fontWeight="700">{agent.name.slice(0, 8)}</text>{costume.bow && <g fill={costumeColors[costume.kind].bow}><path d="M9 37.2 16.2 34.2v6.2z" /><path d="M33 37.2 25.8 34.2v6.2z" /><circle cx="21" cy="37.2" r="2.1" /></g>}{costume.coffee && <g><rect x="31" y="20" width="7" height="10" rx="2" fill="#f3eee4" /><rect x="32" y="20.4" width="5" height="2.2" fill="#4a3428" /><path d="M38 23h2.1a2.2 2.2 0 0 1 0 4.4H38" fill="none" stroke="#f3eee4" strokeWidth="1.3" /></g>}</svg>{costume.hat && <svg className="blob-hat" viewBox="0 0 42 45" aria-hidden="true"><BlobHat kind={costume.kind} /></svg>}{agent.manager && <i><BriefcaseBusiness size={9} /></i>}</span>;
}
function Status({ agent }: { agent: Agent }) { return <span className={`status status-${agent.status}`}><i />{statusLabels[agent.status]}</span>; }
export default function App() {
  const [data, setData] = useState<OfficeState | null>(null);
  const [roomId, setRoomId] = useState(localStorage.getItem('fourteenth-live-room') || localStorage.getItem('fourteenth-room') || '');
  const [allowDemo,setAllowDemo]=useState(false);
  const [connectReturn,setConnectReturn]=useState<Tool>('templates');
  const [tool, setTool] = useState<Tool>('office'); const [selection, setSelection] = useState<string | null>(null);
  const [markers,setMarkers]=useState<{id:string;x:number;y:number;status:string}[]>([]);
  const [replayRoom,setReplayRoom]=useState<Room|null>(null);
  const [cinematic,setCinematic]=useState(false);
  const [recording,setRecording]=useState(false);
  const [historySpatial,setHistorySpatial]=useState(true);
  const [panelExpanded,setPanelExpanded]=useState(false);
  const spatial=tool==='office' || (tool==='replay'?historySpatial:!panelExpanded);
  useEffect(()=>{if(tool==='office')setPanelExpanded(false);},[tool]);
  const [compact,setCompact]=useState(()=>localStorage.getItem('fourteenth-view')==='map');
  const [selectedWork,setSelectedWork]=useState<string|null>(null);
  const [walk, setWalk] = useState(false); const [error, setError] = useState(''); const [toast, setToast] = useState(''); const [busy, setBusy] = useState(false);
  const [whip, setWhip] = useState(false); const [crack, setCrack] = useState(0); const [help, setHelp] = useState(false); const [streamOnline, setStreamOnline] = useState(true);
  const [sceneError, setSceneError] = useState(''); const [sceneReady, setSceneReady] = useState(false);
  const [demoTeams, setDemoTeams] = useState<Record<string,{count:number;selected:number}>>({});
  const container = useRef<HTMLDivElement>(null); const scene = useRef<OfficeScene | null>(null);
  const room = data?.rooms.find(r => r.id === roomId && !r.archived && (!r.demo || allowDemo)) || data?.rooms.filter(r=>!r.archived && !r.demo).sort((a,b)=>(b.missionStartedAt || 0)-(a.missionStartedAt || 0))[0] || data?.rooms.find(r=>!r.archived) || data?.rooms[0];
  const demoTeam = demoTeams[room?.id || ''] || {count:0,selected:0};
  const pairedTeam = !!room?.team?.remote && !room.team.simulated;
  const demoCount = pairedTeam ? 0 : demoTeam.count;
  const demoOffices = useMemo(()=>Array.from({length:demoCount},(_,i)=>({...createDemoTeammate(i),name:room?.name || 'Project'})),[demoCount,room?.name]);
  const displayRoom = useMemo(() => room && demoCount ? withDemoTeammate(room, demoOffices[demoTeam.selected], demoOffices) : room, [room,demoCount,demoTeam.selected,demoOffices]);
  const chooseDemoOffice = useCallback((id:string)=>{
    if(!room)return;const index=demoOffices.findIndex(o=>o.id===id);if(index<0)return;
    setDemoTeams(current=>({...current,[room.id]:{...current[room.id],selected:index}}));
    setTool('office');setCompact(false);
    if(index===demoTeam.selected)scene.current?.focusOffice();
  },[room?.id,demoOffices,demoTeam.selected]);
  useEffect(()=>{if(room && !room.demo && !room.archived)localStorage.setItem('fourteenth-live-room',room.id);else if(room?.demo && !allowDemo)setTool('rooms');},[room?.id,allowDemo]);
  const cursorOwner = room?.agents.find(a => a.provider === 'cursor' && a.turnId);
  const selected = room?.agents.find(a => a.id === selection);
  const liveAgents = room?.agents.filter(a => a.status !== 'ejected') || [];
  const select = useCallback((id: string) => { setSelection(id); setTool('agent'); }, []);
  useEffect(() => {
    api('/state').then(setData).catch(e => setError(e.message));
    const stream = new EventSource('/api/events'); stream.onmessage = e => { setData(JSON.parse(e.data)); setStreamOnline(true); }; stream.onerror = () => setStreamOnline(false);
    return () => stream.close();
  }, []);
  useEffect(() => {
    if(room?.archived){scene.current?.dispose();scene.current=null;setSceneReady(false);return;}
    if (sceneError || (compact && tool!=='recording' && !cinematic && !recording) || !container.current || !room || scene.current || (!spatial && tool!=='recording' && !cinematic && !recording)) return;
    try {
      scene.current = new OfficeScene(container.current, select);
      scene.current.onTeammate=()=>setTool('team'); scene.current.onMode = setWalk; scene.current.onMarkers=setMarkers; scene.current.onStatus = setToast;
      scene.current.onGraphicsLost = () => {
        setSceneReady(false); setWalk(false); setRecording(false); setCinematic(false);
        setSceneError('The browser lost its graphics connection.');
      };
      setSceneReady(true);
    }
    catch(e) { console.error('Office graphics initialization failed', e); setSceneError('The browser could not start 3D graphics.'); }
  }, [!!room, !!room?.archived, select,tool,cinematic,recording,spatial,sceneError,compact]);
  useEffect(()=>()=>{scene.current?.dispose();scene.current=null;},[]);
  useEffect(()=>{if(tool!=='office' && !cinematic && !recording)scene.current?.setWalk(false);},[tool,cinematic,recording]);
  useEffect(()=>{if(tool==='office' && selection && sceneReady)scene.current?.focus(selection);},[tool,selection,sceneReady]);
  useEffect(() => { if (displayRoom) scene.current?.update(replayRoom || {...displayRoom,workItems:displayRoom.workItems.filter(t=>!t.archived)}, selection); }, [displayRoom, replayRoom, selection, sceneReady]);
  useEffect(() => { if(scene.current)scene.current.onTeammate=()=>demoCount?setToast('Demo office · simulated agents and assignments.'):setTool('team'); }, [demoCount,sceneReady]);
  useEffect(()=>{if(scene.current)scene.current.onOfficeSelect=chooseDemoOffice;},[chooseDemoOffice,sceneReady]);
  useEffect(()=>{localStorage.setItem('fourteenth-view',compact?'map':'office');scene.current?.setRendering(!compact && (spatial || cinematic || recording));},[compact,sceneReady,spatial,cinematic,recording]);
  useEffect(() => { if (roomId) localStorage.setItem('fourteenth-room', roomId); }, [roomId]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 5000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if(cinematic){if(e.key==='Escape')setCinematic(false);return;} if(recording){if(e.key==='Escape'||e.key.toLowerCase()==='f'){setRecording(false);setTool('recording');}if(e.altKey && /^[1-4]$/.test(e.key)){e.preventDefault();scene.current?.tourStop(Number(e.key)-1);}return;} if(e.key.toLowerCase()==='f' && tool==='recording' && sceneReady && !sceneError && !(e.target as HTMLElement).closest('input,textarea,select')){setCompact(false);setWhip(false);setHelp(false);setRecording(true);return;} if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return; const entry = hotbar.find(t => t.key === e.key); if (entry) setTool(entry.tool); if (e.key === '9') { setCompact(false); setWhip(v => !v); setTool('office'); } if (e.key === 'Escape') { setCinematic(false); setWhip(false); setTool('office');scene.current?.setWalk(false); setSelection(null); setHelp(false); } if (e.key.toLowerCase() === 'v') {setTool('office');setCompact(false);scene.current?.setWalk(!scene.current.walk);} };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [cinematic,recording,tool,sceneReady,sceneError]);
  async function action(fn: () => Promise<unknown>, success?: string) { setBusy(true); setError(''); try { await fn(); if (success) setToast(success); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }
  function openConnect(from:Tool='templates'){setConnectReturn(from);setTool('connect');}
  function switchRoom(id: string) { setAllowDemo(true);setReplayRoom(null); setWhip(false); setRoomId(id); setSelection(null); setSelectedWork(null); setTool('office'); scene.current?.setWalk(false); }
  function modelOptions() { return <>{!data?.connection.models.some(m=>m.id==='gpt-6-sol') && <option value="gpt-6-sol">GPT-6 Sol</option>}<option value="Account default">Account default</option>{data?.connection.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</>; }
  useEffect(() => {
    if (!scene.current) return;
    scene.current.setWhip(whip && tool === 'office');
    scene.current.onWhip = id => {
      if (busy || !room || replayRoom) return;
      if (room.agents.some(a=>a.provider==='cursor' && a.turnId)) { setError('Change model and speed in Cursor.'); return; }
      action(async () => {
        await officeApi(`/rooms/${room.id}/mode`,{mode:'crunch'}); const result = { message: 'Crunch selected: lightweight workers, low effort, 6 parallel slots, 5-minute turns.' };
        scene.current?.reactToWhip(id); setCrack(n => n + 1); setToast(result.message);
      });
    };
  }, [whip, tool, room, busy, sceneReady,replayRoom]);
  useEffect(()=>{scene.current?.setPanelWidth(tool==='office' || cinematic || recording || !spatial?0:440); if(scene.current)scene.current.onSelect=id=>{if(!replayRoom)select(id);};},[tool,replayRoom,sceneReady,select,cinematic,recording,spatial]);
  const roomEndpoint = `/rooms/${room?.id}`;
  const approvalCount = data ? data.approvals.length + attentionTickets(data).length : 0;
  if (!data || !room) return <main className="loading"><div className="brand-mark">14</div><h1>{error?'The office is offline':'Loading project'}</h1><p>{error || ''}</p>{error?<button className="primary" onClick={()=>window.location.reload()}>Retry connection</button>:<LoaderCircle className="spin" size={20} />}</main>;
  const floorRoom = displayRoom || room;

  if(room.archived)return <main className="empty-projects"><span className="brand-mark">14</span>{tool==='newroom'?<NewRoom defaultPath="" connected={!!data.connection.account} busy={busy} onSubmit={(name,path,demo)=>action(async()=>{const result=await api('/rooms',{name,path,demo});switchRoom(result.room.id);})}/>:<ProjectRooms rooms={data.rooms} current="" busy={busy} action={action} onRoom={switchRoom} onNew={()=>setTool('newroom')}/>}<p role={error?'alert':undefined}>{error || toast}</p></main>;
  return <div className={`app quiet-office ${!spatial && !cinematic && !recording?'workbench':'spatial-shell'} ${tool!=='office'?'has-panel':''} ${walk ? 'walk-mode' : ''} ${compact?'compact-mode':''} ${cinematic?'cinema-mode':''} ${recording?'recording-mode':''}`}>
    <header className="topbar" inert={cinematic || recording}>
      <button className="brand" onClick={() => { setTool('office'); setWhip(false); scene.current?.setWalk(false); }} aria-label="Fourteenth home"><span className="brand-mark">14</span><span className="brand-name">Fourteenth</span></button>
      <button className="project-picker" onClick={() => setTool('rooms')}><span>{room.name}</span><ChevronDown size={14} /></button>
      {room.demo && <span className="demo-label">Demo</span>}
      {!room.demo && data.connection.testAgents && <span className="demo-label" title="Real office transport; simulated agent execution">Test agents</span>}
      <div className="header-spacer"/>
      {tool==='office' && <><button className={`mode-chip ${room.mode}`} onClick={()=>setTool('modes')}><Zap size={12}/>{data.modes?.[room.mode || 'balanced']?.name || 'Balanced'}</button><div className="view-switch" aria-label="Office view"><button aria-label="Overview" className={!walk && !compact?'active':''} onClick={()=>{setCompact(false);scene.current?.setWalk(false);}}><LayoutGrid size={15}/><span>Overview</span></button><button aria-label="Compact map" aria-pressed={compact} className={compact?'active':''} onClick={()=>{setCompact(true);setWhip(false);scene.current?.setWalk(false);}}><GitBranch size={15}/><span>Map</span></button><button aria-label="Walk around" className={walk?'active':''} onClick={()=>{setCompact(false);scene.current?.setWalk(true);}}><DoorOpen size={15}/><span>Walk</span></button></div></>}
      {!room.demo && <button className="mode-chip permission-chip" aria-label="Office permissions" onClick={()=>setTool('settings')}><ShieldCheck size={13}/><span>{room.permissionMode==='read-only'?'Read only':'Project edits'}</span></button>}
      <button aria-label={data.connection.account ? 'Codex connected' : 'Connect Codex'} className="connection-button" onClick={() => openConnect()}><span>{data.connection.account ? 'Connected' : 'Connect Codex'}</span><ArrowUpRight size={15} /></button>
    </header>
    <main className="workspace">
      <div ref={container} className="world" />
      {tool==='office' && !walk && !cinematic && !recording && !replayRoom && <div className="demo-team-controls">
        <button aria-label="Add demo teammate" title={pairedTeam?'Your paired teammate is shown. Preview extra offices in an unpaired project.':demoCount===demoTeammateNames.length?'All demo teammates added':'Add demo teammate'} disabled={pairedTeam || demoCount===demoTeammateNames.length} onClick={()=>{setDemoTeams(current=>{const count=current[room.id]?.count || 0;return {...current,[room.id]:{count:Math.min(count+1,demoTeammateNames.length),selected:Math.min(count,demoTeammateNames.length-1)}};});setToast('Demo teammate added. No model calls.');}}><Plus size={16}/></button>
        {demoCount>0 && <><button aria-label="View project district" title="View project district" onClick={()=>{setCompact(false);scene.current?.focusTeam();}}><Building2 size={14}/></button><select aria-label="Demo teammate office" value={demoTeam.selected} onChange={e=>chooseDemoOffice(demoOffices[Number(e.target.value)].id)}>{demoTeammateNames.slice(0,demoCount).map((name,i)=><option key={name} value={i}>{name} · Demo</option>)}</select><button aria-label="Clear demo teammates" title="Clear demo teammates" onClick={()=>setDemoTeams(current=>({...current,[room.id]:{count:0,selected:0}}))}><X size={14}/></button></>}
      </div>}
      {tool==='office' && floorRoom.team?.remote && !compact && !walk && !cinematic && !recording && <div className="team-floor-bar"><button onClick={()=>{setCompact(false);scene.current?.focusTeam();}}>{floorRoom.team.owner} + {floorRoom.team.remote.owner}</button><button onClick={()=>demoCount?setToast('Demo office · simulated agents and assignments.'):setTool('team')}><span className={`team-presence ${floorRoom.team.connected?'online':''}`}/>{demoCount?'Preview':floorRoom.team.connected?'Connected':'Offline'}</button></div>}
      {cinematic && <DemoDirector connected={streamOnline} room={room} onRoom={switchRoom} onShot={step=>scene.current?.setCinema(step)} onClose={()=>setCinematic(false)} onEvidence={()=>{setCinematic(false);setCompact(false);setSelectedWork(room.workItems.find(item=>item.requiredEvidence?.includes('diff'))?.id || null);setTool('work');}}/>}
      {spatial && !cinematic && !recording && !walk && !compact && <div className="spatial-badges" aria-label="Spatial task states">{markers.map(marker=>{const owner=(replayRoom || room).agents.find(a=>a.id===marker.id);if(!owner)return null;return <button key={marker.id} aria-label={`${agentSpeech(owner)} ${workLabels[marker.status as keyof typeof workLabels]}`} title={`${owner.name} · ${workLabels[marker.status as keyof typeof workLabels]}`} disabled={!!replayRoom} className={`desk-badge ${selection===marker.id?'selected':''}`} style={{transform:`translate(${marker.x}px,${marker.y}px) translate(-50%,-100%)`,borderColor:workColors[marker.status as keyof typeof workColors]}} onClick={()=>whip && tool==='office'?scene.current?.onWhip?.(marker.id):select(marker.id)}><b>{owner.name}</b>{owner.title && <small>{owner.title}</small>}<span style={{color:workColors[marker.status as keyof typeof workColors]}}><i/>{workLabels[marker.status as keyof typeof workLabels]}</span></button>;})}</div>}
      {tool==='office' && sceneError && !compact && <div className="scene-fallback" role="status"><Monitor size={32} /><p>{sceneError}</p><p>Try again, or fully restart your browser or Codex. Your agents can keep working in the map.</p><button className="primary" onClick={()=>{scene.current?.dispose();scene.current=null;setSceneReady(false);setMarkers([]);setWalk(false);setSceneError('');}}>Retry 3D</button><button className="secondary" onClick={()=>{setCompact(true);setTool('office');}}>Use compact map</button></div>}
      {tool==='office' && walk && <><span className="crosshair">+</span><div className="walk-hint"><kbd>W A S D</kbd> move <span>·</span> drag to look <span>·</span><kbd>E</kbd> inspect <span>·</span><kbd>Esc</kbd> overview</div><div className="touch-pad">{[['↑', 'w', 'forward'], ['←', 'a', 'left'], ['↓', 's', 'backward'], ['→', 'd', 'right']].map(([label, key, direction]) => <button key={key} aria-label={`Move ${direction}`} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); scene.current?.keys.add(key); }} onPointerUp={() => scene.current?.keys.delete(key)} onPointerCancel={() => scene.current?.keys.delete(key)}>{label}</button>)}</div></>}

      {spatial && compact && (floorRoom.team?.remote && !replayRoom ? <TeamMap key={room.id} room={floorRoom} onOffice={chooseDemoOffice} onAgent={select} onTeam={()=>demoCount?setToast('Demo office · simulated agents and assignments.'):setTool('team')} onHandoffs={()=>setTool('messages')}/> : <CompactOffice room={replayRoom || room} templates={data.templates} selected={selectedWork} historical={!!replayRoom} busy={busy} onTask={id=>{setSelectedWork(id);setTool('work');}} onTemplates={()=>setTool('templates')} onAdvance={()=>action(()=>officeApi(`/rooms/${room.id}/demo/step`,{}))} onReplay={()=>setTool('replay')}/>)}
      {tool==='office' && !demoCount && !cinematic && !recording && !walk && !compact && <OfficePulse room={replayRoom || room} onTool={setTool} onTask={id=>{if(!replayRoom){setSelectedWork(id);setTool('work');}}} busy={busy || !!replayRoom} onAdvance={()=>action(()=>officeApi(`/rooms/${room.id}/demo/step`,{}))}/>}
      {replayRoom && <div className="replay-banner"><Clock3 size={14}/> Historical view · live work continues<button onClick={()=>{setTool('office');setReplayRoom(null);}}>Return to live</button></div>}
      {tool !== 'office' && !cinematic && !recording && <aside className={`detail-panel ${['mission','replay','modes','templates','work','messages','dashboard'].includes(tool)?'ops-panel':''} ${tool==='dashboard'?'dashboard-panel':''}`} key={tool === 'agent' ? selection : tool}>
        <div className="panel-window-actions"><button onClick={()=>tool==='replay'?setHistorySpatial(v=>!v):setPanelExpanded(v=>!v)}>{spatial?<Expand size={14}/>:<Building2 size={14}/>} {spatial?'Expand panel':'Show office'}</button><button aria-label="Close panel" onClick={()=>{setTool('office');setSelection(null);setReplayRoom(null);}}><X size={16}/></button></div>
        <div className="panel-body">
          {tool==='team' && <TeamPanel key={room.id} room={room} onFloor={()=>{setTool('office');setCompact(!!sceneError);scene.current?.focusTeam();}} onHandoffs={()=>setTool('messages')}/>}
          {tool === 'agent' && selected && <AgentPanel agent={selected} room={room} connected={!!data.connection.account} onConnect={()=>openConnect(tool)} busy={busy} action={action} modelOptions={modelOptions} onSelect={select} onTask={id=>{setSelectedWork(id);setTool('work');}} onBack={()=>setTool('dashboard')} onFocus={() => {setTool('office');setCompact(false);scene.current?.focus(selected.id);}} />}
          {tool === 'agents' && <AgentRoster room={room} onSelect={select}/>}
          {tool === 'templates' && <MissionControl onCursor={()=>setTool('integrations')} onConnect={()=>openConnect(tool)} onTask={id=>{setSelectedWork(id);setTool('work');}} initialCompose onCancel={()=>setTool('dashboard')} room={room} data={data} busy={busy} action={action} onSelect={select} onRoom={switchRoom} onStarted={()=>setTool('dashboard')}/>}
          {tool === 'integrations' && <IntegrationsPanel key={room.id} room={room}/>}
          {tool === 'recording' && <RecordingStudio unavailable={!!sceneError || !sceneReady} onStop={stop=>{setCompact(false);setWhip(false);setReplayRoom(null);scene.current?.tourStop(stop);}} onClean={()=>{setCompact(false);setWhip(false);setHelp(false);setRecording(true);}}/>}
          {tool === 'work' && <><button className="text-button" onClick={()=>setTool('dashboard')}>Back to tickets</button><TaskWorkspace key={selectedWork} room={room} itemId={selectedWork} connected={!!data.connection.account} busy={busy} action={action} onAgent={select} onTask={setSelectedWork} onConnect={()=>openConnect(tool)} onInbox={()=>setTool('approvals')}/></>}
          {tool === 'mission' && <MissionControl onCursor={()=>setTool('integrations')} onConnect={()=>openConnect(tool)} onTask={id=>{setSelectedWork(id);setTool('work');}} room={room} data={data} busy={busy} action={action} onSelect={select} onRoom={switchRoom}/>}
          {tool === 'modes' && <ModesPanel room={room} data={data} busy={busy} action={action}/>}
          {tool === 'replay' && <ReplayPanel spatial={historySpatial} onSpatial={()=>setHistorySpatial(v=>!v)} room={room} busy={busy} action={action} onFrame={setReplayRoom} onRoom={switchRoom}/>}
          {tool === 'messages' && <HandoffsPanel room={room} onAgent={select} onTask={id=>{setSelectedWork(id);setTool('work');}}/>}
          {tool === 'dashboard' && <Dashboard key={room.id} onConnect={()=>openConnect(tool)} onInbox={()=>setTool('approvals')} data={data} room={room} busy={busy} action={action} onAgent={(rid,id)=>{if(rid!==room.id)switchRoom(rid);select(id);}} onMission={rid=>{if(rid!==room.id)switchRoom(rid);setTool('templates');}}/>}
          {tool === 'skills' && <><h2>Skills</h2>{Object.entries(skillDescriptions).map(([id, s]) => <div className="skill-row" key={id}><s.icon size={22} /><div><h3>{s.title}</h3><p>{s.description}</p></div><button role="switch" aria-checked={room.skills.includes(id)} aria-label={`Enable ${s.title}`} className={`switch ${room.skills.includes(id) ? 'on' : ''}`} disabled={busy} onClick={() => action(() => api(roomEndpoint, { skills: room.skills.includes(id) ? room.skills.filter(x => x !== id) : [...room.skills, id] }, 'PATCH'))}><i /></button></div>)}<p className="small muted">Applies to new agents.</p><button className="primary full" disabled={busy} onClick={() => action(() => api(`${roomEndpoint}/install-skills`, {}), 'Three skills installed in this project’s .agents/skills folder')}><ArrowDownToLine size={16} /> Install into project</button><a className="text-link" href="https://github.com/openai/skills" target="_blank" rel="noreferrer">Explore OpenAI’s skill library <ExternalLink size={13} /></a></>}
          {tool === 'tools' && <><ToolsPanel room={room} connected={!!data.connection.account} action={action} onConnect={() => openConnect(tool)} onTool={setTool} onDemo={()=>{setCompact(false);setTool('office');setCinematic(true);}} onWhip={()=>{setCompact(false);setTool('office');setWhip(true);}} onHelp={()=>setHelp(v=>!v)} /></>}
          {tool === 'approvals' && <ManagerInbox data={data} busy={busy} action={action} onTask={(rid,id)=>{if(rid!==room.id)switchRoom(rid);setSelectedWork(id);setTool('work');}}/>}
          {tool === 'settings' && <><h2>Settings</h2><PermissionsPanel room={room} busy={busy} action={action} onConnect={()=>openConnect('settings')}/><label>Concurrent workers <span className="value-pill">{room.budget}</span><input type="range" min="1" max="6" value={room.budget} onChange={e => action(() => api(roomEndpoint, { budget: Number(e.target.value) }, 'PATCH'))} /></label><p className="muted small">{room.permissionMode==='read-only'?'Agents research and review in parallel. File edits are disabled.':'Workers research and review in parallel. The manager owns implementation, keeping file edits coordinated.'}</p><div className="setting-line"><div><b>Office activity</b><p>{cursorOwner ? 'Managed in Cursor' : room.paused ? 'Currently paused' : 'Accepting assignments'}</p></div>{cursorOwner ? <button className="secondary" onClick={()=>select(cursorOwner.id)}>Open desk</button> : <button className="secondary" disabled={busy} onClick={() => action(() => api(`${roomEndpoint}/${room.paused ? 'resume' : 'pause'}`, {}))}>{room.paused ? <Play size={15} /> : <Pause size={15} />}{room.paused ? 'Resume' : 'Pause all'}</button>}</div><details className="compact-disclosure"><summary>Virtual reality</summary><p className="quiet-copy">WebXR headset required. Task editing uses desktop controls.</p><button className="secondary" onClick={()=>action(async()=>{if(!scene.current){setTool('office');setToast('Open Settings again after the office loads to enter VR.');return;}await scene.current.enterVR();})}><Glasses size={16}/> Enter VR</button></details><label>Project folder<input readOnly value={room.path} /></label>{!room.demo && <button className="secondary" disabled={busy || !data.connection.account} onClick={()=>action(()=>officeApi(`/rooms/${room.id}/check`,{}),'Project folder is accessible in the Codex sandbox')}>Check project access</button>}</>}
          {tool === 'connect' && <ConnectPanel connection={data.connection} busy={busy} action={action} onNewRoom={() => setTool(room.demo?'newroom':connectReturn)} />}
          {tool === 'rooms' && <ProjectRooms rooms={data.rooms} current={room.id} busy={busy} action={action} onRoom={switchRoom} onNew={()=>setTool('newroom')}/>}
          {tool === 'newroom' && <NewRoom defaultPath="" connected={!!data.connection.account} busy={busy} onSubmit={(name, path, demo) => action(async () => { const result = await api('/rooms', { name, path, demo }); switchRoom(result.room.id); }, 'Your new office is ready')} />}
        </div>
      </aside>}

      {help && <div className="help-panel"><button className="icon-button" aria-label="Close help" onClick={() => setHelp(false)}><X size={16} /></button><h3>Controls</h3><p><b>Overview</b> · Drag to orbit, scroll to zoom. Click a desk to inspect an agent.</p><p><b>Walk mode</b> · WASD or arrow keys to move. Drag to look. E to inspect. Esc to return.</p><p><b>Hotbar</b> · 1–8 open tools. 9 equips the whip. V switches camera mode.</p><p><b>Window exit</b> · Open an agent’s desk, choose Eject, then choose a replacement model.</p></div>}
      {whip && tool === 'office' && <><WhipOverlay crack={crack} /><div className="whip-hint"><WhipIcon /><span>Click an agent to activate Crunch.<small>Next turns · 6 workers · 5-minute budget</small></span><button aria-label="Put away whip" onClick={() => setWhip(false)}><X size={16} /></button></div></>}
      <nav inert={recording || cinematic} className="workspace-nav" aria-label="Workspace">
        <button aria-current={tool==='office'?'page':undefined} onClick={()=>{setWhip(false);setTool('office');}}><Building2 size={17}/>Office</button>
        <button aria-current={['dashboard','work','templates','mission'].includes(tool)?'page':undefined} onClick={()=>{setWhip(false);setTool('dashboard');}}><LayoutGrid size={17}/>Tickets</button>
        <button aria-current={['agents','agent'].includes(tool)?'page':undefined} onClick={()=>setTool('agents')}><Users size={17}/>Agents</button>
        <button aria-current={tool==='messages'?'page':undefined} onClick={()=>setTool('messages')}><MessageSquare size={17}/>Handoffs</button>
        <button aria-current={tool==='team'?'page':undefined} onClick={()=>setTool('team')}><Users size={17}/>Team{room.team?.overlaps.length ? <span className="nav-count">{new Set(room.team.overlaps.flatMap(o=>o.files)).size}</span> : null}</button>
        <button aria-current={tool==='approvals'?'page':undefined} onClick={()=>setTool('approvals')}><Bell size={17}/>Inbox{approvalCount>0 && <span className="nav-count">{approvalCount}</span>}</button>
        <div className="nav-divider"/>
        <button aria-current={tool==='replay'?'page':undefined} onClick={()=>setTool('replay')}><Clock3 size={17}/>History</button>
        <div className="nav-spacer"/>
        <button aria-current={tool==='tools'?'page':undefined} onClick={()=>setTool('tools')}><Terminal size={17}/>Tools</button>
        <button aria-current={tool==='settings'?'page':undefined} onClick={()=>setTool('settings')}><Settings2 size={17}/>Settings</button>
      </nav>
      {recording && <div className="recording-strip"><span>{room.demo?'SCRIPTED DEMO':data.connection.testAgents?'TEST AGENTS':'LIVE OFFICE'}</span><button onClick={()=>{setRecording(false);setTool('recording');}}>Exit clean view · Esc</button></div>}
      {!streamOnline && <div className="connection-notice" role="status">Reconnecting to companion…</div>}
    </main>
    {busy && <div className="busy-indicator"><LoaderCircle size={15} className="spin" /> Working…</div>}
    {(toast || error) && <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <Bell size={18} /> : <Check size={18} />}<span>{error || toast}</span><button aria-label="Dismiss notification" onClick={() => { setToast(''); setError(''); }}><X size={16} /></button></div>}
  </div>;
}
function AgentRoster({room,onSelect}:{room:Room;onSelect:(id:string)=>void}) {
  const row=(a:Agent)=><button className="agent-row" key={a.id} aria-label={agentSpeech(a)} onClick={()=>onSelect(a.id)}><Avatar agent={a}/><span><b>{agentLine(a)}</b><p>{a.task}</p><small className="agent-model">{modelLabel(a.effectiveModel || a.model)}</small><Status agent={a}/></span><ChevronRight size={16}/></button>;
  const past=room.agents.filter(a=>a.status==='ejected');
  return <><h2>Agents</h2>{room.agents.filter(a=>a.status!=='ejected').map(row)}{!!past.length && <details className="compact-disclosure"><summary>Previous agents · {past.length}</summary>{past.map(row)}</details>}</>;
}
function time(value: number) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
type Action = (fn: () => Promise<unknown>, success?: string) => Promise<void>;
function Empty({ icon: Icon, text }: { icon: typeof Users; text: string }) { return <div className="empty"><Icon size={30} strokeWidth={1.3} /><p>{text}</p></div>; }
function AgentPanel({ agent: a, room, connected, onConnect, busy, action, modelOptions, onSelect, onFocus, onTask, onBack }: { onTask:(id:string)=>void;onBack:()=>void;agent: Agent; room: Room; connected: boolean; onConnect: () => void; busy: boolean; action: Action; modelOptions: () => React.ReactNode; onSelect: (id: string) => void; onFocus: () => void }) {
  const [tab, setTab] = useState('activity'); const [message, setMessage] = useState(''); const [replace, setReplace] = useState(false); const [model, setModel] = useState('gpt-6-sol'); const [confirmedStopped, setConfirmedStopped] = useState(false);
  const endpoint = `/rooms/${room.id}/agents/${a.id}`;
  const task=agentWork(room,a);
  return <><button className="text-button" onClick={onBack}>Back to tickets</button><div className="agent-heading" aria-label={agentSpeech(a)}><Avatar agent={a} size="large" /><div><h2>{a.name}</h2><p>{a.title || a.role}</p></div><button className="icon-button" title="Go to desk" aria-label="Go to desk" onClick={onFocus}><Expand size={18} /></button></div><div className="agent-meta"><Status agent={a} /><span>{modelLabel(a.effectiveModel || a.model)}{a.provider === 'cursor' && !a.model.includes('not reported') && ' · reported'}</span></div><h3 className="task-heading">{task?.title || a.task}</h3>{task && <button className="primary full" onClick={()=>onTask(task.id)}>Open ticket · {workLabels[task.status]} <ArrowRight size={14}/></button>}{a.provider === 'cursor' && <p className="notice">{a.turnId ? 'Execution managed in Cursor. Stop and change models there.' : 'Cursor assignment closed. Inspect saved work.'}</p>}{a.provider !== 'cursor' && <details className="compact-disclosure"><summary>Model settings</summary><div className="speed-control"><div><b>{a.fastMode ? 'Fast requested' : 'Standard speed'}</b><small>Next turn</small></div><button className="secondary" disabled={busy || a.status === 'ejected'} onClick={() => action(async () => { await api(endpoint + '/speed', { fast: !a.fastMode }); }, a.fastMode ? 'Standard speed selected for the next turn' : 'Fast mode requested for the next turn')}><Zap size={14} />{a.fastMode ? 'Use standard' : 'Use fast'}</button></div><p className="speed-cost">Fast may use more quota. Crunch overrides this preference.</p></details>}{a.provider !== 'cursor' && (!!a.tokens || !!a.plan.length) && <div className="agent-metrics"><span><Zap size={13} /> {a.tokens ? a.tokens.toLocaleString() : '—'} tokens</span><span>{a.plan.filter(step=>step.status==='completed').length}/{a.plan.length} plan steps</span></div>}<div className="tabs">{(a.provider === 'cursor' ? ['activity', 'changes', 'handoff'] : ['activity', 'plan', 'changes', 'handoff']).map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === 'activity' && <div className="event-list">{!a.events.length && <Empty icon={Monitor} text="No activity yet." />}{a.events.slice(-25).map(e => <div className={`work-event ${e.kind}`} key={e.id}><div><span>{e.kind === 'update' ? 'PROGRESS' : e.kind.toUpperCase()}</span><time>{time(e.time)}</time></div><p>{e.text}</p></div>)}</div>}
    {tab === 'handoff' && <HandoffDossier agent={a}/>}
    {tab === 'plan' && <div className="plan-list">{a.plan.length ? a.plan.map((p, i) => <div key={i}>{p.status === 'completed' ? <Check size={17} /> : p.status === 'inProgress' ? <LoaderCircle size={17} /> : <span className="plan-circle" />}<span>{p.step}<small>{p.status === 'inProgress' ? 'In progress' : p.status}</small></span></div>) : <Empty icon={LayoutGrid} text="No plan yet." />}</div>}
    {tab === 'changes' && (a.diff ? <><div className="artifact-actions"><DiffButton title={a.task} entries={[{text:a.diff,label:"Latest agent turn"}]}/></div><pre className="diff">{a.diff}</pre></> : <Empty icon={FileCode2} text={room.demo ? 'Sample agents do not change files.' : 'No file diff reported for this turn.'} />)}
    {a.provider !== 'cursor' && a.status !== 'ejected' && <form className="message-form" onSubmit={e => { e.preventDefault(); action(async () => { await api(`${endpoint}/message`, { message }); setMessage(''); }, 'Message delivered'); }}><label className="sr-only" htmlFor="agent-message">Message {a.name}</label><textarea id="agent-message" rows={2} placeholder={a.turnId?`Guidance for ${a.name}…`:`Start ${a.name} with an instruction…`} value={message} onChange={e => setMessage(e.target.value)} required /><button aria-label={a.turnId?"Send guidance":"Start agent"} disabled={busy || !message.trim() || room.paused || (!room.demo && !connected)}>{a.turnId?<Send size={17}/>:<Play size={17}/>}</button></form>}
    {a.provider === 'cursor' && a.turnId && <details className="compact-disclosure"><summary>Cursor session ended?</summary><p>Stop it in Cursor first. Releasing this desk preserves its work and lets another agent continue.</p><label className="cursor-release-check"><input type="checkbox" checked={confirmedStopped} onChange={e=>setConfirmedStopped(e.target.checked)}/> Cursor has finished or stopped</label><button className="secondary full" disabled={busy || !confirmedStopped} onClick={()=>action(()=>api(`/rooms/${room.id}/cursor/${a.id}/release`,{confirmedStopped:true}),'Assignment released. Saved work needs review.')}>Release assignment</button></details>}
    <div className="agent-actions">{a.provider !== 'cursor' && !['paused', 'ejected', 'done', 'idle', 'error'].includes(a.status) && <button className="secondary" disabled={busy} onClick={() => action(() => api(`${endpoint}/stop`, {}), 'Agent paused')}><Pause size={14} /> Pause</button>}{a.status !== 'ejected' && <button className="eject-button" disabled={busy || (a.provider === 'cursor' && !!a.turnId)} onClick={() => action(() => api(`${endpoint}/eject`, {}), `${a.name} left through the window. Handoff saved.`)}><Wind size={16} /> Eject through window <ArrowUpRight size={13} /></button>}</div>
    {a.replacedBy && <button className="secondary full" onClick={()=>onSelect(a.replacedBy!)}>Open replacement <ArrowRight size={14}/></button>}
    {!a.replacedBy && ['paused', 'ejected', 'done', 'idle', 'error'].includes(a.status) && <><button className="secondary full" onClick={() => setReplace(v => !v)}><Sparkles size={16} /> Replace with another model <ChevronDown size={14} /></button>{replace && <form className="replace-form" onSubmit={e => { e.preventDefault(); action(async () => { const result = await api(`${endpoint}/replace`, { model }); onSelect(result.agent.id); }, 'Replacement started with the saved handoff'); }}><label>Replacement model<select value={model} onChange={e => setModel(e.target.value)}>{modelOptions()}</select></label><p className="muted small">Saved context carries over.{a.provider === 'cursor' && ' Replacement uses your connected Codex account.'}</p><button className="primary full" disabled={busy || (!room.demo && !connected)}><Play size={14} /> Start replacement</button>{!room.demo && !connected && <button type="button" className="text-button" onClick={onConnect}>Connect Codex to replace this agent</button>}</form>}</>}
    {a.threadId && <p className="thread-id">TASK {a.threadId}</p>}
  </>;
}
function NewRoom({ defaultPath, connected, busy, onSubmit }: { defaultPath: string; connected: boolean; busy: boolean; onSubmit: (name: string, path: string, demo: boolean) => void }) {
  return <><h2>New project</h2><form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); onSubmit(String(f.get('name')), String(f.get('path')), false); }}><label>Name<input name="name" required maxLength={60} autoFocus placeholder="e.g. Customer portal" /></label><label>Existing project folder<input name="path" required defaultValue={defaultPath} placeholder="C:\Projects\my-project" /></label>{!connected && <p className="notice">Use Cursor here, or connect Codex to run the office manager.</p>}<button className="primary full" disabled={busy}><Plus size={16} /> Create project</button></form></>;
}
function ConnectPanel({ connection, busy, action, onNewRoom }: { connection: OfficeState['connection']; busy: boolean; action: Action; onNewRoom: () => void }) {
  const [authUrl, setAuthUrl] = useState('');
  return <><h2>Connect Codex</h2>{connection.account ? <><div className="account-info"><CheckCheck size={22} /><div><b>{connection.account.email || 'Account connected'}</b><small>{connection.account.planType || connection.account.type}</small></div></div><button className="primary full" onClick={onNewRoom}><ArrowRight size={16} /> Continue to project</button></> : <><p className="muted">Sign in to run agents in your project folders.</p><button className="primary full" disabled={busy} onClick={() => action(async () => { const c = await api('/connect', {}); if (!c.account) { const login = await api('/login', {}); setAuthUrl(login.authUrl); } })}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUpRight size={16} />} Connect Codex</button>{authUrl && <a className="auth-link secondary full" href={authUrl} target="_blank" rel="noreferrer">Continue secure sign-in <ExternalLink size={16} /></a>}</>}{connection.account && connection.sandboxStatus && connection.sandboxStatus!=='ready' && <div className="notice"><b>Enable project editing</b><p>Set up the Windows sandbox. Windows may ask for administrator approval.</p><button className="secondary full" disabled={busy || connection.sandboxSetupPending} onClick={()=>action(()=>api('/sandbox/setup',{}),'Complete the Windows setup prompt')}>{connection.sandboxSetupPending?'Setting up sandbox…':'Set up Windows sandbox'}</button></div>}{connection.error && <p className="notice error">{connection.error}</p>}<button className="text-button" disabled={busy} onClick={() => action(() => api('/connect', {}), 'Connection refreshed')}><RotateCcw size={14} /> Refresh connection</button></>;
}
function ToolsPanel({ room, connected, action, onConnect, onTool, onDemo, onWhip, onHelp }: { room: Room; connected: boolean; action: Action; onConnect: () => void; onTool: (tool: Tool) => void; onDemo:()=>void; onWhip:()=>void; onHelp:()=>void }) {
  const [catalog, setCatalog] = useState<{ skills?: unknown; mcp?: unknown; errors?: string[] } | null>(null);
  const tools = [
    {name:'Workflows',icon:Layers,target:'templates'},
    {name:'Run mode',icon:Zap,target:'modes'},
    {name:'Skills',icon:Sparkles,target:'skills'},
    {name:'Cursor',icon:ArrowUpRight,target:'integrations'}
  ];
  return <><h2>Tools</h2>{tools.map(t=><button className="tool-row" key={t.target} onClick={()=>onTool(t.target as Tool)}><t.icon size={19}/><span><b>{t.name}</b></span><ChevronRight size={14}/></button>)}
    <details className="compact-disclosure"><summary>Presentation</summary><button className="tool-row" onClick={onDemo}><Play size={19}/><span>Watch demo</span></button><button className="tool-row" onClick={()=>onTool('recording')}><Monitor size={19}/><span>Recording studio</span></button><button className="tool-row" onClick={onWhip}><Zap size={19}/><span>Whip · Crunch mode</span></button></details>
    <a className="tool-row" href={`/api/export/${room.id}`} download><ArrowDownToLine size={19}/><span><b>Export history</b></span></a>
    <button className="tool-row" onClick={onHelp}><CircleHelp size={19}/><span>Keyboard controls</span></button>
    <details className="compact-disclosure"><summary>Codex tool catalog</summary><button className="secondary full" onClick={()=>connected?action(async()=>setCatalog(await api(`/tools?roomId=${room.id}`))):onConnect()}><RotateCcw size={15}/>{connected?'Load catalog':'Connect Codex'}</button>{catalog && <pre className="catalog">{JSON.stringify(catalog,null,2)}</pre>}</details>
  </>;

}


