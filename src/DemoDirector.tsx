import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Pause, Play, RotateCcw, X } from 'lucide-react';
import type { Room } from './types';
import { officeApi } from './Operations';
import { agentLine } from './identity';
import './demo-director.css';

const scenes = [
  { title: 'Project search', copy: 'The manager assigns research, implementation, and review.', seconds: 7 },
  { title: 'Team activity', copy: 'Research findings are shared directly with the test author.', seconds: 13 },
  { title: 'Review waiting', copy: 'Review is waiting for implementation to finish Search.tsx.', seconds: 14 },
  { title: 'Manager replaced', copy: 'Astra continues from Sol’s saved task, files, and failed test.', seconds: 10 },
  { title: 'Changes ready for review', copy: 'The diff and passing checks are attached. Review starts.', seconds: 10 },
  { title: 'Review complete', copy: 'Open the changes, test results, or working sample.', seconds: 0 },
];

export function DemoDirector({room,onRoom,onShot,onClose,onEvidence,connected}:{connected:boolean;room:Room;onRoom:(id:string)=>void;onShot:(step:number|null)=>void;onClose:()=>void;onEvidence:()=>void}) {
  const [id,setId]=useState<string|null>(null);
  const [playing,setPlaying]=useState(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [elapsed,setElapsed]=useState(0),[run,setRun]=useState(0);
  const pending=useRef(false),alive=useRef(true),advancedStep=useRef<number|null>(null);
  const step=room.id===id?room.demoStep ?? 0:0;
  const scene=scenes[step] || scenes[0];
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;onShot(null);};},[]);
  useEffect(()=>{
    let cancelled=false;advancedStep.current=null;setBusy(true);setError('');setId(null);
    officeApi('/demo',{}).then(result=>{if(!cancelled){setId(result.room.id);onRoom(result.room.id);setElapsed(0);}}).catch(e=>{if(!cancelled)setError(e.message);}).finally(()=>{if(!cancelled)setBusy(false);});
    return()=>{cancelled=true;};
  },[run]);
  useEffect(()=>{advancedStep.current=null;setElapsed(0);if(id && room.id===id)onShot(step);},[step,id,room.id]);
  async function next(){
    if(!id || pending.current || busy || step>=5 || advancedStep.current===step)return;
    pending.current=true;advancedStep.current=step;setBusy(true);setError('');
    try{await officeApi(`/rooms/${id}/demo/step`,{});}
    catch(e){advancedStep.current=null;if(alive.current){setError((e as Error).message);setPlaying(false);}}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{
    if(!playing || !connected || busy || !id || room.id!==id || step>=5)return;
    const timer=setInterval(()=>setElapsed(value=>value+.1),100);
    return()=>clearInterval(timer);
  },[playing,connected,busy,id,room.id,step]);
  useEffect(()=>{if(playing && connected && scene.seconds && elapsed>=scene.seconds)void next();},[elapsed]);
  const verified=room.id===id?room.workItems.filter(item=>item.status==='done').length:0;
  const peer=room.id===id?room.messages.find(message=>message.kind==='finding' && message.fromId && message.toId):undefined;
  const peerFrom=peer?room.agents.find(agent=>agent.id===peer.fromId):undefined;
  const peerTo=peer?room.agents.find(agent=>agent.id===peer.toId):undefined;
  const receipts=room.id===id?room.workItems.reduce((sum,item)=>sum+item.evidence.length,0):0;
  return <section className="demo-director" aria-label="Office workflow demo">
    <header className="demo-header"><span>Project search <small>Demo · simulated activity</small></span><button autoFocus onClick={onClose} aria-label="Exit cinematic demo"><X size={16}/></button></header>
    <div className="demo-dock">
      <div className="demo-chapters" aria-label={`Step ${step+1} of ${scenes.length}`}>{scenes.map((s,i)=><span key={s.title} className={i<step?'past':i===step?'current':''}><i style={{width:i<step?'100%':i===step?`${step===5?100:Math.min(100,elapsed/scene.seconds*100)}%`:'0%'}}/></span>)}</div>
      <div className="demo-dock-row">
        <div className="demo-caption" aria-live="polite"><h2>{scene.title}</h2><p>{scene.copy}</p>
          {peer && step===1 && <p className="demo-detail">{peerFrom?agentLine(peerFrom):peer.from} → {peerTo?agentLine(peerTo):peer.to}: {peer.text.replace(/^Demo finding: /,'')}</p>}
          {step===2 && room.demoGate?.rejected && <p className="demo-detail demo-blocked">Completion blocked: diff, passing tests, and a screenshot are still missing.</p>}
          {step===5 && <p className="demo-detail">{verified}/{room.workItems.length} tickets verified · {receipts} evidence receipts</p>}
        </div>
        <div className="demo-transport"><span className="demo-counter">{step+1} / {scenes.length}</span>
          {step<5?<><button onClick={()=>setPlaying(value=>!value)} aria-label={playing?'Pause cinematic demo':'Play cinematic demo'}>{playing?<Pause size={16}/>:<Play size={16}/>}</button><button disabled={busy || !id || !connected} onClick={next}>Next <ArrowRight size={15}/></button></>:<><button disabled={busy} onClick={()=>{setRun(value=>value+1);setPlaying(true);}} aria-label="Restart cinematic demo"><RotateCcw size={15}/></button><button onClick={onEvidence}>View changes <ArrowRight size={15}/></button></>}
        </div>
      </div>
      {(!connected || busy) && <p className="demo-status" role="status">{!connected?'Connection lost · playback paused':'Loading…'}</p>}
      {error && <p className="demo-error" role="alert">{error}<button onClick={()=>setRun(value=>value+1)}>Retry demo</button></p>}
    </div>
  </section>;
}
