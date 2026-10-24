import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('Windows setup blocks implementation before a turn and resumes the same ticket after setup', {skip:process.platform!=='win32',timeout:20000}, async t=>{
  const root=path.resolve('.'),temp=await mkdtemp(path.join(os.tmpdir(),'fourteenth-sandbox-'));
  const base='http://127.0.0.1:44326';
  const child=spawn(process.execPath,['server/index.mjs','--production'],{cwd:root,env:{...process.env,PORT:'44326',OFFICE_DATA_DIR:temp,OFFICE_CODEX_HOME:path.join(temp,'codex'),OFFICE_CODEX_BIN:process.execPath,OFFICE_CODEX_ARGS:JSON.stringify([path.join(root,'tests/fake-codex.mjs')]),OFFICE_FIXTURE_SANDBOX_MISSING:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;if(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'fourteenth-sandbox-'))await rm(temp,{recursive:true,force:true});});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'Startup timeout')),10000);child.stdout.on('data',data=>{if(String(data).includes('Fourteenth office')){clearTimeout(timer);resolve();}});});
  const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
  const req=async(route,body)=>{const response=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
  assert.equal((await req('/connect',{})).data.sandboxStatus,'notConfigured');
  const room=(await req('/rooms',{name:'Sandbox check',path:temp,demo:false})).data.room;
  const dispatch=await req(`/rooms/${room.id}/dispatch`,{prompt:'Implement the fixture task'});
  assert.equal(dispatch.status,409);assert.match(dispatch.data.error,/Set up Windows sandbox/);
  const current=async()=>(await req('/state')).data.rooms.find(r=>r.id===room.id);
  const blocked=await current();assert.equal(blocked.agents[0].threadId,undefined);assert.equal(blocked.workItems[0].status,'blocked');
  assert.equal((await req('/sandbox/setup',{})).status,200);
  for(let i=0;i<40;i++){if((await req('/state')).data.connection.sandboxStatus==='ready')break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal((await req('/state')).data.connection.sandboxStatus,'ready');
  assert.equal((await req(`/rooms/${room.id}/agents/${room.agents[0].id}/message`,{message:'Continue the assigned ticket'})).status,200);
  const resumed=await current();assert.equal(resumed.workItems.length,1);assert.equal(resumed.workItems[0].id,blocked.workItems[0].id);assert.equal(resumed.workItems[0].status,'working');assert.ok(resumed.agents[0].turnId);
});
