import { execFile } from 'node:child_process';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SKIP = new Set(['node_modules', '.git']);
const MAX_BYTES = 512 * 1024;

export function httpsGitUrl(raw) {
  const text = String(raw || '').trim();
  const scp = /^git@([^:]+):(.+)$/.exec(text);
  if (scp) {
    const rest = scp[2].replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
    return rest ? `https://${scp[1]}/${rest}.git` : null;
  }
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') return null;
  url.pathname = pathname.endsWith('.git') ? pathname : `${pathname}.git`;
  return url.toString();
}

export function sameRepo(left, right) {
  const a = httpsGitUrl(left);
  const b = httpsGitUrl(right);
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export async function gitHttpsRemote(folder) {
  try {
    const { stdout } = await exec('git', ['-C', folder, 'remote', 'get-url', 'origin'], { timeout: 8000, windowsHide: true });
    return httpsGitUrl(stdout);
  } catch {
    return null;
  }
}

function skipped(relative) {
  return relative.split(/[\\/]/).some(part => SKIP.has(part));
}

export async function listProjectFiles(folder) {
  const fromGit = await gitList(folder);
  const relatives = fromGit ?? await walk(folder, folder);
  return relatives.filter(file => file && !skipped(file));
}

async function gitList(folder) {
  try {
    const { stdout } = await exec('git', ['-C', folder, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

async function walk(dir, root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full, root));
    else if (entry.isFile()) files.push(path.relative(root, full));
  }
  return files;
}

export async function readProjectFile(folder, relative) {
  const root = path.resolve(folder);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path escapes the project');
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
  const bytes = await readFile(full);
  if (bytes.includes(0)) return null;
  return bytes.toString('utf8');
}

export function remotePath(relative) {
  return relative.split(/[\\/]/).join('/');
}
