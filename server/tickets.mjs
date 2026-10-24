import { z } from 'zod';
import { record, updateWork } from './orchestration.mjs';

export const ticketFields = z.object({
  title:z.string().trim().min(3).max(120), description:z.string().trim().min(3).max(12000),
  acceptanceCriteria:z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  files:z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  dependsOn:z.array(z.string()).max(8).default([]), priority:z.enum(['high','normal','low']).default('normal'),
}).strict();
export function assignedTicket(room, agentId) {
  const owner=room.agents.find(a=>a.id===agentId);
  if(owner?.currentWorkItemId)return room.workItems.find(t=>t.id===owner.currentWorkItemId && t.agentId===agentId);
  return room.workItems.find(t=>t.agentId===agentId && t.status==='working' && !t.archived) || room.workItems.find(t=>t.agentId===agentId && !t.archived && t.status!=='done');
}
export function focusTicket(room,owner,item) {
  for(const previous of room.workItems.filter(t=>t.agentId===owner.id && t.id!==item.id))delete previous.resumeOnOffice;
  for(const previous of room.workItems.filter(t=>t.agentId===owner.id && t.id!==item.id && ['working','queued'].includes(t.status) && !t.archived)) {
    previous.status='blocked';previous.blocker='Owner is assigned to another ticket. Resume when ready.';previous.updatedAt=Date.now();delete previous.resumeOnOffice;
  }
  owner.currentWorkItemId=item.id;owner.task=item.description;item.agentId=owner.id;
}
export function editTicket(room,item,body,isStarting) {
  const owner=room.agents.find(a=>a.id===item.agentId);
  if(room.capturing || owner?.turnId || (owner && isStarting(owner.id)))throw new Error('Pause the owner before editing this ticket.');
  if(item.status==='done' || item.archived)throw new Error('Only open tickets can be edited.');
  const {expectedUpdatedAt,...input}=z.object({...ticketFields.shape,expectedUpdatedAt:z.number()}).strict().parse(body);
  if(item.updatedAt!==expectedUpdatedAt)throw new Error('This ticket changed while you were editing. Reopen the editor to load the latest version.');
  if(input.dependsOn.some(id=>room.workItems.find(t=>t.id===id)?.archived))throw new Error('Restore the dependency before linking it.');
  const changedCriteria=JSON.stringify(item.acceptanceCriteria)!==JSON.stringify(input.acceptanceCriteria);
  updateWork(room,item,{status:item.status,dependsOn:input.dependsOn,files:input.files,blocker:item.blocker});
  Object.assign(item,input);if(changedCriteria)item.checks=[];
  if(owner?.currentWorkItemId===item.id)owner.task=item.description;
  item.updatedAt=Date.now();record(room,`Ticket updated: ${item.title}`,'plan');return item;
}
export function archiveTicket(room,item,body,isStarting) {
  const {archived}=z.object({archived:z.boolean()}).strict().parse(body);
  const owner=room.agents.find(a=>a.id===item.agentId);
  if(room.capturing || owner?.turnId || (owner && isStarting(owner.id)))throw new Error('Pause the owner before archiving or restoring this ticket.');
  if(archived && room.workItems.some(t=>!t.archived && t.status!=='done' && t.dependsOn.includes(item.id)))throw new Error('An open ticket depends on this one. Remove that dependency before archiving.');
  item.archived=archived;item.updatedAt=Date.now();delete item.resumeOnOffice;
  if(item.status==='working' || item.status==='queued'){item.status='blocked';item.blocker='Paused when archived. Resume explicitly to continue.';}
  record(room,`${archived?'Archived':'Restored'}: ${item.title}`,'plan');return item;
}
