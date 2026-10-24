import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { Room, Workspace } from './types';
import './workspace-rail.css';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]!.toUpperCase()).join('') || '?';

/**
 * The workspace rail, as in Slack or Discord: one circle per workspace you belong to. Click one
 * to enter it; right-click to rename or remove it. A badge counts agents working there now.
 */
export function WorkspaceRail({ workspaces, current, rooms, busy, onChoose, onCreate, onRename, onRemove }: { workspaces: Workspace[]; current?: Workspace; rooms: Room[]; busy: boolean; onChoose: (id: string) => void; onCreate: (name: string) => void; onRename: (id: string, name: string) => void; onRemove: (id: string) => void }) {
  const [menu, setMenu] = useState<{ id: string; top: number } | null>(null);
  const target = workspaces.find(w => w.id === menu?.id);
  return <nav className="workspace-rail" aria-label="Workspaces" onPointerDown={e => { if (!(e.target as HTMLElement).closest('.rail-menu')) setMenu(null); }}>
    <ul>
      {workspaces.map(w => {
        const working = rooms.filter(r => r.workspaceId === w.id && !r.archived && !r.demo).flatMap(r => r.agents).filter(a => ['working', 'talking', 'approval'].includes(a.status)).length;
        const active = w.id === current?.id;
        return <li key={w.id} className={active ? 'active' : ''}>
          <button aria-current={active ? 'page' : undefined} aria-label={`${w.name}${working ? `, ${working} agent${working === 1 ? '' : 's'} working` : ''}`} title={w.name} style={{ '--workspace-color': w.color } as React.CSSProperties} onClick={() => { setMenu(null); onChoose(w.id); }} onContextMenu={e => { e.preventDefault(); setMenu({ id: w.id, top: e.currentTarget.getBoundingClientRect().top }); }}>
            {initials(w.name)}
            {working > 0 && <span className="rail-badge">{working}</span>}
          </button>
        </li>;
      })}
    </ul>
    {target && menu && <div className="rail-menu" role="menu" style={{ top: menu.top }}>
      <b>{target.name}</b>
      <button role="menuitem" onClick={() => { const name = window.prompt('Workspace name', target.name); if (name?.trim()) onRename(target.id, name.trim()); setMenu(null); }}>Rename</button>
      {workspaces.length > 1 && <button role="menuitem" className="danger" onClick={() => { onRemove(target.id); setMenu(null); }}>Remove (projects move to another workspace)</button>}
    </div>}
    <button className="rail-add" disabled={busy} aria-label="New workspace" title="New workspace" onClick={() => { const name = window.prompt('Name the new workspace'); if (name?.trim()) onCreate(name.trim()); }}><Plus size={18} /></button>
  </nav>;
}
