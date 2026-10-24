/** Display-only costumes. Match the same role text as the name pools. */
export type CostumeKind = 'manager' | 'research' | 'review' | 'build' | 'test' | 'access' | 'api' | 'security' | 'quality' | 'systems' | 'generic';

export const costumeColors: Record<CostumeKind, { hat: string; trim: string; bow: string }> = {
  manager: { hat: '#2e3338', trim: '#c4a36a', bow: '#1e2226' },
  research: { hat: '#3e5270', trim: '#c9b48a', bow: '#2c403c' },
  review: { hat: '#2a2e32', trim: '#8d3d4e', bow: '#7a3040' },
  build: { hat: '#3d5c86', trim: '#f3d7a2', bow: '#2c4a6e' },
  test: { hat: '#6d4b32', trim: '#c4a36a', bow: '#8a4a32' },
  access: { hat: '#8d5a78', trim: '#f0e2ea', bow: '#efe4d4' },
  api: { hat: '#3d7a8c', trim: '#e7d7b8', bow: '#1e4a58' },
  security: { hat: '#243028', trim: '#c4a36a', bow: '#141816' },
  quality: { hat: '#3f6b52', trim: '#d7e2c8', bow: '#2a4034' },
  systems: { hat: '#355e58', trim: '#d4782a', bow: '#243833' },
  generic: { hat: '#5c5348', trim: '#efe6d4', bow: '#4a4038' }
};

export function costumeFor(agent: { role?: string; manager?: boolean }): CostumeKind {
  const text = String(agent.role || '');
  if (agent.manager || /\bmanager\b/i.test(text)) return 'manager';
  if (/accessib/i.test(text)) return 'access';
  if (/\bapi\b|endpoint/i.test(text)) return 'api';
  if (/security|secret/i.test(text)) return 'security';
  if (/test design/i.test(text)) return 'test';
  if (/research|diagnos/i.test(text)) return 'research';
  if (/review/i.test(text)) return 'review';
  if (/implement|frontend/i.test(text)) return 'build';
  if (/quality/i.test(text)) return 'quality';
  if (/system/i.test(text)) return 'systems';
  return 'generic';
}

function mixId(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** One accessory per worker, stable for that agent: half a hat, a quarter a bow tie, a quarter a coffee cup. */
export function accessoriesFor(agent: { id?: string; role?: string; manager?: boolean }) {
  const kind = costumeFor(agent);
  const roll = mixId(String(agent.id || kind)) % 4;
  return { kind, hat: roll < 2, bow: roll === 2, coffee: roll === 3 };
}
