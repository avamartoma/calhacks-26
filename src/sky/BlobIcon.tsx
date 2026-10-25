/** One blob person, drawn as on the clouds: a circle in its type's color with two eyes. */
export function BlobIcon({ color, size = 28, working = false }: { color: string; size?: number; working?: boolean }) {
  return <svg className={`blob-icon ${working ? 'working' : ''}`} width={size} height={size * 45 / 42} viewBox="0 0 42 45" aria-hidden="true">
    <ellipse cx="21" cy="42" rx="12" ry="2.4" fill="#1f284022" />
    <circle cx="21" cy="22" r="19" fill={color} stroke="#ffffffd0" strokeWidth="2" />
    <ellipse cx="15.5" cy="18" rx="4.1" ry="5.1" fill="#f8f8ef" /><ellipse cx="26.5" cy="18" rx="4.1" ry="5.1" fill="#f8f8ef" />
    <ellipse cx="15.9" cy="18.8" rx="1.8" ry="2.4" fill="#34443b" /><ellipse cx="26.9" cy="18.8" rx="1.8" ry="2.4" fill="#34443b" />
  </svg>;
}
