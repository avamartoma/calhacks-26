import path from 'node:path';
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import chokidar from 'chokidar';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { readFileSync } from 'node:fs';
import { gitHttpsRemote, listProjectFiles, readProjectFile, remotePath, sameRepo } from './project-files.mjs';
import { busyMessage, contentHash, ignoredSegments, isConflictSidecar, isGitignored, isOfficeEcho, localEditsWin, projectRelative, sandboxDead, supersededByUpload } from './cloud-sync.mjs';

const hosted = JSON.parse(readFileSync(new URL('../hosted.json', import.meta.url), 'utf8'));

const HEARTBEAT_MS = 15_000;
const CLOSE_DELAY_MS = 1200;
const READY_TIMEOUT_MS = 180_000;
const SYNC_DEBOUNCE_MS = 300;
const REPLACE_RETRY_MS = 15_000;
const PULL_MS = 2_000;
const DELETE_HASH = 'delete';
const QUIET_MS = 1_500;

export function createCloud({ changed, authToken }) {
  const beats = new Map();
  const closing = new Map();
  const running = new Map();
  const generation = new Map();
  const watchers = new Map();
  const accepting = new Set();
  const replacing = new Set();
  const retries = new Map();
  const openedAt = new Map();
  const inbound = new Map();
  const ensuring = new Map();

  async function convex() {
    const url = process.env.CONVEX_URL || process.env.VITE_CONVEX_URL || hosted.convexUrl;
    const client = new ConvexHttpClient(url);
    const token = await authToken?.();
    if (typeof token === 'string' && token.split('.').length === 3) client.setAuth(token);
    return client;
  }

  function patch(room, cloud) {
    room.preview = { ...(room.preview || {}), ...cloud };
    changed();
  }

  function showLive(room, previewUrl) {
    const started = openedAt.get(room.id);
    if (started) console.log(`room ${room.id} open-to-live in ${Date.now() - started}ms`);
    patch(room, { status: 'live', previewUrl, detail: '' });
  }

  function rememberSnapshot(room, session) {
    if (session?.snapshotUrl && room.preview?.snapshotUrl !== session.snapshotUrl) patch(room, { snapshotUrl: session.snapshotUrl });
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
    openedAt.set(room.id, Date.now());
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
      const sessionId = room.preview?.sessionId;
      if (sessionId) convex().then(client => client.mutation(anyApi.sessions.stop, { sessionId })).catch(() => {});
      patch(room, { previewUrl: undefined, detail: 'Paused' });
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
    const client = await convex();
    try {
      const session = await client.query(anyApi.sessions.get, { sessionId });
      if (!alive(room.id, token)) return;
      if (session.status === 'ready') {
        await client.mutation(anyApi.sessions.heartbeat, { sessionId }).catch(() => {});
        return;
      }
      if (session.status === 'paused') {
        patch(room, { status: 'starting', previewUrl: undefined, detail: 'Paused', ...(session.snapshotUrl ? { snapshotUrl: session.snapshotUrl } : {}) });
        return;
      }
      if (session.status === 'stopped' || session.status === 'error') void replace(room, token);
    } catch {
      // Convex is unreachable. Local agents keep working.
    }
  }

  async function stopSession(sessionId) {
    if (!sessionId) return;
    await convex().then(client => client.mutation(anyApi.sessions.stop, { sessionId })).catch(() => {});
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

  function resolveProjectId(room, client) {
    const pending = ensuring.get(room.id);
    if (pending) return pending;
    const job = (async () => {
      const repoUrl = await gitHttpsRemote(room.path);
      let projectId = room.preview?.projectId;
      if (projectId) {
        try { await client.query(anyApi.projects.get, { projectId }); }
        catch { projectId = undefined; }
      }
      if (!projectId && repoUrl) {
        const projects = await client.query(anyApi.projects.list, {});
        projectId = (projects || []).find(project => sameRepo(project.repoUrl, repoUrl))?._id;
      }
      if (!projectId) {
        projectId = await client.mutation(anyApi.projects.create, {
          name: room.name || 'Project',
          description: room.path,
          ...(repoUrl ? { repoUrl } : {}),
        });
      }
      if (room.preview?.projectId !== projectId) patch(room, { projectId });
      return projectId;
    })().finally(() => {
      if (ensuring.get(room.id) === job) ensuring.delete(room.id);
    });
    ensuring.set(room.id, job);
    return job;
  }

  function shareMembers(rows) {
    return (Array.isArray(rows) ? rows : []).flatMap(row => {
      if (!row || typeof row.email !== 'string' || !row.email.trim()) return [];
      return [{ email: row.email, role: typeof row.role === 'string' ? row.role : 'viewer' }];
    });
  }

  async function share(room) {
    if (!room || room.demo) throw new Error('This project cannot be shared.');
    const client = await convex();
    const projectId = await resolveProjectId(room, client);
    const project = await client.query(anyApi.projects.get, { projectId });
    const members = shareMembers(await client.query(anyApi.sharing.list, { projectId }));
    const slug = project.shareSlug || project.slug;
    let previewUrl = '';
    try {
      const shared = await client.query(anyApi.sharing.get, { slug });
      if (shared?.previewStatus === 'live' && typeof shared.previewUrl === 'string') previewUrl = shared.previewUrl;
    } catch { /* The project record is enough when no session is live yet. */ }
    return {
      projectId,
      name: project.name,
      visibility: project.visibility === 'public' ? 'public' : 'private',
      shareSlug: slug,
      previewUrl,
      members,
    };
  }

  async function setVisibility(room, visibility) {
    if (visibility !== 'private' && visibility !== 'public') throw new Error('Visibility must be private or public.');
    const client = await convex();
    const projectId = await resolveProjectId(room, client);
    await client.mutation(anyApi.sharing.setVisibility, { projectId, visibility });
    return share(room);
  }

  function shareEmail(email) {
    const value = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new Error('Enter an email address.');
    return value;
  }

  async function invite(room, email, role) {
    if (role !== 'viewer' && role !== 'editor') throw new Error('Role must be viewer or editor.');
    const client = await convex();
    const projectId = await resolveProjectId(room, client);
    await client.mutation(anyApi.sharing.invite, { projectId, email: shareEmail(email), role });
    return share(room);
  }

  async function removeInvite(room, email) {
    const client = await convex();
    const projectId = await resolveProjectId(room, client);
    await client.mutation(anyApi.sharing.remove, { projectId, email: shareEmail(email) });
    return share(room);
  }

  async function boot(room, token) {
    const client = await convex();
    patch(room, { status: 'starting', detail: 'Opening the cloud environment', previewUrl: undefined });
    try {
      const projectId = await resolveProjectId(room, client);
      if (!alive(room.id, token)) return;

      let sessionId = room.preview?.sessionId;
      let session = null;
      if (sessionId) {
        try { session = await client.query(anyApi.sessions.get, { sessionId }); }
        catch { session = null; sessionId = undefined; }
      }
      if (session?.snapshotUrl) patch(room, { snapshotUrl: session.snapshotUrl });
      if (!session || session.status === 'stopped' || session.status === 'error' || session.status === 'paused') {
        sessionId = await client.mutation(anyApi.sessions.start, { projectId, agent: 'claude' });
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
        ensurePull(room, token);
        showLive(room, session.previewUrl);
        startHeartbeat(room, sessionId, token);
        return;
      }

      if (!repoUrl) {
        patch(room, { detail: 'Uploading the project' });
        await upload(client, room, token, sessionId);
        if (await closed(room, token, sessionId)) return;
      }
      ensurePull(room, token);

      patch(room, { detail: 'Starting the preview' });
      const preview = await client.action(anyApi.sessions.startPreview, { sessionId });
      if (await closed(room, token, sessionId)) return;
      showLive(room, preview.previewUrl);
      startHeartbeat(room, sessionId, token);
    } catch (error) {
      if (!alive(room.id, token)) { await stopSession(room.preview?.sessionId); return; }
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
    const client = await convex();
    let sessionId = room.preview?.sessionId;
    try {
      patch(room, { status: 'starting', detail: 'Restarting the cloud environment', previewUrl: undefined });
      const projectId = room.preview?.projectId;
      if (!projectId) throw new Error('Cloud project is missing');
      if (sessionId) await stopSession(sessionId);
      if (!alive(room.id, token)) return;
      sessionId = await client.mutation(anyApi.sessions.start, {
        projectId,
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
      ensurePull(room, token);
      patch(room, { detail: 'Starting the preview' });
      const preview = await client.action(anyApi.sessions.startPreview, { sessionId });
      if (await closed(room, token, sessionId)) return;
      showLive(room, preview.previewUrl);
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
      rememberSnapshot(room, session);
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
      const key = projectRelative(room.path, relative);
      if (!key || isConflictSidecar(key)) continue;
      const state = inbound.get(room.id);
      state?.syncing.add(key);
      try {
        const content = await readProjectFile(room.path, relative);
        if (content !== null) {
          const started = Date.now();
          await client.action(anyApi.sessions.writeFile, { sessionId, path: remotePath(relative), content });
          rememberUpload(state, key, contentHash(content), started);
          sent += 1;
          if (sent % 8 === 0) patch(room, { detail: `Uploading the project (${sent} files)` });
        } else skipped += 1;
      } finally {
        state?.syncing.delete(key);
      }
    }
    if (sent === 0) throw new Error('No project files to upload');
    if (skipped) patch(room, { detail: `Uploaded ${sent} files, skipped ${skipped}` });
  }

  function startSync(room, token) {
    stopSync(room.id);
    const state = {
      roomId: room.id,
      latest: new Map(),
      syncedAt: new Map(),
      syncing: new Set(),
      quiet: new Map(),
      failures: new Map(),
      cursor: 0,
      watchedAt: Date.now(),
      busy: false,
      stopped: false,
      timer: null,
    };
    inbound.set(room.id, state);
    const pending = new Map();
    const watcher = chokidar.watch(room.path, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: filePath => {
        const relative = path.relative(room.path, String(filePath));
        return ignoredSegments(relative) || isConflictSidecar(relative);
      },
    });
    const queue = (kind, filePath) => {
      const relative = path.relative(room.path, filePath);
      if (!relative || relative.startsWith('..') || ignoredSegments(relative) || isConflictSidecar(relative)) return;
      const key = remotePath(relative);
      const previous = pending.get(key);
      if (previous) clearTimeout(previous.timer);
      pending.set(key, {
        kind,
        timer: setTimeout(() => {
          pending.delete(key);
          void flush(room, token, kind, relative);
        }, SYNC_DEBOUNCE_MS),
      });
    };
    const absorb = async (kind, filePath) => {
      const relative = path.relative(room.path, filePath);
      if (!relative || relative.startsWith('..') || ignoredSegments(relative) || isConflictSidecar(relative)) return;
      const key = remotePath(relative);
      const expected = state.quiet.get(key);
      if (expected && !state.stopped) {
        const sameWrite = kind === 'write' && expected.hash !== DELETE_HASH && await sameQuietWrite(room.path, relative, expected.hash);
        const sameDelete = kind === 'delete' && expected.hash === DELETE_HASH;
        if (state.quiet.get(key) === expected) {
          clearTimeout(expected.timer);
          state.quiet.delete(key);
        }
        if (sameWrite || sameDelete) {
          await markSynced(state, localPath(room.path, key), key);
          return;
        }
      }
      if (!alive(room.id, token) || !accepting.has(room.id) || state.stopped) return;
      queue(kind, filePath);
    };
    watcher.on('add', filePath => { void absorb('write', filePath); });
    watcher.on('change', filePath => { void absorb('write', filePath); });
    watcher.on('unlink', filePath => { void absorb('delete', filePath); });
    watchers.set(room.id, { watcher, pending });
  }

  function ensurePull(room, token) {
    const state = inbound.get(room.id);
    if (!state || state.stopped || state.timer) return;
    state.timer = setInterval(() => { void pull(room, token); }, PULL_MS);
    void pull(room, token);
  }

  function stopSync(roomId) {
    const state = inbound.get(roomId);
    if (state) {
      state.stopped = true;
      if (state.timer) clearInterval(state.timer);
      for (const item of state.quiet.values()) clearTimeout(item.timer);
      inbound.delete(roomId);
    }
    const entry = watchers.get(roomId);
    if (!entry) return;
    for (const item of entry.pending.values()) clearTimeout(item.timer);
    entry.watcher.close().catch(() => {});
    watchers.delete(roomId);
  }

  async function flush(room, token, kind, relative) {
    if (!alive(room.id, token) || !accepting.has(room.id)) return;
    if (isConflictSidecar(relative)) return;
    if (await isGitignored(room.path, relative)) return;
    if (!alive(room.id, token) || !accepting.has(room.id)) return;
    const sessionId = room.preview?.sessionId;
    if (!sessionId) return;
    const client = await convex();
    const remote = remotePath(relative);
    const state = inbound.get(room.id);
    state?.syncing.add(remote);
    try {
      if (kind === 'delete') {
        const started = Date.now();
        await client.action(anyApi.sessions.deleteFile, { sessionId, path: remote });
        rememberUpload(state, remote, DELETE_HASH, started);
      } else {
        const content = await readProjectFile(room.path, relative);
        if (content === null) return;
        const started = Date.now();
        await client.action(anyApi.sessions.writeFile, { sessionId, path: remote, content });
        rememberUpload(state, remote, contentHash(content), started);
      }
    } catch (error) {
      if (!alive(room.id, token) || !accepting.has(room.id)) return;
      if (sandboxDead(error)) { void replace(room, token); return; }
      patch(room, { detail: `Could not sync ${remote}` });
    } finally {
      state?.syncing.delete(remote);
    }
  }

  async function pull(room, token) {
    const state = inbound.get(room.id);
    if (!state || state.busy || state.stopped) return;
    if (!alive(room.id, token) || !accepting.has(room.id)) return;
    const projectId = room.preview?.projectId;
    const sessionId = room.preview?.sessionId;
    if (!projectId || !sessionId) return;
    state.busy = true;
    try {
      const client = await convex();
      if (state.stopped || !alive(room.id, token) || !accepting.has(room.id)) return;
      const session = await client.query(anyApi.sessions.get, { sessionId });
      if (state.stopped || !alive(room.id, token) || !accepting.has(room.id)) return;
      if (session?.status !== 'ready') return;
      const rows = await client.query(anyApi.fileChanges.since, { projectId, after: state.cursor });
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (state.stopped || !alive(room.id, token) || !accepting.has(room.id)) return;
        const failureKey = `${row?.path}:${row?.at}`;
        try {
          const handled = await applyInbound(room, token, client, sessionId, state, row);
          if (!handled || state.stopped) return;
          state.failures.delete(failureKey);
        } catch (error) {
          if (state.stopped || !alive(room.id, token) || !accepting.has(room.id)) return;
          if (sandboxDead(error)) { void replace(room, token); return; }
          const count = (state.failures.get(failureKey) || 0) + 1;
          state.failures.set(failureKey, count);
          patch(room, { detail: `Could not apply ${row?.path || 'file'}` });
          if (count < 3) return;
        }
        if (typeof row?.at === 'number') state.cursor = Math.max(state.cursor, row.at);
      }
    } catch {
      // Convex is unreachable. Local agents keep working.
    } finally {
      state.busy = false;
    }
  }

  async function applyInbound(room, token, client, sessionId, state, row) {
    if (state.stopped || !alive(room.id, token) || !accepting.has(room.id)) return false;
    if (!row || (row.op !== 'write' && row.op !== 'delete') || typeof row.path !== 'string' || typeof row.at !== 'number') return true;
    const relative = projectRelative(room.path, row.path);
    if (!relative || isConflictSidecar(relative)) return true;
    const written = state.latest.get(relative);
    if (isOfficeEcho(row, written) || supersededByUpload(row.at, written?.finishedAt)) return true;
    const full = localPath(room.path, relative);
    if (!full) return true;
    const info = await readLocalInfo(full);
    if (info && (info.isSymbolicLink() || info.isDirectory())) return true;
    if (state.syncing.has(relative)) return false;
    const pending = watchers.get(room.id)?.pending.get(relative);
    const synced = state.syncedAt.get(relative);
    const conflict = localEditsWin({
      pendingWrite: Boolean(pending),
      localMtime: info?.isFile() ? info.mtimeMs : undefined,
      uploadedAt: synced ?? state.watchedAt,
    });
    const adopted = typeof synced === 'number' && synced >= state.watchedAt;
    if (!conflict && !adopted && info?.isFile() && info.mtimeMs > row.at) return true;
    if (row.op === 'delete') {
      if (conflict && info) {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(`${full}.remote`, '', 'utf8');
        recordConflict(room, relative, row.at);
        return true;
      }
      holdQuiet(state, relative, DELETE_HASH);
      await unlink(full).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      state.syncedAt.set(relative, Date.now());
      clearConflict(room, relative);
      return true;
    }
    const read = await client.action(anyApi.sessions.readFile, { sessionId, path: row.path });
    const content = typeof read?.content === 'string' ? read.content : '';
    if (state.stopped || !alive(room.id, token) || !accepting.has(room.id)) return false;
    if (conflict) {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(`${full}.remote`, content, 'utf8');
      recordConflict(room, relative, row.at);
      return true;
    }
    holdQuiet(state, relative, contentHash(content));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    await markSynced(state, full, relative);
    clearConflict(room, relative);
    return true;
  }

  function rememberUpload(state, key, hash, startedAt) {
    if (!state || state.stopped || inbound.get(state.roomId) !== state) return;
    const finished = Date.now();
    state.latest.set(key, { hash, startedAt, finishedAt: finished });
    state.syncedAt.set(key, finished);
  }

  function recordConflict(room, filePath, at) {
    const next = listedConflicts(room).filter(item => item.path !== filePath);
    next.push({ path: filePath, at });
    patch(room, { conflicts: next });
  }

  function clearConflict(room, filePath) {
    const current = listedConflicts(room);
    if (!current.some(item => item.path === filePath)) return;
    patch(room, { conflicts: current.filter(item => item.path !== filePath) });
  }

  async function claim(room, paths) {
    if (!room || room.demo) return null;
    const projectId = room.preview?.projectId;
    const sessionId = room.preview?.sessionId;
    if (!projectId || !sessionId) return null;
    const client = await convex();
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

  return { open, close, claim, share, setVisibility, invite, removeInvite };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function listedConflicts(room) {
  return Array.isArray(room.preview?.conflicts) ? room.preview.conflicts.filter(item => item?.path) : [];
}

function localPath(folder, relative) {
  const root = path.resolve(folder);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function readLocalInfo(full) {
  try {
    return await lstat(full);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function holdQuiet(state, key, hash) {
  const existing = state.quiet.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const current = state.quiet.get(key);
    if (current?.hash === hash) state.quiet.delete(key);
  }, QUIET_MS);
  state.quiet.set(key, { hash, timer });
}

async function markSynced(state, full, key) {
  if (!state || state.stopped) return;
  let at = Date.now();
  if (full) {
    const info = await readLocalInfo(full);
    if (info?.isFile() && info.mtimeMs > at) at = info.mtimeMs;
  }
  state.syncedAt.set(key, at);
}

async function sameQuietWrite(folder, relative, hash) {
  const content = await readProjectFile(folder, relative);
  return content !== null && contentHash(content) === hash;
}
