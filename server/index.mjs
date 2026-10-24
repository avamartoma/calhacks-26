import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rename, realpath, stat, copyFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Codex } from './codex.mjs';
import { checkWorkspace } from './workspace-check.mjs';
import { identifyEvidence, commandWorkspace, refreshReview, isTestCommand, trimEvidence, assertReviewVersion } from './evidence.mjs';
import { createCursorDesk } from './cursor.mjs';
import { ticketFields, assignedTicket, focusTicket, editTicket, archiveTicket } from './tickets.mjs';
import { peerTools, peerInstructions, inbox, queueHandoff, handoffEnvelope, presentHandoffs, delivered, acknowledge, transferInbox } from './peer-handoffs.mjs';
import { createTeam } from './team.mjs';
import { seed, uid, agent, event, workItem, evidenceFrom, roomBy, agentBy, active, canDelegate, handoff, publicItem } from './domain.mjs';
import { claimIdentity, nameStoredRoom, replacementName } from './names.mjs';
import { z } from 'zod';
import { featureUrl } from './feature-link.mjs';
import { permissionMode, permissionsFor, permissionKey } from './permissions.mjs';
import { modes, templates, initOffice, record, waitingReason, completionGaps, updateWork, handoffPacket, selectPolicy, teamInstructions, applyTemplate, createDemo, stepDemo } from './orchestration.mjs';
import { checkpoint, restoreState, branchCheckpoint } from './checkpoints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.OFFICE_DATA_DIR || path.join(root, '.office'));
await mkdir(dataDir, { recursive: true });
const stateFile = path.join(dataDir, 'state.json');
let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); if (state.version !== 1 || !Array.isArray(state.rooms)) throw new Error('Unsupported state'); }
catch (e) { if (e.code !== 'ENOENT') throw e; state = seed(root); }
state.approvals = [];
for (const r of state.rooms) {
  if (r.orchestrationVersion !== 1) {
    let visibleAgents = r.agents.filter(a => a.status !== 'ejected');
    if (r.demo && !visibleAgents.length) {
      const manager = agent('', 'Manager', r.goal || 'Coordinate the office launch', 4, { manager: true, model: 'gpt-6-astra', status: 'working', progress: 24 });
      const research = agent('', 'Research', 'Inspect the project and identify the first dependencies', 0, { model: 'gpt-5.6-sol', status: 'working', progress: 18 });
      const review = agent('', 'Review', 'Define evidence for successful completion', 2, { model: 'gpt-5.6-luna', status: 'working', progress: 12 });
      r.agents.push(manager, research, review); visibleAgents = [manager, research, review]; r.paused = false;
    }
    r.workItems = visibleAgents.map(a => workItem(a.task, a.task, { agentId: a.id, status: a.status === 'done' ? 'review' : active(a) ? 'working' : 'queued', acceptanceCriteria: [a.manager ? 'The requested outcome is implemented and verified' : 'Return a concrete result with evidence'] }));
    r.missionStartedAt ||= Date.now(); r.orchestrationVersion = 1;
  }
  if (!r.demo) for (const a of r.agents) if (active(a) && a.provider !== 'cursor') { a.status = 'paused'; a.turnId = null; event(a, 'system', 'Companion restarted. Resume explicitly after inspecting the latest work.'); const item = assignedTicket(r,a.id); if (item && item.status!=='done' && !item.archived) { item.status = 'blocked'; item.blocker = 'Companion restarted. Resume this ticket to continue.'; item.updatedAt = Date.now(); } }
  delete r.stopping;initOffice(r);nameStoredRoom(r);
}
const clients = new Set();
const codex = new Codex();
let connection = { connected: false, account: null, models: [], error: null };
let saveTimer, broadcastTimer, writeQueue = Promise.resolve();
const loadedThreads = new Set();
const startingAgents = new Set();
const cursor = createCursorDesk({ state, changed, isStarting: id => startingAgents.has(id) });
function snapshot() { state.rooms.forEach(identifyEvidence); return { ...state, rooms: state.rooms.map(r=>({...r,team:team.view(r),timeline:r.timeline.map(({frame,...entry})=>entry),checkpoints:r.checkpoints.map(({frame,...point})=>point)})), connection: {...connection, testAgents: process.env.OFFICE_TEST_AGENTS === '1'}, modes, templates }; }
function changed() {
  if (!broadcastTimer) broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    const frame = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(frame);
  }, 80);
  if (!saveTimer) saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const serialized = JSON.stringify(state, null, 2);
    writeQueue = writeQueue.then(async () => { await writeFile(stateFile + '.tmp', serialized); await rename(stateFile + '.tmp', stateFile); }).catch(e => console.error('State could not be saved:', e.message));
  }, 500);
}
function findThread(threadId) { for (const room of state.rooms) { const a = room.agents.find(a => a.threadId === threadId); if (a) return { room, a }; } return {}; }
const skillNames = ['office-manager', 'office-handoff', 'office-review'];
const skillText = Object.fromEntries(await Promise.all(skillNames.map(async n => [n, await readFile(path.join(root, 'skills', n, 'SKILL.md'), 'utf8')])));
const dynamicTools = [
  { type: 'function', name: 'office_delegate', description: 'Create a visible work item and delegate it to a bounded read-only research or review worker. Workers cannot edit files. Returns worker and work-item ids immediately. Use office_status later for results. Respect the office concurrency limit.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, task: { type: 'string' }, role: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' }, maxItems: 8 }, dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, required: ['name', 'task', 'role'], additionalProperties: false } },
  { type: 'function', name: 'office_status', description: 'Read worker states and their latest results. Do not poll repeatedly; do independent work or end your turn. Worker completion will trigger a manager handoff.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ...peerTools,
  { type: 'function', name: 'office_update_work', description: 'Update a visible mission work item with its real status, evidence, or blocker. Mark work done only after its acceptance criteria are supported by evidence.', inputSchema: { type: 'object', properties: { workItemId: { type: 'string' }, status: { type: 'string', enum: ['queued', 'working', 'blocked', 'review', 'done'] }, evidence: { type: 'string' }, blocker: { type: 'string' } }, required: ['workItemId', 'status'], additionalProperties: false } }
];
Object.assign(dynamicTools.find(t=>t.name==='office_delegate').inputSchema.properties,{files:{type:'array',items:{type:'string'},maxItems:20},requiredEvidence:{type:'array',items:{type:'string',enum:['diff','test','screenshot','log']}}});
Object.assign(dynamicTools.find(t=>t.name==='office_update_work').inputSchema.properties,{
  previewUrl:{type:'string',description:'Full http(s) URL of the implemented feature, including its route. Check it in a browser before reporting; empty string removes the link.'},
  checks:{type:'array',items:{type:'object',properties:{index:{type:'integer'},passed:{type:'boolean'},evidence:{type:'string'}},required:['index','passed','evidence'],additionalProperties:false}},
  receipts:{type:'array',items:{type:'object',properties:{kind:{type:'string',enum:['diff','test','screenshot','log']},text:{type:'string'},passed:{type:'boolean'},artifact:{type:'string'}},required:['kind','text'],additionalProperties:false}},
  dependsOn:{type:'array',items:{type:'string'}},files:{type:'array',items:{type:'string'}}
});
const workChange=z.object({previewUrl:featureUrl.optional(),workItemId:z.string().optional(),status:z.enum(['queued','working','blocked','review','done']),evidence:z.string().max(12000).optional(),blocker:z.string().max(4000).optional(),files:z.array(z.string().trim().min(1).max(500)).max(20).optional(),dependsOn:z.array(z.string()).max(20).optional(),checks:z.array(z.object({index:z.number().int().min(0),passed:z.boolean(),evidence:z.string().trim().min(1).max(2000)})).max(20).optional(),receipts:z.array(z.object({kind:z.enum(['diff','test','screenshot','log']),text:z.string().trim().min(1).max(12000),passed:z.boolean().optional(),artifact:z.string().max(500).optional()})).max(10).optional()});
async function validateReceipts(room,item,change) {
  if(room.demo)return;
  await notificationQueue;
  await refreshReview(room,item);
  for(const receipt of change.receipts || []) {
    if(receipt.kind==='test' && receipt.passed && !item.reviewState.current)throw new Error('Run passing checks on the current project version before submitting a passing test receipt.');
    if(receipt.kind==='screenshot') {
      if(!receipt.artifact)throw new Error('Screenshot evidence needs a project image path');
      const base=await realpath(room.path);const target=await realpath(path.resolve(base,receipt.artifact));const relative=path.relative(base,target);
      if(relative.startsWith('..') || path.isAbsolute(relative) || !['.png','.jpg','.jpeg','.webp'].includes(path.extname(target).toLowerCase()) || !(await stat(target)).isFile())throw new Error('Screenshot evidence must reference an existing project image');
    }
  }
}
const assignedWork=assignedTicket;
function setWorkStatus(room, a, status, blocker = '') {
  const item = assignedWork(room, a.id); if (!item || item.status==='done' || item.archived) return;
  item.status = status; item.blocker = blocker; item.updatedAt = Date.now();
  if (status === 'review' || status === 'done') { item.evidence.push(...evidenceFrom({...a,events:a.events.filter(e=>!a.workStartedAt || e.time>=a.workStartedAt)})); trimEvidence(room,item); }
}
const scheduling=new Set();
async function scheduleWorkers(room) {
  if(room.demo || room.paused || room.archived || scheduling.has(room.id))return;
  scheduling.add(room.id);
  try {
    for(const item of room.workItems.filter(t=>t.status==='queued' && !t.archived).sort((a,b)=>({high:0,normal:1,low:2}[a.priority || 'normal']-({high:0,normal:1,low:2}[b.priority || 'normal'])) || a.createdAt-b.createdAt)) {
      const worker=room.agents.find(a=>a.id===item.agentId);if(!worker || worker.provider==='cursor' || worker.status==='ejected' || worker.turnId || startingAgents.has(worker.id))continue;
      if(worker.manager && worker.currentWorkItemId!==item.id)continue;
      const wait=waitingReason(room,item);
      if(wait){item.blocker=wait.reason; if(wait.files.length && !item.coordination){item.coordination=wait;worker.talkingUntil=Date.now()+18000;for(const id of wait.tasks){const owner=room.agents.find(a=>a.id===room.workItems.find(t=>t.id===id)?.agentId);if(owner)owner.talkingUntil=worker.talkingUntil;}room.messages.push({id:uid(),fromId:worker.id,from:worker.name,toId:room.agents.find(a=>a.manager && a.status!=='ejected')?.id,to:room.agents.find(a=>a.manager && a.status!=='ejected')?.name || 'Manager',text:`Shared files: ${wait.files.join(', ')}. Assignment held until its owner finishes.`,time:Date.now()});record(room,'Shared files: assignment held for coordination','coordination');}continue;}
      if(!worker.manager && room.agents.filter(a=>!a.manager && active(a)).length>=room.budget)continue;
      item.coordination=null;item.blocker='';
      try {focusTicket(room,worker,item);await startAgent(room,worker,item.description);}catch(e){item.status='blocked';item.blocker=e.message;}
    }
  }finally{scheduling.delete(room.id);changed();}
}
async function ensureConnected() { await codex.connect(); if (!connection.account) throw new Error('Sign in to Codex from the Connect panel first.'); }
async function startAgent(room, a, prompt) {
  if (startingAgents.has(a.id)) throw new Error('This agent is already starting.');
  startingAgents.add(a.id);
  try { await startAgentReserved(room, a, prompt); } catch(error) { if(!a.turnId && room.agents.includes(a) && a.status!=='ejected'){if(a.status!=='error')event(a,'error',error.message);a.status='error';setWorkStatus(room,a,'blocked',error.message);changed();}throw error; } finally { startingAgents.delete(a.id); }
}
async function startAgentReserved(room, a, prompt) {
  const access=permissionsFor(room,a),accessKey=permissionKey(room,a);
  cursor.assertAvailable(room);
  if (a.provider === 'cursor') throw new Error('Continue this task in Cursor or replace the finished worker with a Codex model.');
  await ensureConnected();
  if(access.canWrite && process.platform==='win32' && connection.sandboxStatus!=='ready')throw new Error('Windows sandbox setup is required to edit project files. Open Connect Codex, choose Set up Windows sandbox, then resume this ticket.');
  if(!room.agents.includes(a))throw new Error('Office changed. Reopen the ticket and try again.');
  if (room.archived) throw new Error('Restore this project before starting work.');
  if (room.paused) throw new Error('Resume this office before starting work.');
  if (room.capturing) throw new Error('A checkpoint is being captured. Try again shortly.');
  if (a.status === 'ejected') throw new Error('This agent has been ejected. Replace it to continue.');
  if (a.turnId) throw new Error('This agent is already working. Send a message to steer it.');
  if(a.manager && state.rooms.some(other=>other!==room && !other.demo && path.relative(other.path,room.path)==='' && other.agents.some(owner=>owner.manager && (owner.turnId || startingAgents.has(owner.id)))))throw new Error('Another room is already implementing in this project folder. Pause its manager first.');
  if (!a.manager) canDelegate(room);
  const assigned=assignedWork(room,a.id); if(assigned){const wait=waitingReason(room,assigned);if(wait)throw new Error(wait.reason);}
  const policy=selectPolicy(room,a,connection.models); const model=policy.model;
  const resetSession=a.threadId && (a.protocolVersion!==5 || a.threadPermissionKey!==accessKey);
  if(resetSession)a.handoffPacket=handoffPacket(room,a);
  a.workStartedAt=Date.now();a.diff='';a.plan=[];a.progress=0;
  a.status = 'working'; setWorkStatus(room, a, 'working'); event(a, 'user', prompt); changed();
  try {
    if(resetSession){a.previousThreads=[...(a.previousThreads||[]),a.threadId].slice(-8);a.threadId=null;}
    if (!a.threadId) {
      if(a.handoffPacket)prompt+=`\nSaved context (inspect current files before continuing):\n${JSON.stringify(a.handoffPacket)}`;
      const instructions = (room.skills || skillNames).map(n => skillText[n]).filter(Boolean).join('\n\n');
      const result = await codex.call('thread/start', { cwd: room.path, model, sandbox: access.sandbox, approvalPolicy: access.approvalPolicy, developerInstructions: `${instructions}\nYou are ${a.name}${a.title ? `, ${a.title}` : ''}, ${a.role} in Fourteenth. Your id is ${a.id}. Refer to other agents by id. ${a.manager ? `${access.canWrite?'You are the sole file writer.':'You are a read-only manager. Inspect, plan and delegate reviews; do not edit files or claim implementation is complete.'} Use office_delegate proactively for independent read-only work at project kickoff; do not wait for the user to ask for subagents. Maximum ${room.budget} concurrent workers. Use office_message for handoffs. Use office_update_work to keep the mission board accurate and attach concrete verification before marking work done. Declare affected files through office_update_work before implementation and include file scopes in office_delegate. Set dependencies to sequence implementation and review; inspect queued blockers before resequencing. Do not use other agent spawning tools; the office manages the concurrency budget.` : 'You are a read-only specialist. Return evidence with file paths and concrete findings. Do not spawn additional agents or edit files. Report results to the manager.'}\n${peerInstructions}\nOnly show concise progress, actions, plans and results.`, dynamicTools: a.manager ? dynamicTools : dynamicTools.filter(t=>['office_status','office_message','office_acknowledge'].includes(t.name)), serviceName: 'fourteenth' });
      if(result.sandbox?.type !== (access.canWrite?'workspaceWrite':'readOnly'))throw new Error('Codex did not grant the requested project permissions. Refresh Connect Codex and complete sandbox setup before resuming.');
      a.threadId = result.thread.id; a.protocolVersion=5;a.threadPermissionKey=accessKey; loadedThreads.add(a.threadId);
    } else if (!loadedThreads.has(a.threadId)) { const resumed=await codex.call('thread/resume', { threadId: a.threadId, sandbox:access.sandbox, approvalPolicy:access.approvalPolicy });if(resumed.sandbox?.type !== (access.canWrite?'workspaceWrite':'readOnly'))throw new Error('Resumed session permissions do not match this office. Reconnect before continuing.');loadedThreads.add(a.threadId); }
    // Explicit standard resets a previous fast preference. Never send speed changes via steer.
    const requestedServiceTier = policy.serviceTier;
    const pendingInbox = inbox(room,a.id);
    a.peerMessagesThisTurn = 0;
    const instructions=`${prompt}\n${team.view(room) ? 'Paired teammate office (shared context, separate checkout): '+JSON.stringify(team.view(room))+'\nInspect their work scopes and use office_message with their agent IDs for relevant dependencies or overlapping files. Coordinate before editing overlapping files. Do not start or control their agents.\n' : ''}Project folder: ${room.path}. Set the command working directory explicitly. Before searching, verify that the shell is in this project; if directory access fails, report the blocker instead of searching the drive root.\n${a.manager ? teamInstructions(room) : ''}\nCurrent file access: ${access.canWrite?'Manager may edit project files.':'Read only. Inspect and report; do not edit files.'}\nActive ticket: ${assigned?.id || 'none'}.\n${pendingInbox.length ? handoffEnvelope(presentHandoffs(room, pendingInbox)) : ''}\n\nOffice mode: ${room.mode}. Turn time budget: ${policy.minutes} minutes. Current work items: ${JSON.stringify(room.workItems.filter(t=>!t.archived).map(({id,title,status,acceptanceCriteria,requiredEvidence,dependsOn})=>({id,title,status,acceptanceCriteria,requiredEvidence,dependsOn})))}\nPublish concise evidence and next steps. Run each test/check as a standalone command with an explicit working directory inside this project; do not combine checks with other shell commands. After source edits, rerun previously recorded checks so every latest result matches the current source. Completion requires checks with zero-based criterion indices and typed receipts through office_update_work; a plain success message cannot complete a task.`;
    const result = await codex.call('turn/start', { threadId: a.threadId, input: [{ type: 'text', text: instructions }], model, effort: policy.effort || null, serviceTier: requestedServiceTier });
    if(pendingInbox.length) delivered(room,a,pendingInbox);
    a.effectiveModel=model || 'Account default'; a.effectiveEffort=policy.effort || 'Model default';a.deadline=Date.now()+policy.minutes*60000;
    a.lastRequestedServiceTier = requestedServiceTier;
    if (a.lastCompletedTurnId !== result.turn.id) a.turnId = result.turn.id;
  } catch (e) { a.status = 'error'; a.turnId = null; setWorkStatus(room,a,'blocked',e.message); event(a, 'error', e.message); throw e; }
  finally { changed(); }
}
async function stopAgent(a) {
  if (a.provider === 'cursor' && a.turnId) throw new Error('Stop execution in Cursor, then use office_cursor_finish to release this assignment.');
  if (startingAgents.has(a.id)) throw new Error('Agent is starting. Wait for the turn to begin, then stop it.');
  if (a.threadId && a.turnId) {
    try { await codex.call('turn/interrupt', { threadId: a.threadId, turnId: a.turnId }); }
    catch(error){if(!/no active turn to interrupt/i.test(error.message))throw error;}
    // Wait until Codex confirms completion before replacing the writer.
    const deadline = Date.now() + 12000;
    while (a.turnId && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    if (a.turnId) throw new Error('Stop requested; waiting for Codex acknowledgement. Try again when this turn stops.');
  }
  a.status = 'paused';
}
async function sendTo(room, a, text) {
  if (a.provider === 'cursor') throw new Error('Send this message in Cursor. Fourteenth tracks this worker but does not control its execution.');
  if (a.status === 'ejected') throw new Error('Replace this agent before sending a message.');
  if (a.turnId) { await codex.call('turn/steer', { threadId: a.threadId, expectedTurnId: a.turnId, input: [{ type: 'text', text }] }); event(a, 'user', text); }
  else await startAgent(room, a, text);
}
async function refreshAccount() {
  const result = await codex.call('account/read', { refreshToken: false });
  const models = await codex.call('model/list', { limit: 100 });
  const sandboxStatus=process.platform==='win32' ? (await codex.call('windowsSandbox/readiness',{})).status : undefined;
  connection = { connected: true, account: result.account ? { type: result.account.type, email: result.account.email, planType: result.account.planType } : null, models: models.data.filter(m => !m.hidden).map(m => ({ id: m.model, name: m.displayName, description: m.description, isDefault: m.isDefault, efforts:(m.supportedReasoningEfforts || []).map(e=>e.reasoningEffort) })), error: null };
  connection.sandboxStatus=sandboxStatus;
  changed();
}
codex.on('offline', message => { loadedThreads.clear(); connection.connected = false; connection.error = message; for (const r of state.rooms) if (!r.demo) for (const a of r.agents) if (a.provider !== 'cursor' && active(a)) { a.status = 'error'; a.turnId = null; setWorkStatus(r,a,'blocked',message);event(a, 'error', message); } state.approvals = []; changed(); });
let notificationQueue=Promise.resolve();
const commandVersions=new Map();
codex.on('notification', msg => {
  notificationQueue=notificationQueue.then(()=>handleNotification(msg)).catch(error=>{connection.error='Could not record activity: '+error.message;changed();});
});
async function handleNotification(msg) {
  if(msg.method==='windowsSandbox/setupCompleted'){
    if(msg.params.success){
      // Setup persists config, but the running app-server can still cache notConfigured.
      codex.restart().then(refreshAccount).then(()=>{
        if(connection.sandboxStatus!=='ready')connection.error='Windows setup finished, but Codex is not ready. Restart the companion and refresh the connection.';
      }).catch(e=>{connection.error=e.message;}).finally(()=>{connection.sandboxSetupPending=false;changed();});
    }else{
      connection.sandboxSetupPending=false;
      connection.error=String(msg.params.error || '').includes('orchestrator_helper_incomplete')
        ? 'Codex’s Windows setup helper stopped before completing setup. Update the Fourteenth Codex runtime, restart the companion, and retry setup. Your ticket is preserved.'
        : msg.params.error || 'Windows sandbox setup failed. Try setup again.';
      changed();
    }
    return;
  }
  if (msg.method === 'account/updated' || msg.method === 'account/login/completed') { refreshAccount().catch(e => { connection.error = e.message; changed(); }); return; }
  const p = msg.params || {}; const { room, a } = findThread(p.threadId); if (!a) return;
  if (msg.method === 'turn/started') { a.turnId = p.turn.id; a.status = 'working'; setWorkStatus(room, a, 'working'); }
  if (msg.method === 'turn/plan/updated') { a.plan = p.plan || []; a.progress = a.plan.length ? Math.round(a.plan.filter(s => s.status === 'completed').length / a.plan.length * 100) : 0; }
  if (msg.method === 'thread/tokenUsage/updated') a.tokens = p.tokenUsage?.total?.totalTokens || 0;
  if (msg.method === 'item/agentMessage/delta') {
    let entry = a.events.find(e => e.itemId === p.itemId);
    if (!entry) { event(a, 'update', ''); entry = a.events.at(-1); entry.itemId = p.itemId; }
    entry.text = (entry.text + p.delta).slice(-24000);
  }
  if(msg.method==='item/started' && p.item?.type==='commandExecution' && isTestCommand(p.item.command)) commandVersions.set(`${a.threadId}:${p.item.id}`,await commandWorkspace(room.path,p.item.cwd));
  if (msg.method === 'item/completed') {
    const work=assignedWork(room,a.id);
    if(work && p.item.type==='commandExecution') {const isTest=isTestCommand(p.item.command);work.evidence.push({kind:isTest?'test':'log',text:`${p.item.command}\n${p.item.aggregatedOutput || ''}\nExit: ${p.item.exitCode}`,passed:p.item.exitCode===0,time:Date.now(),source:'observed-command',command:p.item.command,id:uid()});if(isTest){const before=commandVersions.get(`${a.threadId}:${p.item.id}`),after=await commandWorkspace(room.path,p.item.cwd);Object.assign(work.evidence.at(-1),{workspaceVersion:after.version,stableWorkspace:!!before?.version && before.version===after.version,commandCwd:after.commandCwd,cwdVerified:before?.cwdVerified===true && after.cwdVerified===true && before.commandCwd===after.commandCwd});commandVersions.delete(`${a.threadId}:${p.item.id}`);}trimEvidence(room,work);}
    if(work && p.item.type==='fileChange')work.evidence.push({id:uid(),kind:'diff',text:p.item.changes.map(c=>`${c.path}\n${c.diff || ''}`).join('\n'),time:Date.now(),source:'observed-file-change'});
    const item = publicItem(p.item);
    if (item) { const old = a.events.find(e => e.itemId === p.item.id); if (old) Object.assign(old, item); else { event(a, item.kind, item.text); a.events.at(-1).itemId = p.item.id; } }
  }
  if (msg.method === 'turn/diff/updated') {
    a.diff = String(p.diff || '').slice(-120000);
    const work=assignedWork(room,a.id);
    if(work && a.diff){const receipt={id:uid(),kind:'diff',text:a.diff,time:Date.now(),source:'observed-turn-diff',turnId:p.turnId || a.turnId};const index=work.evidence.findIndex(e=>e.source===receipt.source && e.turnId===receipt.turnId);if(index>=0 && !room.messages.some(m=>m.evidenceLinks?.some(link=>link.receiptId===work.evidence[index].id)))work.evidence[index]=receipt;else work.evidence.push(receipt);trimEvidence(room,work);}
  }
  if (msg.method === 'turn/completed') {
    a.lastCompletedTurnId = p.turn.id;
    a.turnId = null;
    if (a.status !== 'ejected') a.status = p.turn.status === 'completed' ? 'done' : p.turn.status === 'failed' ? 'error' : 'paused';
    if (a.status === 'done') a.progress = 100;
    if (p.turn.error) event(a, 'error', p.turn.error.message);
    setWorkStatus(room, a, a.status === 'done' ? 'review' : 'blocked', p.turn.error?.message || (a.status==='done'?'':'Turn interrupted. Resume explicitly.'));
    delete a.deadline; record(room,`${a.name}: ${a.status==='done'?'work ready for review':a.status}`,'work');
    state.approvals = state.approvals.filter(x => x.agentId !== a.id);
    if (!a.manager && a.status === 'done') {
      const manager = room.agents.find(m => m.manager && m.status !== 'ejected');
      const text = `${a.name} finished ${a.task}.\n${a.events.filter(e => e.kind === 'update').at(-1)?.text || 'No final message returned.'}`;
      room.messages.push({ id: uid(), fromId: a.id, from: a.name, toId: manager?.id, to: manager?.name || 'Office', text, time: Date.now() }); room.messages = room.messages.filter((m,i,all)=>i>=all.length-80 || m.disposition==='investigate' || m.evidenceLinks?.length || (m.status && m.status!=='acknowledged'));
      a.talkingUntil = Date.now() + 9000; if (manager) manager.talkingUntil = Date.now() + 9000;
      if (manager) {
        room.pendingHandoffs = [...(room.pendingHandoffs || []), text];
        scheduleHandoff(room, manager);
      }
    }
  }
  changed();
  if(msg.method==='turn/completed')scheduleWorkers(room).catch(()=>{});
}
const handoffTimers = new Map();
function scheduleHandoff(room, manager) {
  if (handoffTimers.has(room.id)) return;
  handoffTimers.set(room.id, setTimeout(async () => {
    handoffTimers.delete(room.id);
    if (room.paused || ['paused', 'error', 'ejected'].includes(manager.status)) return;
    const batch = room.pendingHandoffs || []; room.pendingHandoffs = []; if (!batch.length) return;
    try { await sendTo(room, manager, `Worker handoffs:\n${batch.join('\n\n')}\nIntegrate these findings. Continue the original objective; do not redelegate completed tasks.`); }
    catch(e) { room.pendingHandoffs.unshift(...batch); event(manager, 'error', `Handoff awaiting manual resume: ${e.message}`); changed(); }
  }, 1200));
}
codex.on('request', async msg => {
  await notificationQueue;
  const p = msg.params || {}; const { room, a } = findThread(p.threadId);
  if (!a) { codex.reject(msg.id, 'No matching office agent'); return; }
  if (msg.method === 'item/tool/call') {
    try {
      if (room.paused || !a.turnId || a.status==='ejected') throw new Error('Only an active agent can coordinate this office');
      if (!a.manager && !['office_status','office_message','office_acknowledge'].includes(p.tool)) throw new Error('Only the manager can delegate or update work.');
      let output; const args = p.arguments || {};
      if (p.tool === 'office_delegate') {
        const parsed = z.object({ name: z.string().min(1).max(40), task: z.string().min(1).max(12000), role: z.string().min(1).max(40), acceptanceCriteria: z.array(z.string().min(1).max(500)).max(8).optional(), dependsOn: z.array(z.string()).max(8).optional(), files:z.array(z.string().trim().min(1).max(500)).max(20).optional(),requiredEvidence:z.array(z.enum(['diff','test','screenshot','log'])).optional() }).parse(args);
        const known = new Set(room.workItems.map(item => item.id));
        if (parsed.dependsOn?.some(id => !known.has(id))) throw new Error('A dependency does not match a visible work item');
        if(room.workItems.filter(t=>t.status!=='done' && !t.archived).length>=40)throw new Error('Finish existing assignments before creating more'); const worker = agent('', parsed.role, parsed.task, room.agents.length); room.agents.push(worker); claimIdentity(worker, room);
        const item = workItem(parsed.task.split('\n')[0].slice(0, 120), parsed.task, { agentId: worker.id, status: 'queued', acceptanceCriteria: parsed.acceptanceCriteria || ['Return findings with file references'], dependsOn: parsed.dependsOn || [], files:parsed.files || [], requiredEvidence:parsed.requiredEvidence || ['log'], checks:[] }); room.workItems.push(item);
        record(room, `Assigned: ${item.title}`, 'plan'); await scheduleWorkers(room);
        output = { agentId: worker.id, workItemId: item.id, status: worker.status };
      } else if (p.tool === 'office_status') {
        identifyEvidence(room); const messages=inbox(room,a.id); if(messages.length)delivered(room,a,messages);
        output = { selfId:a.id, inbox:messages, teammate:team.view(room), workItems:room.workItems.filter(t=>!t.archived), workers:room.agents.filter(w=>w.status!=='ejected').map(w=>({id:w.id,name:w.name,title:w.title,role:w.role,manager:!!w.manager,status:w.status,task:w.task,latest:w.events.at(-1)?.text})) };
      } else if (p.tool === 'office_message') {
        const message=team.queue(room,a,args) || queueHandoff(room,a,args); changed();
        const target=room.agents.find(target=>target.id===message.toId);
        if(target && !room.paused && target.turnId && target.status==='working' && target.provider!=='cursor' && !startingAgents.has(target.id)) {
          try { await codex.call('turn/steer',{threadId:target.threadId,expectedTurnId:target.turnId,input:[{type:'text',text:handoffEnvelope(presentHandoffs(room,[message]))}]});delivered(room,target,[message]); }
          catch(e) {message.deliveryError='Current turn ended or delivery failed. Waiting for the next turn.';event(a,'system',`Handoff queued for ${target.name}: ${e.message}`);}
        }
        record(room,`${a.name} -> ${message.toOwner ? message.toOwner+' / ' : ''}${message.to}: ${message.status}`,'handoff');
        output={messageId:message.id,status:message.status,startsRecipient:false};
      } else if(p.tool==='office_acknowledge') {
        output=acknowledge(room,a,args);record(room,`${a.name} acknowledged a handoff from ${output.from}`,'handoff');
      } else if (p.tool === 'office_update_work') {
        const parsed = workChange.parse(args);
        const item = room.workItems.find(item => item.id === parsed.workItemId); if (!item) throw new Error('Work item not found');
        await validateReceipts(room,item,parsed); output = updateWork(room,item,parsed); await scheduleWorkers(room);
      } else throw new Error('Unknown office tool');
      codex.respond(msg.id, { contentItems: [{ type: 'inputText', text: JSON.stringify(output) }], success: true }); changed();
    } catch (e) { codex.respond(msg.id, { contentItems: [{ type: 'inputText', text: e.message }], success: false }); }
  } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].includes(msg.method)) {
    state.approvals.push({ id: String(msg.id), rpcId: msg.id, roomId: room.id, agentId: a.id, method: msg.method, command: p.command || p.reason || 'File change requested', questions: p.questions }); a.status = 'approval'; changed();
  } else { codex.reject(msg.id, 'This interaction is not supported by Fourteenth yet. Ask the user in a normal message.'); event(a, 'error', `Unsupported interaction: ${msg.method}`); changed(); }
});

const app = express(); const port = Number(process.env.PORT || 4314); const secret = randomBytes(32).toString('hex');
const sessionName=`office_session_${port}`;
const team=await createTeam({state,dataDir,port:Number(process.env.OFFICE_TEAM_PORT || port+100),changed,persist:async()=>{
  clearTimeout(saveTimer);saveTimer=undefined;
  const serialized=JSON.stringify(state,null,2);
  writeQueue=writeQueue.catch(()=>{}).then(async()=>{await writeFile(stateFile+'.tmp',serialized);await rename(stateFile+'.tmp',stateFile);});await writeQueue;
},onReceive:async(room,target,message)=>{
  record(room,`${message.fromOwner} / ${message.from} -> ${target.name}`,'handoff');
  if(room.paused || !target.turnId || target.status!=='working' || startingAgents.has(target.id))return;
  try {await codex.call('turn/steer',{threadId:target.threadId,expectedTurnId:target.turnId,input:[{type:'text',text:handoffEnvelope([message])}]});delivered(room,target,[message]);}
  catch {message.deliveryError='Waiting for the recipient’s next turn.';}
}});
app.disable('x-powered-by');
app.use((req, res, next) => {
  const validHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!validHosts.includes(req.headers.host)) return res.status(403).json({ error: 'Local access only' });
  const origin = req.headers.origin;
  if (origin && !validHosts.some(h => origin === `http://${h}`)) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.path.startsWith('/api')) {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(sessionName+'='))?.slice(sessionName.length+1) || '';
    if (cookie.length !== secret.length || !timingSafeEqual(Buffer.from(cookie), Buffer.from(secret))) return res.status(401).json({ error: 'Open the office page to establish a local session.' });
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  } else if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) res.cookie(sessionName, secret, { httpOnly: true, sameSite: 'strict' });
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use('/api/rooms/:id',(req,res,next)=>{if(!['GET','HEAD'].includes(req.method) && req.path!=='/archive' && state.rooms.find(r=>r.id===req.params.id)?.archived)return res.status(409).json({error:'Restore this project before changing it.'});next();});
const wrap = fn => async (req, res) => { try { const result = await fn(req, res); if (!res.headersSent) res.json(result ?? { ok: true }); } catch(e) { if (!res.headersSent) res.status(e instanceof z.ZodError ? 400 : 409).json({ error: e instanceof z.ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : e.code==='ENOENT' ? 'Folder not found. Choose an existing local folder.' : e.message }); } };
const textField = z.string().trim().min(1).max(12000);
app.get('/api/state', (req, res) => res.json(snapshot()));
app.get('/api/team/addresses', (req,res)=>res.json({addresses:team.addresses()}));
app.post('/api/rooms/:id/team/invite',wrap(req=>team.invite(roomBy(state,req.params.id),req.body)));
app.post('/api/rooms/:id/team/join',wrap(req=>team.join(roomBy(state,req.params.id),req.body)));
app.post('/api/rooms/:id/team/disconnect',wrap(req=>team.disconnect(roomBy(state,req.params.id))));
app.post('/api/rooms/:id/team/message',wrap(async req=>{
  const room=roomBy(state,req.params.id);
  const {senderId,...args}=z.object({senderId:z.string(),agentId:z.string(),message:z.string().trim().min(1).max(6000),kind:z.enum(['finding','question','answer']).optional(),replyTo:z.string().optional()}).strict().parse(req.body);
  const sender=agentBy(room,senderId);if(sender.status==='ejected')throw new Error('Choose a current local agent.');
  const message=team.queue(room,{...sender,peerMessagesThisTurn:0},args);if(!message)throw new Error('Choose a teammate agent.');
  message.sentByOwner=true;changed();return {message};
}));
app.get('/api/integrations', (req, res) => res.json({ cursor: { command: process.execPath, script: path.join(root, 'scripts', 'cursor-mcp.mjs'), url: `http://127.0.0.1:${port}` } }));
app.post('/api/rooms/:id/cursor/start', wrap(async req => cursor.start(roomBy(state, req.params.id), req.body)));
app.post('/api/rooms/:id/cursor/:aid/update', wrap(async req => cursor.update(roomBy(state, req.params.id), req.params.aid, req.body)));
app.post('/api/rooms/:id/cursor/:aid/finish', wrap(async req => cursor.finish(roomBy(state, req.params.id), req.params.aid, req.body)));
app.post('/api/rooms/:id/cursor/:aid/release', wrap(async req => cursor.release(roomBy(state, req.params.id), req.params.aid, req.body)));
app.post('/api/demo',wrap(async()=>{for(const old of state.rooms.filter(r=>r.demo && r.demoStep>=5 && !r.agents.some(a=>a.turnId)))old.archived=true;const room=createDemo(root);state.rooms.push(room);changed();return {room};}));
app.post('/api/rooms/:id/demo/step',wrap(async req=>{const room=roomBy(state,req.params.id);stepDemo(room);changed();return {room};}));
app.post('/api/rooms/:id/mode',wrap(async req=>{
  const room=roomBy(state,req.params.id); const {mode}=z.object({mode:z.enum(Object.keys(modes))}).parse(req.body);
  cursor.assertAvailable(room);
  room.mode=mode;room.budget=modes[mode].workers;record(room,`${modes[mode].name} mode selected; next turns use its policy`,'mode');changed();await scheduleWorkers(room);return {mode};
}));
app.get('/api/rooms/:id/timeline/:entry',wrap(async req=>{const room=roomBy(state,req.params.id);const entry=room.timeline.find(e=>e.id===req.params.entry);if(!entry)throw new Error('Replay frame no longer available');return entry;}));
app.post('/api/rooms/:id/checkpoints',wrap(async req=>{
  const room=roomBy(state,req.params.id);cursor.assertAvailable(room);const {label}=z.object({label:z.string().trim().min(1).max(80)}).parse(req.body);
  if(room.capturing || room.agents.some(a=>startingAgents.has(a.id)))throw new Error('Wait for starting work or the current checkpoint.');
  room.capturing=true;
  try{const point=await checkpoint(room,label,dataDir);changed();return {checkpoint:point};}finally{delete room.capturing;}
}));
app.post('/api/rooms/:id/checkpoints/:point/:operation',wrap(async req=>{
  const room=roomBy(state,req.params.id);const point=room.checkpoints.find(p=>p.id===req.params.point);if(!point)throw new Error('Checkpoint not found');
  if(room.capturing || room.agents.some(a=>startingAgents.has(a.id)))throw new Error('Wait for starting work or the current checkpoint.');
  if(req.params.operation==='restore'){cursor.assertAvailable(room);restoreState(room,point);changed();return {room};}
  if(req.params.operation==='branch'){const next=await branchCheckpoint(room,point,dataDir);state.rooms.push(next);changed();return {room:next};}
  throw new Error('Unknown checkpoint action');
}));
app.post('/api/rooms/:id/work',wrap(async req=>{
  const room=roomBy(state,req.params.id);
  const body=ticketFields.parse(req.body);
  if(room.capturing)throw new Error('Wait for the checkpoint to finish.');
  if(room.workItems.filter(t=>t.status!=='done' && !t.archived).length>=40)throw new Error('Finish existing tickets before creating more.');
  if(body.dependsOn.some(id=>!room.workItems.some(t=>t.id===id && !t.archived)))throw new Error('Dependency not found in this office.');
  const item=workItem(body.title,body.description,{...body,requiredEvidence:['log'],checks:[]});room.workItems.push(item);
  record(room,`Ticket created: ${item.title}`,'plan');changed();return {item};
}));
app.post('/api/rooms/:id/work/:workId/assign',wrap(async req=>{
  const room=roomBy(state,req.params.id);const item=room.workItems.find(t=>t.id===req.params.workId);if(!item)throw new Error('Work item not found');
  const {role}=z.object({role:z.enum(['Implementation','Research','Review'])}).strict().parse(req.body);
  const manager=room.agents.find(a=>a.manager && a.status!=='ejected');
  const available=()=>{if(!room.workItems.includes(item) || (manager && !room.agents.includes(manager)))throw new Error('Office changed. Reopen this ticket.');if(item.agentId || item.status==='done' || item.archived)throw new Error('This ticket is already assigned, archived or verified.');if(room.capturing)throw new Error('Wait for the checkpoint to finish.');cursor.assertAvailable(room);if(role==='Implementation' && (!manager || manager.status==='ejected' || manager.turnId || startingAgents.has(manager.id)))throw new Error('Pause the current manager assignment before starting this ticket.');};
  available();if(!room.demo)await ensureConnected();available();
  const worker=role==='Implementation'?manager:agent('',role,`${item.title}\n${item.description}`,room.agents.length);
  if(!worker.manager){room.agents.push(worker);claimIdentity(worker,room);}
  focusTicket(room,worker,item);item.updatedAt=Date.now();item.status='queued';item.blocker='';
  if(worker.manager){item.requiredEvidence=[...new Set([...(item.requiredEvidence||[]),'diff','test'])];room.goal ||= item.title;}
  record(room,`Assigned ${item.title} to ${worker.name}`,'plan');changed();
  if(worker.manager && !room.paused && !room.demo){const wait=waitingReason(room,item);if(wait)item.blocker=wait.reason;else await startAgent(room,worker,item.description);}
  else if(room.demo && !room.paused){worker.status='working';item.status='working';}
  else await scheduleWorkers(room);
  changed();return {item,agent:worker};
}));
app.post('/api/rooms/:id/work/:workId/edit',wrap(async req=>{const room=roomBy(state,req.params.id),item=room.workItems.find(t=>t.id===req.params.workId);if(!item)throw new Error('Ticket not found');const result=editTicket(room,item,req.body,id=>startingAgents.has(id));changed();return {item:result};}));
app.post('/api/rooms/:id/work/:workId/archive',wrap(async req=>{const room=roomBy(state,req.params.id),item=room.workItems.find(t=>t.id===req.params.workId);if(!item)throw new Error('Ticket not found');const result=archiveTicket(room,item,req.body,id=>startingAgents.has(id));changed();return {item:result};}));
app.post('/api/rooms/:id/work/:workId/run',wrap(async req=>{
  const room=roomBy(state,req.params.id),item=room.workItems.find(t=>t.id===req.params.workId);if(!item)throw new Error('Ticket not found');
  const owner=room.agents.find(a=>a.id===item.agentId);
  const ready=()=>{if(!room.workItems.includes(item) || (owner && !room.agents.includes(owner)))throw new Error('Office changed. Reopen this ticket.');cursor.assertAvailable(room);if(!owner || owner.status==='ejected')throw new Error('Assign or replace the owner first.');if(owner.provider==='cursor')throw new Error('Continue this assignment in Cursor.');if(room.paused)throw new Error('Resume the office first.');if(room.capturing || owner.turnId || startingAgents.has(owner.id))throw new Error('Wait for the owner to stop before resuming this ticket.');if(item.archived || item.status==='done')throw new Error('Choose an open ticket.');};
  const {note}=z.object({note:z.string().trim().max(2000).optional()}).strict().parse(req.body);ready();if(!room.demo)await ensureConnected();ready();
  const wait=waitingReason(room,item);if(wait)throw new Error(wait.reason);
  if(!room.demo && !owner.manager)canDelegate(room);
  focusTicket(room,owner,item);item.status='queued';item.blocker='';item.checks=[];delete item.resumeOnOffice;changed();
  if(room.demo){owner.status='working';item.status='working';}else await startAgent(room,owner,`Continue this ticket using its saved evidence and peer inbox: ${item.description}\n${note ? `Requested changes: ${note}` : ''}`);
  record(room,`Resumed: ${item.title}`,'work');changed();return {item};
}));
app.post('/api/rooms/:id/work/:workId',wrap(async req=>{
  const room=roomBy(state,req.params.id);const item=room.workItems.find(t=>t.id===req.params.workId);if(!item)throw new Error('Work item not found');
  const {expectedUpdatedAt,expectedVersion,...body}=req.body;
  if(expectedUpdatedAt!==undefined && expectedUpdatedAt!==item.updatedAt)throw new Error('This ticket changed. Reopen it before reviewing.');
  const change=workChange.parse(body);const revision=item.updatedAt;const guard=()=>{if(!room.workItems.includes(item))throw new Error('Office changed. Reopen this ticket.');const owner=room.agents.find(a=>a.id===item.agentId);if(room.capturing || item.archived || owner?.turnId || (owner && startingAgents.has(owner.id)))throw new Error('Pause the owner and restore the ticket before reviewing.');if(item.updatedAt!==revision)throw new Error('This ticket changed. Inspect the latest evidence before reviewing.');};guard();
  await validateReceipts(room,item,change);guard();assertReviewVersion(room,item,change,expectedUpdatedAt,expectedVersion);updateWork(room,item,change);changed();await scheduleWorkers(room);return {item};
}));
app.get('/api/rooms/:id/work/:workId/review',wrap(async req=>{const room=roomBy(state,req.params.id),item=room.workItems.find(t=>t.id===req.params.workId);if(!item)throw new Error('Ticket not found');await notificationQueue;const review=await refreshReview(room,item);changed();return {review,updatedAt:item.updatedAt};}));
app.post('/api/rooms/:id/work/:workId/feature',wrap(async req=>{
  const room=roomBy(state,req.params.id);const item=room.workItems.find(t=>t.id===req.params.workId);if(!item)throw new Error('Work item not found');
  const input=z.object({previewUrl:featureUrl}).strict().parse(req.body);
  item.previewUrl=input.previewUrl;item.updatedAt=Date.now();record(room,input.previewUrl?'Feature link saved':'Feature link removed','artifact');changed();return {item};
}));
app.get('/api/rooms/:id/artifact',wrap(async(req,res)=>{
  const room=roomBy(state,req.params.id);const input=z.string().max(500).parse(req.query.path);
  const base=await realpath(room.path);const file=await realpath(path.resolve(base,input));
  const relative=path.relative(base,file);if(relative.startsWith('..') || path.isAbsolute(relative) || !['.png','.jpg','.jpeg','.webp'].includes(path.extname(file).toLowerCase()))throw new Error('Choose an image artifact inside the project folder');
  res.sendFile(file);
}));
app.get('/api/events', (req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders(); clients.add(res); res.write(`data: ${JSON.stringify(snapshot())}\n\n`); const ping = setInterval(() => res.write(': heartbeat\n\n'), 20000); req.on('close', () => { clearInterval(ping); clients.delete(res); }); });
app.post('/api/connect', wrap(async () => { await codex.connect(); await refreshAccount(); return connection; }));
app.post('/api/sandbox/setup', wrap(async()=>{
  await ensureConnected();
  if(process.platform!=='win32')throw new Error('Windows sandbox setup is only needed on Windows.');
  if(startingAgents.size || state.rooms.some(r=>!r.demo && r.agents.some(a=>a.turnId)))throw new Error('Pause active agents before setting up the Windows sandbox.');
  if(connection.sandboxSetupPending)throw new Error('Sandbox setup is already running. Complete the Windows prompt.');
  connection.sandboxSetupPending=true;connection.error=null;changed();
  try{return await codex.call('windowsSandbox/setupStart',{mode:'elevated'});}
  catch(error){connection.sandboxSetupPending=false;changed();throw error;}
}));
app.post('/api/login', wrap(async () => { await codex.connect(); return codex.call('account/login/start', { type: 'chatgpt' }); }));
app.get('/api/tools', wrap(async req => { await ensureConnected(); const room = roomBy(state, String(req.query.roomId)); const results = await Promise.allSettled([codex.call('skills/list', { cwds: [room.path] }), codex.call('mcpServerStatus/list', { limit: 100 })]); return { skills: results[0].status === 'fulfilled' ? results[0].value : null, mcp: results[1].status === 'fulfilled' ? results[1].value : null, errors: results.filter(r => r.status === 'rejected').map(r => r.reason.message) }; }));
app.post('/api/rooms', wrap(async req => {
  const body = z.object({ name: z.string().trim().min(1).max(60), path: z.string().trim().min(1).max(500), demo: z.boolean().default(false) }).parse(req.body);
  if (!path.isAbsolute(body.path)) throw new Error('Enter an absolute folder path.');
  const actual = await realpath(body.path); if (!(await stat(actual)).isDirectory()) throw new Error('Choose a folder.');
  const manager = agent('', 'Manager', 'Ready for your first assignment', 4, { manager: true });
  const r = { id: uid(), ...body, path: actual, goal: '', orchestrationVersion: 1, missionStartedAt: null, workItems: [], tag: `WORKSPACE ${String(state.rooms.length + 1).padStart(2, '0')}`, agents: [manager], messages: [], skills: [...skillNames], budget: 3, paused: false };
  claimIdentity(manager, r);
  initOffice(r); state.rooms.push(r); changed(); return { room: r };
}));
app.post('/api/rooms/:id/archive',wrap(async req=>{const r=roomBy(state,req.params.id);const {archived}=z.object({archived:z.boolean()}).strict().parse(req.body);if(r.capturing || r.agents.some(a=>a.turnId || startingAgents.has(a.id)))throw new Error('Pause all work before archiving this project.');r.archived=archived;if(archived)r.paused=true;record(r,archived?'Project archived':'Project restored','plan');changed();return {room:r};}));
app.patch('/api/rooms/:id', wrap(async req => { const r = roomBy(state, req.params.id); const b = z.object({ permissionMode:permissionMode.optional(), name:z.string().trim().min(1).max(60).optional(), budget: z.number().int().min(1).max(6).optional(), skills: z.array(z.enum(skillNames)).optional() }).parse(req.body); const previous=r.permissionMode || 'project-write';Object.assign(r, b);if(b.permissionMode && b.permissionMode!==previous)record(r,`Permissions: ${b.permissionMode} for future runs`,'permissions');changed(); }));
app.post('/api/rooms/:id/check',wrap(async req=>{const room=roomBy(state,req.params.id);await ensureConnected();room.workspaceCheck=await checkWorkspace(codex,room.path);changed();return room.workspaceCheck;}));
app.post('/api/rooms/:id/dispatch', wrap(async req => {
  const r = roomBy(state, req.params.id); cursor.assertAvailable(r); const b = z.object({ prompt: textField, model: z.string().max(120).optional(), templateId:z.string().optional() }).parse(req.body);
  let a = r.agents.find(a => a.manager && a.status !== 'ejected'); if (!a) throw new Error('Replace the manager first.');
  if (!r.demo && r.agents.some(w=>w.turnId || startingAgents.has(w.id))) throw new Error('Pause the office before starting a new mission.');
  if (b.templateId && !templates.some(template=>template.id===b.templateId)) throw new Error('Template not found');
  if (!r.demo) {
    await ensureConnected();
    cursor.assertAvailable(r);
    if(!r.agents.includes(a))throw new Error('Office changed. Try starting the mission again.');
    if (b.model && b.model!=='Account default' && !connection.models.some(model=>model.id===b.model)) throw new Error('Choose a model available to this account.');
    if (r.agents.some(worker=>worker.turnId || startingAgents.has(worker.id))) throw new Error('Pause the office before starting a new mission.');
  }
  if(!r.demo){r.workspaceCheck=await checkWorkspace(codex,r.path);cursor.assertAvailable(r);if(!r.agents.includes(a) || a.status==='ejected' || r.stopping || r.capturing || r.agents.some(w=>w.turnId || startingAgents.has(w.id)))throw new Error('Office changed during the access check. Try again.');}
  if (b.model) a.model = b.model;
  r.goal = b.prompt; r.paused = false; r.missionStartedAt = Date.now(); a.task = b.prompt;
  if(!b.templateId){const item=workItem(b.prompt.split('\n')[0].slice(0,120),b.prompt,{agentId:a.id,status:'queued',acceptanceCriteria:['The requested outcome is implemented','Verification evidence is attached'],requiredEvidence:['diff','test']});focusTicket(r,a,item);r.workItems.push(item);}
  if (r.demo) { event(a, 'user', b.prompt); event(a, 'update', 'Demo assignment received. In a live office, the manager delegates research, implements changes, and requests review.'); a.status = 'working'; a.progress = 10;
    if (r.agents.filter(w => !w.manager && w.status !== 'ejected').length === 0) { for (const [role, task, index, progress] of [['Research', 'Inspect the project for this assignment', 0, 12], ['Review', 'Prepare verification criteria', 2, 8]]) { const worker = agent('', role, task, index, { status: 'working', progress }); r.agents.push(worker); claimIdentity(worker, r); } }
    for (const worker of r.agents.filter(w => !w.manager && w.status !== 'ejected').slice(0, 2)) r.workItems.push(workItem(worker.task, worker.task, { agentId: worker.id, status: 'working', dependsOn: [], acceptanceCriteria: ['Return a concrete finding with evidence'] }));
    if(b.templateId){applyTemplate(r,b.templateId,b.prompt);setWorkStatus(r,a,'working');}record(r,'Demo mission assigned','plan');changed();
  } else { const prompt=b.templateId?applyTemplate(r,b.templateId,b.prompt):b.prompt; initOffice(r); record(r,'Mission assigned','plan'); await sendTo(r, a, prompt); }
}));
app.post('/api/rooms/:id/pause',wrap(async req=>{
  const r=roomBy(state,req.params.id);cursor.assertAvailable(r);if(r.stopping || r.agents.some(a=>startingAgents.has(a.id)))throw new Error('An office operation is in progress. Try pausing again in a moment.');r.stopping=true;
  r.paused=true;changed();
  const results=await Promise.allSettled(r.agents.filter(active).map(async a=>{const item=assignedWork(r,a.id);if(!r.demo)await stopAgent(a);else a.status='paused';setWorkStatus(r,a,'blocked','Office paused. Resume to continue.');if(item)item.resumeOnOffice=true;}));
  r.stopping=false;record(r,'Office paused','pause');changed();const fail=results.find(x=>x.status==='rejected');if(fail)throw fail.reason;
}));
app.post('/api/rooms/:id/resume',wrap(async req=>{
  const r=roomBy(state,req.params.id);cursor.assertAvailable(r);if(!r.demo)await ensureConnected();cursor.assertAvailable(r);
  if(r.stopping || r.capturing || r.agents.some(a=>startingAgents.has(a.id)) || (r.paused && r.agents.some(a=>a.turnId)))throw new Error('Wait for the current operation to finish.');
  r.paused=false;
  const resumable=r.workItems.filter(t=>t.resumeOnOffice && !t.archived && t.status==='blocked');
  for(const item of resumable){const owner=r.agents.find(a=>a.id===item.agentId && a.status!=='ejected');if(!owner)continue;item.status='queued';item.blocker='';delete item.resumeOnOffice;}
  const manager=r.agents.find(a=>a.manager && a.status!=='ejected'),task=manager && assignedWork(r,manager.id);
  if(manager && !manager.turnId && task?.status==='queued' && !waitingReason(r,task)){
    if(r.demo){manager.status='working';task.status='working';}else await startAgent(r,manager,`Resume ${task.description}.\n${(r.pendingHandoffs||[]).join('\n')}`);r.pendingHandoffs=[];
  }
  if(r.demo){for(const item of resumable){const a=r.agents.find(a=>a.id===item.agentId);if(a && !waitingReason(r,item)){a.status='working';item.status='working';}}}else await scheduleWorkers(r);
  record(r,'Office resumed','work');changed();return {room:r};
}));
app.post('/api/rooms/:id/agents/:aid/message', wrap(async req => { const r = roomBy(state, req.params.id); const a = agentBy(r, req.params.aid); const { message } = z.object({ message: textField }).parse(req.body); if (r.demo) { event(a, 'user', message); event(a, 'update', 'Demo message received. Connect a live office to execute this instruction.'); } else await sendTo(r, a, message); changed(); }));
app.post('/api/rooms/:id/agents/:aid/stop', wrap(async req => { const r = roomBy(state, req.params.id); const a = agentBy(r, req.params.aid); if (!r.demo) await stopAgent(a); else a.status = 'paused'; setWorkStatus(r, a, 'blocked', 'Agent paused. Resume this ticket when ready.');const item=assignedWork(r,a.id);if(item)delete item.resumeOnOffice;changed(); }));
app.post('/api/rooms/:id/agents/:aid/speed', wrap(async req => {
  const r = roomBy(state, req.params.id); const a = agentBy(r, req.params.aid);
  const { fast } = z.object({ fast: z.boolean() }).strict().parse(req.body);
  if (a.provider === 'cursor') throw new Error('Choose model and speed settings in Cursor.');
  if (a.status === 'ejected') throw new Error('This agent has left. Select its replacement.');
  if (startingAgents.has(a.id)) throw new Error('A turn is starting. Try again once it has started.');
  const message = `${r.demo ? 'Demo: ' : ''}${fast ? 'Fast mode requested' : 'Standard speed selected'} for ${a.name}’s next turn.${fast && !r.demo ? ' Higher usage may apply; availability depends on the model and account.' : ''}`;
  if (!!a.fastMode !== fast) { a.fastMode = fast; event(a, 'system', message); changed(); }
  return { agent: a, message };
}));
app.post('/api/rooms/:id/agents/:aid/eject', wrap(async req => {
  const r = roomBy(state, req.params.id); const a = agentBy(r, req.params.aid); if (a.status === 'ejected') throw new Error('Agent already ejected.');
  if (a.manager) { cursor.assertAvailable(r); r.paused = true; for (const worker of r.agents.filter(w => !w.manager && active(w))) { if (!r.demo) await stopAgent(worker); else worker.status = 'paused'; setWorkStatus(r, worker, 'blocked', 'Manager replaced; waiting for the new manager to resume this task.'); } }
  if (!r.demo) await stopAgent(a);
  a.handoffPacket=handoffPacket(r,a); a.handoff = JSON.stringify(a.handoffPacket); a.status = 'ejected'; a.ejectedAt = Date.now(); setWorkStatus(r, a, 'blocked', 'Agent ejected; task is waiting for a replacement.'); event(a, 'system', 'Ejected from floor 14. Task history preserved for replacement.'); record(r,`${a.name} ejected; handoff saved`,'handoff'); changed();
}));
app.post('/api/rooms/:id/agents/:aid/replace', wrap(async req => {
  const r = roomBy(state, req.params.id); cursor.assertAvailable(r); const old = agentBy(r, req.params.aid); const { model } = z.object({ model: z.string().min(1).max(120) }).parse(req.body);
  const preflight = () => {
    cursor.assertAvailable(r);
    if(!r.agents.includes(old))throw new Error('Office changed. Reopen the agent desk.');
    if (old.replacedBy) throw new Error('This agent already has a replacement. Open the current agent’s desk.');
    if (old.turnId || startingAgents.has(old.id) || !['ejected', 'paused', 'error', 'done', 'idle'].includes(old.status)) throw new Error('Stop or eject this agent before replacing it.');
    if (r.capturing) throw new Error('Wait for the checkpoint to finish.');
    if (!r.demo && !old.manager && r.paused) throw new Error('Resume the office before replacing a worker.');
    if (!r.demo && !old.manager) canDelegate(r);
  };
  preflight();
  if (!r.demo) {
    await ensureConnected();
    preflight();
    if (model !== 'Account default' && !connection.models.some(m => m.id === model)) throw new Error('Choose a model available to this account.');
  }
  const packet=old.handoffPacket || handoffPacket(r,old); if(!old.title)claimIdentity(old,r); const next = agent(replacementName(old, r), old.role, old.task, r.agents.length, { model, manager: old.manager, color: old.color, title: old.title, replaces: old.id, handoffPacket:packet });
  old.replacedBy = next.id; old.status = 'ejected'; old.ejectedAt ||= Date.now(); r.agents.push(next); transferInbox(r,old,next); if (next.manager) r.paused = false;
  const focused = assignedWork(r, old.id);const item=focused && focused.status!=='done' && !focused.archived?focused:null;for(const task of r.workItems.filter(t=>t.agentId===old.id && t.status!=='done' && !t.archived))task.agentId=next.id;if(item){next.currentWorkItemId=item.id;item.status='queued';item.blocker='';item.updatedAt=Date.now();}
  if(!item){next.status='idle';next.task='Ready for an assignment';record(r,`${old.name} replaced; verified work preserved`,'handoff');changed();return {agent:next};}
  if (r.demo) { next.status = 'working'; setWorkStatus(r,next,'working'); event(next, 'update', 'Demo replacement started with the preserved handoff.'); } else await startAgent(r, next, JSON.stringify(packet)); record(r,`${old.name} replaced; handoff preserved`,'handoff'); changed(); return { agent: next };
}));
app.post('/api/approvals/:id', wrap(async req => { const approval = state.approvals.find(x => x.id === req.params.id); if (!approval) throw new Error('This request has already been resolved.'); const b = z.object({ accept: z.boolean().optional(), answers: z.record(z.object({ answers: z.array(z.string()) })).optional() }).parse(req.body); const result = approval.method === 'item/tool/requestUserInput' ? { answers: b.answers || {} } : { decision: b.accept ? 'accept' : 'decline' }; codex.respond(approval.rpcId, result); state.approvals = state.approvals.filter(x => x !== approval); const a = agentBy(roomBy(state, approval.roomId), approval.agentId); a.status = 'working'; changed(); }));
app.post('/api/rooms/:id/install-skills', wrap(async req => { const r = roomBy(state, req.params.id); const target = path.join(r.path, '.agents', 'skills'); for (const n of skillNames) { await mkdir(path.join(target, n), { recursive: true }); try { await copyFile(path.join(root, 'skills', n, 'SKILL.md'), path.join(target, n, 'SKILL.md'), 1); } catch(e) { if (e.code !== 'EEXIST') throw e; const existing = await readFile(path.join(target, n, 'SKILL.md'), 'utf8'); if (existing !== skillText[n]) throw new Error(`Existing ${n} differs. Review it before updating.`); } } return { installed: skillNames }; }));
app.get('/api/export/:id', wrap(async (req, res) => { const r = roomBy(state, req.params.id); res.setHeader('Content-Disposition', 'attachment; filename="office-handoff.json"'); res.json(r); }));
if (process.argv.includes('--production')) app.use(express.static(path.join(root, 'dist')));
else { const { createServer } = await import('vite'); const vite = await createServer({ server: { middlewareMode: true, hmr: { port: port + 1, host: '127.0.0.1' } }, appType: 'spa' }); app.use(vite.middlewares); }
const server = app.listen(port, '127.0.0.1', () => console.log(`Fourteenth office: http://127.0.0.1:${port}`));
const expiring=new Set();
setInterval(()=>{for(const room of state.rooms)if(!room.demo)for(const a of room.agents)if(a.turnId && a.deadline && a.deadline<Date.now() && !expiring.has(a.id)){
  expiring.add(a.id);stopAgent(a).then(()=>{setWorkStatus(room,a,'blocked','Turn time budget reached. Inspect the handoff and resume.');a.handoffPacket=handoffPacket(room,a);record(room,`${a.name} reached the turn time budget`,'pause');}).catch(e=>event(a,'error',e.message)).finally(()=>{expiring.delete(a.id);changed();});
}},1000).unref();
changed();
codex.connect().then(refreshAccount).catch(e => { connection.error = e.message; changed(); });
process.on('SIGINT', () => { team.close();codex.close(); server.close(); process.exit(0); });
