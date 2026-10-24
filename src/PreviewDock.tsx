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
        ? <iframe key={cloud.previewUrl} title="Live preview" src={cloud.previewUrl} />
        : cloud?.snapshotUrl
          ? <img alt="Last preview" src={cloud.snapshotUrl} />
          : <p>{cloud?.detail || 'Opening the cloud environment…'}</p>}
    </aside>
  );
}
