import { identifyEvidence, trimEvidence } from './evidence.mjs';
import { featureUrl } from './feature-link.mjs';
import { queueHandoff, delivered, acknowledge } from './peer-handoffs.mjs';
import { uid, agent, workItem, event, DEFAULT_MODEL } from './domain.mjs';
import { claimIdentity, nameRoom, replacementName } from './names.mjs';
import { illustrativeDiff, passingTranscript, failingTranscript } from './demo-evidence.mjs';

export const modes = {
  balanced: { name: 'Balanced', detail: 'Steady progress with a review gate.', workers: 3, minutes: 20, effort: 'medium', fast: false },
  crunch: { name: 'Crunch', detail: 'Short turns, lightweight workers, more parallel research.', workers: 6, minutes: 5, effort: 'low', fast: true },
  quality: { name: 'Quality', detail: 'Deeper reasoning and deliberate verification.', workers: 3, minutes: 30, effort: 'high', fast: false },
  security: { name: 'Security', detail: 'Careful local code review and explicit coverage limits.', workers: 2, minutes: 25, effort: 'high', fast: false },
  economy: { name: 'Economy', detail: 'Lightweight workers and fewer concurrent turns.', workers: 2, minutes: 10, effort: 'low', fast: false },
  explore: { name: 'Explore', detail: 'Compare alternatives before committing to implementation.', workers: 4, minutes: 15, effort: 'medium', fast: false },
};
export const templates = [
  { id: 'feature', name: 'Ship a React feature', category: 'BUILD', description: 'Map the UI, implement one coherent change, and verify the journey.', roles: ['Research', 'Implementation', 'Review'], criteria: ['Requested behavior works', 'Relevant checks pass', 'UI result inspected'], required: ['diff', 'test', 'screenshot'], prompt: 'Inspect the React app and map the affected files. Implement the requested feature as the sole writer. Delegate bounded research and a final read-only review. Attach a diff, actual test results, and a screenshot artifact path. Check each acceptance criterion. If the feature has a browser UI, run the documented dev server on loopback, open the exact feature route and verify it, then attach that full URL as previewUrl through office_update_work. Reuse an existing server when available. Report launch blockers instead of inventing a link. Include the restart command in a log receipt. Do not deploy or use the Fourteenth office URL as the feature URL.' },
  { id: 'bug', name: 'Fix a production bug', category: 'REPAIR', description: 'Trace the failure, make a focused fix, and prevent regression.', roles: ['Diagnosis', 'Implementation', 'Regression review'], criteria: ['Root cause identified', 'Regression check passes', 'Fix reviewed'], required: ['diff', 'test', 'log'], prompt: 'Diagnose the reported bug in this local repository. Record the failure and root cause. Implement the smallest sound fix, run a regression check, and request independent read-only review. Attach the diff, test result and diagnostic log.' },
  { id: 'review', name: 'Security review', category: 'REVIEW', description: 'Review local code and configuration for defensive improvements.', roles: ['Code review', 'Configuration review', 'Remediation'], criteria: ['Findings cite local files', 'Mitigations are actionable'], required: ['log'], prompt: 'Perform a bounded read-only defensive review of local source and configuration. Cite file paths and lines, explain risks, and suggest fixes. Do not probe external services or execute exploit payloads. Attach findings as a log and state coverage limits.' },
  { id: 'release', name: 'Prepare a release', category: 'DELIVER', description: 'Check readiness, validate the build, and prepare a release handoff.', roles: ['Readiness', 'Build verification', 'Release notes'], criteria: ['Build checks pass', 'Known limitations documented', 'Release handoff prepared'], required: ['test', 'log'], prompt: 'Inspect release readiness, run the documented build and test checks, and prepare release notes with known limitations. Attach command results and the release report. Publishing requires a separate user instruction.' },
];

for (const template of templates) template.skills = ['office-manager', 'office-handoff', 'office-review'];

export function initOffice(room) {
  identifyEvidence(room);
  room.permissionMode ||= 'project-write';
  room.mode ||= 'balanced'; room.timeline ||= []; room.checkpoints ||= []; room.workItems ||= [];
  if(!room.demo && !room.solDefaultsApplied){
    for(const a of room.agents || [])if(a.provider!=='cursor' && (!a.model || a.model==='Account default'))a.model=DEFAULT_MODEL;
    room.solDefaultsApplied=true;
  }
  for (const item of room.workItems) { item.files ||= []; item.checks ||= []; item.requiredEvidence ||= []; item.evidence ||= []; }
  return room;
}
export function officeFrame(room) {
  return structuredClone({ goal: room.goal, permissionMode: room.permissionMode, demoGate: room.demoGate, mode: room.mode, budget: room.budget, skills: room.skills, templateId: room.templateId, paused: room.paused,
    workItems: room.workItems, agents: room.agents.filter(a => a.status !== 'ejected' || a.ejectedAt > Date.now()-5000).map(a => ({ ...a, events: a.events.slice(-6), diff: a.diff?.slice(-12000) })), messages: room.messages.filter((m,i,all)=>i>=all.length-8 || m.disposition==='investigate' || m.evidenceLinks?.length || (m.status && m.status!=='acknowledged')) });
}
export function record(room, title, kind = 'work') {
  initOffice(room);
  room.timeline.push({ id: uid(), time: Date.now(), title, kind, frame: officeFrame(room) });
  room.timeline = room.timeline.slice(-45);
}
export function normalizedFile(file) { return file.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase().replace(/\/$/, ''); }
export function overlappingFiles(first, second) {
  return first.filter(a => second.some(b => { const x=normalizedFile(a), y=normalizedFile(b); return x===y || x.startsWith(y+'/') || y.startsWith(x+'/'); }));
}
export function waitingReason(room, item) {
  const dependencies = item.dependsOn.filter(id => room.workItems.find(t=>t.id===id)?.status !== 'done');
  if (dependencies.length) return { reason: 'Waiting for dependencies', tasks: dependencies, files: [] };
  const readOnly=t=>{const owner=room.agents.find(a=>a.id===t.agentId);return !room.demo && owner && !owner.manager && owner.provider!=='cursor';};
  const other = room.workItems.find(t => t.id!==item.id && t.status==='working' && !readOnly(item) && !readOnly(t) && overlappingFiles(item.files || [],t.files || []).length);
  return other ? { reason: 'Shared files need coordination', tasks: [other.id], files: overlappingFiles(item.files || [],other.files || []) } : null;
}
export function completionGaps(room, item) {
  const gaps=[];
  if(!room.demo && item.requiredEvidence?.includes('test') && item.reviewState && !item.reviewState.current)gaps.push(item.reviewState.label);
  if (item.dependsOn.some(id=>room.workItems.find(t=>t.id===id)?.status!=='done')) gaps.push('Dependencies are not verified');
  for (const kind of item.requiredEvidence || []) if (!item.evidence.some(e=>e.kind===kind && e.text?.trim() && (kind!=='test' || e.passed===true))) gaps.push(`Missing ${kind==='test'?'passing test':kind} evidence`);
  item.acceptanceCriteria.forEach((criterion,index)=>{ if (!item.checks?.some(c=>c.index===index && c.passed && c.evidence?.trim())) gaps.push(`Unchecked criterion: ${criterion}`); });
  if (!item.evidence.some(e=>e.text?.trim())) gaps.push('No evidence attached');
  return gaps;
}
export function updateWork(room, item, change) {
  const candidate=structuredClone(item);
  if(change.previewUrl!==undefined)candidate.previewUrl=featureUrl.parse(change.previewUrl);
  if (change.evidence?.trim()) candidate.evidence.push({ id:uid(), kind: 'note', text: change.evidence.trim(), time: Date.now() });
  for(const receipt of change.receipts || []) candidate.evidence.push({ ...receipt, id:uid(), source:receipt.source || 'reported', time:Date.now() });
  trimEvidence(room,candidate);
  if(change.checks) { if(change.checks.some(c=>c.index>=candidate.acceptanceCriteria.length) || new Set(change.checks.map(c=>c.index)).size!==change.checks.length)throw new Error('Acceptance check indices must be unique and match the criteria'); candidate.checks=change.checks; }
  if(change.files) candidate.files=change.files;
  if(change.dependsOn) {
    if(change.dependsOn.some(id=>id===item.id || !room.workItems.some(t=>t.id===id))) throw new Error('Invalid dependency');
    const visit=(id,seen=new Set())=>{ if(id===item.id) throw new Error('Dependencies cannot form a cycle'); if(seen.has(id))return; seen.add(id); for(const next of room.workItems.find(t=>t.id===id)?.dependsOn || [])visit(next,seen); };
    change.dependsOn.forEach(id=>visit(id)); candidate.dependsOn=change.dependsOn;
  }
  if(change.status==='done') { const gaps=completionGaps(room,candidate); if(gaps.length)throw new Error(gaps.join('; ')); }
  candidate.status=change.status || candidate.status; candidate.blocker=change.blocker || ''; candidate.updatedAt=Date.now();
  Object.assign(item,candidate); identifyEvidence(room); record(room, `${item.title}: ${item.status}`, 'evidence'); return item;
}
export function handoffPacket(room, a) {
  const tasks=room.workItems.filter(t=>t.agentId===a.id);
  return { savedAt:Date.now(), goal:room.goal, task:a.task, files:[...new Set(tasks.flatMap(t=>t.files||[]))], workItems:structuredClone(tasks), messages:structuredClone(room.messages.filter(m=>m.fromId===a.id || m.toId===a.id)),
    discoveries:a.events.filter(e=>e.kind==='update').slice(-10), failedAttempts:a.events.filter(e=>e.kind==='error' || (e.kind==='command' && /Exit: [1-9]/.test(e.text))).slice(-8),
    nextSteps:a.plan.filter(p=>p.status!=='completed'), diff:a.diff || '', events:structuredClone(a.events),
    instruction:'Files remain in the project folder. Inspect their current state before continuing; interrupted actions may not have finished.' };
}
export function selectPolicy(room,a,models) {
  const mode=modes[room.mode] || modes.balanced;
  const lightweight=models.find(m=>/mini|luna|haiku/i.test(m.id));
  const sol=models.find(m=>m.id===DEFAULT_MODEL) || models.find(m=>m.id==='gpt-5.6-sol') || models.find(m=>/\bsol\b/i.test(m.id));
  const chosen=(!a.manager && ['crunch','economy'].includes(room.mode) && lightweight) || models.find(m=>m.id===a.model) || ((!a.model || a.model===DEFAULT_MODEL) ? sol : models.find(m=>m.isDefault));
  if(!chosen && (!a.model || a.model===DEFAULT_MODEL))throw new Error('Sol is not available to this account. Choose an available model in Model and requirements.');
  const effort=chosen?.efforts?.includes(mode.effort) ? mode.effort : undefined;
  return { model:chosen?.id || (a.model==='Account default'?undefined:a.model), effort, serviceTier:mode.fast || a.fastMode ? 'fast':'default', minutes:mode.minutes };
}
export function teamInstructions(room) {
  return `Automatic team workflow: For a new project or multi-step assignment, after inspecting project instructions, use office_delegate early in your first turn without waiting for the user to request subagents. Create up to ${Math.min(2,room.budget)} independent read-only assignments: one for project/data-flow research, one for tests, UX, or acceptance risks. Use fewer when only one useful independent question exists. Each assignment needs a distinct scope, file paths when known, acceptance criteria, evidence requirements and a stopping condition. Keep implementation moving as the sole writer while specialists work. Reuse existing assignments on resume; do not spawn duplicate workers. Do not make initial research depend on the manager's completion. After implementation, request a focused independent review of the changed behavior before claiming completion. Use office_message for direct peer findings. Keep trivial one-line edits or simple questions local and briefly explain when no useful delegation exists. Respect an explicit request to work solo, the office pause state and the ${room.budget}-worker concurrency limit.`;
}
export function applyTemplate(room,id,goal) {
  const template=templates.find(t=>t.id===id); if(!template)throw new Error('Template not found');
  room.skills=[...new Set([...(room.skills || []),...template.skills])];
  delete room.demoStep;delete room.demoGate;
  room.templateId=id; room.goal=goal; room.missionStartedAt=Date.now(); room.pendingHandoffs=[];
  const manager=room.agents.find(a=>a.manager && a.status!=='ejected'); if(!manager)throw new Error('Replace the manager first');
  manager.task=goal;
  const item=workItem(goal.split('\n')[0].slice(0,120),goal,{agentId:manager.id,acceptanceCriteria:[...template.criteria], requiredEvidence:[...template.required], checks:[],files:[]});
  for(const previous of room.workItems.filter(t=>t.agentId===manager.id))delete previous.resumeOnOffice;
  for(const previous of room.workItems.filter(t=>t.agentId===manager.id && !t.archived && ['queued','working'].includes(t.status))){previous.status='blocked';previous.blocker='Manager moved to a new mission. Resume this ticket when ready.';delete previous.resumeOnOffice;}
  manager.currentWorkItemId=item.id;room.workItems.push(item);record(room, `${template.name} office created`, 'template');
  return `${goal}\n\nOffice template: ${template.name}\n${template.prompt}\nSkills: ${template.skills.join(', ')}.\nWork item: ${item.id}\nRequired evidence: ${template.required.join(', ')}. Use office_status and office_update_work to track this objective.`;
}

export function createDemo(path) {
  const manager=agent('','Manager','Ship project search',4,{manager:true,model:'gpt-5.6-sol',status:'idle'});
  const research=agent('','Research','Map search behavior',1,{model:'gpt-5.6-luna',status:'working'});
  const review=agent('','Reviewer','Verify the search journey',2,{model:'gpt-5.6-sol'});
  const room=initOffice({id:uid(),name:'Search launch · demo',path,tag:'GUIDED DEMO',demo:true,goal:'Add instant project search with an accessible empty state.',agents:[manager,research,review],messages:[],skills:['office-manager','office-review','office-handoff'],budget:3,paused:false,orchestrationVersion:1,demoStep:0});
  const first=workItem('Map the search journey','Inspect behavior and affected files',{agentId:research.id,status:'working',files:['src/Search.tsx'],acceptanceCriteria:['Document empty and populated states'],requiredEvidence:['log'],checks:[]});
  const build=workItem('Build project search','Implement search and its empty state',{agentId:manager.id,dependsOn:[first.id],files:['src/Search.tsx'],acceptanceCriteria:['Search filters projects'],requiredEvidence:['diff','test','screenshot'],checks:[]});
  const verify=workItem('Review the finished journey','Review the changes and regression checks',{agentId:review.id,dependsOn:[build.id],files:['src/Search.tsx'],acceptanceCriteria:['Keyboard flow works'],requiredEvidence:['test'],checks:[]});
  room.workItems=[first,build,verify]; nameRoom(room); record(room,'Mission planned: three bounded assignments','plan'); return room;
}
export function stepDemo(room) {
  if(!room.demo || room.demoStep==null)throw new Error('Choose the guided demo office');
  if(room.demoStep>=5)throw new Error('Demo finished. Replay its timeline or start another demo.');
  const [research,build,review]=room.workItems;
  const owner=item=>room.agents.find(a=>a.id===item.agentId);
  const receipt=(kind,text,extra={})=>({kind,text:'Demo fixture: '+text,time:Date.now(),...extra});
  const finish=(item,evidence)=>{item.evidence=evidence;item.checks=item.acceptanceCriteria.map((_,index)=>({index,passed:true,evidence:'Scripted check: '+item.acceptanceCriteria[index]+' — supported by the attached '+evidence.map(e=>e.kind).join(', ')+' fixture.'}));updateWork(room,item,{status:'done'});owner(item).status='done';};
  room.demoStep++;
  if(room.demoStep===1){
    room.mode='crunch';room.budget=6;
    const specialists=[['Product · API scout','Map the search data contract','gpt-5.6-luna','src/api/search.ts'],['Quality · Test designer','Design regression coverage','gpt-5.6-sol','tests/search.test.ts'],['Quality · Accessibility','Check keyboard and focus states','gpt-5.6-terra','src/Search.tsx']];
    for(const [role,taskTitle,model,file] of specialists){const worker=agent('',role,taskTitle,room.agents.length,{model,status:'working'});room.agents.push(worker);claimIdentity(worker,room);const task=workItem(taskTitle,taskTitle,{agentId:worker.id,status:'working',files:[file],acceptanceCriteria:['Return a concrete finding'],requiredEvidence:['log'],checks:[]});room.workItems.push(task);review.dependsOn.push(task.id);event(worker,'update','Demo fixture: specialist joined the coordinated review.');}
    const scout=room.agents.find(a=>/accessib/i.test(a.role)),tester=room.agents.find(a=>/test design/i.test(a.role));
    const peer=queueHandoff(room,scout,{agentId:tester.id,workItemId:room.workItems.find(t=>t.agentId===tester.id).id,message:'Demo finding: Clear search must return focus to the input. Include the empty-state keyboard path in regression coverage.'});delivered(room,tester,[peer]);scout.talkingUntil=tester.talkingUntil=Date.now()+14000;
    record(room,'Peers share findings: accessibility informs test coverage','handoff');
    record(room,'Office expands: Product and Quality teams are online','team');
    finish(research,[receipt('log','Mapped Search.tsx and keyboard navigation.')]);build.status='working';owner(build).status='working';event(owner(build),'update','Implementing instant search and the empty state.');record(room,'Research handed off. Implementation started.','handoff');}
  if(room.demoStep===2){const peer=room.messages.find(m=>m.kind==='finding' && m.status==='delivered');if(peer)acknowledge(room,room.agents.find(a=>a.id===peer.toId),{messageId:peer.id,note:'Demo acknowledgment: added Clear search focus retention to the test plan.'});review.blocker='Search.tsx is still owned by implementation';review.status='blocked';for(const t of [build,review])owner(t).talkingUntil=Date.now()+30000;event(owner(build),'command',failingTranscript);owner(build).plan=[{step:'Normalize query casing, rerun the search regressions, then inspect Clear search focus',status:'pending'}];try{updateWork(room,build,{status:'done'});}catch(error){room.demoGate={taskId:build.id,rejected:true,gaps:completionGaps(room,build),time:Date.now()};event(owner(build),'error','Completion gate rejected this request: '+error.message);record(room,'Completion rejected: required evidence and checks are missing','gate');};room.messages.push({id:uid(),fromId:owner(review).id,from:owner(review).name,toId:owner(build).id,to:owner(build).name,text:'Demo: review and implementation share Search.tsx. Review waits until implementation is verified.',time:Date.now()});record(room,'Shared file detected. Team meets to sequence review.','coordination');}
  if(room.demoStep===3){const old=owner(build);old.handoffPacket=handoffPacket(room,old);old.status='ejected';old.ejectedAt=Date.now();const next=agent(replacementName(old,room),'Manager',old.task,4,{manager:true,model:'gpt-6-astra',replaces:old.id,status:'working',title:old.title,handoffPacket:old.handoffPacket});old.replacedBy=next.id;room.agents.push(next);build.agentId=next.id;record(room,'Manager replaced. Assignment and handoff preserved.','handoff');}
  if(room.demoStep===4){for(const item of room.workItems.slice(3))finish(item,[receipt('log',item.title+' — findings captured and handed off.')]);room.agents.forEach(a=>{a.talkingUntil=0;});finish(build,[receipt('diff',illustrativeDiff),receipt('test',passingTranscript,{passed:true}),receipt('screenshot','Search preview', {artifact:'/demo-search.svg'})]);review.status='working';review.blocker='';owner(review).status='working';record(room,'Implementation verified. Review unblocked.','evidence');}
  if(room.demoStep===5){finish(review,[receipt('test','Keyboard and empty-state checks passed',{passed:true})]);record(room,'Search launch verified. Evidence ready to inspect.','complete');}
  return room;
}
