import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCursorDesk } from '../server/cursor.mjs';
import { createOfficeClient, summarizeOffice } from '../server/office-client.mjs';
import { seed } from '../server/domain.mjs';
import { initOffice, completionGaps } from '../server/orchestration.mjs';

function fixture() {
  const state = seed(path.resolve('.'));
  const room = initOffice(state.rooms[0]); room.demo = false; room.agents = []; room.workItems = []; room.goal = '';
  const desk = createCursorDesk({ state, changed() {} });
  return { state, room, desk };
}
const task = { task: 'Make search keyboard accessible', acceptanceCriteria: ['Search is reachable with Tab'] };
test('releasing an abandoned desk requires confirmation, preserves work and rejects late reports', () => {
  const { room, desk } = fixture(); const run = desk.start(room, task);
  desk.update(room, run.agentId, { summary: 'Partial work', diff: '+preserved change' });
  assert.throws(() => desk.release(room, run.agentId, {}));
  assert.throws(() => desk.release(room, run.agentId, { confirmedStopped: false }));
  assert.ok(room.agents[0].turnId);
  const result = desk.release(room, run.agentId, { confirmedStopped: true });
  assert.equal(result.status, 'blocked'); assert.equal(result.verified, false);
  assert.equal(room.workItems[0].evidence[0].text, '+preserved change');
  assert.equal(room.workItems[0].evidence.at(-1).source, 'user-recovery');
  assert.throws(() => desk.finish(room, run.agentId, { summary: 'Late finish', outcome: 'review' }), /No open/);
  assert.doesNotThrow(() => desk.start(room, task));
});

test('status summaries omit large receipts by default and disclose truncation on request', () => {
  const { room, desk } = fixture(); const run = desk.start(room, task);
  for (let i = 0; i < 10; i++) desk.update(room, run.agentId, { summary: `Progress ${i}`, diff: 'd'.repeat(10000) });
  const summary = summarizeOffice(room);
  assert.equal(summary.tasks[0].evidence, undefined); assert.equal(summary.tasks[0].evidenceCount, 10);
  assert.equal(summary.agents[0].assignmentOpen, true);
  const detail = summarizeOffice(room, true);
  assert.equal(detail.tasks[0].evidence.length, 8); assert.equal(detail.tasks[0].omittedReceipts, 2);
  assert.equal(detail.tasks[0].evidence[0].text.length, 4000); assert.equal(detail.tasks[0].evidence[0].truncated, true);
  assert.equal(room.workItems[0].evidence.length, 10);
});

test('unavailable companion has an actionable error', async () => {
  const office = createOfficeClient({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(office.request('/state'), /Start it with npm start/);
});
test('Cursor preserves evidence, labels unverified claims and releases ownership once', () => {
  const { room, desk } = fixture(); room.paused = true; const run = desk.start(room, task);
  assert.match(room.agents[0].model, /not reported/); assert.equal(room.paused, false);
  assert.throws(() => desk.start(room, task), /owned/);
  assert.throws(() => desk.assertAvailable(room), /owned/);
  desk.update(room, run.agentId, { summary: 'Added a visible label', files: ['Search.tsx'], diff: '+<label>Search</label>', tests: 'Reported: 1 passing test' });
  assert.equal(room.workItems[0].evidence[1].source, 'cursor-reported');
  assert.equal(room.workItems[0].evidence[1].passed, undefined);
  assert.throws(() => desk.finish(room, run.agentId, { summary: 'Done', outcome: 'done' }));
  assert.ok(room.agents[0].turnId);
  const result = desk.finish(room, run.agentId, { summary: 'Please verify the keyboard journey', outcome: 'review' });
  assert.equal(result.verified, false); assert.equal(room.workItems[0].status, 'review');
  assert.equal(room.agents[0].turnId, null); assert.ok(completionGaps(room, room.workItems[0]).length);
  assert.throws(() => desk.update(room, run.agentId, { summary: 'Late update' }), /No open/);
  assert.throws(() => desk.finish(room, run.agentId, { summary: 'Duplicate', outcome: 'review' }), /No open/);
  assert.doesNotThrow(() => desk.assertAvailable(room));
});

test('Cursor refuses demo, checkpoints, in-flight and same-project competing ownership', () => {
  const { state, room, desk } = fixture();
  room.demo = true; assert.throws(() => desk.start(room, task), /live/); room.demo = false;
  room.capturing = true; assert.throws(() => desk.start(room, task), /checkpoint/); room.capturing = false;
  const starting = createCursorDesk({ state, changed() {}, isStarting: () => true });
  room.agents.push({ id: 'starting' }); assert.throws(() => starting.start(room, task), /active office/); room.agents = [];
  const other = structuredClone(room); other.id = 'another-room'; other.agents.push({ turnId: 'active-turn' }); state.rooms.push(other);
  assert.throws(() => desk.start(room, task), /active office/); other.agents = [];
  desk.start(other, task); assert.throws(() => desk.start(room, task), /owned/);
  assert.equal(room.workItems.length, 0);
});

test('Cursor client accepts only a loopback origin', () => {
  for (const url of ['https://example.com', 'http://user:pass@localhost:4314', 'http://localhost:4314/other']) assert.throws(() => createOfficeClient({ url }), /local HTTP/);
});

test('stdio MCP runs a complete Cursor assignment without model credentials or Codex sign-in', { timeout: 30000 }, async t => {
  const root = path.resolve('.'); const temp = await mkdtemp(path.join(os.tmpdir(), 'fourteenth-cursor-'));
  const base = 'http://127.0.0.1:44319'; let child; let client;
  async function startServer() {
    child = spawn(process.execPath, ['server/index.mjs', '--production'], { cwd: root, windowsHide: true, env: { ...process.env, PORT: '44319', OFFICE_DATA_DIR: temp, OFFICE_CODEX_HOME: path.join(temp, 'codex'), OFFICE_CODEX_BIN: process.execPath, OFFICE_CODEX_ARGS: JSON.stringify([path.join(root, 'tests/fake-codex.mjs')]), OFFICE_FIXTURE_SIGNED_OUT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', d => errors += d);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(errors || 'Startup timed out')), 10000); child.stdout.on('data', d => { if (String(d).includes('Fourteenth office')) { clearTimeout(timer); resolve(); } }); child.once('exit', () => { clearTimeout(timer); reject(new Error(errors || 'Server exited')); }); });
  }
  async function stopServer() { if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; } }
  t.after(async () => { await client?.close(); await stopServer(); if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'fourteenth-cursor-')) await rm(temp, { recursive: true, force: true }); });
  await startServer();
  client = new Client({ name: 'fourteenth-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'scripts/cursor-mcp.mjs')], env: { FOURTEENTH_URL: base, FOURTEENTH_PROJECT: temp }, stderr: 'pipe' }));
  const tools = await client.listTools(); assert.equal(tools.tools.length, 6); assert.ok(!tools.tools.some(tool => /grok_review/.test(tool.name)));
  const call = async (name, args) => { const res = await client.callTool({ name, arguments: args }); return { ...JSON.parse(res.content[0].text), isError: res.isError }; };
  const opened = await call('office_open', { name: 'Cursor integration test' }); assert.ok(opened.roomId);
  const openedAgain = await call('office_open', {}); assert.equal(openedAgain.roomId, opened.roomId);
  const run = await call('office_cursor_start', { roomId: opened.roomId, ...task, model: 'Grok (test fixture)' }); assert.ok(run.agentId);
  const scoped = createOfficeClient({ url: base, project: root }); await assert.rejects(scoped.room(opened.roomId), /workspace/);
  const admin = createOfficeClient({ url: base, project: temp });
  await assert.rejects(admin.dispatch(opened.roomId, { prompt: 'Do not overwrite Cursor' }), /owned/);
  await assert.rejects(admin.request(`/rooms/${opened.roomId}/pause`, {}), /owned/);
  const beforeMode = (await admin.room(opened.roomId)).mode;
  await assert.rejects(admin.request(`/rooms/${opened.roomId}/mode`, { mode: 'crunch' }), /owned/);
  assert.equal((await admin.room(opened.roomId)).mode, beforeMode);
  await assert.rejects(admin.request(`/rooms/${opened.roomId}/agents/${run.agentId}/stop`, {}), /Stop execution in Cursor/);
  await call('office_cursor_update', { roomId: opened.roomId, agentId: run.agentId, summary: 'Fixture progress', diff: '+label', tests: 'Fixture output, not a real test' });
  await new Promise(resolve => setTimeout(resolve, 800));
  await stopServer(); await startServer();
  // Ownership survives restarts; the MCP client renews its local session cookie.
  const restored = await admin.room(opened.roomId); assert.ok(restored.agents.find(a => a.id === run.agentId).turnId);
  const duplicate = await call('office_cursor_start', { roomId: opened.roomId, ...task }); assert.equal(duplicate.isError, true);
  const finished = await call('office_cursor_finish', { roomId: opened.roomId, agentId: run.agentId, summary: 'Fixture finished. Needs verification.', outcome: 'review' });
  assert.equal(finished.verified, false); assert.equal(finished.status, 'review');
  const status = await client.callTool({ name: 'office_status', arguments: { roomId: opened.roomId, includeEvidence: true } });
  assert.match(status.content[0].text, /cursor-reported/);
  const actual = await admin.room(opened.roomId); assert.equal(actual.workItems[0].status, 'review'); assert.equal(actual.agents.find(a => a.id === run.agentId).turnId, null);
  const recovery = await call('office_cursor_start', { roomId: opened.roomId, ...task });
  await assert.rejects(admin.request(`/rooms/${opened.roomId}/cursor/${recovery.agentId}/release`, { confirmedStopped: false }));
  const released = await admin.request(`/rooms/${opened.roomId}/cursor/${recovery.agentId}/release`, { confirmedStopped: true });
  assert.equal(released.status, 'blocked');
  assert.equal((await admin.room(opened.roomId)).workItems.at(-1).evidence.at(-1).source, 'user-recovery');
});
