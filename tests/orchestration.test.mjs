import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workItem,agent,event } from '../server/domain.mjs';
import { initOffice,updateWork,waitingReason,completionGaps,handoffPacket,selectPolicy,createDemo,stepDemo } from '../server/orchestration.mjs';
import { checkpoint,branchCheckpoint,restoreState } from '../server/checkpoints.mjs';
const exec=promisify(execFile);
const makeRoom=()=>initOffice({id:'room',name:'Tests',path:'.',goal:'Ship feature',budget:3,demo:true,agents:[agent('M','Manager','Ship',0,{manager:true})],workItems:[],messages:[],skills:[],paused:false});

test('Sol is the agent default while explicit selections and cheaper office modes remain usable',()=>{
  const models=[{id:'gpt-6-astra',isDefault:true},{id:'gpt-6-sol',efforts:['medium']},{id:'gpt-6-luna',efforts:['low']}];
  const room=makeRoom();const worker=agent('Scout','Research','Inspect');
  assert.equal(worker.model,'gpt-6-sol');assert.equal(selectPolicy(room,worker,models).model,'gpt-6-sol');
  assert.equal(selectPolicy(room,{...worker,model:'Account default'},models).model,'gpt-6-astra');
  room.mode='economy';assert.equal(selectPolicy(room,worker,models).model,'gpt-6-luna');
  assert.equal(selectPolicy(room,{...worker,manager:true},models).model,'gpt-6-sol');
  assert.throws(()=>selectPolicy({...room,mode:'balanced'},worker,[models[0]]),/Sol is not available/);
  const legacy=initOffice({agents:[{...worker,model:'Account default'},{...worker,id:'selected',model:'gpt-6-astra'}]});
  assert.equal(legacy.agents[0].model,'gpt-6-sol');assert.equal(legacy.agents[1].model,'gpt-6-astra');
  legacy.agents[0].model='Account default';initOffice(legacy);assert.equal(legacy.agents[0].model,'Account default','migration must not override later explicit choices');
});

test('read-only specialists can inspect the manager files without blocking the team',()=>{
  const room=makeRoom();room.demo=false;
  const scout=agent('Scout','Research','Inspect'),reviewer=agent('Reviewer','Review','Verify');room.agents.push(scout,reviewer);
  const build=workItem('Build','Build',{agentId:room.agents[0].id,files:['src/search.js'],status:'working'});
  const research=workItem('Research','Inspect',{agentId:scout.id,files:['src/search.js'],status:'queued'});
  const review=workItem('Review','Verify',{agentId:reviewer.id,files:['src/search.js'],dependsOn:[research.id]});room.workItems=[build,research,review];
  assert.equal(waitingReason(room,research),null);assert.match(waitingReason(room,review).reason,/dependencies/);
  research.status='done';assert.equal(waitingReason(room,review),null);
  const secondWriter=agent('Other','Implementation','Build',0,{manager:true});room.agents.push(secondWriter);
  assert.match(waitingReason(room,{...research,agentId:secondWriter.id}).reason,/Shared files/);
});
test('completion gate rejects a success note, failed tests and unchecked criteria atomically',()=>{
  const room=makeRoom();const item=workItem('Ship','Build',{requiredEvidence:['test','diff'],acceptanceCriteria:['Works'],checks:[]});room.workItems=[item];
  assert.throws(()=>updateWork(room,item,{status:'done',evidence:'Everything works'}),/Missing passing test/);assert.equal(item.evidence.length,0);
  assert.throws(()=>updateWork(room,item,{status:'done',receipts:[{kind:'test',text:'failed',passed:false},{kind:'diff',text:'diff'}],checks:[{index:0,passed:true,evidence:'looked'}]}),/passing test/);
  updateWork(room,item,{status:'done',receipts:[{kind:'test',text:'test passed',passed:true},{kind:'diff',text:'+ feature'}],checks:[{index:0,passed:true,evidence:'test passed'}]});assert.equal(item.status,'done');
});
test('scheduler holds unfinished dependencies and normalized shared directories',()=>{
  const room=makeRoom();const a=workItem('A','A',{files:['src\\Search'],status:'working'}),b=workItem('B','B',{files:['src/Search/index.tsx']});room.workItems=[a,b];
  assert.match(waitingReason(room,b).reason,/Shared files/);a.status='review';assert.equal(waitingReason(room,b),null);b.dependsOn=[a.id];assert.match(waitingReason(room,b).reason,/dependencies/);a.status='done';assert.equal(waitingReason(room,b),null);
  assert.throws(()=>updateWork(room,a,{status:'queued',dependsOn:[b.id]}),/cycle/);
});
test('replacement packet includes failures, diffs, files and pending steps',()=>{
  const room=makeRoom(),a=room.agents[0];room.workItems=[workItem('A','A',{agentId:a.id,files:['src/a.ts']})];event(a,'command','npm test\nExit: 1');event(a,'update','Found the null case');a.diff='+ guard';a.plan=[{step:'Retry test',status:'pending'}];
  const packet=handoffPacket(room,a);assert.equal(packet.failedAttempts.length,1);assert.equal(packet.nextSteps[0].step,'Retry test');assert.deepEqual(packet.files,['src/a.ts']);assert.equal(packet.diff,'+ guard');
});
test('Crunch uses catalog capabilities, preserving the selected manager',()=>{
  const room=makeRoom();room.mode='crunch';const models=[{id:'strong',isDefault:true,efforts:['high']},{id:'fixture-mini',efforts:['low']}];room.agents[0].model='strong';
  assert.equal(selectPolicy(room,room.agents[0],models).model,'strong');assert.equal(selectPolicy(room,room.agents[0],models).effort,undefined);const policy=selectPolicy(room,{manager:false,model:'strong'},models);assert.equal(policy.model,'fixture-mini');assert.equal(policy.effort,'low');assert.equal(policy.minutes,5);
});
test('guided demo traverses coordination and replacement then passes every gate',()=>{
  const room=createDemo('.');stepDemo(room);assert.equal(room.agents.filter(a=>a.status!=='ejected').length,6);assert.equal(room.workItems.length,6);assert.equal(room.mode,'crunch');assert.equal(room.budget,6);for(let i=1;i<5;i++)stepDemo(room);assert.ok(room.workItems.every(t=>t.status==='done'));assert.ok(room.workItems.every(t=>completionGaps(room,t).length===0));assert.ok(room.agents.some(a=>a.handoffPacket?.failedAttempts.length));assert.ok(room.timeline.some(e=>e.kind==='coordination'));assert.throws(()=>stepDemo(room),/finished/);
});
test('demo records a rejected completion and preserves that snapshot after later verification',()=>{
  const room=createDemo('.');stepDemo(room);stepDemo(room);
  const build=room.workItems[1];
  assert.equal(build.status,'working');assert.equal(build.evidence.length,0);
  assert.equal(room.demoGate.rejected,true);assert.ok(room.demoGate.gaps.includes('Missing passing test evidence'));
  const entry=room.timeline.find(entry=>entry.kind==='gate');
  assert.ok(entry);assert.equal(entry.frame.workItems[1].status,'working');
  stepDemo(room);stepDemo(room);
  assert.equal(build.status,'done');assert.equal(entry.frame.workItems[1].evidence.length,0);
  assert.equal(entry.frame.demoGate.rejected,true);
  assert.match(build.evidence.find(receipt=>receipt.kind==='test').text,/case/i);
});
test('code checkpoints preserve the Git index, exclude untracked files and branch isolated code',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fourteenth-checkpoint-'));t.after(async()=>{if(path.basename(dir).startsWith('fourteenth-checkpoint-'))await rm(dir,{recursive:true,force:true});});
  const git=async(...args)=>(await exec('git',args,{cwd:dir,windowsHide:true})).stdout.trim();await git('init');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');await writeFile(path.join(dir,'app.txt'),'baseline');await git('add','app.txt');await git('commit','-m','Baseline');
  await writeFile(path.join(dir,'app.txt'),'staged');await git('add','app.txt');await writeFile(path.join(dir,'app.txt'),'checkpoint');await writeFile(path.join(dir,'private.txt'),'untracked');
  const room=makeRoom();room.skills=['office-manager','office-handoff'];room.demo=false;room.path=dir;const item=workItem('A','A',{agentId:room.agents[0].id});room.workItems=[item];const data=path.join(dir,'.office');await import('node:fs/promises').then(fs=>fs.mkdir(data));const point=await checkpoint(room,'Before change',data);
  assert.equal(await git('show',':app.txt'),'staged');assert.equal(await readFile(path.join(dir,'app.txt'),'utf8'),'checkpoint');
  const branch=await branchCheckpoint(room,point,data);assert.equal(await readFile(path.join(branch.path,'app.txt'),'utf8'),'checkpoint');await assert.rejects(readFile(path.join(branch.path,'private.txt')));assert.notEqual(branch.agents[0].id,room.agents[0].id);assert.equal(branch.workItems[0].agentId,branch.agents[0].id);assert.deepEqual(branch.skills,room.skills);assert.equal(branch.agents[0].handoffPacket.workItems[0].agentId,branch.agents[0].id);
  await writeFile(path.join(dir,'app.txt'),'later');restoreState(room,point);assert.equal(await readFile(path.join(dir,'app.txt'),'utf8'),'later');assert.equal(room.paused,true);assert.equal(room.agents[0].threadId,undefined);
});
