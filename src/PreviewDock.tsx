import type { SandboxState } from './types';

const labels = { starting: 'Starting', live: 'Live', error: 'Error' };

export function PreviewDock({ sandbox }: { sandbox?: SandboxState }) {
  const status = sandbox?.status ?? 'starting';
  return (
    <aside className="preview-dock" aria-label="Live preview">
      <header>
        <b>Live preview</b>
        <span className={`preview-status preview-${status}`}>{labels[status]}</span>
      </header>
      {status === 'live' && sandbox?.previewUrl
        ? <iframe title="Live preview" src={sandbox.previewUrl} />
        : <p>{sandbox?.detail || 'Opening the cloud environment…'}</p>}
    </aside>
  );
}
