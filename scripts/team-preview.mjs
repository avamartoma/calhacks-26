// Isolated UI/integration fixture. No model calls, real accounts, or user projects.
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('.'),children=[];
async function start(port,name){
  const dir=path.join(root,'.office','team-preview',name);await mkdir(dir,{recursive:true});
  const child=spawn(process.execPath,['server/index.mjs','--production'],{cwd:root,env:{...process.env,PORT:String(port),OFFICE_TEAM_PORT:String(port+100),OFFICE_TEST_AGENTS:'1',OFFICE_DATA_DIR:dir,OFFICE_CODEX_HOME:path.join(dir,'codex'),OFFICE_CODEX_BIN:process.execPath,OFFICE_CODEX_ARGS:JSON.stringify([path.join(root,'tests/fake-codex.mjs')])},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.stderr.pipe(process.stderr);
  await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(String(d).includes('Fourteenth office'))resolve();});child.once('exit',()=>reject(new Error('Preview stopped')));});
  const base=`http://127.0.0.1:${port}`,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
  async function req(route,body){const res=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await res.json();if(!res.ok)throw new Error(data.error);return data;}
  await req('/connect',{});
  let room=(await req('/state')).rooms.find(r=>!r.demo);
  if(!room){room=(await req('/rooms',{name:`Search · ${name} test office`,path:dir,demo:false})).room;
    for(const title of name==='Alex'?['Build search interface','Review keyboard navigation']:['Implement search endpoint','Review response contract']){
      const {item}=await req(`/rooms/${room.id}/work`,{title,description:title,files:['src/search.ts'],acceptanceCriteria:['Report implementation findings']});
      await req(`/rooms/${room.id}/work/${item.id}/assign`,{role:'Research'});
    }
  }
  const current=(await req('/state')).rooms.find(r=>r.id===room.id);
  for(const worker of current.agents.filter(a=>!a.manager && a.status==='paused'))await req(`/rooms/${room.id}/agents/${worker.id}/message`,{message:'Continue the isolated UI test fixture.'});
  console.log(`${name} integration fixture: ${base}`);return {req,room,base};
}
await start(4351,'Alex');await start(4352,'Blair');
console.log('Open Team to pair these two test offices. Agent output uses the test adapter.');
process.on('SIGINT',()=>{children.forEach(child=>child.kill());process.exit(0);});
