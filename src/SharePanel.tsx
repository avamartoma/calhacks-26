import { useEffect, useState } from 'react';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';

type ShareMember = { email: string; role: string };
type ShareInfo = { name?: string; visibility?: string; shareSlug?: string; role?: string };

type Call = (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;

function officeConvexUrl(): string {
  const env = (import.meta as unknown as { env?: { VITE_CONVEX_URL?: string } }).env;
  const value = env?.VITE_CONVEX_URL?.trim();
  return value || 'http://127.0.0.1:3210';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'The request failed.';
}

function asMembers(value: unknown): ShareMember[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { members?: unknown }).members)
      ? (value as { members: unknown[] }).members
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    const email = typeof record.email === 'string' ? record.email : '';
    const role = typeof record.role === 'string' ? record.role : '';
    if (!email) return [];
    return [{ email, role }];
  });
}

function asShareInfo(value: unknown): ShareInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    visibility: typeof record.visibility === 'string' ? record.visibility : undefined,
    shareSlug: typeof record.shareSlug === 'string' ? record.shareSlug : typeof record.slug === 'string' ? record.slug : undefined,
    role: typeof record.role === 'string' ? record.role : undefined,
  };
}

export function SharePanel({ projectId, shareSlug, projectName }: { projectId?: string; shareSlug?: string; projectName?: string }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');
  const [visibility, setVisibility] = useState<'private' | 'public' | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const slug = shareSlug || info?.shareSlug || '';
  const name = info?.name || projectName || 'Share';

  useEffect(() => {
    const client = new ConvexHttpClient(officeConvexUrl());
    let cancelled = false;
    void (async () => {
      if (shareSlug) {
        try {
          const next = asShareInfo(await (client.query as Call)(anyApi.sharing.get, { slug: shareSlug }));
          if (cancelled) return;
          setInfo(next);
          if (next?.visibility === 'public' || next?.visibility === 'private') setVisibility(next.visibility);
        } catch (err) {
          if (!cancelled) setError(errorMessage(err));
        }
      } else if (projectId) {
        try {
          const project = asShareInfo(await (client.query as Call)(anyApi.projects.get, { projectId }));
          if (cancelled) return;
          if (project) {
            setInfo(project);
            if (project.visibility === 'public' || project.visibility === 'private') setVisibility(project.visibility);
          }
        } catch (err) {
          if (!cancelled) setError(errorMessage(err));
        }
      }
      if (projectId) {
        try {
          const list = asMembers(await (client.query as Call)(anyApi.sharing.list, { projectId }));
          if (!cancelled) setMembers(list);
        } catch (err) {
          if (!cancelled) setError(errorMessage(err));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, shareSlug, version]);

  async function mutate(run: (client: ConvexHttpClient) => Promise<unknown>, ok: string) {
    if (!projectId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const client = new ConvexHttpClient(officeConvexUrl());
      await run(client);
      setNotice(ok);
      setVersion((value) => value + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!slug) return;
    try {
      const origin = window.location.port === '4314' ? 'http://localhost:4316' : window.location.origin;
      await navigator.clipboard.writeText(`${origin}/p/${slug}`);
      setCopied(true);
      setError('');
    } catch {
      setError('Clipboard unavailable.');
    }
  }

  return <section className="share-panel" aria-label="Share">
    <h3>{name}</h3>
    {!projectId && <p>Open a cloud project to share it.</p>}
    <div className="share-row">
      <span>Visibility</span>
      <button type="button" className={visibility === 'private' ? 'on' : 'secondary'} disabled={busy || !projectId} aria-pressed={visibility === 'private'} onClick={() => { setVisibility('private'); void mutate((client) => (client.mutation as Call)(anyApi.sharing.setVisibility, { projectId, visibility: 'private' }), 'Visibility is private.'); }}>Private</button>
      <button type="button" className={visibility === 'public' ? 'on' : 'secondary'} disabled={busy || !projectId} aria-pressed={visibility === 'public'} onClick={() => { setVisibility('public'); void mutate((client) => (client.mutation as Call)(anyApi.sharing.setVisibility, { projectId, visibility: 'public' }), 'Visibility is public.'); }}>Public</button>
    </div>
    {slug ? <p>Slug <code className="share-slug">{slug}</code></p> : <p>The hosted link appears after the share app is deployed.</p>}
    {slug && <div className="share-row"><button type="button" className="secondary" onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy link'}</button></div>}
    <form className="share-row" onSubmit={(event) => {
      event.preventDefault();
      const next = email.trim();
      if (!projectId || !next.includes('@')) return;
      void mutate((client) => (client.mutation as Call)(anyApi.sharing.invite, { projectId, email: next, role }), `Invited ${next} as ${role}.`);
      setEmail('');
    }}>
      <label>Email<input type="email" value={email} required placeholder="name@example.com" onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Role<select value={role} onChange={(event) => setRole(event.target.value === 'editor' ? 'editor' : 'viewer')}><option value="viewer">viewer</option><option value="editor">editor</option></select></label>
      <button type="submit" className="primary" disabled={busy || !projectId}>Invite</button>
    </form>
    <ul className="share-members">
      {members.map((member) => <li key={member.email}><span>{member.email}<small>{member.role || 'member'}</small></span><button type="button" disabled={busy || !projectId} onClick={() => void mutate((client) => (client.mutation as Call)(anyApi.sharing.remove, { projectId, email: member.email }), `Removed ${member.email}.`)}>Remove</button></li>)}
    </ul>
    {error && <p className="share-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
