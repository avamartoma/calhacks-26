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
import { seed, selfDriven } from '../server/domain.mjs';
import { initOffice } from '../server/orchestration.mjs';
import { attributionOf } from '../server/run-doc.mjs';

const task = { task: 'Make search keyboard accessible', acceptanceCriteria: ['Search is reachable with Tab'] };

test('a Codex CLI session takes the shared writer lock and labels its evidence', () => {
  const state = seed(path.resolve('.'));
  const room = initOffice(state.rooms[0]); room.demo = false; room.agents = []; room.workItems = [];
  const desk = createCursorDesk({ state, changed() {} });
  const run = desk.start(room, task, 'codex-cli');
  assert.ok(selfDriven(room.agents[0])); assert.match(run.instruction, /office_codex_update/);
  assert.throws(() => desk.start(room, task, 'claude-code'), /owned by a Codex CLI assignment.*office_codex_finish/);
  desk.update(room, run.agentId, { summary: 'Progress', tests: '1 passing' }, 'codex-cli');
  const receipt = room.workItems[0].evidence[0];
  assert.equal(receipt.source, 'codex-reported'); assert.equal(attributionOf(receipt, room.workItems[0]), 'self-reported');
});

test('stdio MCP runs a Codex CLI assignment', { timeout: 30000 }, async t => {
  const root = path.resolve('.'); const temp = await mkdtemp(path.join(os.tmpdir(), 'iteration1-codex-cli-'));
  const base = 'http://127.0.0.1:44321';
  const child = spawn(process.execPath, ['server/index.mjs', '--production'], { cwd: root, windowsHide: true, env: { ...process.env, PORT: '44321', OFFICE_TEAM_PORT: '44421', OFFICE_DATA_DIR: temp, OFFICE_CODEX_HOME: path.join(temp, 'codex'), OFFICE_CLAUDE_HOME: path.join(temp, 'claude'), OFFICE_CODEX_BIN: process.execPath, OFFICE_CODEX_ARGS: JSON.stringify([path.join(root, 'tests/fake-codex.mjs')]), OFFICE_FIXTURE_SIGNED_OUT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let client;
  t.after(async () => {
    await client?.close();
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'iteration1-codex-cli-')) await rm(temp, { recursive: true, force: true });
  });
  let errors = ''; child.stderr.on('data', d => errors += d);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(errors || 'Startup timed out')), 10000); child.stdout.on('data', d => { if (String(d).includes('Iteration1 office')) { clearTimeout(timer); resolve(); } }); child.once('exit', () => { clearTimeout(timer); reject(new Error(errors || 'Server exited')); }); });
  client = new Client({ name: 'iteration1-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'scripts/codex-mcp.mjs')], env: { ITERATION1_URL: base, ITERATION1_PROJECT: temp }, stderr: 'pipe' }));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 8); assert.ok(names.includes('office_codex_start') && names.includes('office_codex_finish'));
  const call = async (name, args) => { const res = await client.callTool({ name, arguments: args }); return JSON.parse(res.content[0].text); };
  const opened = await call('office_open', {}); assert.equal(opened.name, 'Codex CLI office');
  const run = await call('office_codex_start', { roomId: opened.roomId, ...task }); assert.ok(run.agentId, JSON.stringify(run));
  const admin = createOfficeClient({ url: base, project: temp });
  await assert.rejects(admin.request(`/rooms/${opened.roomId}/agents/${run.agentId}/stop`, {}), /Stop execution in Codex CLI, then use office_codex_finish/);
  const finished = await call('office_codex_finish', { roomId: opened.roomId, agentId: run.agentId, summary: 'Needs verification.', outcome: 'review' });
  assert.equal(finished.verified, false);
  assert.equal((await admin.room(opened.roomId)).agents.find(a => a.id === run.agentId).provider, 'codex-cli');
});
