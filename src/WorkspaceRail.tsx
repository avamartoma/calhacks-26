import { useRef, useState } from 'react';
import { Globe, Plus, Users } from 'lucide-react';
import type { Room, Workspace } from './types';
import './workspace-rail.css';

/** Shrinks a picture to a 128 px square, cropped from the middle, small enough to save with the workspace. */
async function squarePicture(file: File) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height), canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
  bitmap.close();
  const webp = canvas.toDataURL('image/webp', .85);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', .85);
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]!.toUpperCase()).join('') || '?';

/**
 * The workspace rail, as in Slack or Discord: one circle per workspace you belong to. Click one
 * to enter it; right-click to rename or remove it. A badge counts agents working there now.
 * The web app passes shared and public workspaces too: only their creator can change them,
 * `onAdd` replaces the name prompt with its own dialog, and `onMembers` opens a shared one's people.
 */
export function WorkspaceRail({ workspaces, current, rooms, busy, onChoose, onCreate, onRename, onRemove, onPicture, onAdd, onMembers }: { workspaces: Workspace[]; current?: Workspace; rooms: Room[]; busy: boolean; onChoose: (id: string) => void; onCreate: (name: string) => void; onRename: (id: string, name: string) => void; onRemove: (id: string) => void; onPicture: (id: string, image: string | null) => void; onAdd?: () => void; onMembers?: (id: string) => void }) {
  const [menu, setMenu] = useState<{ id: string; top: number } | null>(null);
  const target = workspaces.find(w => w.id === menu?.id);
  const picker = useRef<HTMLInputElement>(null);
  // Without `admin`, as in the local app, every workspace is yours to change.
  const editable = (w: Workspace) => w.kind !== 'public' && w.admin !== false;
  const personal = workspaces.filter(w => (w.kind ?? 'personal') === 'personal');
  const removable = (w: Workspace) => editable(w) && (w.kind === 'shared' || personal.length > 1);
  return <nav className="workspace-rail" aria-label="Workspaces" onPointerDown={e => { if (!(e.target as HTMLElement).closest('.rail-menu')) setMenu(null); }}>
    <ul>
      {workspaces.map(w => {
        const working = rooms.filter(r => r.workspaceId === w.id && !r.archived && !r.demo).flatMap(r => r.agents).filter(a => ['working', 'talking', 'approval'].includes(a.status)).length;
        const active = w.id === current?.id;
        const kind = w.kind === 'public' ? ', public to everyone signed in' : w.kind === 'shared' ? ', shared' : '';
        return <li key={w.id} className={`${active ? 'active' : ''} ${w.kind ? `rail-${w.kind}` : ''}`}>
          <button aria-current={active ? 'page' : undefined} aria-label={`${w.name}${kind}${working ? `, ${working} agent${working === 1 ? '' : 's'} working` : ''}`} title={`${w.name}${kind}`} style={{ '--workspace-color': w.color } as React.CSSProperties} onClick={() => { setMenu(null); onChoose(w.id); }} onContextMenu={e => { e.preventDefault(); if (editable(w) || (w.kind === 'shared' && onMembers)) setMenu({ id: w.id, top: e.currentTarget.getBoundingClientRect().top }); }}>
            {w.image ? <img src={w.image} alt="" /> : w.kind === 'public' ? <Globe size={20} /> : initials(w.name)}
            {w.kind === 'shared' && <span className="rail-shared" aria-hidden="true"><Users size={10} /></span>}
            {working > 0 && <span className="rail-badge">{working}</span>}
          </button>
        </li>;
      })}
    </ul>
    {target && menu && <div className="rail-menu" role="menu" style={{ top: menu.top }}>
      <b>{target.name}</b>
      {target.kind === 'shared' && onMembers && <button role="menuitem" onClick={() => { onMembers(target.id); setMenu(null); }}>{target.admin ? 'Members and permissions…' : 'Members…'}</button>}
      {editable(target) && <>
        <button role="menuitem" onClick={() => { const name = window.prompt('Workspace name', target.name); if (name?.trim()) onRename(target.id, name.trim()); setMenu(null); }}>Rename</button>
        <button role="menuitem" onClick={() => picker.current?.click()}>Change picture…</button>
        {target.image && <button role="menuitem" onClick={() => { onPicture(target.id, null); setMenu(null); }}>Remove picture</button>}
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = '';
          if (!file) return;
          try { onPicture(target.id, await squarePicture(file)); } catch { window.alert('That picture could not be read. Try a PNG or JPEG.'); }
          setMenu(null);
        }} />
        {removable(target) && <button role="menuitem" className="danger" onClick={() => { onRemove(target.id); setMenu(null); }}>{target.kind === 'shared' ? 'Remove (projects go back to their owners)' : 'Remove (projects move to another workspace)'}</button>}
      </>}
    </div>}
    <button className="rail-add" disabled={busy} aria-label="New workspace" title="New workspace" onClick={() => { if (onAdd) { onAdd(); return; } const name = window.prompt('Name the new workspace'); if (name?.trim()) onCreate(name.trim()); }}><Plus size={18} /></button>
  </nav>;
}
