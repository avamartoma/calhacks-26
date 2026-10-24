import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('signed-out mission dispatch preserves the existing room and creates no worker turn', {timeout:20000}, async t=>{
  const root=path.resolve('.'),temp=await mkdtemp(path.join(os.tmpdir(),'fourteenth-preflight-'));
  const base='http://127.0.0.1:44317';
  const child=spawn(process.execPath,['server/index.mjs','--production'],{cwd:root,env:{...process.env,PORT:'44317',OFFICE_DATA_DIR:temp,OFFICE_CODEX_HOME:path.join(temp,'codex'),OFFICE_CODEX_BIN:process.execPath,OFFICE_CODEX_ARGS:JSON.stringify([path.join(root,'tests/fake-codex.mjs')]),OFFICE_FIXTURE_SIGNED_OUT:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;
    if(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'fourteenth-preflight-'))await rm(temp,{recursive:true,force:true});
  });
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(stderr || 'Startup timeout')),10000);
    child.stdout.on('data',data=>{if(String(data).includes('Fourteenth office')){clearTimeout(timer);resolve();}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(stderr || 'Server exited'));});
  });
  const page=await fetch(base),cookie=page.headers.get('set-cookie').split(';')[0];
  const request=async(route,body)=>{
    const response=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  await request('/connect',{});
  const {data:{room}}=await request('/rooms',{name:'Preflight',path:temp,demo:false});
  const rejected=await request(`/rooms/${room.id}/dispatch`,{prompt:'Do not replace the room while signed out',templateId:'feature'});
  assert.equal(rejected.status,409);assert.match(rejected.data.error,/Sign in/);
  const after=(await request('/state')).data.rooms.find(candidate=>candidate.id===room.id);
  assert.equal(after.goal,room.goal);assert.equal(after.paused,room.paused);
  assert.deepEqual(after.workItems,room.workItems);assert.deepEqual(after.agents,room.agents);
  assert.deepEqual(after.timeline,room.timeline);
  const replacement = await request(`/rooms/${room.id}/agents/${room.agents[0].id}/replace`, { model: 'Account default' });
  assert.equal(replacement.status, 409); assert.match(replacement.data.error, /Sign in/);
  const afterReplacement = (await request('/state')).data.rooms.find(candidate=>candidate.id===room.id);
  assert.deepEqual(afterReplacement.agents, after.agents);
  assert.deepEqual(afterReplacement.workItems, after.workItems);
});
