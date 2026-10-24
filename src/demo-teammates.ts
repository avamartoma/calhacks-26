import type { Room, SharedOffice } from './types';

export const demoTeammateNames = ['Sam', 'Jordan', 'Casey', 'Riley', 'Avery', 'Taylor', 'Quinn', 'Jamie'];

export function createDemoTeammate(index: number): SharedOffice {
  const name = demoTeammateNames[index];
  if (!name) throw new Error('All demo teammates have been added.');
  const id = `preview-office-${index}`;
  const tasks = ['Coordinate project search', 'Build the search interface', 'Review keyboard navigation'];
  return {
    id, owner: `${name} (demo)`, name: 'Project search', paused: false,
    agents: ['Morgan', 'Jules', 'Nova'].map((agent, i) => ({
      id: `${id}-agent-${i}`, name: agent, role: ['Manager', 'Implementation', 'Review'][i],
      model: 'gpt-6-sol', task: tasks[i], status: i === 2 ? 'talking' : 'working',
      manager: i === 0, color: ['#dab666', '#86afa0', '#b6a6c7'][i],
    })),
    workItems: tasks.map((title, i) => ({
      id: `${id}-task-${i}`, title, status: i === 2 ? 'review' : 'working',
      agentId: `${id}-agent-${i}`, files: i === 1 ? ['src/Search.tsx'] : [],
      blocker: '', receiptCount: 0,
    })),
  };
}

// This is a view-only overlay. Never send simulated agents to the live API.
export function withDemoTeammate(room: Room, remote: SharedOffice, offices: SharedOffice[] = [remote]): Room {
  // A visual rehearsal must never hide a genuinely paired office or its handoffs.
  if (room.team?.remote && !room.team.simulated) return room;
  return {...room, team: {
    owner: room.team?.owner || 'You', remote, connected: false,
    lastSeen: null, error: null, overlaps: [], simulated: true, offices,
  }};
}
