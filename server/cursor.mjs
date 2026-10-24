import path from 'node:path';
import { z } from 'zod';
import { featureUrl } from './feature-link.mjs';
import { agent, event, workItem, uid } from './domain.mjs';
import { claimIdentity } from './names.mjs';
import { record } from './orchestration.mjs';
import { trimEvidence, identifyEvidence } from './evidence.mjs';
import { claimDisplay, creditRun, identityBySub, rememberDisplay } from './identity.mjs';

const text = z.string().trim().min(1).max(12000);
const progress = z.object({ previewUrl: featureUrl.optional(), summary: text, files: z.array(z.string().trim().min(1).max(500)).max(20).optional(), diff: z.string().max(16000).optional(), tests: z.string().max(16000).optional() }).strict();
const finished = progress.extend({ outcome: z.enum(['review', 'blocked']) });

// Tools that run in the user's own session and report in over MCP: the office observes them
// and cannot stop them, and each signs in with its own account, so no key is involved here.
export const reporters = {
  cursor: { name: 'Cursor', tools: 'office_cursor', source: 'cursor-reported' },
  'claude-code': { name: 'Claude Code', tools: 'office_claude', source: 'claude-reported' },
  'codex-cli': { name: 'Codex CLI', tools: 'office_codex', source: 'codex-reported' }
};
const reporter = provider => { const r = reporters[provider]; if (!r) throw new Error('Unknown reporting tool'); return r; };

export function createCursorDesk({ state, changed, isStarting = () => false, currentIdentity = () => null }) {
  const sameProject = room => state.rooms.filter(r => !r.demo && path.relative(r.path, room.path) === '');
  function assertAvailable(room) {
    if (room.demo) return;
    const holder = sameProject(room).flatMap(r => r.agents).find(a => reporters[a.provider] && a.turnId);
    if (holder) { const r = reporters[holder.provider]; throw new Error(`This project is owned by a ${r.name} assignment. Finish or stop it in ${r.name}, then call ${r.tools}_finish before starting another writer.`); }
  }
  function start(room, body, provider = 'cursor') {
    const r = reporter(provider);
    const input = z.object({ task: text, model: z.string().trim().min(1).max(120).default(`${r.name} · model not reported`), acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(8) }).strict().parse(body);
    const identity = currentIdentity();
    if (room.demo) throw new Error(`Choose a live project room for ${r.name} work.`);
    if (sameProject(room).some(r => r.capturing)) throw new Error('Wait for the checkpoint to finish before assigning work.');
    assertAvailable(room);
    if (sameProject(room).some(r => r.agents.some(a => a.turnId || isStarting(a.id)))) throw new Error(`Wait for the active office work to finish before ${r.name} takes ownership.`);
    const worker = agent('', 'Implementation', input.task, room.agents.length, { provider, model: input.model, modelSource: r.source, status: 'working', turnId: uid(), credentialSub: identity?.sub || null });
    const item = workItem(input.task.split('\n')[0].slice(0, 120), input.task, { agentId: worker.id, status: 'working', acceptanceCriteria: input.acceptanceCriteria, requiredEvidence: ['diff', 'test'], checks: [], comments: [], files: [] });
    room.paused = false;
    room.agents.push(worker); claimDisplay(identity, worker); claimIdentity(worker, room); rememberDisplay(identity, worker); creditRun(identity, 'started');
    room.workItems.push(item); room.goal ||= input.task;
    event(worker, 'user', input.task); event(worker, 'system', `Execution stays in ${r.name}. Model, progress and evidence are reported through MCP; verify results before accepting the task.`);
    record(room, `${r.name} took implementation ownership`, 'work'); changed();
    return { roomId: room.id, agentId: worker.id, workItemId: item.id, instruction: `Publish concise progress with ${r.tools}_update. After execution has finished or stopped, call ${r.tools}_finish. Iteration1 cannot interrupt ${r.name} execution.` };
  }
  // An attributed run only accepts reports from the account that opened it, so signing
  // out mid-run cannot hand it to someone else. Operator recovery is exempt: it exists
  // precisely for when that agent can no longer answer.
  function owner(room, id, provider, enforce = true) {
    const worker = room.agents.find(a => a.id === id && a.provider === provider);
    const item = room.workItems.find(t => t.agentId === id);
    if (!worker || !item || !worker.turnId) throw new Error(`No open ${reporter(provider).name} assignment for this agent. Start a new assignment or inspect its saved evidence.`);
    if (enforce && worker.credentialSub && currentIdentity()?.sub !== worker.credentialSub) throw new Error('This assignment belongs to another signed-in account. Sign back in as its owner, or release the desk from the office.');
    return { worker, item };
  }
  function publish(room, id, input, provider, enforce = true) {
    const { worker, item } = owner(room, id, provider, enforce);
    event(worker, 'update', input.summary);
    if (input.files) item.files = input.files;
    if (input.previewUrl!==undefined) item.previewUrl=input.previewUrl;
    for (const [field, kind] of [['diff', 'diff'], ['tests', 'test']]) if (input[field]?.trim()) item.evidence.push({ kind, text: input[field], source: reporters[provider].source, time: Date.now() });
    if (input.diff) worker.diff = input.diff;
    identifyEvidence(room); trimEvidence(room,item); item.updatedAt = Date.now();
    return { worker, item };
  }
  function update(room, id, body, provider = 'cursor') {
    const { item } = publish(room, id, progress.parse(body), provider);
    record(room, `${reporter(provider).name} published progress`, 'work'); changed(); return { workItemId: item.id, status: item.status };
  }
  function finish(room, id, body, provider = 'cursor', source = reporter(provider).source) {
    const input = finished.parse(body);
    const { worker, item } = publish(room, id, input, provider, source !== 'user-recovery');
    creditRun(identityBySub(state, worker.credentialSub), input.outcome);
    worker.turnId = null; worker.status = input.outcome === 'review' ? 'done' : 'error';
    item.status = input.outcome; item.blocker = input.outcome === 'blocked' ? input.summary : '';
    item.evidence.push({ kind: 'log', text: input.summary, source, time: Date.now() });
    identifyEvidence(room); trimEvidence(room,item);
    worker.talkingUntil = Date.now() + 18000;
    const manager = room.agents.find(a => a.manager && a.status !== 'ejected');
    if (manager) manager.talkingUntil = worker.talkingUntil;
    room.messages.push({ id: uid(), fromId: worker.id, from: worker.name, toId: manager?.id, to: manager?.name || 'Office', text: input.summary, time: Date.now() });
    record(room, `${reporters[provider].name} released assignment: ${input.outcome}`, 'handoff'); changed();
    return { workItemId: item.id, status: item.status, verified: false, instruction: 'Execution is reported finished. Inspect the diff and reproduce the reported checks before accepting this task.' };
  }
  function release(room, id, body, provider = 'cursor') {
    z.object({ confirmedStopped: z.literal(true) }).strict().parse(body);
    return finish(room, id, { outcome: 'blocked', summary: `User confirmed ${reporter(provider).name} execution has stopped. Assignment released; inspect saved work before continuing.` }, provider, 'user-recovery');
  }
  return { assertAvailable, start, update, finish, release };
}
