import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { queueHandoff } from './peer-handoffs.mjs';

const id = z.string().min(1).max(100);
const short = z.string().max(300);
const agentSchema = z.object({ id, name:short, role:short, model:short, task:z.string().max(500), status:z.enum(['idle','working','talking','approval','done','paused','error','ejected']), manager:z.boolean(), provider:z.literal('cursor').optional(), color:z.string().regex(/^#[0-9a-f]{6}$/i), replaces:id.optional(), replacedBy:id.optional() });
const officeSchema = z.object({ id, name:short, owner:z.string().trim().min(1).max(60), paused:z.boolean(), agents:z.array(agentSchema).max(100), workItems:z.array(z.object({id,title:short,status:z.enum(['queued','working','blocked','review','done']),agentId:id.nullable(),files:z.array(z.string().max(500)).max(20),blocker:z.string().max(500),receiptCount:z.number().int().min(0)})).max(100) });
const messageSchema = z.object({ id, fromId:id, toId:id, from:short, to:short, text:z.string().min(1).max(6000), kind:z.enum(['finding','question','answer']), time:z.number(), workItemId:id.optional(), replyTo:id.optional(), fromOfficeId:id, toOfficeId:id, sentByOwner:z.boolean().optional() });
const ackSchema = z.object({id,toId:id,to:short,status:z.enum(['queued','delivered','acknowledged']),acknowledgement:z.string().max(2000).optional(),disposition:z.enum(['applied','investigate','not-applicable']).optional(),evidenceLinks:z.array(z.object({workItemId:id,receiptId:id})).max(8).optional(),deliveryError:z.string().max(500).optional()});
const packetSchema = z.object({office:officeSchema,messages:z.array(messageSchema).max(200),acks:z.array(ackSchema).max(200)});
const secret = () => randomBytes(32).toString('hex');
const equal = (a,b) => typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));

export function peerOrigin(value) {
  const url=new URL(value);
  const host=url.hostname;
  const privateHost=host==='localhost' || (isIP(host)===4 && (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)));
  if(url.username || url.password || url.pathname!=='/' || url.search || url.hash || !(url.protocol==='https:' || (url.protocol==='http:' && privateHost)))throw new Error('Use an HTTPS origin or a private-network HTTP address.');
  return url.origin;
}

// Only this allowlist crosses the connection. Paths, account details, logs,
// diffs, approval requests, thread IDs and execution controls remain local.
export function sharedOffice(room,owner) {
  return officeSchema.parse({id:room.id,name:room.name,owner,paused:room.paused,agents:room.agents.slice(-100).map(a=>({id:a.id,name:a.name,role:a.role,model:a.effectiveModel || a.model,task:a.task.slice(0,500),status:a.status,manager:!!a.manager,provider:a.provider,color:/^#[0-9a-f]{6}$/i.test(a.color)?a.color:'#86afa0',replaces:a.replaces,replacedBy:a.replacedBy})),workItems:room.workItems.filter(t=>!t.archived).slice(-100).map(t=>({id:t.id,title:t.title.slice(0,300),status:t.status,agentId:t.agentId,files:(t.files || []).slice(0,20),blocker:(t.blocker || '').slice(0,500),receiptCount:t.evidence.length}))});
}

export async function createTeam({state,dataDir,port,changed,persist,onReceive}) {
  const file=path.join(dataDir,'team-links.json');
  let links=[],pendingJoins={};
  try { const stored=JSON.parse(await readFile(file,'utf8'));links=stored.links || [];pendingJoins=stored.pendingJoins || {}; } catch(e) {if(e.code!=='ENOENT')throw e;}
  const invites=new Map(); let listener; let writes=Promise.resolve(); let syncing=false;
  const localRoom=link=>state.rooms.find(r=>r.id===link.roomId && !r.archived);
  const save=()=>{const content=JSON.stringify({links,pendingJoins});writes=writes.catch(()=>{}).then(async()=>{await writeFile(file+'.tmp',content,{mode:0o600});await rename(file+'.tmp',file);});return writes;};
  const linkFor=room=>links.find(l=>l.roomId===room.id);
  const addresses=()=>[...new Set(Object.values(networkInterfaces()).flat().filter(n=>n && n.family==='IPv4' && !n.internal).map(n=>`http://${n.address}:${port}`)),`http://127.0.0.1:${port}`];
  function view(room) {
    const link=linkFor(room); if(!link)return null;
    const remote=link.remote;
    const overlaps=[];
    if(remote)for(const task of room.workItems.filter(t=>!t.archived && t.status!=='done'))for(const peer of remote.workItems.filter(t=>t.status!=='done')) {
      const normalize=p=>p.replaceAll('\\','/').replace(/^\.\//,'').toLowerCase();
      const files=(task.files || []).filter(f=>peer.files.some(p=>normalize(p)===normalize(f)));
      if(files.length)overlaps.push({localTaskId:task.id,localTitle:task.title,remoteTaskId:peer.id,remoteTitle:peer.title,files});
    }
    return {owner:link.owner,connected:!!link.lastSeen && Date.now()-link.lastSeen<10000,lastSeen:link.lastSeen || null,error:link.error || null,remote:remote || null,overlaps};
  }
  function packet(link) {
    const room=localRoom(link); if(!room)throw new Error('Office is unavailable.');
    return {office:sharedOffice(room,link.owner),messages:room.messages.filter(m=>m.fromOfficeId===room.id && m.toOfficeId===link.remote?.id && m.status!=='acknowledged').slice(-200).map(m=>messageSchema.parse(m)),acks:room.messages.filter(m=>m.fromOfficeId===link.remote?.id && m.toOfficeId===room.id).slice(-200).map(m=>ackSchema.parse(m))};
  }
  async function accept(link,raw) {
    if(!links.includes(link))throw new Error('Connection was disconnected.');
    const incoming=packetSchema.parse(raw),room=localRoom(link);
    if(!room)throw new Error('Office is unavailable.');
    if(link.remote && incoming.office.id!==link.remote.id)throw new Error('This connection belongs to another office.');
    if(state.rooms.some(r=>r.id===incoming.office.id))throw new Error('Connect a different Fourteenth instance.');
    link.remote=incoming.office; link.lastSeen=Date.now();delete link.error;
    for(const data of incoming.messages) {
      if(data.fromOfficeId!==incoming.office.id || data.toOfficeId!==room.id || !incoming.office.agents.some(a=>a.id===data.fromId))continue;
      let message=room.messages.find(m=>m.id===data.id);
      if(message)continue; // Idempotent transport; local delivery state is authoritative.
      if(room.messages.filter(m=>m.status!=='acknowledged').length>=200)throw new Error('Recipient inbox is full.');
      let target=room.agents.find(a=>a.id===data.toId);
      const visited=new Set();
      while(target?.replacedBy && !visited.has(target.id)){visited.add(target.id);target=room.agents.find(a=>a.id===target.replacedBy);}
      message={...data,from:incoming.office.agents.find(a=>a.id===data.fromId).name,fromOwner:incoming.office.owner,toOwner:link.owner,status:'queued',receivedAt:Date.now()};
      if(target && target.status!=='ejected' && target.provider!=='cursor') {
        message.originalToId=data.toId;message.toId=target.id;message.to=target.name;room.messages.push(message);
        await onReceive(room,target,message);
      } else {message.deliveryError='Recipient is unavailable. Choose a current teammate agent.';room.messages.push(message);}
    }
    for(const ack of incoming.acks) {
      const message=room.messages.find(m=>m.id===ack.id && m.fromOfficeId===room.id && m.toOfficeId===incoming.office.id);
      if(!message)continue;
      const recipient=incoming.office.agents.find(a=>a.id===ack.toId);
      if(!recipient)continue;
      // A recipient may be replaced, but its acknowledged state cannot regress.
      if(message.status==='acknowledged' && ack.status!=='acknowledged')continue;
      const activity=message.status!==ack.status || message.toId!==ack.toId || message.acknowledgement!==ack.acknowledgement || !message.receivedAt;
      Object.assign(message,ack,{to:recipient.name,remoteEvidence:true});
      if(activity)message.receivedAt=Date.now();
    }
    await persist();await save();changed();
  }
  const transport=express();transport.disable('x-powered-by');
  transport.use((req,res,next)=>{if(req.headers.origin)return res.status(403).json({error:'Use the local Fourteenth app to pair.'});next();});
  transport.use(express.json({limit:'2mb'}));
  const endpoint=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){res.status(403).json({error:e instanceof z.ZodError?'Invalid office packet.':e.message});}};
  transport.post('/pair',endpoint(async req=>{
    const body=z.object({invitation:id,clientId:id,packet:packetSchema}).parse(req.body);
    const invite=invites.get(body.invitation);
    if(!invite || invite.expiresAt<Date.now())throw new Error('Invitation expired. Create a new invitation.');
    if(invite.clientId && invite.clientId!==body.clientId)throw new Error('Invitation already used.');
    let link=links.find(l=>l.roomId===invite.roomId);
    if(link && link.clientId!==body.clientId)throw new Error('This office already has a teammate.');
    if(state.rooms.some(r=>r.id===body.packet.office.id))throw new Error('Connect a different Fourteenth instance.');
    if(!link){link={roomId:invite.roomId,owner:invite.owner,token:secret(),clientId:body.clientId,host:true};links.push(link);}
    invite.clientId=body.clientId;
    await accept(link,body.packet);
    return {token:link.token,packet:packet(link)};
  }));
  transport.post('/exchange',endpoint(async req=>{
    const token=req.headers.authorization?.replace(/^Bearer /,'');
    const link=links.find(l=>l.host && equal(l.token,token));
    if(!link)throw new Error('Connection revoked or unknown.');
    await accept(link,req.body);return packet(link);
  }));
  transport.post('/leave',endpoint(async req=>{
    const token=req.headers.authorization?.replace(/^Bearer /,'');
    const link=links.find(l=>l.host && equal(l.token,token));
    if(!link)throw new Error('Connection revoked or unknown.');
    links=links.filter(l=>l!==link);await save();changed();return {ok:true};
  }));
  async function listen() {
    if(listener)return;
    await new Promise((resolve,reject)=>{const server=transport.listen(port,'0.0.0.0',()=>{listener=server;resolve();});server.once('error',reject);});
  }
  async function request(origin,route,body,token) {
    const response=await fetch(origin+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    if(Number(response.headers.get('content-length'))>2e6)throw new Error('Office response is too large.');
    const reader=response.body.getReader();let size=0;const parts=[];
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2e6){await reader.cancel();throw new Error('Office response is too large.');}parts.push(Buffer.from(value));}
    const data=JSON.parse(Buffer.concat(parts).toString());if(!response.ok)throw new Error(data.error || 'Teammate is unavailable.');return data;
  }
  async function sync() {
    if(syncing)return;syncing=true;
    try {await Promise.all(links.filter(l=>!l.host && localRoom(l)).map(async link=>{
      try {await persist();await accept(link,await request(link.origin,'/exchange',packet(link),link.token));}
      catch(e){link.error=e.message==='fetch failed'?'Teammate is offline. Messages stay queued.':e.message;changed();}
    }));} finally {syncing=false;}
  }
  const timer=setInterval(()=>{sync();if(links.some(l=>l.host))changed();},2000);timer.unref();
  if(links.some(l=>l.host))await listen();
  return {
    view, addresses,
    async invite(room,body) {
      if(room.demo)throw new Error('Choose a live project before inviting a teammate.');
      if(linkFor(room))throw new Error('Disconnect the current teammate first.');
      const {owner,address}=z.object({owner:z.string().trim().min(1).max(60),address:z.string()}).parse(body);
      const origin=peerOrigin(address);if(!addresses().includes(origin))throw new Error('Choose this computer’s sharing address.');
      await listen();for(const [key,value] of invites)if(value.roomId===room.id || value.expiresAt<Date.now())invites.delete(key);
      const invitation=secret(),expiresAt=Date.now()+600000;invites.set(invitation,{roomId:room.id,owner,expiresAt});
      return {code:Buffer.from(JSON.stringify({v:1,origin,invitation,expiresAt})).toString('base64url'),expiresAt};
    },
    async join(room,body) {
      if(room.demo)throw new Error('Choose a live project before joining a teammate.');
      if(linkFor(room))throw new Error('Disconnect the current teammate first.');
      const {owner,code}=z.object({owner:z.string().trim().min(1).max(60),code:z.string().trim().max(3000)}).parse(body);
      let invite;try{invite=z.object({v:z.literal(1),origin:z.string(),invitation:id,expiresAt:z.number()}).parse(JSON.parse(Buffer.from(code,'base64url').toString()));}catch{throw new Error('Paste a Fourteenth invitation code.');}
      if(invite.expiresAt<Date.now())throw new Error('Invitation expired. Ask for a new one.');
      const origin=peerOrigin(invite.origin);
      const pending=pendingJoins[room.id];
      const clientId=pending?.invitation===invite.invitation?pending.clientId:secret();
      pendingJoins[room.id]={invitation:invite.invitation,clientId};await save();
      const response=await request(origin,'/pair',{invitation:invite.invitation,clientId,packet:{office:sharedOffice(room,owner),messages:[],acks:[]}});
      if(pendingJoins[room.id]?.clientId!==clientId)throw new Error('Pairing was cancelled.');
      const token=z.string().length(64).parse(response.token),remote=packetSchema.parse(response.packet).office;
      const link={roomId:room.id,owner,origin,clientId,token,host:false,remote};links.push(link);
      try {await accept(link,response.packet);delete pendingJoins[room.id];await save();return view(room);}
      catch(e){links=links.filter(l=>l!==link);await save();throw e;}
    },
    async disconnect(room) {
      const link=linkFor(room);links=links.filter(l=>l.roomId!==room.id);delete pendingJoins[room.id];
      for(const [key,value] of invites)if(value.roomId===room.id)invites.delete(key);
      await save();changed();
      if(link && !link.host)try{await request(link.origin,'/leave',{},link.token);}catch{}
      return {ok:true};
    },
    queue(room,sender,args) {
      const link=linkFor(room),remote=link?.remote;
      if(!remote?.agents.some(a=>a.id===args.agentId))return null;
      // Reuse local bounds and reply validation against a temporary shared view.
      const combined={...room,agents:[...room.agents,...remote.agents],workItems:[...room.workItems,...remote.workItems],messages:room.messages};
      const message=queueHandoff(combined,sender,args);room.messages=combined.messages;
      Object.assign(message,{fromOfficeId:room.id,toOfficeId:remote.id,fromOwner:link.owner,toOwner:remote.owner});changed();return message;
    },
    close(){clearInterval(timer);listener?.close();},
  };
}
