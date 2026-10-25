import type { CloudPreview } from './types';

const labels = { starting: 'Starting', live: 'Live', error: 'Error' };

/**
 * The project's live preview from its cloud sandbox. A live preview (or a paused one's last
 * picture) gets the full panel; otherwise it is a small note in the corner. When the cloud
 * backend is not connected, that note says there is no preview, with the reason on hover.
 */
export function PreviewDock({ cloud }: { cloud?: CloudPreview }) {
  const status = cloud?.status ?? 'starting';
  const live = status === 'live' && !!cloud?.previewUrl;
  if (!live && !cloud?.snapshotUrl) {
    const starting = status === 'starting' && !!cloud?.sessionId;
    return <aside className="preview-dock preview-empty" aria-label="Live preview" title={cloud?.detail || undefined}>
      <span className={`preview-dot ${starting ? 'starting' : ''}`} aria-hidden="true" />
      {starting ? 'Starting preview…' : 'No preview to display'}
    </aside>;
  }
  return (
    <aside className="preview-dock" aria-label="Live preview">
      <header>
        <b>Live preview</b>
        <span className={`preview-status preview-${status}`}>{labels[status]}</span>
      </header>
      {live
        ? <iframe key={cloud!.previewUrl} title="Live preview" src={cloud!.previewUrl} />
        : <img alt="Last preview" src={cloud!.snapshotUrl} />}
    </aside>
  );
}
