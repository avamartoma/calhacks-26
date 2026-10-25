import type { Agent, CloudSpot, OfficeIdentity, Room, SharedOffice, WorkItem } from './types';

export type CloudStatus = 'Preview live' | 'Waiting on you' | 'Paused' | 'View only';

/** One status for a project cloud. Shared projects are view-only; a live preview and a waiting desk outrank a paused sandbox. */
export function cloudStatus(room: Pick<Room, 'paused' | 'preview' | 'agents'>, waiting: boolean, shared: boolean): CloudStatus {
  if (shared) return 'View only';
  if (waiting || room.agents.some(agent => agent.status === 'approval')) return 'Waiting on you';
  if (room.preview?.status === 'live') return 'Preview live';
  return 'Paused';
}

export function cloudStatusLabel(status: CloudStatus) {
  return status === 'View only' ? 'View only (shared with me)' : status;
}

export function liveAgentCount(room: Pick<Room, 'agents'>) {
  return room.agents.filter(agent => agent.status !== 'ejected').length;
}

/** Unsigned local runs stay "local". A signed-in subject is shown by the name recorded for that account. */
export function ownerLabel(agent: Pick<Agent, 'credentialSub'>, identities: OfficeIdentity[] = []) {
  if (!agent.credentialSub) return 'local';
  return identities.find(identity => identity.sub === agent.credentialSub)?.label || 'local';
}

export function agentIsMine(agent: Pick<Agent, 'credentialSub'>, identities: OfficeIdentity[] = []) {
  if (!agent.credentialSub) return true;
  return identities.some(identity => identity.sub === agent.credentialSub);
}

export interface FileDiff { path: string; added: number; removed: number; body: string }

/** Split a unified diff into files with added and removed line counts. */
export function diffFiles(diff: string | undefined, files: string[] = []): FileDiff[] {
  const text = diff?.trim() || '';
  if (!text) return files.map(path => ({ path, added: 0, removed: 0, body: '' }));
  const parts = text.split(/^(?=diff --git )/m).filter(part => part.trim());
  if (!text.includes('diff --git ')) {
    const counts = lineCounts(text);
    const paths = files.length ? files : ['changes'];
    return paths.map((path, index) => ({ path, added: index === 0 ? counts.added : 0, removed: index === 0 ? counts.removed : 0, body: index === 0 ? text : '' }));
  }
  return parts.map(body => {
    const match = body.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const counts = lineCounts(body);
    return { path: match?.[2] || 'file', ...counts, body };
  });
}

function lineCounts(body: string) {
  let added = 0, removed = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

export function ticketDiff(item: WorkItem, agent?: Agent) {
  const recorded = item.evidence.filter(entry => entry.kind === 'diff').map(entry => entry.text).filter(Boolean);
  if (recorded.length) return recorded.join('\n');
  if (agent && (agent.currentWorkItemId === item.id || item.status === 'working' || item.status === 'review')) return agent.diff || '';
  return '';
}

/** A teammate project the signed-in office can see but does not own. */
export function sharedProjectRoom(remote: SharedOffice, owner: string): Room {
  let hash = 0;
  for (const char of remote.id) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const angle = hash * 0.017;
  const cloud: CloudSpot = { x: Math.cos(angle) * 42, y: Math.sin(angle) * 42, depth: -1.4 };
  return {
    id: `shared:${remote.id}`,
    viewOnly: true,
    name: remote.name,
    path: '',
    tag: 'SHARED',
    demo: false,
    goal: `${owner}'s project`,
    timeline: [],
    checkpoints: [],
    paused: remote.paused,
    budget: 1,
    skills: [],
    messages: [],
    cloud,
    workItems: remote.workItems.map(item => ({
      id: item.id, title: item.title, description: item.title, status: item.status, agentId: item.agentId,
      dependsOn: [], acceptanceCriteria: [], files: item.files || [], evidence: [], blocker: item.blocker, createdAt: 0, updatedAt: 0,
    })),
    agents: remote.agents.filter(agent => agent.status !== 'ejected').map(agent => ({
      id: agent.id, name: agent.name, role: agent.role, task: agent.task, model: agent.model, status: agent.status,
      manager: agent.manager, provider: agent.provider, color: agent.color, progress: 0, events: [], plan: [], tokens: 0,
    })),
  };
}
