import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sharedOffice,peerOrigin} from '../server/team.mjs';
import {agent,workItem} from '../server/domain.mjs';

test('shared offices expose status, not local credentials or execution data',()=>{
  const a=agent('Morgan','Manager','Build search',0,{threadId:'private-thread',diff:'private diff',events:[{text:'private log'}]});
  const r={id:'r',name:'Search',paused:false,path:'private path',agents:[a],workItems:[workItem('Search','private description',{evidence:[{text:'private receipt'}]})]};
  const shared=sharedOffice(r,'Alex');assert.equal(shared.owner,'Alex');assert.equal(shared.workItems[0].receiptCount,1);assert.ok(!JSON.stringify(shared).includes('private'));
  assert.equal(peerOrigin('http://192.168.1.20:4414'),'http://192.168.1.20:4414');
  for(const origin of ['http://example.com','http://127.example.com','http://10.example.com','file:///tmp','http://localhost:1/secret','http://user:pass@localhost:1'])assert.throws(()=>peerOrigin(origin));
});

test('two independently owned offices synchronize handoffs, acknowledgments, replacement and reconnection',{timeout:90000},async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'fourteenth-team-')),root=path.resolve('.');
  const clients=[];
  async function start(port,name){
    const dir=path.join(temp,name);await mkdir(dir,{recursive:true});
    const child=spawn(process.execPath,['server/index.mjs','--production'],{cwd:root,env:{...process.env,PORT:String(port),OFFICE_TEAM_PORT:String(port+100),OFFICE_DATA_DIR:dir,OFFICE_CODEX_HOME:path.join(dir,'codex'),OFFICE_CODEX_BIN:process.execPath,OFFICE_CODEX_ARGS:JSON.stringify([path.join(root,'tests/fake-codex.mjs')])},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let errors='';child.stderr.on('data',d=>errors+=d);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors || 'Startup timeout')),12000);child.stdout.on('data',d=>{if(String(d).includes('Fourteenth office')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(errors));});});
    const base=`http://127.0.0.1:${port}`,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
    const client={child,dir,base,cookie,async req(route,body){const res=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};}};
    clients.push(client);await client.req('/connect',{});return client;
  }
  async function stop(client){if(client.child.exitCode!==null || client.child.signalCode!==null)return;await new Promise(resolve=>{client.child.once('exit',resolve);client.child.kill();});}
  t.after(async()=>{await Promise.all(clients.map(stop));if(path.dirname(temp)===os.tmpdir() && path.basename(temp).startsWith('fourteenth-team-'))await rm(temp,{recursive:true,force:true});});
  const a=await start(44341,'alex'),b=await start(44342,'blair');
  assert.notEqual(a.cookie.split('=')[0],b.cookie.split('=')[0],'ports have independent browser sessions');
  async function create(client,name){const result=await client.req('/rooms',{name,path:client.dir,demo:false});assert.equal(result.status,200);return result.data.room;}
  const ar=await create(a,'Search frontend'),br=await create(b,'Search API');await create(a,'Private unrelated project');
  const current=async(client,room)=>(await client.req('/state')).data.rooms.find(r=>r.id===room.id);
  async function wait(fn){for(let i=0;i<180;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}assert.fail('Timed out waiting for office synchronization');}
  const invitation=await a.req(`/rooms/${ar.id}/team/invite`,{owner:'Alex',address:'http://127.0.0.1:44441'});assert.equal(invitation.status,200);
  const joined=await b.req(`/rooms/${br.id}/team/join`,{owner:'Blair',code:invitation.data.code});assert.equal(joined.status,200,JSON.stringify(joined));
  const left=await current(a,ar);assert.equal(left.team.remote.owner,'Blair');assert.ok(!JSON.stringify(left.team).includes(b.dir));assert.ok(!JSON.stringify(left.team).includes('token'));
  assert.equal((await fetch('http://127.0.0.1:44441/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch('http://127.0.0.1:44441/api/rooms')).status,404,'peer transport never exposes owner controls');
  assert.equal((await b.req(`/rooms/${ar.id}/agents/${ar.agents[0].id}/stop`,{})).status,409,'remote IDs cannot invoke local controls');
  async function worker(client,room,title){const task=(await client.req(`/rooms/${room.id}/work`,{title,description:title,files:['src/search.ts'],acceptanceCriteria:['Report evidence']})).data.item;const assigned=await client.req(`/rooms/${room.id}/work/${task.id}/assign`,{role:'Research'});assert.equal(assigned.status,200,JSON.stringify(assigned));return assigned.data.agent;}
  const aa=await worker(a,ar,'Build search UI'),bb=await worker(b,br,'Review search contract');
  await wait(async()=>{const r=await current(a,ar);return r.team.remote.agents.some(x=>x.id===bb.id) && r.team.overlaps.length;});
  async function invoke(client,room,worker,tool,args){
    const count=(await current(client,room)).agents.find(x=>x.id===worker.id).events.filter(e=>e.text.startsWith('{"fixtureTool"')).length;
    assert.equal((await client.req(`/rooms/${room.id}/agents/${worker.id}/message`,{message:'FIXTURE_TOOL '+JSON.stringify({tool,args})})).status,200);
    return wait(async()=>{const events=(await current(client,room)).agents.find(x=>x.id===worker.id).events.filter(e=>e.text.startsWith('{"fixtureTool"'));return events.length>count && JSON.parse(events.at(-1).text);});
  }
  const sent=await invoke(a,ar,aa,'office_message',{agentId:bb.id,message:'Use q as the query parameter.',kind:'finding'});assert.equal(sent.success,true);const mid=JSON.parse(sent.contentItems[0].text).messageId;
  await wait(async()=>{const r=await current(b,br);return r.messages.find(m=>m.id===mid)?.status==='delivered';});
  assert.ok((await current(b,br)).agents.find(x=>x.id===bb.id).events.some(e=>e.text.includes('FIXTURE_RECEIVED_INBOX') && e.text.includes('Alex')));
  assert.equal((await invoke(b,br,bb,'office_acknowledge',{messageId:mid,note:'Will review the q contract.',disposition:'investigate'})).success,true);
  await wait(async()=>(await current(a,ar)).messages.find(m=>m.id===mid)?.status==='acknowledged');
  const reply=await invoke(b,br,bb,'office_message',{agentId:aa.id,message:'Confirmed q is supported.',kind:'answer',replyTo:mid});assert.equal(reply.success,true);
  assert.equal((await invoke(b,br,bb,'office_acknowledge',{messageId:mid,note:'Applied',disposition:'applied',evidenceLinks:[{workItemId:'remote-ticket',receiptId:'remote-receipt'}]})).success,false,'remote receipts cannot bypass local evidence gates');
  await b.req(`/rooms/${br.id}/agents/${bb.id}/stop`,{});
  const queued=await invoke(a,ar,aa,'office_message',{agentId:bb.id,message:'Keep this through replacement.'});const qid=JSON.parse(queued.contentItems[0].text).messageId;
  await wait(async()=>(current(b,br)).then(r=>r.messages.some(m=>m.id===qid)));
  assert.equal((await current(b,br)).agents.find(x=>x.id===bb.id).turnId,null,'messages never start idle agents');
  const replacement=await b.req(`/rooms/${br.id}/agents/${bb.id}/replace`,{model:'gpt-6-sol'});assert.equal(replacement.status,200);
  await wait(async()=>{const r=await current(a,ar);return r.messages.find(m=>m.id===qid)?.toId===replacement.data.agent.id;});
  assert.equal((await current(b,br)).messages.filter(m=>m.id===qid).length,1,'polling deduplicates delivery');
  await new Promise(r=>setTimeout(r,700));await stop(a);
  const offline=await b.req(`/rooms/${br.id}/team/message`,{senderId:replacement.data.agent.id,agentId:aa.id,message:'Offline handoff persists.'});assert.equal(offline.status,200);const offlineId=offline.data.message.id;
  const restarted=await start(44341,'alex');
  await wait(async()=>(await current(restarted,ar)).messages.some(m=>m.id===offlineId));
  assert.equal((await current(restarted,ar)).agents.find(x=>x.id===aa.id).turnId,null,'reconnect does not resume work');
  const stored=JSON.parse(await readFile(path.join(b.dir,'team-links.json'),'utf8'));assert.equal(stored.links.length,1);
  assert.equal((await b.req(`/rooms/${br.id}/team/disconnect`,{})).status,200);
  assert.equal((await current(restarted,ar)).team,null);assert.equal((await current(b,br)).team,null);
});
