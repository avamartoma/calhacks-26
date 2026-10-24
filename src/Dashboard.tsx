import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Plus, Search } from 'lucide-react';
import type { OfficeState, Room } from './types';
import { officeApi, workLabels, workColors } from './Operations';
import { TaskWorkspace, type Action } from './TaskWorkspace';
import { TicketForm } from './TicketForm';
import { agentLine, agentSpeech } from './identity';
import './dashboard.css';

export function Dashboard({data,room,busy,action,onAgent,onMission,onConnect,onInbox}:{data:OfficeState;room:Room;busy:boolean;action:Action;onAgent:(roomId:string,id:string)=>void;onMission:(roomId:string)=>void;onConnect:()=>void;onInbox:()=>void}) {
  const detailRef=useRef<HTMLElement>(null),listRef=useRef<HTMLDivElement>(null);
  const storageKey=`fourteenth-board:${room.id}`;
  const [saved]=useState(()=>{try{return JSON.parse(sessionStorage.getItem(storageKey)||'{}');}catch{return {};}});
  const [scope,setScope]=useState<string>(data.rooms.some(r=>r.id===saved.scope && !r.archived)||saved.scope==='all'?saved.scope:room.id);
  const [query,setQuery]=useState<string>(saved.query||''),[filter,setFilter]=useState<string>(saved.filter||'open'),[selected,setSelected]=useState<string|null>(data.rooms.some(r=>r.workItems.some(t=>t.id===saved.selected && (!!t.archived === (saved.filter==='archived'))))?saved.selected:null),[creating,setCreating]=useState(false);
  const [createRoomId,setCreateRoomId]=useState(room.id),[sort,setSort]=useState('attention');
  useEffect(()=>{sessionStorage.setItem(storageKey,JSON.stringify({scope,query,filter,selected}));},[scope,query,filter,selected,storageKey]);
  useEffect(()=>{if((selected || creating) && window.matchMedia('(max-width:950px)').matches)detailRef.current?.scrollIntoView({block:'start'});},[selected,creating]);
  const offices=data.rooms.filter(r=>!r.archived && (scope==='all'?!r.demo:r.id===scope));
  const rows=offices.flatMap(r=>r.workItems.map(item=>({room:r,item,owner:r.agents.find(a=>a.id===item.agentId)})));
  const attention=(item:typeof rows[number]['item'])=>['blocked','review'].includes(item.status)||!item.agentId;
  const results=rows.filter(({item,room:r,owner})=>(filter==='archived'?item.archived:!item.archived && (filter==='all'||filter==='open'&&item.status!=='done'||filter==='attention'&&item.status!=='done'&&attention(item)||filter==='unassigned'&&!item.agentId&&item.status!=='done'||item.status===filter)) && `${item.title} ${item.description} ${r.name} ${owner?.name || ''} ${owner?.title || ''} ${owner?.role || ''} ${(item.files || []).join(' ')}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>{
    if(sort==='recent')return b.item.updatedAt-a.item.updatedAt;
    const priority=(x:typeof a)=>({high:0,normal:1,low:2}[x.item.priority || 'normal']);
    return (sort==='attention'?Number(attention(b.item))-Number(attention(a.item)):0) || priority(a)-priority(b) || a.item.createdAt-b.item.createdAt;
  });
  const detail=data.rooms.flatMap(r=>r.workItems.map(item=>({room:r,item}))).find(x=>x.item.id===selected);
  const createRoom=data.rooms.find(r=>r.id===createRoomId && !r.archived) || room;
  const currentOffice=data.rooms.find(r=>r.id===scope) || room;
  const closeDetail=()=>{setSelected(null);setCreating(false);listRef.current?.scrollIntoView({block:'start'});};
  return <div className={`dashboard ${detail||creating?'showing-detail':''}`}>
    <header className="board-heading"><div><h2>Tickets</h2></div><div className="button-row"><button className="secondary" onClick={()=>{setCreateRoomId(scope==='all'?(room.demo?(data.rooms.find(r=>!r.demo && !r.archived)?.id || room.id):room.id):scope);setCreating(true);setSelected(null);}}><Plus size={15}/> New ticket</button><button className="primary" onClick={()=>onMission(currentOffice.id)}>Start work <ArrowRight size={14}/></button></div></header>

    <div className="board-filters"><label><span className="sr-only">Search tickets</span><Search size={15}/><input placeholder="Search tickets…" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="Office filter" value={scope} onChange={e=>{setScope(e.target.value);closeDetail();}}><option value="all">All live projects</option>{data.rooms.filter(r=>r.id===room.id || r.id===scope).map(r=><option key={r.id} value={r.id}>{r.name}{r.demo?' · Demo':''}</option>)}</select><select aria-label="Ticket status" value={filter} onChange={e=>setFilter(e.target.value)}>{[['open','Open tickets'],['attention','Needs attention'],['all','All tickets'],['unassigned','Unassigned'],['queued','Queued'],['working','Working'],['blocked','Blocked'],['review','In review'],['done','Verified'],['archived','Archived']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><select aria-label="Sort tickets" value={sort} onChange={e=>setSort(e.target.value)}><option value="attention">Attention first</option><option value="priority">Priority first</option><option value="recent">Recently updated</option></select></div>
    <div className={`board-layout ${detail||creating?'with-detail':''}`}>
      <div className="ticket-list" ref={listRef}><div className="ticket-list-heading"><span>{results.length} tickets</span></div>
        {!results.length && <div className="board-empty"><h3>{query || filter!=='open'?'No matching tickets':'No open tickets'}</h3><button className="secondary" onClick={query || filter!=='open'?()=>{setQuery('');setFilter('open');}:()=>onMission(currentOffice.id)}>{query || filter!=='open'?'Clear filters':'Start work'}</button></div>}
        {results.map(({room:r,item,owner})=><button key={item.id} className={`ticket-row ${selected===item.id?'selected':''}`} aria-label={[item.title, item.archived?'Archived':workLabels[item.status], owner?agentSpeech(owner):'Unassigned', item.blocker].filter(Boolean).join('. ')} onClick={()=>{setSelected(item.id);setCreating(false);}}><span className="ticket-state" style={{color:workColors[item.status]}}><i/>{item.archived?'Archived':workLabels[item.status]}</span><div><b title={item.title}>{item.title}</b><small>{scope==='all'?`${r.name} · `:''}{owner?`${agentLine(owner)}${owner.status==='paused'?' · paused':''}`:'Unassigned'}{item.priority==='high'?' · High priority':''}{item.dependsOn.some(id=>r.workItems.find(t=>t.id===id)?.status!=='done')?' · Waiting on dependencies':''}</small>{item.blocker && <span className="ticket-blocker">{item.blocker}</span>}</div>{['review','done'].includes(item.status) && <span className="ticket-checks">{item.checks?.filter(c=>c.passed).length || 0}/{item.acceptanceCriteria.length}<small>checks</small></span>}<ArrowRight size={14}/></button>)}
      </div>
      {creating && <section className="board-detail" ref={detailRef}><h3>New ticket</h3>{scope==='all' && <label>Project<select value={createRoom.id} onChange={e=>setCreateRoomId(e.target.value)}>{data.rooms.filter(r=>!r.archived && (!r.demo || r.id===room.id)).map(r=><option key={r.id} value={r.id}>{r.name}{r.demo?' · Demo':''}</option>)}</select></label>}<p className="quiet-copy">Creating a ticket does not start an agent.</p><TicketForm key={createRoom.id} room={createRoom} busy={busy} onCancel={closeDetail} onSave={body=>action(async()=>{const {item}=await officeApi(`/rooms/${createRoom.id}/work`,body);setScope(createRoom.id);setFilter('open');setQuery('');setCreating(false);setSelected(item.id);},'Ticket created')}/></section>}
      {detail && !creating && <section className="board-detail" ref={detailRef}><button className="text-button" onClick={closeDetail}>Back to tickets</button><TaskWorkspace key={detail.item.id} room={detail.room} itemId={detail.item.id} connected={!!data.connection.account} busy={busy} action={action} onAgent={id=>onAgent(detail.room.id,id)} onTask={setSelected} onConnect={onConnect} onInbox={onInbox}/></section>}
    </div>
  </div>;
}
