import { useEffect, useState } from 'react';
import type { ReviewState, Room, WorkItem } from './types';
import { officeApi, WorkDetail } from './Operations';
import { HandoffsPanel } from './HandoffsPanel';
import { TicketForm } from './TicketForm';
import { agentLine } from './identity';
export type Action=(fn:()=>Promise<unknown>,success?:string)=>Promise<void>;

export function TaskWorkspace({room,itemId,connected,busy,action,onAgent,onTask,onConnect,onInbox}:{room:Room;itemId:string|null;connected:boolean;busy:boolean;action:Action;onAgent:(id:string)=>void;onTask:(id:string)=>void;onConnect:()=>void;onInbox:()=>void}) {
  const item=room.workItems.find(t=>t.id===itemId);
  const [editing,setEditing]=useState(false),[role,setRole]=useState('Implementation');
  if(!item)return <p className="quiet-copy">This ticket is no longer on the active board. Its recorded work is available in Replay.</p>;
  const owner=room.agents.find(a=>a.id===item.agentId),manager=room.agents.find(a=>a.manager && a.status!=='ejected');
  const endpoint=`/rooms/${room.id}/work/${item.id}`,signedIn=room.demo || connected;
  const dependencies=item.dependsOn.filter(id=>room.workItems.find(t=>t.id===id)?.status!=='done');
  const active=!!owner?.turnId || (room.demo && owner?.status==='working');
  const archive=()=>action(()=>officeApi(endpoint+'/archive',{archived:!item.archived}),item.archived?'Ticket restored':'Ticket archived. You can restore it here.');
  if(editing)return <section><h2>Edit ticket</h2><TicketForm key={item.id} room={room} item={item} busy={busy} onCancel={()=>setEditing(false)} onSave={body=>action(async()=>{await officeApi(endpoint+'/edit',body);setEditing(false);},'Ticket updated')}/></section>;
  return <div className="task-workspace">
    <h2 className="ticket-title">{item.title}</h2><div className="ticket-options"><span>{item.archived?'Archived':`${item.priority || 'normal'} priority`}</span>{!active && item.status!=='done' && !item.archived && <button onClick={()=>setEditing(true)}>Edit ticket</button>}{!active && <button disabled={busy} onClick={archive}>{item.archived?'Restore ticket':'Archive'}</button>}</div>
    {!item.archived && item.status!=='done' && <section className="next-action" aria-label="Next step">
      {owner?.status==='ejected'?<><b>Owner needs replacing</b><button className="secondary" onClick={()=>onAgent(owner.replacedBy || owner.id)}>Open {owner.replacedBy?'replacement':'desk'}</button></>:
      owner?.provider==='cursor'?<><b>Managed in Cursor</b><button className="secondary" onClick={()=>onAgent(owner.id)}>Open Cursor desk</button></>:
      active && owner?.currentWorkItemId && owner.currentWorkItemId!==item.id?<><b>{agentLine(owner)} is working on another ticket</b><button className="secondary" onClick={()=>onTask(owner.currentWorkItemId!)}>Open active ticket</button></>:
      active?<><b>{owner?.status==='approval'?'Waiting for your approval':`${agentLine(owner)} is working`}</b><button className="secondary" disabled={busy} onClick={owner?.status==='approval'?onInbox:()=>action(()=>officeApi(`/rooms/${room.id}/agents/${owner!.id}/stop`,{}),'Agent paused')}>{owner?.status==='approval'?'Review request':'Pause agent'}</button></>:
      !signedIn?<><b>Ready when you connect</b><button className="primary" onClick={onConnect}>Connect Codex</button></>:
      room.paused?<><b>This office is paused</b><button className="primary" disabled={busy} onClick={()=>action(()=>officeApi(`/rooms/${room.id}/resume`,{}),'Office resumed')}>Resume office</button></>:
      !owner?<><label>Who should handle it?<select value={role} onChange={e=>setRole(e.target.value)}><option value="Implementation">Manager · implement</option><option value="Research">Specialist · research</option><option value="Review">Specialist · review</option></select></label>{role==='Implementation' && manager?.turnId?<><p>Manager is busy with another ticket.</p><button className="secondary" onClick={()=>onAgent(manager.id)}>Open manager</button></>:<button className="primary" disabled={busy} onClick={()=>action(()=>officeApi(endpoint+'/assign',{role}),'Ticket assigned')}>{role==='Implementation'?'Send to manager':'Assign specialist'}</button>}</>:
      ['blocked','queued'].includes(item.status)?<><b>{dependencies.length?'Waiting on dependencies':'Ready to continue'}</b>{dependencies.length?<button className="secondary" onClick={()=>onTask(dependencies[0])}>Open dependency</button>:<button className="primary" disabled={busy} onClick={()=>action(()=>officeApi(endpoint+'/run',{}),'Ticket resumed')}>Resume ticket</button>}</>:
      null}
    </section>}
    <WorkDetail hideHeading room={room} itemId={item.id} onSelect={onAgent} onTask={onTask}/>
    {!item.archived && <TicketReview key={item.id+':'+item.updatedAt} room={room} item={item} busy={busy} action={action} connected={signedIn} active={active}/>}
    <details className="task-conversations"><summary>Agent handoffs · {room.messages.filter(m=>(m.workItemId===item.id || m.evidenceLinks?.some(l=>l.workItemId===item.id))).length}</summary><HandoffsPanel room={room} taskId={item.id} onAgent={onAgent} onTask={onTask}/></details>
  </div>;
}
function TicketReview({room,item,busy,action,connected,active}:{room:Room;item:WorkItem;busy:boolean;action:Action;connected:boolean;active:boolean}) {
  const [note,setNote]=useState(''),[checks,setChecks]=useState<number[]>(item.checks?.filter(c=>c.passed).map(c=>c.index) || []);
  const [review,setReview]=useState<ReviewState|null>(item.reviewState || null),[checking,setChecking]=useState(false),[error,setError]=useState('');
  const refresh=async()=>{setChecking(true);setError('');try{const result=await officeApi('/rooms/'+room.id+'/work/'+item.id+'/review');setReview(result.review);}catch(e){setError(String(e));}finally{setChecking(false);}};
  useEffect(()=>{if(!active && !room.demo)void refresh();},[item.id,item.updatedAt,active]);
  if(active || !item.agentId)return null;
  const gaps=[...item.dependsOn.filter(id=>room.workItems.find(t=>t.id===id)?.status!=='done').map(id=>'Verify '+(room.workItems.find(t=>t.id===id)?.title || 'dependency')),...(item.requiredEvidence || []).filter(kind=>!(kind==='log' && note.trim()) && !item.evidence.some(e=>e.kind===kind && e.text.trim() && (kind!=='test' || e.passed===true))).map(kind=>'Attach '+(kind==='test'?'passing test':kind)+' evidence')];
  if(!room.demo && item.requiredEvidence?.includes('test') && !review?.current)gaps.push(review?.label || 'Check the current project version');
  else if(!room.demo && !review?.version)gaps.push(review?.error || 'Check the current project version');
  const owner=room.agents.find(a=>a.id===item.agentId),canRerun=connected && !room.paused && owner?.provider!=='cursor' && owner?.status!=='ejected';
  const submit=(decision:'done'|'changes')=>action(async()=>{
    if(decision==='changes')await officeApi('/rooms/'+room.id+'/work/'+item.id+'/run',{note});
    else await officeApi('/rooms/'+room.id+'/work/'+item.id,{status:'done',expectedUpdatedAt:item.updatedAt,...(!room.demo?{expectedVersion:review?.version}:{}),receipts:[{kind:'log',text:note}],checks:item.acceptanceCriteria.map((_,index)=>({index,passed:checks.includes(index),evidence:note}))});
    setNote('');
  },decision==='done'?'Ticket verified':'Changes requested');
  return <section className="ticket-review compact-review" aria-label="Review changes">
    {!room.demo && <div className="review-version"><div><b>{checking?'Checking project version…':!item.requiredEvidence?.includes('test') && review?.version?'Source recorded':review?.label || 'Version not checked'}</b><small>{review?.version?'Source '+review.version.slice(0,10)+(item.requiredEvidence?.includes('test')?' · '+review.passing+' passing '+(review.passing===1?'check':'checks'):''):review?.error}</small></div><button className="text-button" disabled={checking || busy} onClick={()=>void refresh()}>Refresh</button></div>}
    {error && <p role="alert">{error}</p>}
    {item.status!=='done' && <><h3>Review changes</h3>{gaps.length>0 && <div className="review-gaps"><ul>{gaps.map(gap=><li key={gap}>{gap}</li>)}</ul></div>}
    {item.acceptanceCriteria.map((criterion,index)=><label className="board-dependency" key={index}><input type="checkbox" checked={checks.includes(index)} onChange={e=>setChecks(e.target.checked?[...checks,index]:checks.filter(i=>i!==index))}/>{criterion}</label>)}
    <label>Review note<textarea maxLength={2000} rows={2} value={note} onChange={e=>setNote(e.target.value)} placeholder="What did you check, or what needs changing?"/></label>
    <div className="button-row"><button className="primary" disabled={busy || checking || !note.trim() || !!gaps.length || checks.length!==item.acceptanceCriteria.length} onClick={()=>void submit('done')}>Approve</button><button className="secondary" disabled={busy || !note.trim() || !canRerun} onClick={()=>void submit('changes')}>Request changes</button></div></>}
  </section>;
}
