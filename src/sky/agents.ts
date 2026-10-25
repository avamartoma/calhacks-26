// Agent types and their colors, shared by the sky's agent dots, its legend and the folder view.
// An agent's type comes from its role, so every project manager is the same color everywhere.

export interface AgentKind { id: string; label: string; color: string; match: RegExp }

export const agentKinds: AgentKind[] = [
  { id: 'manager', label: 'Manager', color: '#e0a526', match: /manag|lead|coordinat|planner/i },
  { id: 'review', label: 'Review & QA', color: '#8a6cc2', match: /review|\bqa\b|test|verif|regress|security|audit/i },
  { id: 'writing', label: 'Writing', color: '#d4688a', match: /writ|copy|docs|scribe|announc|chef|content/i },
  { id: 'research', label: 'Research', color: '#2f9aa0', match: /research|scout|diagnos|analy|explor/i },
  { id: 'data', label: 'Data', color: '#4f9a6a', match: /data|forecast|ingest|match|schedul|visuali|pipeline/i },
  { id: 'build', label: 'Build', color: '#3f7cc4', match: /implement|front|back|engineer|dev|build|fix|integrat|migrat|site|game|design|system/i }
];
export const otherKind: AgentKind = { id: 'other', label: 'Other', color: '#8a93a4', match: /$^/ };
export const builtinKind: AgentKind = { id: 'builtin', label: 'Built-in', color: '#8b9298', match: /built-in/i };

export function kindOf(role: string, manager = false): AgentKind {
  if (/built-in/i.test(role)) return builtinKind;
  if (manager) return agentKinds[0];
  return agentKinds.find(k => k.match.test(role)) || otherKind;
}

/** An agent as the sky shows it: its type and whether it is working right now. */
/** `name` (like "Sage", or "Claude · Ava") is what search matches, along with the role. */
export interface SkyAgent { role: string; status: string; manager?: boolean; name?: string }
export const isWorking = (status: string) => ['working', 'talking', 'approval'].includes(status);
