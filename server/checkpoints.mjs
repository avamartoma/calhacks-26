import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { uid } from './domain.mjs';
import { officeFrame, record, initOffice, handoffPacket } from './orchestration.mjs';
const exec=promisify(execFile);
async function git(cwd,args,env={}) { const result=await exec('git',args,{cwd,env:{...process.env,...env},windowsHide:true,maxBuffer:2*1024*1024}); return result.stdout.trim(); }
export async function checkpoint(room,label,dataDir) {
  if(room.agents.some(a=>a.turnId))throw new Error('Pause the office before capturing a checkpoint.');
  const point={id:uid(),label,time:Date.now(),frame:officeFrame(room),commit:null};
  if(!room.demo){
    const top=await git(room.path,['rev-parse','--show-toplevel']);
    if(path.resolve(top)!==path.resolve(room.path))throw new Error('Use a repository root for code checkpoints.');
    const index=path.join(dataDir,`checkpoint-${point.id}.index`);
    const env={GIT_INDEX_FILE:index,GIT_AUTHOR_NAME:'Fourteenth',GIT_AUTHOR_EMAIL:'fourteenth@localhost',GIT_COMMITTER_NAME:'Fourteenth',GIT_COMMITTER_EMAIL:'fourteenth@localhost'};
    try {
      const head=await git(room.path,['rev-parse','HEAD']);
      await git(room.path,['read-tree','HEAD'],env);
      // Track only files already under version control. Secrets/ignored and untracked files are excluded.
      await git(room.path,['add','-u','--','.'],env);
      const tree=await git(room.path,['write-tree'],env);
      point.commit=await git(room.path,['commit-tree',tree,'-p',head,'-m',`Fourteenth checkpoint: ${label}`],env);
      await git(room.path,['update-ref',`refs/fourteenth/${point.id}`,point.commit]);
    } finally { await rm(index,{force:true}); }
  }
  room.checkpoints.push(point);record(room,`Checkpoint: ${label}`,'checkpoint');return point;
}
export function restoreState(room,point) {
  if(room.agents.some(a=>a.turnId))throw new Error('Pause the office before restoring its state.');
  Object.assign(room,structuredClone(point.frame));room.paused=true;room.pendingHandoffs=[];
  room.agents.forEach(a=>{delete a.threadId;delete a.turnId;delete a.deadline;delete a.talkingUntil;if(a.status!=='ejected')a.status='paused';});
  room.agents.forEach(a=>{a.handoffPacket=handoffPacket(room,a);});
  record(room,`Restored office state: ${point.label}`,'checkpoint');
}
export async function branchCheckpoint(room,point,dataDir) {
  const next=initOffice({...structuredClone(point.frame),id:uid(),name:`${room.name} · branch`,demo:room.demo,path:room.path,tag:'CHECKPOINT BRANCH',orchestrationVersion:1,timeline:[],checkpoints:[],paused:true});
  if(!room.demo){
    if(!point.commit)throw new Error('This checkpoint has no code snapshot');
    const parent=path.join(dataDir,'branches');await mkdir(parent,{recursive:true});
    next.path=path.join(parent,next.id);
    await git(room.path,['worktree','add','-b',`codex/office-${next.id.slice(0,8)}`,next.path,point.commit]);
  }
  next.agents.forEach(a=>{delete a.threadId;delete a.turnId;delete a.deadline;delete a.talkingUntil;if(a.status!=='ejected')a.status='paused';});
  const agents=new Map(next.agents.map(a=>[a.id,uid()]));const items=new Map(next.workItems.map(t=>[t.id,uid()]));
  next.agents.forEach(a=>{a.id=agents.get(a.id);if(a.currentWorkItemId)a.currentWorkItemId=items.get(a.currentWorkItemId);delete a.replaces;delete a.replacedBy;});
  next.workItems.forEach(t=>{t.id=items.get(t.id);t.agentId=agents.get(t.agentId)||null;t.dependsOn=t.dependsOn.map(id=>items.get(id));});
  next.messages.forEach(m=>{if(m.fromId)m.fromId=agents.get(m.fromId)||m.fromId;if(m.toId)m.toId=agents.get(m.toId)||m.toId;if(m.workItemId)m.workItemId=items.get(m.workItemId);if(m.evidenceLinks)m.evidenceLinks=m.evidenceLinks.map(l=>({...l,workItemId:items.get(l.workItemId)||l.workItemId}));});
  next.agents.forEach(a=>{a.handoffPacket=handoffPacket(next,a);});
  record(next,`Branched from ${point.label}`,'checkpoint');return next;
}
