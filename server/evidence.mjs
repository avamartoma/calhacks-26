import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const exec = promisify(execFile);

export function isTestCommand(command = '') {
  // Inspect executable commands, not mentions of `test` in a file path or log.
  let script=String(command).trim();
  const wrapper=script.match(/\s(?:-Command|-c|-lc)\s+([\s\S]+)$/i);
  if(wrapper)script=wrapper[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  // An aggregate shell exit cannot establish an individual check's result.
  if (/[;&|\r\n`<>]/.test(script) || script.includes('$(')) return false;
  return /^(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun)\s+(?:run\s+)?(?:test(?:[:\w-]*)?|check(?:[:\w-]*)?)\b/i.test(script) || /^(?:npx\s+)?(?:vitest|jest|pytest|playwright\s+test)\b/i.test(script) || /^node(?:\.exe)?\s+--test\b/i.test(script) || /^python(?:3|\.exe)?\s+-m\s+(?:pytest|unittest)\b/i.test(script) || /^(?:cargo|go|dotnet)\s+test\b/i.test(script);
}

export function trimEvidence(room, item) {
  const linked = new Set((room.messages || []).flatMap(m => (m.evidenceLinks || []).filter(l=>l.workItemId===item.id).map(l=>l.receiptId)));
  const checks = new Map();
  for(const receipt of item.evidence)if(receipt.source==='observed-command' && receipt.kind==='test' && isTestCommand(receipt.command || receipt.text.split('\n')[0]))checks.set(receipt.command || receipt.text.split('\n')[0],receipt);
  const retained = new Set(checks.values());
  const recent = new Set(item.evidence.filter(e=>!linked.has(e.id) && !retained.has(e)).slice(-30));
  item.evidence = item.evidence.filter(e=>linked.has(e.id) || retained.has(e) || recent.has(e));
}

export function assertReviewVersion(room, item, change, expectedUpdatedAt, expectedVersion) {
  if (!room.demo && change.status==='done' && (expectedUpdatedAt===undefined || typeof expectedVersion!=='string' || !expectedVersion)) throw new Error('Refresh this ticket and its checks before approving.');
  if (expectedUpdatedAt!==undefined && expectedUpdatedAt!==item.updatedAt) throw new Error('This ticket changed. Reopen it before reviewing.');
  if (expectedVersion!==undefined && expectedVersion!==item.reviewState?.version) throw new Error('Project files changed. Refresh checks before approving.');
}

export function identifyEvidence(room) {
  for (const item of room.workItems || []) for (const receipt of item.evidence || []) {
    receipt.id ||= randomUUID();
    if(receipt.kind==='test' && receipt.source==='observed-command' && !isTestCommand(receipt.command || receipt.text.split('\n')[0]))receipt.kind='log';
  }
}

export async function commandWorkspace(folder, cwd) {
  if(typeof cwd!=='string' || !path.isAbsolute(cwd))return {version:null,cwdVerified:false};
  try {
    const root=await realpath(folder),actual=await realpath(cwd),relative=path.relative(root,actual);
    if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))return {version:null,cwdVerified:false};
    return {...await workspaceVersion(folder),commandCwd:actual,cwdVerified:true};
  } catch { return {version:null,cwdVerified:false}; }
}

// Hash tracked and non-ignored project files, including dirty and untracked code.
// Git's ignore rules exclude build products; exceeding a bound fails closed.
export async function workspaceVersion(folder) {
  try {
    const { stdout } = await exec('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', '.'], { cwd: folder, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const files = [...new Set(stdout.split('\0').filter(Boolean))].sort();
    if (files.length > 5000) throw new Error('Too many files');
    const hash = createHash('sha256'); let bytes = 0;
    for (const name of files) {
      const target = path.resolve(folder, name), relative = path.relative(folder, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outside project');
      hash.update(name + '\0');
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw new Error('Linked source cannot be fingerprinted');
        if (!info.isFile()) throw new Error('Unsupported project entry');
        bytes += info.size;
        if (info.size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw new Error('Project exceeds snapshot limit');
        hash.update(await readFile(target));
      } catch (error) { if (error.code === 'ENOENT') hash.update('deleted'); else throw error; }
      hash.update('\0');
    }
    return { version: hash.digest('hex'), checkedAt: Date.now(), fileCount: files.length };
  } catch { return { version: null, checkedAt: Date.now(), error: 'Version unavailable. Use a Git project without symlinks or submodules, with at most 5,000 non-ignored files (64 MB total, 8 MB per file), then rerun checks.' }; }
}

export function testReview(item, snapshot) {
  const observed = item.evidence.filter(e => e.kind === 'test' && e.source === 'observed-command' && isTestCommand(e.command || e.text.split('\n')[0]));
  const latest = new Map();
  for (const receipt of observed) latest.set(receipt.command || receipt.text.split('\n')[0], receipt);
  const current = [...latest.values()].filter(e => snapshot.version && e.workspaceVersion === snapshot.version && e.stableWorkspace === true && e.cwdVerified === true);
  const failures = current.filter(e => e.passed !== true);
  const stale = [...latest.values()].filter(e => !current.includes(e));
  return { ...snapshot, current: current.length > 0 && !failures.length && !stale.length, passing: current.filter(e => e.passed === true).length, failing: failures.length, stale: stale.length, label: snapshot.error ? 'Version unavailable' : failures.length ? 'Checks failed' : stale.length ? 'Checks need rerunning' : current.length ? 'Checks current' : 'Run checks to record this version' };
}

export async function refreshReview(room, item) {
  identifyEvidence(room);
  if (room.demo) return null;
  item.reviewState = testReview(item, await workspaceVersion(room.path));
  return item.reviewState;
}
