// Read-only rehearsal preflight. Never starts agents or alters saved tickets.
import process from 'node:process';

const args=process.argv.slice(2);
const name=args.includes('--project')?args[args.indexOf('--project')+1]:undefined;
const office=process.env.OFFICE_DEMO_URL || 'http://127.0.0.1:4314';
let failed=false;
function report(ok,label,detail=''){console.log(`${ok?'PASS':'FAIL'} ${label}${detail?`: ${detail}`:''}`);if(!ok)failed=true;}
async function get(url,headers={}){return fetch(url,{headers,signal:AbortSignal.timeout(5000)});}
async function state(base){const response=await get(base);if(!response.ok)throw new Error(`HTTP ${response.status}`);const cookie=response.headers.get('set-cookie')?.split(';')[0];const headers=cookie?{cookie}:{};const res=await get(base+'/api/state',headers);if(!res.ok)throw new Error(`State HTTP ${res.status}`);return {data:await res.json(),headers};}
try{
  const {data,headers}=await state(office);
  report(data.connection.testAgents===false,'Office uses real execution',data.connection.testAgents===undefined?'Restart the companion to expose runtime metadata':office);
  const candidates=data.rooms.filter(r=>!r.demo&&!r.archived&&(!name||r.name.toLowerCase()===name.toLowerCase()));
  const room=candidates.sort((a,b)=>(b.missionStartedAt||0)-(a.missionStartedAt||0)).find(r=>r.workItems.some(t=>!t.archived&&t.status==='done'&&t.previewUrl));
  if(!room)throw new Error(`No verified feature found${name?' in '+name:''}. Use --project NAME.`);
  const ticket=room.workItems.find(t=>t.status==='done'&&t.previewUrl&&!t.archived);
  if(!ticket)throw new Error('The verified feature ticket is archived.');
  report(true,'Verified feature',`${room.name} / ${ticket.title}`);
  report(ticket.evidence.some(e=>e.kind==='diff'&&e.text?.trim()),'Recorded diff');
  report(room.messages.some(m=>m.status==='acknowledged'),'Acknowledged handoff');
  const res=await get(`${office}/api/rooms/${room.id}/work/${ticket.id}/review`,headers);
  if(!res.ok)throw new Error(`Review HTTP ${res.status}`);
  const {review}=await res.json();report(review.current&&review.passing>0&&!review.failing,'Checks match current source',review.label);
  const url=new URL(ticket.previewUrl);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Preflight only checks local feature URLs. Inspect the external preview manually.');
  const feature=await get(url);report(feature.ok,'Feature server',url.href);
  const model=await get(office+'/models/office-shell.glb');report(model.ok&&(model.headers.get('content-type')||'').includes('model'),'3D office asset');
}catch(e){report(false,'Core demo',e.message);}
if(args.includes('--team'))for(const [name,port] of [['Alex',4351],['Blair',4352]]){
  try{const {data}=await state(`http://127.0.0.1:${port}`);const room=data.rooms.find(r=>!r.demo&&!r.archived&&r.team?.remote);report(!!data.connection.testAgents,`${name}: rehearsal disclosure`);report(!!room?.team?.connected,`${name}: paired office`);report(!!room?.team?.overlaps?.length,`${name}: shared file scope`);}
  catch(e){report(false,`${name}: team rehearsal`,e.message);}
}
console.log('Browser checks still required: 3D renders, handoff delivery, feature interaction. This command does not run a model or prove autonomous execution.');
process.exitCode=failed?1:0;
