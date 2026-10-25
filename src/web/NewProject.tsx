import { useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import { FolderUp, Github } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { packFolder, type PackedFolder } from './pack';

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] : 'Something went wrong');
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;

/** A new project from a folder on this computer or from a GitHub repository. */
export function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [source, setSource] = useState<'folder' | 'github'>('folder');
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [packed, setPacked] = useState<PackedFolder | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const uploadUrl = useMutation(api.projects.generateUploadUrl);
  const fromUpload = useMutation(api.projects.createFromUpload);
  const create = useMutation(api.projects.create);

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setError(''); setBusy('Packing…');
    try { const result = await packFolder(files); setPacked(result); if (!name.trim()) setName(result.name); }
    catch (e) { setError(message(e)); setPacked(null); }
    finally { setBusy(''); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      let id: Id<'projects'>;
      if (source === 'folder') {
        if (!packed) throw new Error('Choose a folder first');
        setBusy('Uploading…');
        const response = await fetch(await uploadUrl({}), { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: packed.archive });
        if (!response.ok) throw new Error('The upload failed. Try again.');
        const { storageId } = await response.json() as { storageId: Id<'_storage'> };
        id = await fromUpload({ name: name.trim(), description: '', storageId });
      } else {
        setBusy('Creating…');
        id = await create({ name: name.trim(), repoUrl: repoUrl.trim(), description: '' });
      }
      onCreated(id);
    } catch (e) { setError(message(e)); }
    finally { setBusy(''); }
  }

  return <form className="new-project web-new-project" onSubmit={submit}>
    <h2>New project</h2>
    <div className="web-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={source === 'folder'} onClick={() => setSource('folder')}><FolderUp size={15} /> Upload a folder</button>
      <button type="button" role="tab" aria-selected={source === 'github'} onClick={() => setSource('github')}><Github size={15} /> GitHub repo</button>
    </div>
    {source === 'folder' ? <>
      <input ref={picker} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={e => void pick(e.target.files)} />
      <button type="button" className="secondary" onClick={() => picker.current?.click()} disabled={!!busy}>{packed ? 'Choose a different folder' : 'Choose folder'}</button>
      {packed && <p className="web-note">{packed.files} files, {megabytes(packed.archive.size)} packed{packed.skipped ? ` · ${packed.skipped} left out (dependencies, build output, git, files over 5 MB)` : ''}</p>}
    </> : <label>Repository link<input value={repoUrl} onChange={e => setRepoUrl(e.target.value)} placeholder="https://github.com/you/project" required /></label>}
    <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder="Customer portal" required /></label>
    {error && <p className="web-error" role="alert">{error}</p>}
    <div className="new-project-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!!busy || !name.trim() || (source === 'folder' ? !packed : !repoUrl.trim())}>{busy || 'Create project'}</button></div>
  </form>;
}
