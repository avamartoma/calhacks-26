import type { CloudPreview } from './types';

const labels = { starting: 'Starting', live: 'Live', error: 'Error' };

export function PreviewDock({ cloud }: { cloud?: CloudPreview }) {
  const status = cloud?.status ?? 'starting';
  return (
    <aside className="preview-dock" aria-label="Live preview">
      <header>
        <b>Live preview</b>
        <span className={`preview-status preview-${status}`}>{labels[status]}</span>
      </header>
      {status === 'live' && cloud?.previewUrl
        ? <iframe title="Live preview" src={cloud.previewUrl} />
        : <p>{cloud?.detail || 'Opening the cloud environment…'}</p>}
    </aside>
  );
}
