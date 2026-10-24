import path from 'node:path';
import { realpath } from 'node:fs/promises';

export function createOfficeClient({ url = 'http://127.0.0.1:4314', project = process.cwd(), fetchImpl = fetch } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Fourteenth URL must be a local HTTP origin.');
  const base = parsed.origin;
  let cookie;
  async function localFetch(url, options) {
    try { return await fetchImpl(url, options); }
    catch { throw new Error(`Fourteenth is unavailable at ${base}. Start it with npm start, then retry.`); }
  }
  async function session() {
    const res = await localFetch(base, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    cookie = res.headers.get('set-cookie')?.split(';')[0];
    if (!cookie?.startsWith(`office_session_${parsed.port || '80'}=`) && !cookie?.startsWith('office_session=')) throw new Error('Start Fourteenth before connecting Cursor.');
  }
  async function request(route, body, retry = true) {
    if (!cookie) await session();
    const res = await localFetch(base + '/api' + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Cookie: cookie, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.status === 401 && retry) { await session(); return request(route, body, false); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Office request failed (${res.status})`);
    return data;
  }
  async function rooms() {
    const actual = await realpath(project);
    const state = await request('/state');
    return state.rooms.filter(room => !room.demo && path.relative(actual, room.path) === '');
  }
  async function room(id) { const found = (await rooms()).find(r => r.id === id); if (!found) throw new Error('Choose a live office belonging to this Cursor workspace.'); return found; }
  return { request, rooms, room,
    async open(name) { const existing = await rooms(); return existing[0] || (await request('/rooms', { name, path: await realpath(project), demo: false })).room; },
    async dispatch(id, body) { await room(id); return request(`/rooms/${encodeURIComponent(id)}/dispatch`, body); },
    async cursorStart(id, body) { await room(id); return request(`/rooms/${encodeURIComponent(id)}/cursor/start`, body); },
    async cursorReport(id, agentId, operation, body) { await room(id); if (!['update', 'finish'].includes(operation)) throw new Error('Invalid Cursor operation'); return request(`/rooms/${encodeURIComponent(id)}/cursor/${encodeURIComponent(agentId)}/${operation}`, body); }
  };
}

export function summarizeOffice(room, includeEvidence = false) {
  return {
    roomId: room.id, name: room.name, goal: room.goal, paused: room.paused,
    tasks: room.workItems.map(({ evidence, ...item }) => ({ ...item, evidenceCount: evidence.length,
      ...(includeEvidence ? { evidence: evidence.slice(-8).map(e => ({ ...e, text: e.text.slice(0, 4000), truncated: e.text.length > 4000 })), omittedReceipts: Math.max(0, evidence.length - 8) } : {}) })),
    agents: room.agents.filter(a => a.status !== 'ejected').map(a => ({ id: a.id, name: a.name, title: a.title, model: a.effectiveModel || a.model, modelSource: a.modelSource, provider: a.provider || 'codex', assignmentOpen: !!a.turnId, status: a.status, task: a.task, latest: a.events.slice(-2).map(e => ({ kind: e.kind, text: e.text.slice(-2000), time: e.time })) })),
    handoffs: room.messages.slice(-3).map(m => ({ ...m, text: m.text.slice(0, 2000) }))
  };
}
