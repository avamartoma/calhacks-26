import { useState } from 'react';
import type { Room, WorkItem } from './types';
export function TicketForm({room,item,busy,onSave,onCancel}:{room:Room;item?:WorkItem;busy:boolean;onSave:(body:unknown)=>void;onCancel:()=>void}) {
  const [title,setTitle]=useState(item?.title || ''),[description,setDescription]=useState(item?.description || ''),[criteria,setCriteria]=useState(item?.acceptanceCriteria.join('\n') || '');
  const [files,setFiles]=useState(item?.files?.join('\n') || ''),[dependencies,setDependencies]=useState(item?.dependsOn || []),[priority,setPriority]=useState(item?.priority || 'normal');
  const [revision]=useState(item?.updatedAt),[error,setError]=useState('');
  return <form className="ticket-form" onSubmit={e=>{
    e.preventDefault();const lines=criteria.split('\n').map(s=>s.trim()).filter(Boolean),scope=files.split('\n').map(s=>s.trim()).filter(Boolean);
    if(!title.trim() || lines.length<1 || lines.length>8 || scope.length>20 || dependencies.length>8){setError('Add a title and 1–8 acceptance checks. Use at most 20 files and 8 dependencies.');return;}
    setError('');onSave({title,description:description.trim() || title,acceptanceCriteria:lines,files:scope,dependsOn:dependencies,priority,...(item?{expectedUpdatedAt:revision}:{})});
  }}>
    <label>Title<input autoFocus required minLength={3} maxLength={120} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Keep focus after clearing search"/></label>
    <label>Done when<textarea required rows={2} value={criteria} onChange={e=>setCriteria(e.target.value)} placeholder="One check per line, e.g. Clear search returns focus to the input."/></label>
    <label>Priority<select value={priority} onChange={e=>setPriority(e.target.value as typeof priority)}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
    <details><summary>Details, files & dependencies</summary>
      <label>Context<textarea maxLength={12000} rows={3} value={description} onChange={e=>setDescription(e.target.value)}/></label>
      <label>Files · one per line<textarea rows={2} value={files} onChange={e=>setFiles(e.target.value)}/></label>
      {room.workItems.filter(t=>t.id!==item?.id && !t.archived).map(t=><label className="board-dependency" key={t.id}><input type="checkbox" checked={dependencies.includes(t.id)} onChange={e=>setDependencies(e.target.checked?[...dependencies,t.id]:dependencies.filter(id=>id!==t.id))}/>{t.title}{t.status==='done'?' · verified':''}</label>)}
    </details>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="button-row"><button className="primary" disabled={busy}>{item?'Save changes':'Create ticket'}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
