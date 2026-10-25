import { useState } from 'react';
import { ExternalLink, Maximize2, Minus } from 'lucide-react';
import type { CloudPreview } from './types';

const labels = { starting: 'Starting', live: 'Live', error: 'Error' };
const MINIMIZED = 'opencloud-preview-minimized';

/**
 * The project's live preview from its cloud sandbox. A live preview (or a paused one's last
 * picture) gets the full panel; otherwise it is a small note in the corner. When the cloud
 * backend is not connected, that note says there is no preview, with the reason on hover.
 * The panel can be minimized to a pill (remembered on this browser), and a live preview
 * opened in its own tab.
 */
export function PreviewDock({ cloud }: { cloud?: CloudPreview }) {
  const [minimized, setMinimized] = useState(() => localStorage.getItem(MINIMIZED) === '1');
  const minimize = (value: boolean) => { setMinimized(value); localStorage.setItem(MINIMIZED, value ? '1' : '0'); };
  const status = cloud?.status ?? 'starting';
  const live = status === 'live' && !!cloud?.previewUrl;
  if (!live && !cloud?.snapshotUrl) {
    const starting = status === 'starting' && !!cloud?.sessionId;
    return <aside className="preview-dock preview-empty" aria-label="Live preview" title={cloud?.detail || undefined}>
      <span className={`preview-dot ${starting ? 'starting' : ''}`} aria-hidden="true" />
      {starting ? 'Starting preview…' : 'No preview to display'}
    </aside>;
  }
  const openTab = live && <a className="preview-action" href={cloud!.previewUrl} target="_blank" rel="noopener noreferrer" aria-label="Open the preview in a new tab" title="Open in a new tab"><ExternalLink size={13} /></a>;
  if (minimized) {
    return <aside className="preview-dock preview-empty preview-minimized" aria-label="Live preview">
      <button type="button" className="preview-restore" onClick={() => minimize(false)} title="Show the preview">
        <span className={`preview-dot ${live ? 'live' : ''}`} aria-hidden="true" />
        Live preview · {labels[status]}
        <Maximize2 size={12} aria-hidden="true" />
      </button>
      {openTab}
    </aside>;
  }
  return (
    <aside className="preview-dock" aria-label="Live preview">
      <header>
        <b>Live preview</b>
        <span className="preview-actions">
          <span className={`preview-status preview-${status}`}>{labels[status]}</span>
          {openTab}
          <button type="button" className="preview-action" onClick={() => minimize(true)} aria-label="Minimize the preview" title="Minimize"><Minus size={13} /></button>
        </span>
      </header>
      {live
        ? <iframe key={cloud!.previewUrl} title="Live preview" src={cloud!.previewUrl} />
        : <img alt="Last preview" src={cloud!.snapshotUrl} />}
    </aside>
  );
}
