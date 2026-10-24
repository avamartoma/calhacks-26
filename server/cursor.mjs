import path from 'node:path';
import { z } from 'zod';
import { featureUrl } from './feature-link.mjs';
import { agent, event, workItem, uid } from './domain.mjs';
import { claimIdentity } from './names.mjs';
import { record } from './orchestration.mjs';
import { trimEvidence, identifyEvidence } from './evidence.mjs';

const text = z.string().trim().min(1).max(12000);
const progress = z.object({ previewUrl: featureUrl.optional(), summary: text, files: z.array(z.string().trim().min(1).max(500)).max(20).optional(), diff: z.string().max(16000).optional(), tests: z.string().max(16000).optional() }).strict();
const finished = progress.extend({ outcome: z.enum(['review', 'blocked']) });

export function createCursorDesk({ state, changed, isStarting = () => false }) {
  const sameProject = room => state.rooms.filter(r => !r.demo && path.relative(r.path, room.path) === '');
  function assertAvailable(room) {
    if (room.demo) return;
    if (sameProject(room).some(r => r.agents.some(a => a.provider === 'cursor' && a.turnId))) throw new Error('This project is owned by a Cursor assignment. Finish or stop it in Cursor, then call office_cursor_finish before starting another writer.');
  }
  function start(room, body) {
    const input = z.object({ task: text, model: z.string().trim().min(1).max(120).default('Cursor · model not reported'), acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(8) }).strict().parse(body);
    if (room.demo) throw new Error('Choose a live project room for Cursor work.');
    if (sameProject(room).some(r => r.capturing)) throw new Error('Wait for the checkpoint to finish before assigning work.');
    assertAvailable(room);
    if (sameProject(room).some(r => r.agents.some(a => a.turnId || isStarting(a.id)))) throw new Error('Wait for the active office work to finish before Cursor takes ownership.');
    const worker = agent('', 'Implementation', input.task, room.agents.length, { provider: 'cursor', model: input.model, modelSource: 'cursor-reported', status: 'working', turnId: uid() });
    const item = workItem(input.task.split('\n')[0].slice(0, 120), input.task, { agentId: worker.id, status: 'working', acceptanceCriteria: input.acceptanceCriteria, requiredEvidence: ['diff', 'test'], checks: [], files: [] });
    room.paused = false;
    room.agents.push(worker); claimIdentity(worker, room); room.workItems.push(item); room.goal ||= input.task;
    event(worker, 'user', input.task); event(worker, 'system', 'Execution stays in Cursor. Model, progress and evidence are reported through MCP; verify results before accepting the task.');
    record(room, 'Cursor took implementation ownership', 'work'); changed();
    return { roomId: room.id, agentId: worker.id, workItemId: item.id, instruction: 'Publish concise progress with office_cursor_update. After execution has finished or stopped, call office_cursor_finish. Fourteenth cannot interrupt Cursor execution.' };
  }
  function owner(room, id) {
    const worker = room.agents.find(a => a.id === id && a.provider === 'cursor');
    const item = room.workItems.find(t => t.agentId === id);
    if (!worker || !item || !worker.turnId) throw new Error('No open Cursor assignment for this agent. Start a new assignment or inspect its saved evidence.');
    return { worker, item };
  }
  function publish(room, id, input) {
    const { worker, item } = owner(room, id);
    event(worker, 'update', input.summary);
    if (input.files) item.files = input.files;
    if (input.previewUrl!==undefined) item.previewUrl=input.previewUrl;
    for (const [field, kind] of [['diff', 'diff'], ['tests', 'test']]) if (input[field]?.trim()) item.evidence.push({ kind, text: input[field], source: 'cursor-reported', time: Date.now() });
    if (input.diff) worker.diff = input.diff;
    identifyEvidence(room); trimEvidence(room,item); item.updatedAt = Date.now();
    return { worker, item };
  }
  function update(room, id, body) {
    const { item } = publish(room, id, progress.parse(body));
    record(room, 'Cursor published progress', 'work'); changed(); return { workItemId: item.id, status: item.status };
  }
  function finish(room, id, body, source = 'cursor-reported') {
    const input = finished.parse(body);
    const { worker, item } = publish(room, id, input);
    worker.turnId = null; worker.status = input.outcome === 'review' ? 'done' : 'error';
    item.status = input.outcome; item.blocker = input.outcome === 'blocked' ? input.summary : '';
    item.evidence.push({ kind: 'log', text: input.summary, source, time: Date.now() });
    identifyEvidence(room); trimEvidence(room,item);
    worker.talkingUntil = Date.now() + 18000;
    const manager = room.agents.find(a => a.manager && a.status !== 'ejected');
    if (manager) manager.talkingUntil = worker.talkingUntil;
    room.messages.push({ id: uid(), fromId: worker.id, from: worker.name, toId: manager?.id, to: manager?.name || 'Office', text: input.summary, time: Date.now() });
    record(room, `Cursor released assignment: ${input.outcome}`, 'handoff'); changed();
    return { workItemId: item.id, status: item.status, verified: false, instruction: 'Execution is reported finished. Inspect the diff and reproduce the reported checks before accepting this task.' };
  }
  function release(room, id, body) {
    z.object({ confirmedStopped: z.literal(true) }).strict().parse(body);
    return finish(room, id, { outcome: 'blocked', summary: 'User confirmed Cursor execution has stopped. Assignment released; inspect saved work before continuing.' }, 'user-recovery');
  }
  return { assertAvailable, start, update, finish, release };
}
