import type { WorkItem } from './types';

// Stable topological lanes keep independent assignments parallel and handoffs downstream.
export function taskLayout(items: WorkItem[], vertical = false) {
  const byId = new Map(items.map(item => [item.id, item]));
  const remaining = new Map(items.map(item => [item.id, new Set(item.dependsOn.filter(id => byId.has(id))).size]));
  const rank = new Map(items.map(item => [item.id, 0]));
  const queue = items.filter(item => remaining.get(item.id) === 0).map(item => item.id);
  const visited = new Set<string>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    visited.add(id);
    for (const next of items.filter(item => item.dependsOn.includes(id))) {
      rank.set(next.id, Math.max(rank.get(next.id)!, rank.get(id)! + 1));
      remaining.set(next.id, remaining.get(next.id)! - 1);
      if (remaining.get(next.id) === 0) queue.push(next.id);
    }
  }
  const rows = new Map<number, number>();
  const nodes = items.map(item => {
    const lane = visited.has(item.id) ? rank.get(item.id)! : 0;
    const row = rows.get(lane) || 0;
    rows.set(lane, row + 1);
    return { item, lane, x: 24 + (vertical ? row : lane) * 292, y: 24 + (vertical ? lane : row) * 174 };
  });
  const nodesById = new Map(nodes.map(node => [node.item.id, node]));
  const edges = nodes.flatMap(to => [...new Set(to.item.dependsOn)].flatMap(id => {
    const from = nodesById.get(id);
    if (!from) return [];
    const x1 = from.x + (vertical ? 124 : 248), y1 = from.y + (vertical ? 124 : 62);
    const x2 = to.x + (vertical ? 124 : 0), y2 = to.y + (vertical ? 0 : 62);
    const d = vertical
      ? `M ${x1} ${y1} C ${x1} ${(y1+y2)/2}, ${x2} ${(y1+y2)/2}, ${x2} ${y2-5}`
      : `M ${x1} ${y1} C ${(x1+x2)/2} ${y1}, ${(x1+x2)/2} ${y2}, ${x2-5} ${y2}`;
    return [{ from: from.item, to: to.item, d }];
  }));
  return {
    nodes, edges,
    width: Math.max(296, ...nodes.map(node => node.x + 272)),
    height: Math.max(172, ...nodes.map(node => node.y + 148)),
    invalid: items.some(item => !visited.has(item.id) || item.dependsOn.some(id => !byId.has(id))),
  };
}
