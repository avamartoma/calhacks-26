import { useState } from 'react';
import type { OfficeState, Room } from './types';
import { officeApi, workLabels } from './Operations';
import type { Action } from './TaskWorkspace';
import { agentLine, agentSpeech } from './identity';

export function attentionTickets(data:OfficeState){return data.rooms.filter(r=>!r.archived && !r.demo).flatMap(room=>room.workItems.filter(t=>!t.archived && ['blocked','review'].includes(t.status)).map(item=>({room,item})));}
export function ManagerInbox({data,busy,action,onTask}:{data:OfficeState;busy:boolean;action:Action;onTask:(roomId:string,id:string)=>void}) {
  const tickets=attentionTickets(data);
  return <><h2>Inbox</h2>
    {!data.approvals.length && !tickets.length && <div className="board-empty"><h3>Nothing needs your attention</h3></div>}
    {data.rooms.filter(room=>data.approvals.some(a=>a.roomId===room.id)||tickets.some(t=>t.room.id===room.id)).map(room=><section className="inbox-project" key={room.id}><h3>{room.name}</h3>
      {data.approvals.filter(a=>a.roomId===room.id).map(a=>{const owner=room.agents.find(w=>w.id===a.agentId);return <div className="approval" key={a.id} aria-label={owner?`${agentSpeech(owner)}. Needs a decision.`:'Agent needs a decision'}><b>{owner ? agentLine(owner) : 'Agent'} · needs a decision</b>{a.questions?<form onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);action(()=>officeApi(`/approvals/${a.id}`,{answers:Object.fromEntries(a.questions!.map(q=>[q.id,{answers:[String(form.get(q.id))]}]))}));}}>{a.questions.map(q=><label key={q.id}>{q.question}<input name={q.id} required list={`answers-${a.id}-${q.id}`}/><datalist id={`answers-${a.id}-${q.id}`}>{q.options?.map(o=><option key={o.label}>{o.label}</option>)}</datalist></label>)}<button className="primary" disabled={busy}>Send answer</button></form>:<><pre>{a.command}</pre><div className="button-row"><button className="primary" disabled={busy} onClick={()=>action(()=>officeApi(`/approvals/${a.id}`,{accept:true}))}>Allow once</button><button className="secondary" disabled={busy} onClick={()=>action(()=>officeApi(`/approvals/${a.id}`,{accept:false}))}>Decline</button></div></>}</div>})}
      {tickets.filter(t=>t.room.id===room.id).map(({item})=>{const owner=room.agents.find(w=>w.id===item.agentId);return <button className="attention-ticket" key={item.id} aria-label={`${item.title}. ${workLabels[item.status]}. ${owner?agentSpeech(owner):'Unassigned'}`} onClick={()=>onTask(room.id,item.id)}><span>{workLabels[item.status]}</span><b>{item.title}</b><small>{owner?agentLine(owner):'Unassigned'}{item.blocker?` · ${item.blocker}`:''}</small></button>;})}
    </section>)}
  </>;
}
export function ProjectRooms({rooms,current,busy,action,onRoom,onNew}:{rooms:Room[];current:string;busy:boolean;action:Action;onRoom:(id:string)=>void;onNew:()=>void}) {
  const [editing,setEditing]=useState<string|null>(null),[name,setName]=useState('');
  const card=(room:Room)=><article className="room-card" key={room.id}>
    {editing===room.id?<form onSubmit={e=>{e.preventDefault();action(async()=>{const response=await fetch(`/api/rooms/${room.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});const result=await response.json();if(!response.ok)throw new Error(result.error);setEditing(null);},'Project renamed');}}><label>Project name<input value={name} onChange={e=>setName(e.target.value)} required minLength={1} maxLength={60}/></label><div className="button-row"><button className="primary" disabled={busy}>Save</button><button type="button" className="secondary" onClick={()=>setEditing(null)}>Cancel</button></div></form>:<>
      <button className="room-open" disabled={room.archived} onClick={()=>onRoom(room.id)}><b>{room.name}{current===room.id?' · current':''}</b><small>{room.demo?'Demo':room.path}</small><span>{room.workItems.filter(t=>!t.archived && t.status!=='done').length} open · {room.agents.filter(a=>!!a.turnId).length} running</span></button>
      <div className="room-actions">{!room.archived && <button onClick={()=>{setEditing(room.id);setName(room.name);}}>Rename</button>}<button disabled={busy || room.agents.some(a=>!!a.turnId)} onClick={()=>action(()=>officeApi(`/rooms/${room.id}/archive`,{archived:!room.archived}),room.archived?'Project restored':'Project archived. Restore it below.')}>{room.archived?'Restore':'Archive'}</button></div>
    </>}
  </article>;
  return <><div className="board-heading"><h2>Projects</h2><button className="primary" onClick={onNew}>New project</button></div>{rooms.filter(r=>!r.archived && !r.demo).map(card)}{!rooms.some(r=>!r.archived && !r.demo) && <p className="quiet-copy">Create a project to start real work.</p>}<details className="compact-disclosure"><summary>Demos · {rooms.filter(r=>!r.archived&&r.demo).length}</summary>{rooms.filter(r=>!r.archived&&r.demo).map(card)}</details><details className="compact-disclosure"><summary>Archived · {rooms.filter(r=>r.archived).length}</summary>{rooms.filter(r=>r.archived).map(card)}</details></>;
}
