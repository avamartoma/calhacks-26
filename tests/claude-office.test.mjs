import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function office(t, port) {
  const root = path.resolve('.'), temp = await mkdtemp(path.join(os.tmpdir(), 'iteration1-claude-office-'));
  const project = path.join(temp, 'project'); await mkdir(project);
  const git = (...args) => execFileSync('git', args, { cwd: project });
  git('init', '-q'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  await writeFile(path.join(project, 'README.md'), '# Fixture\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = `http://127.0.0.1:${port}`;
  // Codex stays signed out: everything here must run on Claude alone.
  const child = spawn(process.execPath, ['server/index.mjs', '--production'], { cwd: root, env: { ...process.env, PORT: String(port), OFFICE_DATA_DIR: temp, OFFICE_CODEX_HOME: path.join(temp, 'codex'), OFFICE_CODEX_BIN: process.execPath, OFFICE_CODEX_ARGS: JSON.stringify([path.join(root, 'tests/fake-codex.mjs')]), OFFICE_FIXTURE_SIGNED_OUT: '1', OFFICE_CLAUDE_SDK: path.join(root, 'tests/fake-claude-sdk.mjs'), OFFICE_CLAUDE_KEY_FILE: path.join(temp, 'key.json'), ANTHROPIC_API_KEY: 'sk-ant-fixture-' + 'x'.repeat(30) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'iteration1-claude-office-')) await rm(temp, { recursive: true, force: true }); });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr || 'Startup timeout')), 10000); child.stdout.on('data', data => { if (String(data).includes('Iteration1 office')) { clearTimeout(timer); resolve(); } }); });
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const req = async (route, body, method) => { const response = await fetch(base + '/api' + route, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  const room = (await req('/rooms', { name: 'Claude office', path: project, demo: false })).data.room;
  const current = async () => (await req('/state')).data.rooms.find(r => r.id === room.id);
  const until = async (check, label) => { for (let i = 0; i < 120; i++) { const r = await current(); if (check(r)) return r; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out waiting for ${label}`); };
  return { req, room, current, until };
}

test('a Claude manager runs the office: plans, delegates to a Claude worker, edits, checks and hands off', { timeout: 30000 }, async t => {
  const { req, room, until } = await office(t, 44346);
  const started = await req(`/rooms/${room.id}/dispatch`, { prompt: 'Add instant search', model: 'claude-opus-5-5' });
  assert.equal(started.status, 200, JSON.stringify(started.data));

  const settled = await until(r => r.agents.some(a => !a.manager && a.status === 'done') && r.agents.find(a => a.manager).events.some(e => /Worker handoffs/.test(e.text || '')), 'the worker handoff to reach the manager');
  const manager = settled.agents.find(a => a.manager);
  const worker = settled.agents.find(a => !a.manager && a.status !== 'ejected');
  assert.equal(manager.provider, 'claude'); assert.equal(manager.model, 'claude-opus-5-5');
  assert.equal(worker.provider, 'claude', 'a Claude manager delegates to Claude workers');
  assert.equal(worker.model, 'claude-opus-5-5');

  const managerTools = manager.events.find(e => /^tools:/.test(e.text || '')).text;
  assert.match(managerTools, /\bWrite\b/, 'the manager is the writer');
  assert.match(managerTools, /office_delegate/);
  const workerTools = worker.events.find(e => /^tools:/.test(e.text || '')).text;
  assert.doesNotMatch(workerTools, /\b(Write|Edit|Bash)\b/, 'workers are read-only, as with Codex');
  assert.match(workerTools, /office: office_status,office_message,office_acknowledge/);
  assert.ok(worker.events.some(e => /worker saw \d+ work items/.test(e.text || '')), 'the worker used an office tool for real');

  assert.deepEqual(manager.plan.map(p => p.status), ['completed', 'inProgress'], 'TodoWrite becomes the office plan');
  const ticket = settled.workItems.find(t => t.agentId === manager.id);
  assert.ok(ticket.evidence.some(e => e.source === 'observed-command' && e.kind === 'test' && e.command === 'npm test' && e.passed === true && e.cwdVerified === true), 'the check is recorded as observed evidence');
  assert.ok(ticket.evidence.some(e => e.source === 'observed-turn-diff' && /\+implemented/.test(e.text)), 'the edit is recorded as an observed diff');
  assert.ok(settled.messages.some(m => m.fromId === worker.id && m.toId === manager.id), 'the finished worker handed off to the manager');
  assert.match(manager.events.filter(e => /^tools:/.test(e.text || '')).at(-1).text, /resume: fake-session-/, 'the manager continued its own session for the handoff');
});

test('a read-only office keeps a Claude manager read-only', { timeout: 30000 }, async t => {
  const { req, room, until } = await office(t, 44356);
  assert.equal((await req(`/rooms/${room.id}`, { permissionMode: 'read-only' }, 'PATCH')).status, 200);
  assert.equal((await req(`/rooms/${room.id}/dispatch`, { prompt: 'Review the code', model: 'claude-sonnet-5-5' })).status, 200);
  const settled = await until(r => r.agents.find(a => a.manager).events.some(e => /^tools:/.test(e.text || '')), 'the manager turn');
  const tools = settled.agents.find(a => a.manager).events.find(e => /^tools:/.test(e.text || '')).text;
  assert.doesNotMatch(tools, /\b(Write|Edit|Bash)\b/, 'read only means read only, whichever engine runs the desk');
});

test('choosing a Claude model needs Claude connected, and Codex is never required', { timeout: 30000 }, async t => {
  const { req, room } = await office(t, 44366);
  const codexOnly = await req(`/rooms/${room.id}/dispatch`, { prompt: 'Add search', model: 'gpt-6-sol' });
  assert.equal(codexOnly.status, 409); assert.match(codexOnly.data.error, /Sign in to Codex/);
});
