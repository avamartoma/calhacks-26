// Sky colors for the local time of day, in a Studio Ghibli palette: saturated cerulean days,
// warm gold evenings, rose dawns and deep blue nights. Colors blend smoothly between keyframes.

export type RGB = [number, number, number];
export interface SkyPalette {
  zenith: RGB; horizon: RGB;
  /** Sun by day, moon by night. */
  sun: RGB;
  cloudLight: RGB; cloudShadow: RGB;
  /** 0 by day, 1 at night. */
  stars: number;
  /** Sun position on screen, 0..1 from the left and from the bottom. */
  sunX: number; sunY: number;
  /** Label text and its glow, chosen to read on clouds at this hour. */
  ink: string; glow: string;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

interface Key { hour: number; zenith: string; horizon: string; sun: string; light: string; shadow: string; stars: number }
const keys: Key[] = [
  { hour: 0, zenith: '#0a1430', horizon: '#24325a', sun: '#dfe6ff', light: '#7383ad', shadow: '#2a3456', stars: 1 },
  { hour: 4.5, zenith: '#111d44', horizon: '#3a3f72', sun: '#e6e8ff', light: '#7c86b0', shadow: '#323a62', stars: .9 },
  { hour: 5.75, zenith: '#4a4f96', horizon: '#f2a184', sun: '#ffd2a0', light: '#ffd3b8', shadow: '#8f7aa6', stars: .2 },
  { hour: 7, zenith: '#2f7fd0', horizon: '#b6e0f2', sun: '#fff1d6', light: '#fffaf2', shadow: '#b4c6df', stars: 0 },
  { hour: 12, zenith: '#1b64c4', horizon: '#86cde6', sun: '#fffbe8', light: '#ffffff', shadow: '#b6c8de', stars: 0 },
  { hour: 16.5, zenith: '#2170c8', horizon: '#9fd6ec', sun: '#fff3dc', light: '#fffaf1', shadow: '#b3c2da', stars: 0 },
  // Sunset after the references: purple overhead, orange low, gold-lit tops on mauve clouds.
  { hour: 18.4, zenith: '#5b5296', horizon: '#f6884a', sun: '#ffd27a', light: '#ffcf8a', shadow: '#a8778f', stars: .05 },
  { hour: 19.6, zenith: '#33366f', horizon: '#de6c5a', sun: '#ffab84', light: '#e9a7a0', shadow: '#62527f', stars: .35 },
  { hour: 21, zenith: '#0e1838', horizon: '#2c3762', sun: '#dfe6ff', light: '#76839f', shadow: '#2c3558', stars: .95 },
  { hour: 24, zenith: '#0a1430', horizon: '#24325a', sun: '#dfe6ff', light: '#7383ad', shadow: '#2a3456', stars: 1 }
];

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Hours since local midnight, e.g. 18.5 for 6:30 pm. `?hour=18.5` in the address overrides it for previews. */
export function localHour(date = new Date()) {
  const override = Number(new URLSearchParams(location.search).get('hour'));
  if (location.search.includes('hour=') && Number.isFinite(override)) return ((override % 24) + 24) % 24;
  return date.getHours() + date.getMinutes() / 60;
}

export function paletteAt(hour: number): SkyPalette {
  const i = keys.findIndex((k, n) => n < keys.length - 1 && hour >= k.hour && hour < keys[n + 1].hour);
  const a = keys[Math.max(i, 0)], b = keys[Math.max(i, 0) + 1];
  const t = smooth((hour - a.hour) / (b.hour - a.hour));
  const night = a.stars + (b.stars - a.stars) * t;
  // The sun arcs from 6:00 to 19:30; the moon takes the night.
  const day = (hour - 6) / 13.5;
  const arc = day >= 0 && day <= 1 ? day : (((hour + 24 - 19.5) % 24) / 10.5);
  return {
    zenith: mix(hex(a.zenith), hex(b.zenith), t), horizon: mix(hex(a.horizon), hex(b.horizon), t),
    sun: mix(hex(a.sun), hex(b.sun), t),
    cloudLight: mix(hex(a.light), hex(b.light), t), cloudShadow: mix(hex(a.shadow), hex(b.shadow), t),
    stars: night,
    sunX: .14 + .72 * arc, sunY: .12 + .72 * Math.sin(Math.PI * arc),
    ink: night > .5 ? '#f2f5ff' : '#1f2b49', glow: night > .5 ? 'rgba(10,20,48,.75)' : 'rgba(255,255,255,.9)'
  };
}
