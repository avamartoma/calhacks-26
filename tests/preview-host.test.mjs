import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { officeHostAllowed, officeHostMiddleware } from '../server/host.mjs';

const root = path.resolve('.');
const e2bHost = '3000-preview123.e2b.app';

function ask(port, host, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      agent: false,
      headers: { host, connection: 'close', ...(origin ? { origin } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(sandbox) {
  const app = express();
  let port = 0;
  app.use((req, res, next) => officeHostMiddleware({ port, sandbox })(req, res, next));
  app.get('/', (_req, res) => res.type('text').send('ok'));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(server);
    });
    server.once('error', reject);
  });
}

test('an E2B host is refused unless the process was launched as a sandbox', () => {
  assert.deepEqual(officeHostAllowed({ host: e2bHost, origin: `https://${e2bHost}`, port: 4314, sandbox: undefined }), { ok: false, error: 'Local access only' });
  assert.deepEqual(officeHostAllowed({ host: e2bHost, port: 4314, sandbox: 'true' }), { ok: false, error: 'Local access only' });
  assert.deepEqual(officeHostAllowed({ host: 'evil.e2b.app.attacker.com', port: 4314, sandbox: '1' }), { ok: false, error: 'Local access only' });
  assert.deepEqual(officeHostAllowed({ host: 'not-e2b.app', port: 4314, sandbox: '1' }), { ok: false, error: 'Local access only' });
  assert.equal(officeHostAllowed({ host: e2bHost, port: 4314, sandbox: '1' }).ok, true);
  assert.equal(officeHostAllowed({ host: e2bHost, origin: `https://${e2bHost}`, port: 4314, sandbox: '1' }).ok, true);
  assert.deepEqual(officeHostAllowed({ host: e2bHost, origin: 'https://other.e2b.app', port: 4314, sandbox: '1' }), { ok: false, error: 'Origin not allowed' });
  assert.deepEqual(officeHostAllowed({ host: e2bHost, origin: `http://${e2bHost}`, port: 4314, sandbox: '1' }), { ok: false, error: 'Origin not allowed' });
  assert.equal(officeHostAllowed({ host: '127.0.0.1:4314', origin: 'http://127.0.0.1:4314', port: 4314, sandbox: undefined }).ok, true);
  assert.deepEqual(officeHostAllowed({ host: 'evil.example', port: 4314, sandbox: '1' }), { ok: false, error: 'Local access only' });
});

test('the office middleware serves an E2B preview host only when E2B_SANDBOX=1', async () => {
  const closed = await listen(undefined);
  const open = await listen('1');
  try {
    const closedPort = closed.address().port;
    const openPort = open.address().port;
    const blocked = await ask(closedPort, e2bHost, `https://${e2bHost}`);
    assert.equal(blocked.status, 403);
    assert.match(blocked.body, /Local access only/);
    const local = await ask(closedPort, `127.0.0.1:${closedPort}`);
    assert.equal(local.status, 200);

    const preview = await ask(openPort, e2bHost);
    assert.equal(preview.status, 200);
    const matching = await ask(openPort, e2bHost, `https://${e2bHost}`);
    assert.equal(matching.status, 200);
    const mismatch = await ask(openPort, e2bHost, 'https://other.e2b.app');
    assert.equal(mismatch.status, 403);
    assert.match(mismatch.body, /Origin not allowed/);
    const stranger = await ask(openPort, 'evil.example');
    assert.equal(stranger.status, 403);
    assert.match(stranger.body, /Local access only/);
  } finally {
    await Promise.all([closed, open].map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('sessions.start launches the sandbox with E2B_SANDBOX=1', async () => {
  const source = await readFile(path.join(root, 'convex/lib/sandbox.ts'), 'utf8');
  assert.match(source, /export function sandboxProcessEnv\(\)[\s\S]*?E2B_SANDBOX: "1"/);
  assert.match(source, /envs: sandboxProcessEnv\(\)/);
  assert.match(source, /return \{\s*\.\.\.sandboxProcessEnv\(\)/);
});
