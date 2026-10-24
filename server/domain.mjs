import { randomUUID } from 'node:crypto';
import { nameRoom } from './names.mjs';
export const uid = () => randomUUID();
export const DEFAULT_MODEL = 'gpt-6-sol';
export const palette = ['#ff7a3c', '#3ec4e6', '#f2c22e', '#c47af2', '#2fce8a', '#f08ab4'];
export function agent(name, role, task, index = 0, extra = {}) {
  return { id: uid(), name, role, task, model: DEFAULT_MODEL, status: 'idle', color: palette[index % palette.length], progress: 0, events: [], plan: [], tokens: 0, ...extra };
}
export function event(a, kind, text) {
  a.events.push({ id: uid(), kind, text: String(text).slice(-24000), time: Date.now() });
  a.events = a.events.slice(-120);
}
export function workItem(title, description, extra = {}) {
  return { id: uid(), title, description, status: 'queued', agentId: null, dependsOn: [], acceptanceCriteria: [], evidence: [], blocker: '', createdAt: Date.now(), updatedAt: Date.now(), ...extra };
}
export function evidenceFrom(a) {
  const evidence = a.events
    .filter(e => ['command', 'file', 'tool', 'update', 'error'].includes(e.kind) && e.text.trim())
    .slice(-8)
    .map(e => ({ kind: e.kind, text: e.text.slice(-4000), time: e.time }));
  if (a.diff) evidence.push({ kind: 'diff', text: a.diff.slice(-12000), time: Date.now() });
  return evidence.slice(-8);
}
export function seed(cwd) {
  const manager = agent('', 'Manager', 'Coordinate the office launch', 4, { manager: true, model: 'gpt-6-astra', status: 'working', progress: 64 });
  const agents = [manager,
    agent('', 'Frontend', 'Build the project switcher', 0, { model: 'gpt-5.6-sol', status: 'working', progress: 72 }),
    agent('', 'Research', 'Map the Codex app-server events', 1, { model: 'gpt-5.6-terra', status: 'talking', progress: 88 }),
    agent('', 'Quality', 'Verify room navigation', 2, { model: 'gpt-5.6-luna', status: 'working', progress: 46 }),
    agent('', 'Systems', 'Design the task handoff protocol', 3, { model: 'gpt-5.6-terra', status: 'talking', progress: 61 })];
  agents.forEach(a => {
    a.plan = [{ step: 'Inspect project context', status: 'completed' }, { step: a.task, status: 'inProgress' }, { step: 'Verify and hand off', status: 'pending' }];
    event(a, 'update', a.manager ? 'I split the launch into independent tasks. Frontend owns the switcher; research is checking the event contract.' : `Working on: ${a.task}. This is a sample activity in the demo office.`);
  });
  nameRoom({ agents });
  const workItems = agents.map(a => workItem(a.manager ? 'Coordinate the office launch' : a.task, a.task, { agentId: a.id, status: a.status === 'talking' ? 'working' : a.status, acceptanceCriteria: a.manager ? ['Specialists have bounded assignments', 'Results return with evidence'] : ['Return a concrete, evidence-backed result'] }));
  workItems.slice(2).forEach(item => { item.dependsOn = [workItems[1].id]; });
  const research = agents.find(a => a.role === 'Research');
  const systems = agents.find(a => a.role === 'Systems');
  return { version: 1, rooms: [{ id: uid(), name: 'The agent office', path: cwd, tag: 'WORKSPACE 01', demo: true, goal: 'Build a better place to work with agents.', orchestrationVersion: 1, missionStartedAt: Date.now(), workItems, agents, messages: [{ id: uid(), fromId: research.id, toId: systems.id, from: research.name, to: systems.name, text: 'The event stream includes task plans and tool actions. I’m sending the contract over.', time: Date.now() }], skills: ['office-manager', 'office-handoff', 'office-review'], budget: 3, paused: false }], approvals: [] };
}
export function roomBy(state, id) { const r = state.rooms.find(r => r.id === id); if (!r) throw new Error('Room not found'); return r; }
export function agentBy(room, id) { const a = room.agents.find(a => a.id === id); if (!a) throw new Error('Agent not found'); return a; }
export function active(a) { return ['working', 'talking', 'approval'].includes(a.status); }
export function canDelegate(room) {
  if (room.paused) throw new Error('This office is paused');
  if (room.agents.filter(a => !a.manager && active(a)).length >= room.budget) throw new Error(`Worker limit reached (${room.budget}). Wait for a result before delegating more.`);
}
export function handoff(a) {
  return `Task: ${a.task}\nRole: ${a.role}\nPlan: ${JSON.stringify(a.plan)}\nRecent observable work:\n${a.events.slice(-12).map(e => `${e.kind}: ${e.text}`).join('\n')}\nContinue from this handoff. Inspect actual files before editing. Do not assume that interrupted actions finished.`;
}
export function publicItem(item) {
  if (!item || item.type === 'reasoning') return null;
  if (item.type === 'agentMessage' || item.type === 'plan') return { kind: item.type === 'plan' ? 'plan' : 'update', text: item.text || '' };
  if (item.type === 'commandExecution') return { kind: 'command', text: `${item.command}\n${item.aggregatedOutput || ''}${item.exitCode != null ? `\nExit: ${item.exitCode}` : ''}` };
  if (item.type === 'fileChange') return { kind: 'file', text: item.changes.map(c => `${c.path}\n${c.diff || ''}`).join('\n') };
  if (item.type === 'mcpToolCall') return { kind: 'tool', text: `${item.server} / ${item.tool} · ${item.status}` };
  if (item.type === 'webSearch') return { kind: 'tool', text: `Web search: ${item.query || item.action?.query || ''}` };
  return null;
}
