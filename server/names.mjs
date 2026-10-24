/** Display names and job titles. Edit the pools; do not use these strings as IDs. */
export const namePools = {
  Manager: [
    { name: 'Marge', title: 'Floor Manager' },
    { name: 'Monty', title: 'Keeper of the Plan' },
    { name: 'Dana', title: 'Project Lead' },
    { name: 'Gus', title: 'Head of the Office' }
  ],
  Implementation: [
    { name: 'Bea', title: 'Code Builder' },
    { name: 'Otto', title: 'Feature Maker' },
    { name: 'Wren', title: 'Code Carpenter' }
  ],
  Research: [
    { name: 'Rhea', title: 'Codebase Detective' },
    { name: 'Scout', title: 'Rabbit-Hole Diver' },
    { name: 'Quinn', title: 'Question Asker' },
    { name: 'Sage', title: 'Doc Digger' }
  ],
  Review: [
    { name: 'Vera', title: 'Second Pair of Eyes' },
    { name: 'Nicky', title: 'Diff Inspector' },
    { name: 'Reid', title: 'Code Critic' },
    { name: 'Hawk', title: 'Detail Spotter' }
  ],
  'Test design': [
    { name: 'Tess', title: 'Bug Hunter' },
    { name: 'Ida', title: 'Edge-Case Finder' },
    { name: 'Bugsy', title: 'Break-It Tester' },
    { name: 'Pax', title: 'Test Planner' }
  ],
  Accessibility: [
    { name: 'Ally', title: "Everyone's Advocate" },
    { name: 'Addie', title: 'Keyboard Checker' },
    { name: 'Lumen', title: 'Contrast Keeper' }
  ],
  'API discovery': [
    { name: 'Pia', title: 'Endpoint Explorer' },
    { name: 'Ray', title: 'Route Mapper' },
    { name: 'Juno', title: 'API Scout' }
  ],
  Security: [
    { name: 'Kit', title: 'Lock Checker' },
    { name: 'Sid', title: 'Risk Sniffer' },
    { name: 'Vault', title: 'Secrets Guard' }
  ],
  Generic: [
    { name: 'Mo', title: 'Helpful Hand' },
    { name: 'Pip', title: 'Odd-Job Blob' },
    { name: 'Lou', title: 'Desk Buddy' }
  ]
};

const ROMANS = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

export function poolFor(agent) {
  const text = String(agent?.role || '');
  if (agent?.manager || /\bmanager\b/i.test(text)) return namePools.Manager;
  if (/accessib/i.test(text)) return namePools.Accessibility;
  if (/\bapi\b|endpoint/i.test(text)) return namePools['API discovery'];
  if (/security|secret/i.test(text)) return namePools.Security;
  if (/test design/i.test(text)) return namePools['Test design'];
  if (/research/i.test(text)) return namePools.Research;
  if (/review/i.test(text)) return namePools.Review;
  if (/implement|frontend/i.test(text)) return namePools.Implementation;
  return namePools.Generic;
}

export function hashId(id) {
  let hash = 2166136261;
  for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function successorName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  const last = parts.at(-1);
  const index = ROMANS.indexOf(last);
  if (index >= 0) {
    const next = ROMANS[index + 1] || String(index + 3);
    return `${parts.slice(0, -1).join(' ')} ${next}`;
  }
  return `${parts.join(' ')} II`;
}

/** Next display name for a replacement. Title stays on the new agent. */
export function replacementName(agent, room) {
  const used = activeNames(room);
  let name = successorName(agent?.name);
  while (used.has(name)) name = successorName(name);
  return name;
}

export function chooseIdentity(agent, taken) {
  const pool = poolFor(agent);
  const used = taken instanceof Set ? taken : new Set(taken || []);
  const start = hashId(agent.id) % pool.length;
  for (let step = 0; step < pool.length; step++) {
    const entry = pool[(start + step) % pool.length];
    if (!used.has(entry.name)) return { name: entry.name, title: entry.title };
  }
  const base = pool[start];
  for (let n = 2; n < 200; n++) {
    const name = `${base.name} ${n}`;
    if (!used.has(name)) return { name, title: base.title };
  }
  return { name: `${base.name} extra`, title: base.title };
}

function activeNames(room) {
  const used = new Set();
  for (const other of room?.agents || []) {
    if (other.status === 'ejected' || !other.title || !other.name) continue;
    used.add(other.name);
  }
  return used;
}

/** Assign a display name and title once. Existing titles are left untouched. */
export function claimIdentity(agent, room) {
  if (agent.title) return agent;
  const pick = chooseIdentity(agent, activeNames(room));
  agent.name = pick.name;
  agent.title = pick.title;
  return agent;
}

export function nameRoom(room) {
  for (const agent of room?.agents || []) claimIdentity(agent, room);
  return room;
}

export function nameStoredRoom(room) {
  nameRoom(room);
  const known = new Map();
  for (const agent of room?.agents || []) {
    if (agent?.id && agent.name && agent.title) known.set(agent.id, { name: agent.name, title: agent.title });
  }
  const frames = [...(room?.timeline || []).map(entry => entry.frame), ...(room?.checkpoints || []).map(point => point.frame)];
  for (const frame of frames) {
    if (!frame?.agents) continue;
    for (const agent of frame.agents) {
      const pinned = known.get(agent.id);
      if (pinned && !agent.title) {
        agent.name = pinned.name;
        agent.title = pinned.title;
      }
    }
    nameRoom(frame);
    for (const agent of frame.agents) {
      if (agent?.id && agent.name && agent.title && !known.has(agent.id)) known.set(agent.id, { name: agent.name, title: agent.title });
    }
  }
  return room;
}
