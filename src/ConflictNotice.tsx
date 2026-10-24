export type CloudConflict = { path: string; at: number };

export function ConflictNotice({ conflicts }: { conflicts?: CloudConflict[] | null }) {
  const items = visibleConflicts(conflicts);
  if (items.length === 0) return null;
  return (
    <aside className="conflict-notice" aria-live="polite" style={{
      margin: '12px 16px',
      padding: '10px 12px',
      maxWidth: 420,
      background: '#fff',
      border: '1px solid #e2c7b8',
      borderRadius: 8,
      color: '#5c3b32',
      font: '12px/1.45 Manrope, sans-serif',
    }}>
      <strong style={{ display: 'block', marginBottom: 4 }}>Cloud edits kept aside</strong>
      <p style={{ margin: '0 0 6px' }}>The remote copy is beside the file as .remote.</p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map(item => <li key={item.path}>{item.path}</li>)}
      </ul>
    </aside>
  );
}

function visibleConflicts(conflicts?: CloudConflict[] | null) {
  const items: CloudConflict[] = [];
  const seen = new Set<string>();
  for (const item of conflicts ?? []) {
    if (!item?.path || seen.has(item.path)) continue;
    seen.add(item.path);
    items.push(item);
  }
  return items;
}
