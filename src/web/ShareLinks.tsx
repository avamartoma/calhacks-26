import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Check, Copy, LoaderCircle } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import hosted from '../../hosted.json';
import { localHour, paletteAt } from '../sky/time-of-day';

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');
const rgb = (color: number[]) => `rgb(${color.map(value => Math.round(value * 255)).join(',')})`;
const linkFor = (token: string) => `${hosted.shareOrigin}/join/${token}`;

/** Opening a share or invite link: accept it for the signed-in person, then open the project. */
export function JoinLink({ token, go }: { token: string; go: (path: string) => void }) {
  const preview = useQuery(api.shareLinks.preview, { token });
  const accept = useMutation(api.shareLinks.accept);
  const [error, setError] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (!preview?.valid || started.current) return;
    started.current = true;
    accept({ token }).then(({ projectId }) => go(`/project/${projectId}`)).catch(e => setError(message(e)));
  }, [preview?.valid]);
  const palette = paletteAt(localHour());
  const problem = error || (preview && !preview.valid ? preview.reason : '');
  return <main className="sign-in" style={{ background: `linear-gradient(${rgb(palette.zenith)}, ${rgb(palette.horizon)})` }}>
    <section className="sign-in-card">
      <span className="brand-mark">oc</span>
      {problem ? <>
        <h1>This link doesn't work</h1>
        <p>{problem}</p>
        <button className="primary full" onClick={() => go('/')}>Go to your sky</button>
      </> : <>
        <h1>{preview?.valid ? `Opening ${preview.project}` : 'Opening the project'}</h1>
        <p>{preview?.valid ? `You can ${preview.role === 'editor' ? 'view it and start agents on it' : 'view it and watch its agents'}.` : ''}</p>
        <LoaderCircle className="spin" size={20} />
      </>}
    </section>
  </main>;
}

/** The owner's view and edit links in the Share panel: copy one to share it, or turn it off. */
export function ShareLinkButtons({ projectId }: { projectId: Id<'projects'> }) {
  const links = useQuery(api.shareLinks.list, { projectId });
  const create = useMutation(api.shareLinks.create);
  const revoke = useMutation(api.shareLinks.revoke);
  const [copied, setCopied] = useState<'viewer' | 'editor' | null>(null);
  const [error, setError] = useState('');
  if (!links) return null;
  const copy = async (role: 'viewer' | 'editor') => {
    setError('');
    try {
      const token = links[role]?.token ?? await create({ projectId, role });
      await navigator.clipboard.writeText(linkFor(token));
      setCopied(role); setTimeout(() => setCopied(null), 1500);
    } catch (e) { setError(message(e)); }
  };
  return <div className="web-share-links">
    {(['viewer', 'editor'] as const).map(role => {
      const link = links[role];
      return <div key={role} className="web-share-link">
        <span><b>{role === 'editor' ? 'Edit link' : 'View link'}</b><small>{link ? `On · ${link.joined} ${link.joined === 1 ? 'person has' : 'people have'} joined with it` : 'Off'}</small></span>
        <button className="secondary" onClick={() => void copy(role)}>{copied === role ? <><Check size={14} /> Copied</> : <><Copy size={14} /> {link ? 'Copy' : 'Turn on and copy'}</>}</button>
        {link && <button className="text-button danger" onClick={() => void revoke({ projectId, role })}>Turn off</button>}
      </div>;
    })}
    <p className="web-note">Anyone who opens a link while signed in gets that access. Turning a link off removes the access it gave.</p>
    {error && <p className="web-error" role="alert">{error}</p>}
  </div>;
}
