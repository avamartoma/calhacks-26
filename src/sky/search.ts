// Word matching for the sky's search, used when search by meaning isn't available (the web office
// has no search server; the local office may not have its model). A project matches when every
// word you typed appears in its name, description, or its agents' names and types.

export interface Searchable { id: string; name: string; description?: string; detail?: string; kind?: string; agents?: { name?: string; role: string }[] }

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Projects matching every word, best first: name matches, then agent matches, then the rest. */
export function keywordMatches<T extends Searchable>(projects: T[], query: string, limit = 6): { p: T; match: string }[] {
  const terms = words(query);
  if (!terms.length) return [];
  const found: { p: T; match: string; score: number }[] = [];
  for (const p of projects) {
    if (p.kind === 'you') continue;
    const projectText = `${p.name} ${p.description ?? ''} ${p.detail ?? ''}`.toLowerCase();
    const agents = (p.agents ?? []).map(agent => ({ label: agent.name || agent.role.replace(/^Built-in /i, ''), text: `${agent.name ?? ''} ${agent.role}`.toLowerCase() }));
    const everything = `${projectText} ${agents.map(agent => agent.text).join(' ')}`;
    if (!terms.every(term => everything.includes(term))) continue;
    const inName = terms.every(term => p.name.toLowerCase().includes(term));
    // Say which agent matched when the project's own text doesn't explain the match.
    const byAgent = !terms.every(term => projectText.includes(term)) ? agents.find(agent => terms.some(term => agent.text.includes(term))) : undefined;
    found.push({ p, match: byAgent ? `Agent: ${byAgent.label}` : '', score: inName ? 2 : byAgent ? 1 : 0 });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit).map(({ p, match }) => ({ p, match }));
}
