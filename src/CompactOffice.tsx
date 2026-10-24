import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, GitBranch, Layers, Play, ShieldCheck } from 'lucide-react';
import type { Room, OfficeTemplate } from './types';
import { taskLayout } from './task-layout';
import { workColors, workLabels } from './Operations';
import { agentLine, agentSpeech, modelLabel } from './identity';
import './compact-office.css';

export function CompactOffice({ room, templates, selected, historical, busy, onTask, onTemplates, onAdvance, onReplay }: {
  room: Room; templates: OfficeTemplate[]; selected: string | null; historical: boolean; busy: boolean;
  onTask: (id: string) => void; onTemplates: () => void; onAdvance: () => void; onReplay: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [vertical, setVertical] = useState(true);
  const marker = useId().replaceAll(':', '');
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setVertical(entry.contentRect.width < 860));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const visibleWork=useMemo(()=>room.workItems.filter(t=>!t.archived),[room.workItems]);
  const graph = useMemo(() => taskLayout(visibleWork, vertical), [visibleWork, vertical]);
  room={...room,workItems:visibleWork};
  const done = room.workItems.filter(item => item.status === 'done').length;
  const template = templates.find(item => item.id === room.templateId);
  return <section className="compact-office" aria-label="Compact office map">
    <header className="map-heading">
      <div><p className="eyeline">{historical ? 'HISTORICAL OFFICE' : room.demo ? 'SIMULATED OFFICE' : room.paused ? 'PAUSED OFFICE' : 'LIVE OFFICE'} <span> / {template?.name || 'Custom workflow'}</span></p>
        <h1>{room.goal || 'A clear view of the work.'}</h1></div>
      <button className="secondary" onClick={onTemplates}><Layers size={15}/> Templates</button>
    </header>
    <div className="map-summary"><span><ShieldCheck size={15}/><b>{done}/{room.workItems.length}</b> verified</span><span>{room.agents.filter(a => a.status !== 'ejected').length} agents</span><span>{room.workItems.filter(item => item.status === 'blocked' || !!item.blocker).length} waiting</span>
      {room.demoStep != null && !historical && <button disabled={busy} onClick={room.demoStep >= 5 ? onReplay : onAdvance}><Play size={12}/>{room.demoStep >= 5 ? 'Replay demo' : 'Next demo moment'}<ArrowRight size={12}/></button>}
    </div>
    <div className="map-viewport" ref={viewport} tabIndex={0} role="region" aria-label="Task dependency graph. Scroll to explore; select a task to inspect its evidence.">
      {room.workItems.length ? <div className="task-graph" style={{ width: graph.width, height: graph.height }}>
        <svg width={graph.width} height={graph.height} aria-hidden="true"><defs><marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>
          {graph.edges.map(edge => <path key={`${edge.from.id}-${edge.to.id}`} d={edge.d} fill="none" stroke={edge.from.status === 'done' ? '#6e9b86' : '#9ca99e'} strokeWidth="1.5" strokeDasharray={edge.from.status === 'done' ? undefined : '4 4'} markerEnd={`url(#${marker})`}/>)}
        </svg>
        {graph.nodes.map(({ item, x, y }) => {
          const owner = room.agents.find(agent => agent.id === item.agentId);
          const checks = item.checks?.filter(check => check.passed).length || 0;
          return <button key={item.id} className={`graph-task ${selected === item.id ? 'selected' : ''}`} style={{ left: x, top: y }} aria-label={`${item.title}. ${workLabels[item.status]}. ${owner ? agentSpeech(owner) : 'Unassigned'}`} aria-pressed={selected === item.id} onClick={() => onTask(item.id)} disabled={historical}>
            <span className="graph-state" style={{ color: workColors[item.status] }}>{item.status === 'done' ? <Check size={12}/> : <i/>}{workLabels[item.status]}{room.paused && item.status !== 'done' && <small> · Paused</small>}</span>
            <b className="graph-title" title={item.title}>{item.title}</b>
            <span className="graph-owner"><i className="map-sphere" style={{ background: owner?.color || '#b4c5b8' }} aria-hidden="true"><i/><i/></i><span>{agentLine(owner)}<small>{owner ? modelLabel(owner.effectiveModel || owner.model) : 'No model assigned'}</small></span><span className="graph-checks">{checks}/{item.acceptanceCriteria.length}<small>checks</small></span></span>
          </button>;
        })}
      </div> : <div className="map-empty"><GitBranch size={30}/><h2>One goal. A connected team.</h2><p>Choose an office template and assign an outcome. Its tasks and handoffs will appear here.</p><button className="primary" onClick={onTemplates}>Choose a template <ArrowRight size={15}/></button></div>}
    </div>
    <footer className="map-footer"><span><GitBranch size={13}/> Arrows show dependencies</span><span>{historical?'Inspect snapshot evidence in Replay':'Click a task for evidence'}</span>{graph.invalid && <span role="status">Some dependencies need repair.</span>}</footer>
  </section>;
}
