import { createInterface } from 'node:readline';
import {existsSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const threads=new Map(); let count=0;
const sandboxMarker=path.join(process.env.CODEX_HOME,'fixture-sandbox-ready');
const sandboxReady=!process.env.OFFICE_FIXTURE_SANDBOX_MISSING || existsSync(sandboxMarker);
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const notify=(method,params)=>send({method,params});
const toolReplies=new Map();
const toolCall=(threadId,tool,args)=>new Promise(resolve=>{const id='tool-'+ ++count;toolReplies.set(id,resolve);send({id,method:'item/tool/call',params:{threadId,tool,arguments:args}});});
async function exerciseTool(threadId,text) {
  if(!text?.startsWith('FIXTURE_TOOL '))return;
  const {tool,args}=JSON.parse(text.split('\n')[0].slice(13));
  const exposed=threads.get(threadId)?.dynamicTools?.some(t=>t.name===tool);
  const reply=await toolCall(threadId,tool,args);
  notify('item/agentMessage/delta',{threadId,itemId:'tool-result-'+ ++count,delta:JSON.stringify({fixtureTool:tool,exposed,...reply})});
}
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(m.id==null)return;
  if(!m.method && toolReplies.has(m.id)){toolReplies.get(m.id)(m.result);toolReplies.delete(m.id);return;}
  if(!m.method)return;
  const p=m.params;
  const result=value=>send({id:m.id,result:value});
  if(m.method==='initialize')return result({userAgent:'test-only'});
  if(m.method==='account/read')return result({account:process.env.OFFICE_FIXTURE_SIGNED_OUT?null:{type:'chatgpt',email:'fixture@example.invalid',planType:'test'}});
  if(m.method==='model/list')return result({data:[{model:'fixture-model',displayName:'Fixture model',hidden:false,isDefault:true},{model:'gpt-6-sol',displayName:'GPT-6 Sol',hidden:false,isDefault:false,supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]});
  if(m.method==='windowsSandbox/readiness')return result({status:sandboxReady?'ready':'notConfigured'});
  if(m.method==='windowsSandbox/setupStart'){
    if(p.mode!=='elevated')return send({id:m.id,error:{code:-32602,message:'Expected elevated sandbox setup'}});
    result({started:true});setTimeout(()=>{writeFileSync(sandboxMarker,'ready');notify('windowsSandbox/setupCompleted',{mode:p.mode,success:true,error:null});},20);return;
  }
  if(m.method==='command/exec')return result({exitCode:0,stdout:p.cwd+'\nfixture',stderr:''});
  if(m.method==='thread/start'){
    // Match the app-server SandboxMode wire enum, not SandboxPolicy's type names.
    if(!['read-only','workspace-write','danger-full-access'].includes(p.sandbox))return send({id:m.id,error:{code:-32602,message:'Invalid sandbox mode: '+p.sandbox}});
    const expected=p.developerInstructions?.includes('You are the sole file writer.')?'workspace-write':'read-only';
    if(p.developerInstructions?.includes('You are a read-only manager.') && p.approvalPolicy!=='never')return send({id:m.id,error:{code:-32602,message:'Review-only must deny escalation'}});
    if(p.sandbox!==expected)return send({id:m.id,error:{code:-32602,message:'Incorrect sandbox for office role: '+p.sandbox}});
    const id='fixture-thread-'+ ++count; threads.set(id,{...p,id}); return result({thread:{id},sandbox:{type:p.sandbox==='workspace-write'?'workspaceWrite':'readOnly'}});
  }
  if(m.method==='thread/resume'){if(!threads.has(p.threadId))threads.set(p.threadId,{id:p.threadId});return result({thread:{id:p.threadId},sandbox:{type:p.sandbox==='workspace-write'?'workspaceWrite':'readOnly'}});}
  if(m.method==='turn/start'){
    const thread=threads.get(p.threadId); const id='fixture-turn-'+ ++count; thread.turn=id;
    thread.interruptRace=p.input?.[0]?.text?.startsWith('FIXTURE_INTERRUPT_RACE');
    notify('turn/started',{threadId:p.threadId,turn:{id,status:'inProgress'}});
    result({turn:{id,status:'inProgress'}});
    const testReceipt=p.input?.[0]?.text?.includes('FIXTURE_TEST_RECEIPT');
    if(testReceipt)notify('item/started',{threadId:p.threadId,item:{type:'commandExecution',id:'cmd-'+id,command:'npm test',cwd:thread.cwd}});
    setTimeout(()=>exerciseTool(p.threadId,p.input?.[0]?.text),10);
    if(p.input?.[0]?.text?.includes('Office peer inbox'))notify('item/agentMessage/delta',{threadId:p.threadId,itemId:'inbox-'+id,delta:'FIXTURE_RECEIVED_INBOX '+p.input[0].text});
    if(p.input?.[0]?.text?.startsWith('FIXTURE_COORDINATE')) setTimeout(async()=>{
      const first=await toolCall(p.threadId,'office_delegate',{name:'Scout',role:'Research',task:'Inspect search',files:['src/search.ts'],acceptanceCriteria:['Find the entry point'],requiredEvidence:['log']});
      if(!first.success)return;const item=JSON.parse(first.contentItems[0].text);
      await toolCall(p.threadId,'office_delegate',{name:'Reviewer',role:'Review',task:'Review search',files:['src/search.ts'],dependsOn:[item.workItemId],acceptanceCriteria:['Review findings'],requiredEvidence:['log']});
    },30);
    setTimeout(()=>{
      if(testReceipt || p.input?.[0]?.text?.startsWith('FIXTURE_ARTIFACTS'))for(const diff of ['+ first change','+ final change'])notify('turn/diff/updated',{threadId:p.threadId,turnId:id,diff});
      notify('turn/plan/updated',{threadId:p.threadId,turnId:id,plan:[{step:'Read fixture',status:'completed'},{step:'Wait for user',status:'inProgress'}]});
      notify('item/agentMessage/delta',{threadId:p.threadId,itemId:'msg-'+id,delta:'Fixture progress: '});
      notify('item/agentMessage/delta',{threadId:p.threadId,itemId:'msg-'+id,delta:'awaiting next action. Requested tier: '+p.serviceTier});
      notify('item/completed',{threadId:p.threadId,item:{type:'reasoning',id:'private',summary:[],content:['RAW_PRIVATE_SENTINEL']}});
      notify('item/completed',{threadId:p.threadId,item:{type:'commandExecution',id:'cmd-'+id,command:testReceipt?'npm test':'fixture command',cwd:thread.cwd,aggregatedOutput:'OK',exitCode:0}});
    },20);
    return;
  }
  if(m.method==='turn/interrupt'){
    if(threads.get(p.threadId)?.interruptRace)send({id:m.id,error:{code:-1,message:'no active turn to interrupt'}});else result({});
    setTimeout(()=>notify('turn/completed',{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}}),30);return;
  }
  if(m.method==='turn/steer'){
    if(p.input?.[0]?.text?.startsWith('Office peer inbox') && p.input[0].text.includes('FIXTURE_DELIVERY_FAIL'))return send({id:m.id,error:{code:-1,message:'Simulated ended turn'}});
    result({turnId:p.expectedTurnId});
    if(p.input?.[0]?.text?.startsWith('Office peer inbox'))notify('item/agentMessage/delta',{threadId:p.threadId,itemId:'steer-inbox-'+ ++count,delta:'FIXTURE_RECEIVED_INBOX '+p.input[0].text});
    setTimeout(()=>exerciseTool(p.threadId,p.input?.[0]?.text),10);return;
  }
  if(m.method==='skills/list')return result({data:[]});
  if(m.method==='mcpServerStatus/list')return result({data:[],nextCursor:null});
  send({id:m.id,error:{code:-32601,message:'Unknown fixture method '+m.method}});
});
