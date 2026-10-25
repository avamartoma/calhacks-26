import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// The ASI:One (Fetch.ai) agents in agents/ run as separate local processes. They check in here over the
// loopback API, like the MCP servers, so the office can show them inside a project and hand them work
// from the UI. Nothing here is persisted: an agent that stops checking in shows as offline.
export const fetchAgentNames = ['office', 'watcher', 'reviewer', 'planner'];
export const fetchJobKinds = { office: ['chat'], reviewer: ['review'], planner: ['plan', 'create', 'start'] };
const ONLINE_MS = 20000;
const ACTIVITY = 120;
const JOBS = 60;

const name = z.enum(fetchAgentNames);
const heartbeat = z.object({ name, address: z.string().regex(/^agent1[0-9a-z]{20,80}$/), details: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()])).default({}) }).strict();
const activity = z.object({ name, kind: z.string().trim().min(1).max(40), text: z.string().trim().min(1).max(6000), roomId: z.string().max(80).optional(), taskId: z.string().max(80).optional() }).strict();
const jobRequest = z.object({ agent: z.enum(['office', 'reviewer', 'planner']), kind: z.string(), roomId: z.string().max(80), taskId: z.string().max(80).optional(), payload: z.record(z.string(), z.unknown()).default({}) }).strict()
  .refine(job => fetchJobKinds[job.agent].includes(job.kind), { message: 'That agent does not take this kind of job.' })
  .refine(job => job.kind !== 'chat' || (typeof job.payload.text === 'string' && job.payload.text.trim().length > 0 && job.payload.text.length <= 4000), { message: 'Write a message of up to 4000 characters.' })
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
      if (b.kind !== 'chat' && jobs.some(j => j.agent === b.agent && j.kind === b.kind && j.roomId === b.roomId && j.taskId === b.taskId && ['queued', 'running'].includes(j.status))) throw new Error('That request is already in progress.');
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

/** Starts agents/run_all.py from the agent venv when someone connects to an agent that isn't running. */
export function createFetchLauncher({ root, url, changed, online, spawnImpl = spawn }) {
  let child = null, error = '', startedAt = 0;
  const python = path.join(root, '.office', 'runtime', 'agent-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  // run_all.py has a child per agent; on Windows killing it alone would leave those running.
  const stop = () => { if (!child) return; const pid = child.pid; child = null; if (process.platform === 'win32' && pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); else try { process.kill(-pid, 'SIGTERM'); } catch {} };
  process.once('exit', stop);
  return {
    status() { return { running: !!child, startedAt, error, ready: existsSync(python) }; },
    start() {
      if (child || online()) return { started: false };
      if (!existsSync(python)) { error = 'The agents aren’t set up on this computer yet. Follow “ASI:One (Fetch.ai) agents” in the README.'; changed(); throw new Error(error); }
      const logs = path.join(root, '.office'); mkdirSync(logs, { recursive: true });
      const log = createWriteStream(path.join(logs, 'fetch-agents.log'), { flags: 'a' });
      child = spawnImpl(python, ['-u', path.join(root, 'agents', 'run_all.py')], { cwd: root, env: { ...process.env, ITERATION1_URL: url, ITERATION1_PROJECT: process.env.ITERATION1_PROJECT || root }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.pipe(log); child.stderr?.pipe(log);
      error = ''; startedAt = Date.now();
      const self = child;
      child.on('exit', code => { if (child !== self) return; child = null; error = `The agents stopped (exit code ${code}). See .office/fetch-agents.log.`; changed(); });
      child.on('error', e => { if (child !== self) return; child = null; error = `The agents could not start: ${e.message}`; changed(); });
      changed(); return { started: true };
    }
  };
}
