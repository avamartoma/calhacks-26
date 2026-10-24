import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SKIP = new Set(['node_modules', '.git']);

const FILE_TOOLS = {
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  edit: ['path', 'file_path'],
  write: ['path', 'file_path'],
  delete: ['path', 'file_path'],
  applyAgentDiff: ['path'],
};

export function ignoredSegments(relative) {
  return String(relative || '').split(/[\\/]/).some(part => SKIP.has(part));
}

export function projectRelative(folder, input) {
  const text = String(input || '');
  if (!text.trim() || text.includes('\0')) return null;
  const root = path.resolve(folder);
  const full = path.resolve(root, text);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith('..') || ignoredSegments(relative)) return null;
  return relative.split(/[\\/]/).join('/');
}

export function editPaths(name, input) {
  const keys = FILE_TOOLS[name];
  if (!keys || !input || typeof input !== 'object') return [];
  return keys.map(key => input[key]).filter(value => typeof value === 'string' && value);
}

export function busyMessage(relative) {
  return `File is busy: ${relative} is held by another session.`;
}

export function sandboxDead(error) {
  const message = String(error?.message || error).toLowerCase();
  if (message.includes('path escapes') || message.includes('path must be')) return false;
  return /sandbox|not found|expired|disconnected|is stopped|is error|timed out|timeout/.test(message);
}

export async function isGitignored(folder, relative) {
  if (ignoredSegments(relative)) return true;
  try {
    await exec('git', ['-C', folder, 'check-ignore', '-q', '--', relative], { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
