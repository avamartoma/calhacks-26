import test from 'node:test';
import assert from 'node:assert/strict';
import { agent, workItem } from '../server/domain.mjs';
import { inbox, queueHandoff, acknowledge, delivered, transferInbox } from '../server/peer-handoffs.mjs';
import { handoffPacket, initOffice, officeFrame, createDemo, stepDemo, updateWork } from '../server/orchestration.mjs';
import { branchCheckpoint } from '../server/checkpoints.mjs';
function fixture() {const a=agent('Scout','Research','Inspect'),b=agent('Reviewer','Review','Verify');const task=workItem('Inspect','Inspect',{agentId:a.id});return {a,b,task,room:initOffice({id:'test',name:'test',demo:true,path:'.',agents:[a,b],workItems:[task],messages:[]})};}

test('successor can resolve an inherited investigation and linked receipts survive routine activity',()=>{
  const {a,b,task,room}=fixture();
  task.evidence.push({id:'retained',kind:'diff',text:'actual fix'});
  const message=queueHandoff(room,a,{agentId:b.id,message:'Inspect storage recovery'});delivered(room,b,[message]);
  acknowledge(room,b,{messageId:message.id,note:'Investigating',disposition:'investigate'});
  const acknowledgedAt=message.acknowledgedAt;
  const next=agent('Replacement','Review','Continue');room.agents.push(next);transferInbox(room,b,next);
  assert.equal(message.status,'acknowledged');assert.equal(message.acknowledgedAt,acknowledgedAt);assert.equal(message.originalToId,b.id);
  acknowledge(room,next,{messageId:message.id,note:'Fixed storage recovery',disposition:'applied',evidenceLinks:[{workItemId:task.id,receiptId:'retained'}]});
  for(let i=0;i<40;i++)updateWork(room,task,{receipts:[{kind:'log',text:`activity ${i}`}]});
  assert.ok(task.evidence.some(e=>e.id==='retained'));
  assert.equal(task.evidence.length,31);
});

test('applied findings link exact receipts atomically and survive checkpoint branching',async()=>{
  const {a,b,task,room}=fixture();
  task.evidence.push({id:'receipt-1',kind:'test',text:'focus regression passes',passed:true});
  const message=queueHandoff(room,a,{agentId:b.id,message:'Clear must restore focus'});delivered(room,b,[message]);
  acknowledge(room,b,{messageId:message.id,note:'Checking focus behavior',disposition:'investigate'});
  const original=structuredClone(message);
  assert.throws(()=>acknowledge(room,b,{messageId:message.id,note:'Used it',disposition:'applied'}),/Link/);
  assert.throws(()=>acknowledge(room,b,{messageId:message.id,note:'Used it',disposition:'applied',evidenceLinks:[{workItemId:'other',receiptId:'receipt-1'}]}),/receipt on a ticket/);
  assert.deepEqual(message,original);
  acknowledge(room,b,{messageId:message.id,note:'Added a focus regression',disposition:'applied',evidenceLinks:[{workItemId:task.id,receiptId:'receipt-1'}]});
  assert.equal(task.status,'queued');
  const branch=await branchCheckpoint(room,{label:'linked evidence',frame:officeFrame(room)},'.');
  const link=branch.messages.find(m=>m.id===message.id).evidenceLinks[0];
  assert.notEqual(link.workItemId,task.id);
  assert.equal(branch.workItems.find(t=>t.id===link.workItemId).evidence[0].id,'receipt-1');
});
test('scripted demo shows a specialist finding and later acknowledgment without verifying its task',()=>{
  const room=createDemo('.');stepDemo(room);const message=room.messages.find(m=>m.kind==='finding');
  const scout=room.agents.find(a=>a.id===message.fromId),tester=room.agents.find(a=>a.id===message.toId);
  assert.equal(message.from,scout.name);assert.equal(message.to,tester.name);assert.match(scout.role,/accessib/i);assert.match(tester.role,/test design/i);assert.equal(message.status,'delivered');
  stepDemo(room);assert.equal(message.status,'acknowledged');assert.notEqual(room.workItems.find(t=>t.id===message.workItemId).status,'done');
});
test('peer handoff validates scope, links replies, separates delivery from acknowledgment and bounds traffic',()=>{
  const {a,b,task,room}=fixture();
  assert.throws(()=>queueHandoff(room,a,{agentId:a.id,message:'self'}),/another current/);
  assert.throws(()=>queueHandoff(room,a,{agentId:'outside-room',message:'outside'}),/another current/);
  b.provider='cursor';assert.throws(()=>queueHandoff(room,a,{agentId:b.id,message:'external'}),/Codex desks/);delete b.provider;
  assert.throws(()=>queueHandoff(room,a,{agentId:b.id,message:'task',workItemId:'missing'}),/Task not found/);
  const m=queueHandoff(room,a,{agentId:b.id,message:'Check src/search.ts',kind:'question'});
  assert.equal(m.workItemId,task.id);assert.equal(m.status,'queued');assert.equal(b.talkingUntil,undefined);
  assert.throws(()=>acknowledge(room,a,{messageId:m.id,note:'no'}),/Only the recipient/);
  assert.throws(()=>acknowledge(room,b,{messageId:m.id,note:'no'}),/not been delivered/);
  delivered(room,b,[m]);assert.equal(m.status,'delivered');assert.ok(b.talkingUntil);
  const response=queueHandoff(room,b,{agentId:a.id,message:'Confirmed line 18',replyTo:m.id,kind:'answer'});assert.equal(response.workItemId,task.id);
  acknowledge(room,b,{messageId:m.id,note:'Used to focus the keyboard regression review.'});assert.equal(inbox(room,b.id).length,0);assert.equal(task.status,'queued');assert.equal(task.evidence.length,0);
  for(let i=0;i<7;i++)queueHandoff(room,a,{agentId:b.id,message:`finding ${i}`});
  assert.throws(()=>queueHandoff(room,a,{agentId:b.id,message:'overflow'}),/limit reached/);
});
test('unresolved messages survive JSON persistence, replacement and checkpoint branches',async()=>{
  const {a,b,room}=fixture();const m=queueHandoff(room,a,{agentId:b.id,message:'Important discovery'});delivered(room,b,[m]);
  for(let i=0;i<90;i++)room.messages.push({id:`legacy${i}`,from:'Old',to:'Old',text:'old',time:0});
  const stored=JSON.parse(JSON.stringify(room));assert.equal(inbox(stored,b.id)[0].id,m.id);
  assert.equal(handoffPacket(room,b).messages[0].id,m.id);
  const next=agent('Reviewer','Review','Continue');room.agents.push(next);transferInbox(room,b,next);
  assert.equal(m.toId,next.id);assert.equal(m.originalToId,b.id);assert.equal(m.status,'queued');assert.equal(m.deliveredAt,undefined);
  const frame=officeFrame(room);assert.ok(frame.messages.some(x=>x.id===m.id));
  const branch=await branchCheckpoint(room,{label:'point',frame},'.');
  const copied=branch.messages.find(x=>x.id===m.id);assert.notEqual(copied.toId,next.id);assert.ok(branch.agents.some(x=>x.id===copied.toId));assert.ok(branch.workItems.some(x=>x.id===copied.workItemId));
});
