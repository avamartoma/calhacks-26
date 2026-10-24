import {reviewProject,reviewGuards} from './review-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {agent,workItem} from '../server/domain.mjs';
import {assignedTicket,focusTicket,editTicket,archiveTicket} from '../server/tickets.mjs';
import {initOffice,applyTemplate} from '../server/orchestration.mjs';

test('ticket focus preserves terminal work and parks previous missions without losing backlog',()=>{
  const manager=agent('Morgan','Manager','Build',0,{manager:true});
  const old=workItem('Old work','Old work',{agentId:manager.id,status:'done'}),next=workItem('Next work','Next work',{agentId:manager.id,status:'queued'});
  const room=initOffice({agents:[manager],workItems:[old,next],messages:[],skills:[]});
  manager.currentWorkItemId=old.id;
  assert.equal(assignedTicket(room,manager.id),old,'completed focus never falls through to another queued ticket');
  focusTicket(room,manager,next);next.resumeOnOffice=true;
  applyTemplate(room,'bug','Fix the new defect');
  assert.equal(old.status,'done');assert.equal(next.status,'blocked');assert.equal(next.resumeOnOffice,undefined);
  assert.equal(room.workItems.length,3);assert.equal(assignedTicket(room,manager.id),room.workItems.at(-1));
});

test('ticket editing uses revisions and preserves dependency and archive integrity',()=>{
  const item=workItem('First ticket','Description',{status:'queued',checks:[{index:0,passed:true,evidence:'Old criteria'}]}),dependent=workItem('Dependent','Wait',{dependsOn:[item.id]});
  const room=initOffice({agents:[],workItems:[item,dependent],messages:[]});
  const body={title:'Updated ticket',description:'Updated task',acceptanceCriteria:['New criteria'],priority:'high',files:[],dependsOn:[],expectedUpdatedAt:item.updatedAt};
  assert.throws(()=>editTicket(room,item,{...body,expectedUpdatedAt:-1},()=>false),/changed/);
  editTicket(room,item,body,()=>false);assert.equal(item.priority,'high');assert.deepEqual(item.checks,[]);
  assert.throws(()=>editTicket(room,item,{...body,expectedUpdatedAt:item.updatedAt,dependsOn:[dependent.id]},()=>false),/cycle/);
  assert.throws(()=>archiveTicket(room,item,{archived:true},()=>false),/depends/);
  dependent.dependsOn=[];archiveTicket(room,item,{archived:true},()=>false);assert.equal(item.status,'blocked');
  archiveTicket(room,item,{archived:false},()=>false);assert.equal(item.archived,false);assert.equal(item.status,'blocked','restoring does not start execution');
});

test('manager can assign, pause, resume, review and replace without losing the project backlog',{timeout:30000},async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'fourteenth-manager-')),root=path.resolve('.'),base='http://127.0.0.1:44325';
  const project=await reviewProject(temp);
  const child=spawn(process.execPath,['server/index.mjs','--production'],{cwd:root,env:{...process.env,PORT:'44325',OFFICE_DATA_DIR:temp,OFFICE_CODEX_HOME:path.join(temp,'codex'),OFFICE_CODEX_BIN:process.execPath,OFFICE_CODEX_ARGS:JSON.stringify([path.join(root,'tests/fake-codex.mjs')])},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',d=>stderr+=d);
  t.after(async()=>{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;if(path.dirname(temp)===os.tmpdir() && path.basename(temp).startsWith('fourteenth-manager-'))await rm(temp,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'Startup timed out')),10000);child.stdout.on('data',d=>{if(String(d).includes('Fourteenth office')){clearTimeout(timer);resolve();}});});
  const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
  const req=async(route,body)=>{const res=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};};
  const ok=async(route,body)=>{const r=await req(route,body);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
  await ok('/connect',{});const {room}=await ok('/rooms',{name:'Manager test',path:project,demo:false}),ep=`/rooms/${room.id}`;
  const current=async()=>(await req('/state')).data.rooms.find(r=>r.id===room.id);
  const make=async title=>(await ok(ep+'/work',{title,description:title,acceptanceCriteria:['Observable result'],files:[],dependsOn:[]})).item;
  const backlog=await make('Plan future work'),build=await make('Implement project search'),research=await make('Research access keys'),review=await make('Review empty states');
  const manager=(await ok(ep+`/work/${build.id}/assign`,{role:'Implementation'})).agent;
  const other=(await ok('/rooms',{name:'Same folder',path:project,demo:false})).room;
  const conflict=await req(`/rooms/${other.id}/dispatch`,{prompt:'Overlapping implementation'});assert.equal(conflict.status,409);
  const otherState=(await req('/state')).data.rooms.find(r=>r.id===other.id);assert.equal(otherState.workItems[0].status,'blocked');assert.ok(!otherState.agents[0].turnId,'another room cannot start a competing writer');
  const researcher=(await ok(ep+`/work/${research.id}/assign`,{role:'Research'})).agent;
  const reviewer=(await ok(ep+`/work/${review.id}/assign`,{role:'Review'})).agent;
  assert.equal((await req(ep+`/work/${build.id}/archive`,{archived:true})).status,409,'cannot archive running work');
  await ok(ep+`/agents/${reviewer.id}/stop`,{});
  await ok(ep+'/pause',{});let office=await current();assert.ok(office.workItems.find(t=>t.id===research.id).resumeOnOffice);
  assert.equal(office.workItems.find(t=>t.id===review.id).resumeOnOffice,undefined);
  await ok(ep+'/resume',{});office=await current();assert.ok(office.agents.find(a=>a.id===manager.id).turnId);assert.ok(office.agents.find(a=>a.id===researcher.id).turnId);assert.equal(office.agents.find(a=>a.id===reviewer.id).turnId,null,'individually paused worker stays paused');
  await ok(ep+`/agents/${manager.id}/stop`,{});
  await ok(ep+`/work/${build.id}/run`,{note:'FIXTURE_TEST_RECEIPT Check keyboard interactions'});assert.ok((await current()).agents.find(a=>a.id===manager.id).turnId);
  for(let attempt=0;attempt<100;attempt++){const result=await ok(ep+`/work/${build.id}/review`);if(result.review.current)break;await new Promise(r=>setTimeout(r,20));}
  await ok(ep+'/pause',{});
  const reviewed=await ok(ep+`/work/${build.id}/review`);assert.equal(reviewed.review.current,true,'streamed checks record cwd and stable source');
  const approval={status:'done',receipts:[{kind:'log',text:'Inspected fixture'}],checks:[{index:0,passed:true,evidence:'Fixture review'}]};
  const missingGuards=await req(ep+`/work/${build.id}`,approval);assert.equal(missingGuards.status,409);assert.match(missingGuards.data.error,/Refresh/);
  await writeFile(path.join(project,'source.js'),'export const example = false;\n');
  const stale=await req(ep+`/work/${build.id}`,{...approval,expectedUpdatedAt:reviewed.updatedAt,expectedVersion:reviewed.review.version});assert.equal(stale.status,409);assert.match(stale.data.error,/files changed/);
  assert.equal((await current()).workItems.find(t=>t.id===build.id).status,'blocked','rejected approval does not complete the ticket');
  await writeFile(path.join(project,'source.js'),'export const example = true;\n');
  await ok(ep+`/work/${review.id}`,{...await reviewGuards(req,ep+`/work/${review.id}`),status:'done',receipts:[{kind:'log',text:'Inspected empty state'}],checks:[{index:0,passed:true,evidence:'Concrete file review'}]});
  await ok(ep+'/resume',{});await ok(ep+`/agents/${reviewer.id}/replace`,{model:'Account default'});
  office=await current();assert.equal(office.workItems.find(t=>t.id===review.id).status,'done');assert.equal(office.agents.at(-1).status,'idle','replacement with no open focus does not run');
  await ok(ep+'/pause',{});
  await ok(ep+'/dispatch',{prompt:'Ship settings preferences',templateId:'feature'});office=await current();assert.ok(office.workItems.some(t=>t.id===backlog.id && !t.agentId));assert.equal(office.workItems.find(t=>t.id===build.id).status,'blocked');assert.equal(office.workItems.length,5);
  await ok(ep+'/pause',{});await ok(ep+'/archive',{archived:true});assert.equal((await req(ep+'/dispatch',{prompt:'Must not run'})).status,409);await ok(ep+'/archive',{archived:false});assert.equal((await current()).paused,true);
});
