import path from 'node:path';
import chokidar from 'chokidar';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { gitHttpsRemote, listProjectFiles, readProjectFile, remotePath, sameRepo } from './project-files.mjs';
import { busyMessage, ignoredSegments, isGitignored, projectRelative, sandboxDead } from './cloud-sync.mjs';

const HEARTBEAT_MS = 15_000;
const CLOSE_DELAY_MS = 1200;
const READY_TIMEOUT_MS = 180_000;
const SYNC_DEBOUNCE_MS = 300;
const REPLACE_RETRY_MS = 15_000;

export function createCloud({ changed, userId }) {
  const beats = new Map();
  const closing = new Map();
  const running = new Map();
  const generation = new Map();
  const watchers = new Map();
  const accepting = new Set();
  const replacing = new Set();
  const retries = new Map();

  function convex() {
    const url = process.env.CONVEX_URL || process.env.VITE_CONVEX_URL || 'http://127.0.0.1:3210';
    return new ConvexHttpClient(url);
  }

  function patch(room, cloud) {
    room.cloud = { ...(room.cloud || {}), ...cloud };
    changed();
  }

  function alive(roomId, token) {
    return generation.get(roomId) === token;
  }

  function open(room) {
    if (!room || room.demo) return { skipped: true };
    const pending = closing.get(room.id);
    if (pending) {
      clearTimeout(pending);
      closing.delete(room.id);
    }
    if (running.has(room.id)) return { started: true };
    const token = (generation.get(room.id) || 0) + 1;
    generation.set(room.id, token);
    const job = boot(room, token).finally(() => {
      if (running.get(room.id) === job) running.delete(room.id);
    });
    running.set(room.id, job);
    return { started: true };
  }

  function close(room) {
    if (!room || room.demo) return { skipped: true };
    if (closing.has(room.id)) return { scheduled: true };
    const timer = setTimeout(() => {
      closing.delete(room.id);
      const token = (generation.get(room.id) || 0) + 1;
      generation.set(room.id, token);
      disarm(room.id);
      const sessionId = room.cloud?.sessionId;
      if (sessionId) convex().mutation(anyApi.sessions.stop, { sessionId }).catch(() => {});
      patch(room, { previewUrl: undefined, detail: 'Cloud environment closed' });
    }, CLOSE_DELAY_MS);
    closing.set(room.id, timer);
    return { scheduled: true };
  }

  function disarm(roomId) {
    const beat = beats.get(roomId);
    if (beat) clearInterval(beat);
    beats.delete(roomId);
    const retry = retries.get(roomId);
    if (retry) clearTimeout(retry);
    retries.delete(roomId);
    accepting.delete(roomId);
    stopSync(roomId);
  }

  function startHeartbeat(room, sessionId, token) {
    const existing = beats.get(room.id);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => { void pulse(room, sessionId, token, timer); }, HEARTBEAT_MS);
    beats.set(room.id, timer);
  }

  async function pulse(room, sessionId, token, timer) {
    if (!alive(room.id, token)) {
      clearInterval(timer);
      beats.delete(room.id);
      return;
    }
    const client = convex();
    try {
      const session = await client.query(anyApi.sessions.get, { sessionId });
      if (!alive(room.id, token)) return;
      if (session.status === 'ready') {
        await client.mutation(anyApi.sessions.heartbeat, { sessionId }).catch(() => {});
        return;
      }
      if (session.status === 'stopped' || session.status === 'error') void replace(room, token);
    } catch {
      // Convex is unreachable. Local agents keep working.
    }
  }

  async function stopSession(sessionId) {
    if (!sessionId) return;
    await convex().mutation(anyApi.sessions.stop, { sessionId }).catch(() => {});
  }

  async function closed(room, token, sessionId) {
    if (alive(room.id, token)) return false;
    await stopSession(sessionId);
    return true;
  }

  function arm(room, token) {
    accepting.add(room.id);
    startSync(room, token);
  }

  async function boot(room, token) {
    const client = convex();
    patch(room, { status: 'starting', detail: 'Opening the cloud environment', previewUrl: undefined });
    try {
      const owner = userId() || 'local';
      const repoUrl = await gitHttpsRemote(room.path);
      let projectId = room.cloud?.projectId;
      if (projectId) {
        try { await client.query(anyApi.projects.get, { projectId }); }
        catch { projectId = undefined; }
      }
      if (!projectId && repoUrl) {
        const projects = await client.query(anyApi.projects.list, {});
        projectId = (projects || []).find(project => sameRepo(project.repoUrl, repoUrl))?._id;
      }
      if (!alive(room.id, token)) return;
      if (!projectId) {
        projectId = await client.mutation(anyApi.projects.create, {
          name: room.name || 'Project',
          ownerId: owner,
          description: room.path,
          ...(repoUrl ? { repoUrl } : {}),
        });
      }
      if (!alive(room.id, token)) return;
      patch(room, { projectId });

      let sessionId = room.cloud?.sessionId;
      let session = null;
      if (sessionId) {
        try { session = await client.query(anyApi.sessions.get, { sessionId }); }
        catch { session = null; sessionId = undefined; }
      }
      if (!session || session.status === 'stopped' || session.status === 'error') {
        sessionId = await client.mutation(anyApi.sessions.start, { projectId, userId: owner, agent: 'claude' });
        patch(room, { sessionId, detail: 'Starting the sandbox' });
        if (!alive(room.id, token)) { await stopSession(sessionId); return; }
        session = await watch(client, room, token, sessionId);
      } else if (session.status === 'provisioning') {
        patch(room, { sessionId, detail: 'Starting the sandbox' });
        session = await watch(client, room, token, sessionId);
      }
      if (!session || await closed(room, token, sessionId)) return;
      arm(room, token);

      if (session.previewStatus === 'live' && session.previewUrl) {
        patch(room, { status: 'live', previewUrl: session.previewUrl, detail: '' });
        startHeartbeat(room, sessionId, token);
        return;
      }

      if (!repoUrl) {
        patch(room, { detail: 'Uploading the project' });
        await upload(client, room, token, sessionId);
        if (await closed(room, token, sessionId)) return;
      }

      patch(room, { detail: 'Starting the preview' });
      const preview = await client.action(anyApi.sessions.startPreview, { sessionId });
      if (await closed(room, token, sessionId)) return;
      patch(room, { status: 'live', previewUrl: preview.previewUrl, detail: '' });
      startHeartbeat(room, sessionId, token);
    } catch (error) {
      if (!alive(room.id, token)) { await stopSession(room.cloud?.sessionId); return; }
      accepting.delete(room.id);
      stopSync(room.id);
      patch(room, { status: 'error', detail: error instanceof Error ? error.message : 'Cloud environment failed' });
    }
  }

  async function replace(room, token) {
    if (!alive(room.id, token) || replacing.has(room.id)) return;
    replacing.add(room.id);
    const pendingRetry = retries.get(room.id);
    if (pendingRetry) clearTimeout(pendingRetry);
    retries.delete(room.id);
    accepting.delete(room.id);
    stopSync(room.id);
    const client = convex();
    let sessionId = room.cloud?.sessionId;
    try {
      patch(room, { status: 'starting', detail: 'Restarting the cloud environment', previewUrl: undefined });
      const projectId = room.cloud?.projectId;
      if (!projectId) throw new Error('Cloud project is missing');
      if (sessionId) await stopSession(sessionId);
      if (!alive(room.id, token)) return;
      sessionId = await client.mutation(anyApi.sessions.start, {
        projectId,
        userId: userId() || 'local',
        agent: 'claude',
      });
      patch(room, { sessionId, detail: 'Starting the sandbox' });
      if (!alive(room.id, token)) { await stopSession(sessionId); return; }
      const session = await watch(client, room, token, sessionId);
      if (!session || await closed(room, token, sessionId)) return;
      arm(room, token);
      patch(room, { detail: 'Syncing the project' });
      await upload(client, room, token, sessionId);
      if (await closed(room, token, sessionId)) return;
      patch(room, { detail: 'Starting the preview' });
      const preview = await client.action(anyApi.sessions.startPreview, { sessionId });
      if (await closed(room, token, sessionId)) return;
      patch(room, { status: 'live', previewUrl: preview.previewUrl, detail: '' });
      startHeartbeat(room, sessionId, token);
    } catch (error) {
      if (!alive(room.id, token)) { await stopSession(sessionId); return; }
      accepting.delete(room.id);
      stopSync(room.id);
      patch(room, { status: 'error', detail: error instanceof Error ? error.message : 'Cloud environment failed' });
      const timer = setTimeout(() => {
        retries.delete(room.id);
        if (alive(room.id, token)) void replace(room, token);
      }, REPLACE_RETRY_MS);
      retries.set(room.id, timer);
    } finally {
      replacing.delete(room.id);
    }
  }

  async function watch(client, room, token, sessionId) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!alive(room.id, token)) return null;
      const session = await client.query(anyApi.sessions.get, { sessionId });
      if (session.status === 'ready') return session;
      if (session.status === 'error') throw new Error('The sandbox failed to start');
      if (session.status === 'stopped') throw new Error('The sandbox stopped');
      await delay(2000);
    }
    throw new Error('The sandbox was not ready in time');
  }

  async function upload(client, room, token, sessionId) {
    const files = await listProjectFiles(room.path);
    let sent = 0;
    let skipped = 0;
    for (const relative of files) {
      if (!alive(room.id, token)) return;
      const content = await readProjectFile(room.path, relative);
      if (content === null) { skipped += 1; continue; }
      await client.action(anyApi.sessions.writeFile, { sessionId, path: remotePath(relative), content });
      sent += 1;
      if (sent % 8 === 0) patch(room, { detail: `Uploading the project (${sent} files)` });
    }
    if (sent === 0) throw new Error('No project files to upload');
    if (skipped) patch(room, { detail: `Uploaded ${sent} files, skipped ${skipped}` });
  }

  function startSync(room, token) {
    stopSync(room.id);
    const pending = new Map();
    const watcher = chokidar.watch(room.path, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: filePath => ignoredSegments(path.relative(room.path, String(filePath))),
    });
    const queue = (kind, filePath) => {
      const relative = path.relative(room.path, filePath);
      if (!relative || relative.startsWith('..') || ignoredSegments(relative)) return;
      const key = remotePath(relative);
      const previous = pending.get(key);
      if (previous) clearTimeout(previous);
      pending.set(key, setTimeout(() => {
        pending.delete(key);
        void flush(room, token, kind, relative);
      }, SYNC_DEBOUNCE_MS));
    };
    watcher.on('add', filePath => queue('write', filePath));
    watcher.on('change', filePath => queue('write', filePath));
    watcher.on('unlink', filePath => queue('delete', filePath));
    watchers.set(room.id, { watcher, pending });
  }

  function stopSync(roomId) {
    const entry = watchers.get(roomId);
    if (!entry) return;
    for (const timer of entry.pending.values()) clearTimeout(timer);
    entry.watcher.close().catch(() => {});
    watchers.delete(roomId);
  }

  async function flush(room, token, kind, relative) {
    if (!alive(room.id, token) || !accepting.has(room.id)) return;
    if (await isGitignored(room.path, relative)) return;
    if (!alive(room.id, token) || !accepting.has(room.id)) return;
    const sessionId = room.cloud?.sessionId;
    if (!sessionId) return;
    const client = convex();
    const remote = remotePath(relative);
    try {
      if (kind === 'delete') {
        await client.action(anyApi.sessions.deleteFile, { sessionId, path: remote });
      } else {
        const content = await readProjectFile(room.path, relative);
        if (content === null) return;
        await client.action(anyApi.sessions.writeFile, { sessionId, path: remote, content });
      }
    } catch (error) {
      if (!alive(room.id, token) || !accepting.has(room.id)) return;
      if (sandboxDead(error)) { void replace(room, token); return; }
      patch(room, { detail: `Could not sync ${remote}` });
    }
  }

  async function claim(room, paths) {
    if (!room || room.demo) return null;
    const projectId = room.cloud?.projectId;
    const sessionId = room.cloud?.sessionId;
    if (!projectId || !sessionId) return null;
    const client = convex();
    for (const input of paths || []) {
      const relative = projectRelative(room.path, input);
      if (!relative) continue;
      let result;
      try { result = await client.mutation(anyApi.leases.acquire, { projectId, path: relative, sessionId }); }
      catch { return null; }
      if (result?.ok === false) return busyMessage(relative);
    }
    return null;
  }

  return { open, close, claim };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
