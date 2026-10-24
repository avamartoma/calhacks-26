import { useEffect, useState } from 'react';
import { ArrowRight, Check, Copy, Users } from 'lucide-react';
import { officeApi, workLabels } from './Operations';
import type { Room } from './types';
import './team.css';

export function TeamPanel({room,onFloor,onHandoffs}:{room:Room;onFloor:()=>void;onHandoffs:()=>void}) {
  const [owner,setOwner]=useState(localStorage.getItem('fourteenth-owner') || '');
  const [addresses,setAddresses]=useState<string[]>([]),[address,setAddress]=useState('');
  const [code,setCode]=useState(''),[invitation,setInvitation]=useState(''),[expires,setExpires]=useState(0);
  const [tab,setTab]=useState<'invite'|'join'>('invite'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
  const [recipient,setRecipient]=useState(''),[message,setMessage]=useState(''),[sent,setSent]=useState(false);
  const [sender,setSender]=useState(room.agents.find(a=>a.manager && a.status!=='ejected')?.id || '');
  const team=room.team,remote=team?.remote;
  useEffect(()=>{if(!room.agents.some(a=>a.id===sender && a.status!=='ejected'))setSender(room.agents.find(a=>a.manager && a.status!=='ejected')?.id || room.agents.find(a=>a.status!=='ejected')?.id || '');},[room.agents,sender]);
  useEffect(()=>{officeApi('/team/addresses').then(d=>{setAddresses(d.addresses);setAddress(d.addresses[0] || '');}).catch(e=>setError(e.message));},[]);
  useEffect(()=>{if(remote && !remote.agents.some(a=>a.id===recipient && a.status!=='ejected' && a.provider!=='cursor'))setRecipient(remote.agents.find(a=>a.manager && a.status!=='ejected' && a.provider!=='cursor')?.id || remote.agents.find(a=>a.status!=='ejected' && a.provider!=='cursor')?.id || '');},[remote,recipient]);
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'Connection failed.');}finally{setBusy(false);}}
  return <section className="team-panel"><h2>Team</h2>
    {team && remote ? <>
      <div className="team-connection"><span className={`team-presence ${team.connected?'online':''}`}/><div><b>{remote.owner}</b><small>{team.connected?'Connected':team.lastSeen?`Last seen ${new Date(team.lastSeen).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`:'Connecting'}</small></div><button className="secondary" onClick={onFloor}>View offices</button></div>
      {!team.connected && <p className="notice">{team.error || 'Waiting for teammate.'} Last received work is shown below.</p>}
      {team.overlaps.length>0 && <div className="team-overlaps"><h3>Shared file scopes</h3>{[...new Set(team.overlaps.flatMap(o=>o.files))].map(file=><details key={file}><summary>{file}</summary>{team.overlaps.filter(o=>o.files.includes(file)).map(o=><p key={o.localTaskId+o.remoteTaskId}>{o.localTitle} ↔ {o.remoteTitle}</p>)}</details>)}<small>Coordinate before merging. Each office uses its own checkout.</small></div>}
      <h3>{remote.owner}’s office <span className="muted">· {remote.name}</span></h3>
      <div className="team-agent-list">{remote.agents.filter(a=>a.status!=='ejected').map(a=><button disabled={a.provider==='cursor'} key={a.id} className={recipient===a.id?'selected':''} onClick={()=>{setRecipient(a.id);setSent(false);}}><span className="team-sphere" style={{background:a.color}}>••</span><span><b>{a.name} <small>{a.role}</small></b><small>{a.task || 'No assignment'}</small></span><em>{a.status}</em></button>)}</div>
      <h3>Tickets <small>· reported by {remote.owner}</small></h3>
      {remote.workItems.length?remote.workItems.map(t=><details className="team-ticket" key={t.id}><summary><span>{t.title}</span><small>{workLabels[t.status]}</small></summary>{t.blocker && <p>{t.blocker}</p>}<p>{t.files.join(', ') || 'No file scope declared'}</p><small>{t.receiptCount} receipts in teammate’s office</small></details>):<p className="quiet-copy">No tickets yet.</p>}
      <form className="team-compose" onSubmit={e=>{e.preventDefault();run(async()=>{await officeApi(`/rooms/${room.id}/team/message`,{senderId:sender,agentId:recipient,message,kind:'question'});setMessage('');setSent(true);});}}>
        <h3>Send a handoff</h3><div className="team-route"><label>From your desk<select value={sender} onChange={e=>setSender(e.target.value)}>{room.agents.filter(a=>a.status!=='ejected').map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><ArrowRight size={16}/><label>To {remote.owner}<select value={recipient} onChange={e=>setRecipient(e.target.value)}>{remote.agents.filter(a=>a.status!=='ejected' && a.provider!=='cursor').map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>
        <label className="sr-only" htmlFor="team-message">Handoff message</label><textarea id="team-message" value={message} onChange={e=>{setMessage(e.target.value);setSent(false);}} rows={3} maxLength={6000} placeholder="Ask about a dependency or share a finding…" required/>
        <small>Active agents receive it now. Idle agents read it next turn.</small><button className="primary full" disabled={busy || !message.trim() || !recipient || !sender}>Send handoff</button>{sent && <p role="status">Queued. <button className="text-button" type="button" onClick={onHandoffs}>View handoffs</button></p>}
      </form>
      <details className="compact-disclosure"><summary>Connection settings</summary><p>Shared: agent assignments, ticket titles, file scopes and handoffs. Each person controls their own agents. Code stays in separate checkouts.</p><button className="secondary" disabled={busy} onClick={()=>run(async()=>{await officeApi(`/rooms/${room.id}/team/disconnect`,{});setInvitation('');})}>Disconnect teammate</button></details>
    </> : <>
      <p className="quiet-copy">Connect a teammate’s Fourteenth office on the same project. Each person uses their own checkout and Codex account.</p>
      {room.demo?<p className="notice">Open a live project to connect a teammate.</p>:<>
        <label>Your name<input value={owner} maxLength={60} onChange={e=>{setOwner(e.target.value);localStorage.setItem('fourteenth-owner',e.target.value);}} placeholder="Name shown to your teammate"/></label>
        <div className="tabs"><button onClick={()=>setTab('invite')} className={tab==='invite'?'active':''}>Invite teammate</button><button onClick={()=>setTab('join')} className={tab==='join'?'active':''}>Join teammate</button></div>
        {tab==='invite'?<>
          <label>Sharing address<select value={address} onChange={e=>setAddress(e.target.value)}>{addresses.map(a=><option key={a}>{a}</option>)}</select></label>
          <p className="quiet-copy">Use a trusted local network. Only the paired office can read shared work; your app and agent controls stay local.</p>
          <button className="primary full" disabled={busy || !owner.trim() || !address} onClick={()=>run(async()=>{const result=await officeApi(`/rooms/${room.id}/team/invite`,{owner,address});setInvitation(result.code);setExpires(result.expiresAt);setCopied(false);})}><Users size={16}/>Create invitation</button>
          {invitation && <div className="team-invitation"><label>Invitation code<textarea rows={3} readOnly value={invitation}/></label><button className="secondary" onClick={()=>run(async()=>{await navigator.clipboard.writeText(invitation);setCopied(true);})}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?'Copied':'Copy invitation'}</button><small>Share privately. Expires at {new Date(expires).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}.</small><p>Teammate: open the same project in Fourteenth → Team → Join teammate.</p></div>}
        </>:<form onSubmit={e=>{e.preventDefault();run(async()=>{await officeApi(`/rooms/${room.id}/team/join`,{owner,code});setCode('');});}}><label>Invitation code<textarea value={code} onChange={e=>setCode(e.target.value)} rows={4} required/></label><p className="quiet-copy">Joining shares assignments, ticket titles, file scopes and handoffs for this project.</p><button className="primary full" disabled={busy || !owner.trim() || !code.trim()}>Connect offices</button></form>}
      </>}
    </>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
