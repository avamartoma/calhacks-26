import { ArrowRight, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import type { Room } from './types';
import { workLabels, workColors } from './Operations';

export function TeamMap({room,onAgent,onTeam,onHandoffs,onOffice}:{room:Room;onAgent:(id:string)=>void;onTeam:()=>void;onHandoffs:()=>void;onOffice:(id:string)=>void}) {
  const [query,setQuery]=useState('');
  const team=room.team,remote=team?.remote;if(!team || !remote)return null;
  const offices=[{id:room.id,owner:team.owner,name:room.name,agents:room.agents,workItems:room.workItems.filter(t=>!t.archived),local:true},...(team.offices || [remote]).map(office=>({...office,local:false}))];
  const matching=offices.filter(office=>[office.owner,office.name,...office.agents.map(a=>`${a.name} ${a.role} ${a.task}`),...office.workItems.map(t=>t.title)].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const messages=team.simulated?[]:room.messages.filter(m=>m.fromOfficeId).slice(-3).reverse();
  return <section className="team-map" aria-label="Team office map"><header><h1>{room.name}</h1><button className="secondary" onClick={onTeam}><span className={`team-presence ${team.connected?'online':''}`}/>{team.simulated?'Demo teammate':team.connected?'Teammate connected':'Teammate offline'}</button></header>
    <div className="team-map-search"><input aria-label="Search project team" placeholder="Find a teammate, agent or ticket…" value={query} onChange={e=>setQuery(e.target.value)}/><span>{matching.length} / {offices.length} offices</span></div>
    {!matching.length && <p role="status">No matching offices. <button className="text-button" onClick={()=>setQuery('')}>Clear search</button></p>}
    <div className="team-map-offices">{matching.map(office=><section className="team-map-office" key={office.id}><header><h2>{office.owner}<small>{office.local?'Your office':office.name}</small></h2><span>{office.agents.filter(a=>a.status!=='ejected').length} agents</span></header>
      {!office.local && team.simulated && <button className="text-button" onClick={()=>onOffice(office.id)}>Open office <ArrowRight size={13}/></button>}
      <div className="team-map-desks">{office.agents.filter(a=>a.status!=='ejected').map(a=>{const task=office.workItems.find(t=>t.agentId===a.id && t.status!=='done') || office.workItems.find(t=>t.agentId===a.id);return <button key={a.id} onClick={()=>office.local?onAgent(a.id):team.simulated?onOffice(office.id):onTeam()}><span className="team-map-monitor"><b>{task?.title || a.task}</b><small style={{color:task?workColors[task.status]:undefined}}>{task?workLabels[task.status]:a.status}</small></span><span className="team-sphere" style={{background:a.color}}>••</span><b>{a.name}</b><small>{a.role} · {a.model}</small></button>;})}</div>
    </section>)}</div>
    <footer><button className="text-button" onClick={onHandoffs}><MessageSquare size={15}/>Between offices <ArrowRight size={14}/></button>{messages.length?messages.map(m=><button className="team-map-handoff" key={m.id} onClick={onHandoffs}><small>{m.fromOwner} → {m.toOwner} · {m.status}</small><span>{m.text}</span></button>):<p className="quiet-copy">No cross-office handoffs yet.</p>}{team.overlaps.length>0 && <button className="text-button" onClick={onTeam}>Review shared file scopes <ArrowRight size={14}/></button>}</footer>
  </section>;
}
