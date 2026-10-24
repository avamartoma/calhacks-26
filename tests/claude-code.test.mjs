import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCursorDesk } from '../server/cursor.mjs';
import { createOfficeClient } from '../server/office-client.mjs';
import { seed, selfDriven, external } from '../server/domain.mjs';
import { initOffice } from '../server/orchestration.mjs';
import { attributionOf } from '../server/run-doc.mjs';

function fixture() {
  const state = seed(path.resolve('.'));
  const room = initOffice(state.rooms[0]); room.demo = false; room.agents = []; room.workItems = []; room.goal = '';
  return { state, room, desk: createCursorDesk({ state, changed() {} }) };
}
const task = { task: 'Make search keyboard accessible', acceptanceCriteria: ['Search is reachable with Tab'] };

test('a Claude Code session owns a desk, labels its evidence and is self-driven', () => {
  const { room, desk } = fixture();
  const run = desk.start(room, { ...task, model: 'claude-opus-5-5' }, 'claude-code');
  const worker = room.agents[0];
  assert.equal(worker.provider, 'claude-code'); assert.equal(worker.modelSource, 'claude-reported');
  assert.ok(selfDriven(worker)); assert.ok(external(worker));
  assert.match(run.instruction, /office_claude_update/);
  desk.update(room, run.agentId, { summary: 'Added a label', tests: 'Reported: 1 passing' }, 'claude-code');
  const receipt = room.workItems[0].evidence[0];
  assert.equal(receipt.source, 'claude-reported'); assert.equal(attributionOf(receipt, room.workItems[0]), 'self-reported');
  const done = desk.finish(room, run.agentId, { summary: 'Please verify', outcome: 'review' }, 'claude-code');
  assert.equal(done.verified, false); assert.equal(worker.turnId, null);
});

test('reports must come through the tool that opened the desk', () => {
  const { room, desk } = fixture();
  const run = desk.start(room, task, 'claude-code');
  assert.match(room.agents[0].model, /Claude Code · model not reported/);
  assert.throws(() => desk.update(room, run.agentId, { summary: 'From Cursor' }), /No open Cursor assignment/);
  assert.throws(() => desk.start(room, task, 'unknown'), /Unknown reporting tool/);
});

test('Cursor and Claude Code share one writer lock per project', () => {
  const { room, desk } = fixture();
  const run = desk.start(room, task, 'claude-code');
  assert.throws(() => desk.start(room, task), /owned by a Claude Code assignment.*office_claude_finish/);
  assert.throws(() => desk.assertAvailable(room), /Claude Code/);
  desk.release(room, run.agentId, { confirmedStopped: true }, 'claude-code');
  assert.equal(room.workItems[0].evidence.at(-1).source, 'user-recovery');
  assert.match(room.workItems[0].blocker, /Claude Code execution has stopped/);
  desk.start(room, task);
  assert.throws(() => desk.start(room, task, 'claude-code'), /owned by a Cursor assignment/);
});

test('stdio MCP runs a Claude Code assignment without an API key', { timeout: 30000 }, async t => {
  const root = path.resolve('.'); const temp = await mkdtemp(path.join(os.tmpdir(), 'iteration1-claude-code-'));
  const base = 'http://127.0.0.1:44320';
  const { ANTHROPIC_API_KEY, ...env } = process.env;
  const child = spawn(process.execPath, ['server/index.mjs', '--production'], { cwd: root, windowsHide: true, env: { ...env, PORT: '44320', OFFICE_DATA_DIR: temp, OFFICE_CLAUDE_KEY_FILE: path.join(temp, 'no-key.json'), OFFICE_CODEX_HOME: path.join(temp, 'codex'), OFFICE_CODEX_BIN: process.execPath, OFFICE_CODEX_ARGS: JSON.stringify([path.join(root, 'tests/fake-codex.mjs')]), OFFICE_FIXTURE_SIGNED_OUT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let client;
  t.after(async () => {
    await client?.close();
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'iteration1-claude-code-')) await rm(temp, { recursive: true, force: true });
  });
  let errors = ''; child.stderr.on('data', d => errors += d);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(errors || 'Startup timed out')), 10000); child.stdout.on('data', d => { if (String(d).includes('Iteration1 office')) { clearTimeout(timer); resolve(); } }); child.once('exit', () => { clearTimeout(timer); reject(new Error(errors || 'Server exited')); }); });
  client = new Client({ name: 'iteration1-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'scripts/claude-mcp.mjs')], env: { ITERATION1_URL: base, ITERATION1_PROJECT: temp }, stderr: 'pipe' }));
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['office_claude_finish', 'office_claude_start', 'office_claude_update', 'office_dispatch', 'office_identify', 'office_open', 'office_run_doc', 'office_status']);
  const call = async (name, args) => { const res = await client.callTool({ name, arguments: args }); return { ...JSON.parse(res.content[0].text), isError: res.isError }; };
  const opened = await call('office_open', {}); assert.ok(opened.roomId); assert.equal(opened.name, 'Claude Code office');
  const run = await call('office_claude_start', { roomId: opened.roomId, ...task, model: 'claude-opus-5-5' }); assert.ok(run.agentId, JSON.stringify(run));
  const admin = createOfficeClient({ url: base, project: temp });
  await assert.rejects(admin.request(`/rooms/${opened.roomId}/agents/${run.agentId}/stop`, {}), /Stop execution in Claude Code, then use office_claude_finish/);
  await assert.rejects(admin.request(`/rooms/${opened.roomId}/cursor/${run.agentId}/update`, { summary: 'Wrong tool' }), /No open Cursor assignment/);
  await call('office_claude_update', { roomId: opened.roomId, agentId: run.agentId, summary: 'Fixture progress', diff: '+label' });
  const finished = await call('office_claude_finish', { roomId: opened.roomId, agentId: run.agentId, summary: 'Fixture finished. Needs verification.', outcome: 'review' });
  assert.equal(finished.verified, false); assert.equal(finished.status, 'review');
  const actual = await admin.room(opened.roomId);
  const worker = actual.agents.find(a => a.id === run.agentId);
  assert.equal(worker.provider, 'claude-code'); assert.equal(worker.model, 'claude-opus-5-5'); assert.equal(worker.turnId, null);
  assert.ok(actual.workItems[0].evidence.some(e => e.source === 'claude-reported'));
});
