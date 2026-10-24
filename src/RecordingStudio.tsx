import { Camera, ArrowRight, Maximize } from 'lucide-react';
import './recording-studio.css';

const stops = ['Entrance','Manager','Team desks','Water cooler'];

export function RecordingStudio({onStop,onClean,unavailable}:{onStop:(stop:number)=>void;onClean:()=>void;unavailable:boolean}) {
  return <section className="recording-studio"><h2>Recording studio</h2><p className="quiet-copy">Choose a camera. Hide controls. Record your screen.</p>
    <div className="tour-stops">{stops.map((name,i)=><button disabled={unavailable} key={name} onClick={()=>onStop(i)}><span>0{i+1}</span><div><b>{name}</b></div><ArrowRight size={16}/></button>)}</div>
    <button className="primary full" disabled={unavailable} onClick={onClean}><Camera size={17}/> Enter clean view <kbd>F</kbd></button>
    <button className="full" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen();}}><Maximize size={17}/> Full screen</button>
    <p className="quiet-copy">Clean view: <b>Alt + 1–4</b> jumps between stops. <b>WASD</b> moves; drag to look. <b>F</b> restores the controls. <b>Esc</b> restores the controls.</p>
    <div className="notice">View controls only; no video is saved.</div>
    {unavailable && <p role="status">3D is unavailable. You can still record the compact map and evidence panels.</p>}
  </section>;
}
