import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// The ASI:One (Fetch.ai) agents in agents/ run as separate local processes. They check in here over the
// loopback API, like the MCP servers, so the office can show them inside a project and hand them work
// from the UI. Nothing here is persisted: an agent that stops checking in shows as offline.
export const fetchAgentNames = ['office', 'watcher', 'reviewer', 'planner'];
export const fetchJobKinds = { reviewer: ['review'], planner: ['plan', 'create', 'start'] };
const ONLINE_MS = 20000;
const ACTIVITY = 120;
const JOBS = 60;

const name = z.enum(fetchAgentNames);
const heartbeat = z.object({ name, address: z.string().regex(/^agent1[0-9a-z]{20,80}$/), details: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()])).default({}) }).strict();
const activity = z.object({ name, kind: z.string().trim().min(1).max(40), text: z.string().trim().min(1).max(6000), roomId: z.string().max(80).optional(), taskId: z.string().max(80).optional() }).strict();
const jobRequest = z.object({ agent: z.enum(['reviewer', 'planner']), kind: z.string(), roomId: z.string().max(80), taskId: z.string().max(80).optional(), payload: z.record(z.string(), z.unknown()).default({}) }).strict()
  .refine(job => fetchJobKinds[job.agent].includes(job.kind), { message: 'That agent does not take this kind of job.' })
  .refine(job => JSON.stringify(job.payload).length <= 20000, { message: 'Job payload is too large.' });
const jobResult = z.object({ name, status: z.enum(['done', 'failed']), result: z.record(z.string(), z.unknown()).default({}) }).strict()
  .refine(body => JSON.stringify(body.result).length <= 40000, { message: 'Job result is too large.' });

export function createFetchHub({ changed, now = Date.now }) {
  const agents = {}, log = [], jobs = [];
  function record(entry) { log.push({ id: randomUUID(), time: now(), ...entry }); if (log.length > ACTIVITY) log.splice(0, log.length - ACTIVITY); }
  return {
    /** What the page sees: who is online, recent activity and jobs. */
    snapshot() {
      const t = now();
      return { agents: fetchAgentNames.map(n => agents[n] ? { ...agents[n], online: t - agents[n].lastSeen < ONLINE_MS } : { name: n, online: false, lastSeen: 0, address: '', details: {} }), activity: log, jobs };
    },
    /** An agent checks in. Returns the jobs it should take now, marked running. */
    heartbeat(body) {
      const b = heartbeat.parse(body); const wasOnline = agents[b.name] && now() - agents[b.name].lastSeen < ONLINE_MS;
      agents[b.name] = { name: b.name, address: b.address, details: b.details, lastSeen: now() };
      const claimed = jobs.filter(j => j.agent === b.name && j.status === 'queued');
      for (const job of claimed) { job.status = 'running'; job.startedAt = now(); }
      if (!wasOnline || claimed.length) changed();
      return { jobs: claimed.map(({ id, kind, roomId, taskId, payload }) => ({ id, kind, roomId, taskId, payload })) };
    },
    activity(body) { record(activity.parse(body)); changed(); return {}; },
    /** The page queues work for the reviewer or planner. */
    request(body, roomExists) {
      const b = jobRequest.parse(body); if (!roomExists(b.roomId)) throw new Error('Project not found');
      if (jobs.some(j => j.agent === b.agent && j.kind === b.kind && j.roomId === b.roomId && j.taskId === b.taskId && ['queued', 'running'].includes(j.status))) throw new Error('That request is already in progress.');
      const job = { id: randomUUID(), ...b, status: 'queued', createdAt: now() };
      jobs.push(job); if (jobs.length > JOBS) jobs.splice(0, jobs.length - JOBS);
      changed(); return { job };
    },
    finish(id, body) {
      const b = jobResult.parse(body); const job = jobs.find(j => j.id === id);
      if (!job || job.agent !== b.name || job.status !== 'running') throw new Error('Job not found');
      Object.assign(job, { status: b.status, result: b.result, finishedAt: now() });
      changed(); return {};
    }
  };
}
