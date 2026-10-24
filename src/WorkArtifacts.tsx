import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileCode2, X } from 'lucide-react';
import type { Room, WorkItem } from './types';
import './artifacts.css';

export function DiffButton({entries,title}:{entries:{text:string;label:string}[];title:string}) {
  const [open,setOpen]=useState(false);
  if(!entries.length)return null;
  return <><button onClick={()=>setOpen(true)}><FileCode2 size={14}/> Open diff</button>{open && createPortal(<DiffViewer title={title} entries={entries} onClose={()=>setOpen(false)}/>,document.body)}</>;
}
function DiffViewer({entries,title,onClose}:{entries:{text:string;label:string}[];title:string;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [selected,setSelected]=useState(entries.length-1);
  const entry=entries[Math.min(selected,entries.length-1)];
  useEffect(()=>{const element=dialog.current!,previous=document.activeElement as HTMLElement|null;element.showModal();return()=>{element.close();previous?.focus();};},[]);
  return <dialog ref={dialog} className="diff-viewer" onKeyDown={e=>e.stopPropagation()} onKeyUp={e=>e.stopPropagation()} onCancel={onClose} aria-labelledby="diff-title">
    <header><div><small>CODE CHANGES</small><h2 id="diff-title">{title}</h2></div><button aria-label="Close diff" onClick={onClose}><X size={20}/></button></header>
    <div className="diff-toolbar"><label>Recorded diff<select value={selected} onChange={e=>setSelected(Number(e.target.value))}>{entries.map((e,i)=><option value={i} key={i}>{e.label}</option>)}</select></label><span>+ added · − removed</span></div>
    <pre tabIndex={0} aria-label="Diff contents">{entry.text.split('\n').map((line,i)=><span key={i} className={line.startsWith('@@')?'diff-hunk':line.startsWith('+')?'diff-added':line.startsWith('-')?'diff-removed':line.startsWith('diff ') || line.startsWith('index ')?'diff-file':''}>{line || ' '}<br/></span>)}</pre>
    <footer>Recorded evidence; files may have changed since this was captured.</footer>
  </dialog>;
}
function safeLink(value?:string) {
  if(!value)return undefined;
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol) && !url.username && !url.password?url.href:undefined;}catch{return undefined;}
}
export function WorkArtifacts({room,item,readOnly=false}:{room:Room;item:WorkItem;readOnly?:boolean}) {
  const [editing,setEditing]=useState(false),[url,setUrl]=useState(item.previewUrl || ''),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const entries=item.evidence.filter(e=>e.kind==='diff' && e.text.trim()).map((e,i)=>({text:e.text,label:`${i+1} · ${e.source || (room.demo?'Demo sample':'Reported diff')} · ${new Date(e.time).toLocaleTimeString()}`}));
  const preview=room.demo && item.evidence.some(e=>e.artifact==='/demo-search.svg')?'/demo/search-preview.html':safeLink(item.previewUrl);
  const canLink=!!preview || item.requiredEvidence?.some(kind=>['diff','screenshot'].includes(kind));
  if(!entries.length && !canLink)return null;
  return <section className="work-artifacts" aria-label="Work artifacts">
    <div className="artifact-actions"><DiffButton entries={entries} title={item.title}/>{preview && <a href={preview} target="_blank" rel="noopener noreferrer">{room.demo?'Open sample':'Open feature'} <ExternalLink size={14}/></a>}{canLink && !readOnly && !room.demo && <button className="artifact-edit" onClick={()=>{setUrl(item.previewUrl || '');setError('');setEditing(!editing);}}>{preview?'Edit link':'Add feature link'}</button>}</div>
    {!entries.length && item.requiredEvidence?.includes('diff') && <p className="quiet-copy">No diff recorded yet.</p>}
    {preview && !room.demo && <p className="artifact-destination">{preview}<small>Local links need the project’s dev server running.</small></p>}
    {editing && <form onSubmit={async e=>{e.preventDefault();setSaving(true);setError('');try{const response=await fetch(`/api/rooms/${room.id}/work/${item.id}/feature`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({previewUrl:url})});const result=await response.json();if(!response.ok)throw new Error(result.error || 'Could not save the link');setEditing(false);}catch(err){setError((err as Error).message);}finally{setSaving(false);}}}>
      <label>Feature URL<input autoFocus type="url" maxLength={2000} value={url} onChange={e=>setUrl(e.target.value)} placeholder="http://localhost:5173/search"/></label><div className="artifact-actions"><button disabled={saving} type="submit">{saving?'Saving…':url.trim()?'Save link':'Remove link'}</button><button type="button" disabled={saving} onClick={()=>setEditing(false)}>Cancel</button></div>{error && <p role="alert">{error}</p>}
    </form>}
  </section>;
}
