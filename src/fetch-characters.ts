import type { Agent, AgentStatus, FetchAgentName, FetchState, Room } from './types';

export const FETCH_GRAY = '#8b9298';
export const FETCH_PREFIX = 'fetch:';
export const fetchNames: FetchAgentName[] = ['office', 'planner', 'watcher', 'reviewer'];
const titles: Record<FetchAgentName, string> = {
  office: 'Office', planner: 'Planner', watcher: 'Watcher', reviewer: 'Reviewer'
};
const roles: Record<FetchAgentName, string> = {
  office: 'Chat', planner: 'Jira', watcher: 'Watches', reviewer: 'Reviews'
};

export const isFetchCharacter = (agent?: { id?: string } | null) => !!agent?.id?.startsWith(FETCH_PREFIX);
export const fetchNameOf = (agent: { id: string }) => agent.id.slice(FETCH_PREFIX.length) as FetchAgentName;
export const fetchId = (name: FetchAgentName) => `${FETCH_PREFIX}${name}`;

// Which Fetch agents have done work in each project. Jobs and activity live only in the
// server's memory, so this keeps a used agent in its project after a restart.
const USED_KEY = 'iteration1-fetch-used';
function loadUsed(): Record<string, FetchAgentName[]> {
  try {
    const saved = JSON.parse(localStorage.getItem(USED_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch { return {}; }
}

/** Agents with a job in this project, or activity tagged with it. Opening a panel isn't use. */
function workedFetchNames(roomId: string, fetch?: FetchState): FetchAgentName[] {
  const fromWork = (fetch?.activity || []).filter(a => a.roomId === roomId).map(a => a.name);
  const fromJobs = (fetch?.jobs || []).filter(j => j.roomId === roomId).map(j => j.agent as FetchAgentName);
  return [...fromWork, ...fromJobs];
}

/** Remembers every agent that has worked in each project. */
export function rememberFetchUse(roomIds: string[], fetch?: FetchState) {
  try {
    const all = loadUsed();
    let changed = false;
    for (const roomId of roomIds) {
      const have = all[roomId] || [], worked = workedFetchNames(roomId, fetch);
      const add = fetchNames.filter(n => !have.includes(n) && worked.includes(n));
      if (add.length) { all[roomId] = [...have, ...add]; changed = true; }
    }
    if (changed) localStorage.setItem(USED_KEY, JSON.stringify(all));
  } catch { /* storage unavailable: live jobs and activity still count */ }
}

export function usedFetchNames(roomId: string, fetch?: FetchState): FetchAgentName[] {
  const saved = loadUsed()[roomId] || [], worked = workedFetchNames(roomId, fetch);
  return fetchNames.filter(name => saved.includes(name) || worked.includes(name));
}

function fetchStatus(name: FetchAgentName, fetch?: FetchState): AgentStatus {
  if ((fetch?.jobs || []).some(j => j.agent === name && (j.status === 'queued' || j.status === 'running'))) return 'working';
  return 'idle';
}

export function fetchCharacter(name: FetchAgentName, fetch?: FetchState): Agent {
  return {
    id: fetchId(name),
    name: titles[name],
    title: 'Built-in',
    role: roles[name],
    task: 'Built into Iteration1',
    model: 'Built-in',
    status: fetchStatus(name, fetch),
    color: FETCH_GRAY,
    progress: 0,
    events: [],
    plan: [],
    tokens: 0
  };
}

/** Adds the Fetch agents this project has used as gray built-in characters; unused ones stay out. */
export function withUsedFetch(room: Room, fetch?: FetchState): Room {
  const chars = usedFetchNames(room.id, fetch).map(name => fetchCharacter(name, fetch));
  return { ...room, agents: [...room.agents.filter(a => !isFetchCharacter(a)), ...chars] };
}
