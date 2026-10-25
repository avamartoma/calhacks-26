import { placeholder } from '../cloud/data';
import { accessFor, can } from '../cloud/model';
import { seedOf } from './sky-math';
import type { SkyProject } from './SkyView';

/**
 * Other people's projects for the background of the sky, from the placeholder workspace data
 * until the workspace backend serves real ones. Only projects the signed-in user may see are
 * included; hidden ones never appear, not even as a shape.
 */
export function placeholderNeighbors(workspaceId = 'ws-northwind'): SkyProject[] {
  const data = placeholder, me = data.currentUserId;
  const visible = data.projects.filter(p => p.workspaceId === workspaceId && p.ownerId !== me && p.status === 'active' && can.see(accessFor(data, p, me)));
  return visible.map((p, i) => {
    // A golden-angle spiral around your projects, set back behind them.
    const angle = i * 2.399963 + .6, radius = 420 + 230 * Math.sqrt(i), seed = seedOf(p.id);
    const owner = data.users.find(u => u.id === p.ownerId)?.name.split(' ')[0];
    const agents = data.agents.filter(a => a.projectId === p.id).map(a => ({ role: a.role, status: a.status, manager: /manager/i.test(a.role) }));
    return { id: `sample-${p.id}`, name: p.name, description: p.description, detail: owner ? `${owner}'s project` : 'Shared project', owner, mine: false, agents,
      x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * .6, depth: .45 + .35 * seed, seed };
  });
}
