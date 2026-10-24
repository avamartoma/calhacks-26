import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {openInBrowser} from '../server/codex.mjs';

test('only https sign-in pages are ever opened in a browser', async () => {
  assert.equal(await openInBrowser('http://example.invalid/login'), false);
  assert.equal(await openInBrowser('file:///etc/passwd'), false);
  assert.equal(await openInBrowser('javascript:alert(1)'), false);
});

test('one sign-in request takes a signed-out office to a connected account', {timeout:20000}, async t => {
  const root=path.resolve('.'),temp=await mkdtemp(path.join(os.tmpdir(),'iteration1-sign-in-'));
  const base='http://127.0.0.1:44336';
  const child=spawn(process.execPath,['server/index.mjs','--production'],{cwd:root,env:{...process.env,PORT:'44336',OFFICE_DATA_DIR:temp,OFFICE_CODEX_HOME:path.join(temp,'codex'),OFFICE_CODEX_BIN:process.execPath,OFFICE_CODEX_ARGS:JSON.stringify([path.join(root,'tests/fake-codex.mjs')]),OFFICE_FIXTURE_SIGNED_OUT:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;if(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'iteration1-sign-in-'))await rm(temp,{recursive:true,force:true});});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'Startup timeout')),10000);child.stdout.on('data',data=>{if(String(data).includes('Iteration1 office')){clearTimeout(timer);resolve();}});});
  const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
  const req=async(route,body)=>{const response=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};

  const started=await req('/codex/sign-in',{});
  assert.equal(started.status,200);
  assert.equal(started.data.connected,false);
  assert.equal(started.data.authUrl,'http://127.0.0.1/fixture-sign-in');
  assert.equal(started.data.opened,false,'a non-https page is offered as a link, never opened');
  // The page shows the waiting step until the account arrives, then the account itself.
  let connection=(await req('/state')).data.connection;
  if(!connection.account)assert.equal(connection.signIn?.step,'browser');
  for(let i=0;i<80 && !connection.account;i++){await new Promise(resolve=>setTimeout(resolve,25));connection=(await req('/state')).data.connection;}
  assert.equal(connection.account?.email,'fixture@example.invalid');
  assert.equal(connection.signIn,undefined,'the waiting step clears once signed in');

  const again=await req('/codex/sign-in',{});
  assert.equal(again.data.connected,true,'signing in again when already connected is a no-op');
});
