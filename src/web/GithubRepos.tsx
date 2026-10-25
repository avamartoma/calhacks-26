import { useEffect, useMemo, useState } from 'react';
import { useAction, useMutation } from 'convex/react';
import { LoaderCircle } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { GithubRepo } from '../../convex/github';
import { preselect } from './github-pick';

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');

function ago(iso: string | null) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'updated today';
  if (days < 30) return `updated ${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 365) return `updated ${Math.floor(days / 30)} month${days < 60 ? '' : 's'} ago`;
  return `updated ${Math.floor(days / 365)} year${days < 730 ? '' : 's'} ago`;
}

/**
 * Picks GitHub repos to add to the sky. Signed in with GitHub, it lists your repos straight away;
 * otherwise it asks for a GitHub username first. Only public repos are listed.
 */
export function GithubRepos({ githubLogin, onAdded }: { githubLogin: boolean; onAdded: (ids: string[]) => void }) {
  const list = useAction(api.github.repos);
  const importRepos = useMutation(api.projects.importGithub);
  const [username, setUsername] = useState(() => localStorage.getItem('opencloud-github-username') || '');
  const [loaded, setLoaded] = useState<{ username: string; repos: GithubRepo[] } | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [everyone, setEveryone] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function load(name?: string) {
    setBusy('Loading your repos…'); setError('');
    try {
      const result = await list(name ? { username: name } : {});
      setLoaded(result); setChosen(preselect(result.repos));
      if (name) localStorage.setItem('opencloud-github-username', result.username);
    } catch (e) { setError(message(e)); setLoaded(null); }
    finally { setBusy(''); }
  }
  useEffect(() => { if (githubLogin || username) void load(githubLogin ? undefined : username); }, []);

  const shown = useMemo(() => (loaded?.repos || []).filter(repo => showAll || (!repo.fork && !repo.archived) || chosen.has(repo.id)), [loaded, showAll, chosen]);
  const hidden = (loaded?.repos.length || 0) - shown.length;
  const toggle = (id: number) => setChosen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  async function add() {
    const repos = (loaded?.repos || []).filter(repo => chosen.has(repo.id)).map(repo => ({ id: repo.id, name: repo.name, description: repo.description, cloneUrl: repo.cloneUrl }));
    setBusy(`Adding ${repos.length}…`); setError('');
    try { onAdded(await importRepos({ repos, visibility: everyone ? 'public' : 'private' })); }
    catch (e) { setError(message(e)); }
    finally { setBusy(''); }
  }

  // Not a form: this sits inside the New project form, and forms can't nest.
  if (!githubLogin && !loaded) return <div className="github-user">
    <label>GitHub username<input value={username} onChange={e => setUsername(e.target.value)} placeholder="octocat" autoComplete="off" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (username.trim()) void load(username); } }} /></label>
    <button type="button" className="secondary" disabled={!!busy || !username.trim()} onClick={() => void load(username)}>{busy ? 'Loading…' : 'Show my repos'}</button>
    {error && <p className="web-error" role="alert">{error}</p>}
  </div>;
  if (!loaded) return busy ? <p className="web-note github-loading"><LoaderCircle className="spin" size={14} /> {busy}</p> : error ? <p className="web-error" role="alert">{error}</p> : null;
  return <div className="github-repos">
    <p className="web-note">{loaded.repos.length ? `Public repos for ${loaded.username}. Each one becomes a cloud you can open; nothing runs until you do.` : `${loaded.username} has no public repos yet.`}{!githubLogin && <> <button type="button" className="text-button inline" onClick={() => setLoaded(null)}>Change</button></>}</p>
    <ul>{shown.map(repo => <li key={repo.id}>
      <label className={repo.added ? 'added' : ''}>
        <input type="checkbox" checked={repo.added || chosen.has(repo.id)} disabled={repo.added} onChange={() => toggle(repo.id)} />
        <span><b>{repo.name}</b>{repo.description && <small className="github-description">{repo.description}</small>}<small>{[repo.added ? 'On your sky' : '', repo.language, repo.fork ? 'Fork' : '', repo.archived ? 'Archived' : '', ago(repo.pushedAt)].filter(Boolean).join(' · ')}</small></span>
      </label>
    </li>)}</ul>
    {hidden > 0 && <button type="button" className="text-button" onClick={() => setShowAll(true)}>Show {hidden} fork{hidden === 1 ? '' : 's'} and archived repo{hidden === 1 ? '' : 's'}</button>}
    <label className="web-check github-public"><input type="checkbox" checked={everyone} onChange={e => setEveryone(e.target.checked)} />
      <span>Everyone signed in can see these<small>View only. They'll also see what agents do in them, including the tasks you give.</small></span>
    </label>
    {error && <p className="web-error" role="alert">{error}</p>}
    <button type="button" className="primary" disabled={!!busy || !chosen.size} onClick={() => void add()}>{busy || (chosen.size ? `Add ${chosen.size} to my sky` : 'Choose repos to add')}</button>
  </div>;
}
