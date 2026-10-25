// Agent blobs on the sky's clouds. Coding agents are colored by what they're working on; the four
// built-in agents (office, planner, watcher, reviewer) are gray. There's one of each built-in agent,
// so each sits on the cloud it last worked on, moves when it works somewhere else, and isn't shown
// anywhere until it's been used.

import { agentKinds, type SkyAgent } from './agents.ts';

export type BuiltinName = 'office' | 'planner' | 'watcher' | 'reviewer';
const TITLES: Record<BuiltinName, string> = { office: 'Office', planner: 'Planner', watcher: 'Watcher', reviewer: 'Reviewer' };

/** Something a built-in agent did, or was asked to do, on a project. */
export interface BuiltinUse { name: string; projectId: string; at: number; working: boolean }

/** Each built-in agent on the project it last worked on: projectId → its blobs. */
export function builtinBlobs(uses: BuiltinUse[]): Map<string, SkyAgent[]> {
  const latest = new Map<string, BuiltinUse>();
  for (const use of uses) {
    if (!(use.name in TITLES) || !use.projectId) continue;
    const seen = latest.get(use.name);
    if (!seen || use.at > seen.at) latest.set(use.name, use);
  }
  const byProject = new Map<string, SkyAgent[]>();
  for (const [name, use] of latest) {
    const blobs = byProject.get(use.projectId) ?? [];
    blobs.push({ role: `Built-in ${TITLES[name as BuiltinName]}`, status: use.working ? 'working' : 'idle' });
    byProject.set(use.projectId, blobs);
  }
  return byProject;
}

/** A coding agent's type, from what it was asked to do. Coding agents that match nothing more specific are Build. */
export function taskRole(task: string): string {
  return (agentKinds.find(kind => kind.match.test(task)) ?? agentKinds.find(kind => kind.id === 'build')!).label;
}
