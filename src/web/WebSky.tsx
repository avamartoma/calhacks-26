import { useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useQuery } from 'convex/react';
import { Cloud, Plus, X } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import { AccountBadge } from '../AccountBadge';
import { SkyView, type SkyProject } from '../sky/SkyView';
import { seedOf } from '../sky/sky-math';
import { ConnectionsPanel } from './Connections';
import { GithubRepos } from './GithubRepos';
import { NewProject } from './NewProject';

export type SkyRow = NonNullable<ReturnType<typeof useSkyRows>>[number];
export const useSkyRows = () => useQuery(api.projects.sky, {});

const roles = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor' } as const;
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
  const [accountsOpen, setAccountsOpen] = useState(false);
  const projects = useMemo<SkyProject[]>(() => {
    let mine = 0, shared = 0;
    return (rows || []).map(row => {
      const index = row.mine ? mine++ : shared++;
      const angle = row.mine ? index * 2.4 : index * 2.399963 + .6;
      const radius = row.mine ? 80 * Math.sqrt(index) : 420 + 230 * Math.sqrt(index);
      const seed = seedOf(row.id);
      return {
        // Everything on your web sky is a project you can view, so every cloud opens.
        id: row.id, name: row.name, description: describe(row), mine: row.mine, enterable: true, owner: row.owner?.split('@')[0],
        agents: row.runs.map(run => ({ role: roles[run.agent], status: agentStatus(run.status) })),
        x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * (row.mine ? .8 : .6), depth: row.mine ? 1 : .45 + .35 * seed, seed,
      };
    });
  }, [rows]);
  const account = user ? { sub: user.sub || '', label: user.name || user.email || 'You', email: user.email, picture: user.picture } : null;
  const githubLogin = !!user?.sub?.startsWith('github|');
  // Signing in with GitHub the first time offers your repos once; New project always has them.
  const offerKey = `opencloud-github-offered:${user?.sub}`;
  const [offer, setOffer] = useState(() => githubLogin && !localStorage.getItem(offerKey));
  const closeOffer = () => { localStorage.setItem(offerKey, '1'); setOffer(false); };
  return <div className={`app quiet-office opencloud web-office sky-shell ${account ? 'has-account' : ''}`}>
    <main className="workspace">
      <div className="opencloud-actions">
        <button className="sky-return" aria-pressed={accountsOpen} onClick={() => setAccountsOpen(open => !open)}>Accounts</button>
        <button className="sky-return" onClick={() => setCreating(true)}><Plus size={16} /> New project</button>
      </div>
      <div className="world">
        {account && <AccountBadge account={account} onSignOut={() => void logout({ logoutParams: { returnTo: window.location.origin } })} />}
        {rows && <SkyView projects={projects} onEnter={id => go(`/project/${encodeURIComponent(id)}`)} />}
        {rows && !rows.length && !creating && !offer && <div className="sky-hint"><Cloud size={16} /><span>No projects yet. Upload a folder or link a GitHub repo to start.</span><button className="primary" onClick={() => setCreating(true)}>New project</button></div>}
        {creating && <NewProject githubLogin={githubLogin} onClose={() => setCreating(false)} onCreated={id => go(`/project/${encodeURIComponent(id)}`)} />}
        {offer && !creating && <aside className="web-panel github-offer" aria-label="Add your GitHub repos">
          <header><h2>Add your GitHub repos</h2><button className="icon-button" aria-label="Not now" onClick={closeOffer}><X size={16} /></button></header>
          <GithubRepos githubLogin onAdded={closeOffer} />
          <button className="text-button" onClick={closeOffer}>Not now</button>
        </aside>}
        {accountsOpen && <ConnectionsPanel onClose={() => setAccountsOpen(false)} />}
      </div>
    </main>
  </div>;
}
