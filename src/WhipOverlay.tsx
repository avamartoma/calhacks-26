import { useEffect, useRef } from 'react';

export function WhipIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m4 21 4-7 2 1-4 7M9 14C17 9 4 2 14 2c10 0 9 9 3 9-4 0-4-5-1-5" /></svg>;
}

// Original in-app rope animation; no desktop overlay or global input capture.
export function WhipOverlay({ crack }: { crack: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const flash = useRef(0);
  useEffect(() => { if (crack) flash.current = performance.now() + 280; }, [crack]);
  useEffect(() => {
    const element = canvas.current!;
    const ctx = element.getContext('2d')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0, height = 0, frame = 0, inside = false;
    const mouse = { x: 0, y: 0 };
    const nodes = Array.from({ length: 18 }, () => ({ x: 0, y: 0, px: 0, py: 0 }));
    const resize = () => {
      const r = element.getBoundingClientRect(); width = r.width; height = r.height;
      const ratio = Math.min(devicePixelRatio, 2); element.width = width * ratio; element.height = height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const move = (e: PointerEvent) => {
      const r = element.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
      const wasInside = inside;
      inside = mouse.x >= 0 && mouse.x <= width && mouse.y >= 0 && mouse.y <= height && (e.target as HTMLElement).tagName === 'CANVAS';
      if (!wasInside && inside) nodes.forEach((n,i) => { n.x=n.px=mouse.x+i*7; n.y=n.py=mouse.y+i*5; });
    };
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      if (inside) {
        nodes[0].x=mouse.x; nodes[0].y=mouse.y;
        for (let i=1;i<nodes.length;i++) {
          const n=nodes[i], vx=(n.x-n.px)*.83, vy=(n.y-n.py)*.83; n.px=n.x; n.py=n.y; n.x+=vx; n.y+=vy+.48;
          if (reduced) { n.x=mouse.x+i*5; n.y=mouse.y+i*6; }
        }
        for (let pass=0;pass<6;pass++) for (let i=1;i<nodes.length;i++) {
          const a=nodes[i-1], b=nodes[i], dx=b.x-a.x, dy=b.y-a.y, length=Math.hypot(dx,dy)||1, excess=(length-9)/length;
          if(i>1){a.x+=dx*excess*.5;a.y+=dy*excess*.5;} b.x-=dx*excess*(i===1?1:.5);b.y-=dy*excess*(i===1?1:.5);
        }
        const snapped=flash.current>performance.now();
        ctx.lineCap='round';ctx.lineJoin='round';ctx.shadowColor='#15120f55';ctx.shadowBlur=3;
        for(let i=1;i<nodes.length;i++) { ctx.beginPath();ctx.moveTo(nodes[i-1].x,nodes[i-1].y);ctx.lineTo(nodes[i].x,nodes[i].y);ctx.lineWidth=4.5-i*.2;ctx.strokeStyle=snapped?'#e0ac56':'#6a4026';ctx.stroke(); }
        ctx.shadowBlur=0;
        if(snapped) for(let i=0;i<8;i++){const angle=i*Math.PI/4;ctx.beginPath();ctx.moveTo(mouse.x+Math.cos(angle)*9,mouse.y+Math.sin(angle)*9);ctx.lineTo(mouse.x+Math.cos(angle)*19,mouse.y+Math.sin(angle)*19);ctx.lineWidth=2;ctx.strokeStyle='#f9d386';ctx.stroke();}
      }
      frame=requestAnimationFrame(draw);
    };
    const observer=new ResizeObserver(resize);observer.observe(element);resize();
    window.addEventListener('pointermove',move);frame=requestAnimationFrame(draw);
    return () => { observer.disconnect();window.removeEventListener('pointermove',move);cancelAnimationFrame(frame); };
  }, []);
  return <canvas ref={canvas} className="whip-overlay" aria-hidden="true" />;
}
