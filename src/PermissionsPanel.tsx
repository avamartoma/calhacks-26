import type { Room } from './types';
import { agentLine } from './identity';
import type { Action } from './TaskWorkspace';

export function PermissionsPanel({room,busy,action,onConnect}:{room:Room;busy:boolean;action:Action;onConnect:()=>void}) {
  const mode=room.permissionMode || 'project-write';
  const running=room.agents.some(a=>!!a.turnId);
  return <section className="permissions-panel" aria-label="Office permissions">
    <h3>Permissions</h3><p className="quiet-copy">One setting for every Codex model in this office.</p>
    <label>Project access<select disabled={busy || room.demo} value={mode} onChange={e=>{const permissionMode=e.target.value;action(async()=>{const response=await fetch(`/api/rooms/${room.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode})});if(!response.ok){const result=await response.json();throw new Error(result.error || 'Could not save permissions');}},running?'Permissions saved for future runs. Current runs keep their existing access.':'Office permissions saved');}}><option value="project-write">Manager can edit project</option><option value="read-only">Review only · no file edits</option></select></label>
    <p className="quiet-copy">{mode==='read-only'?'All Codex agents inspect and report. Commands that need broader access are denied.':'The manager edits project files. Specialists inspect and report. Requests for broader access come to your Inbox.'}</p>
    {room.demo?<p className="notice">Demo agents do not access files.</p>:<><ul className="permission-roster">{room.agents.filter(a=>a.status!=='ejected').map(a=><li key={a.id}><b>{agentLine(a)}</b><span>{a.provider==='cursor'?'Managed in Cursor':a.turnId?`${a.threadPermissionKey?.startsWith('read-only')?'Read only':a.manager?'Project edits':'Read only'} · running`:a.manager && mode==='project-write'?'Project edits':'Read only'}</span></li>)}</ul>{running && <p className="notice">Applies on the next run. Pause active agents first to change their current access.</p>}<button className="text-link" onClick={onConnect}>Windows sandbox setup →</button></>}
  </section>;
}
