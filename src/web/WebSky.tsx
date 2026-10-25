import { useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useQuery } from 'convex/react';
import { Cloud, KeyRound, Plus } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import { AccountBadge } from '../AccountBadge';
import { SkyView, type SkyProject } from '../sky/SkyView';
import { seedOf } from '../sky/sky-math';
import { KeyPanel } from './KeyPanel';
import { NewProject } from './NewProject';

export type SkyRow = NonNullable<ReturnType<typeof useSkyRows>>[number];
export const useSkyRows = () => useQuery(api.projects.sky, {});

const agentStatus = (status: string) => status === 'starting' || status === 'running' ? 'working' : status === 'error' ? 'error' : 'done';

export function describe(row: SkyRow) {
  const working = row.runs.filter(run => run.status === 'starting' || run.status === 'running').length;
  const agents = working ? `${working} agent${working === 1 ? '' : 's'} working` : row.runs.length ? 'Agents idle' : 'No agents yet';
  const preview = row.session?.previewStatus === 'live' ? 'Preview live' : 'Paused';
  return row.mine ? `${agents} · ${preview}` : `${row.owner ? `${row.owner.split('@')[0]}'s project` : 'Shared with you'} · ${row.role === 'editor' ? 'Can edit' : 'View only'}`;
}

/** The signed-in person's sky: their projects up front, projects shared with them behind. */
export function WebSky({ go }: { go: (path: string) => void }) {
  const rows = useSkyRows();
  const { user, logout } = useAuth0();
  const [creating, setCreating] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const projects = useMemo<SkyProject[]>(() => {
    let mine = 0, shared = 0;
    return (rows || []).map(row => {
      const index = row.mine ? mine++ : shared++;
      const angle = row.mine ? index * 2.4 : index * 2.399963 + .6;
      const radius = row.mine ? 80 * Math.sqrt(index) : 420 + 230 * Math.sqrt(index);
      const seed = seedOf(row.id);
      return {
        id: row.id, name: row.name, description: describe(row), mine: row.mine, owner: row.owner?.split('@')[0],
        agents: row.runs.map(run => ({ role: 'Claude', status: agentStatus(run.status) })),
        x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * (row.mine ? .8 : .6), depth: row.mine ? 1 : .45 + .35 * seed, seed,
      };
    });
  }, [rows]);
  const account = user ? { sub: user.sub || '', label: user.name || user.email || 'You', email: user.email, picture: user.picture } : null;
  return <div className={`app quiet-office opencloud web-office sky-shell ${account ? 'has-account' : ''}`}>
    <main className="workspace">
      <div className="opencloud-actions">
        <button className="sky-return" onClick={() => setCreating(true)}><Plus size={16} /> New project</button>
        <button className="sky-return" aria-pressed={keyOpen} onClick={() => setKeyOpen(open => !open)}><KeyRound size={15} /> Anthropic key</button>
      </div>
      <div className="world">
        {account && <AccountBadge account={account} onSignOut={() => void logout({ logoutParams: { returnTo: window.location.origin } })} />}
        {rows && <SkyView projects={projects} onEnter={id => go(`/project/${encodeURIComponent(id)}`)} />}
        {rows && !rows.length && !creating && <div className="sky-hint"><Cloud size={16} /><span>No projects yet. Upload a folder or link a GitHub repo to start.</span><button className="primary" onClick={() => setCreating(true)}>New project</button></div>}
        {creating && <NewProject onClose={() => setCreating(false)} onCreated={id => go(`/project/${encodeURIComponent(id)}`)} />}
        {keyOpen && <KeyPanel onClose={() => setKeyOpen(false)} />}
      </div>
    </main>
  </div>;
}
