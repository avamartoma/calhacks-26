import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
export const OFFICE_SERVER = 'office';

/** The names Claude sees for office tools served by the in-process MCP server. */
export const officeToolNames = tools => tools.map(t => `mcp__${OFFICE_SERVER}__${t.name}`);

/**
 * Serves the office tools (delegate, status, message, acknowledge, update work) to a Claude
 * agent. The definitions are the same JSON Schemas Codex receives; `call` runs the same
 * handler Codex tool calls use, so both engines coordinate through one implementation.
 */
export function officeMcpServer({ createSdkMcpServer, tool }, tools, call) {
  return createSdkMcpServer({
    name: OFFICE_SERVER,
    version: '1.0.0',
    tools: tools.map(def => tool(def.name, def.description, z.fromJSONSchema(def.inputSchema).shape, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await call(def.name, args)) }] }; }
      catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
    }))
  });
}

/** Claude's TodoWrite list as the office plan Codex publishes: [{ step, status }]. */
export function todosToPlan(todos) {
  if (!Array.isArray(todos)) return null;
  const status = { pending: 'pending', in_progress: 'inProgress', completed: 'completed' };
  return todos.filter(t => t && typeof t.content === 'string').map(t => ({ step: t.content, status: status[t.status] || 'pending' }));
}

/**
 * The project's current changes as one unified diff: tracked files against HEAD plus new,
 * non-ignored files. Codex reports a turn diff; this is the Claude equivalent the review
 * gate records as an observed diff receipt. Returns '' outside a Git checkout.
 */
export async function projectDiff(folder, limit = 120000) {
  const git = async args => {
    try { return (await exec('git', args, { cwd: folder, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch (error) { return typeof error.stdout === 'string' && error.code === 1 ? error.stdout : null; } // `diff --no-index` exits 1 when files differ.
  };
  const tracked = await git(['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', '.']);
  if (tracked === null) return '';
  let diff = tracked;
  const untracked = (await git(['-c', 'core.quotepath=off', 'ls-files', '-o', '--exclude-standard', '-z', '--', '.']) || '').split('\0').filter(Boolean);
  for (const file of untracked.slice(0, 50)) {
    if (diff.length >= limit) break;
    diff += (await git(['diff', '--no-color', '--no-index', '--', '/dev/null', file])) || '';
  }
  return diff.length > limit ? diff.slice(0, limit) + `\n… diff truncated at ${limit} characters` : diff;
}
