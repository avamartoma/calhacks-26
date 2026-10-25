import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { numstat } from '../convex/lib/numstat.ts';

test('numstat lines become files with counts, binary files as zero', () => {
  assert.deepEqual(numstat('3\t1\tsrc/app.ts\n-\t-\tlogo.png\n0\t12\told.txt\n\n'), [
    { path: 'src/app.ts', added: 3, removed: 1 },
    { path: 'logo.png', added: 0, removed: 0 },
    { path: 'old.txt', added: 0, removed: 12 },
  ]);
});

// The same shadow history the runner keeps in a sandbox, run here against a temporary folder.
test('a shadow git history sees new, changed and deleted files without touching the project git', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opencloud-changes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const work = path.join(dir, 'workspace'), shadow = path.join(dir, 'shadow');
  await mkdir(path.join(work, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(work, 'keep.txt'), 'a\nb\n');
  await writeFile(path.join(work, 'gone.txt'), 'bye\n');
  await writeFile(path.join(work, 'node_modules', 'x', 'i.js'), 'skip');
  execFileSync('git', ['init', '-q'], { cwd: work });
  const env = { ...process.env, GIT_DIR: shadow, GIT_WORK_TREE: work };
  const git = (...args) => execFileSync('git', args, { env, cwd: work, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  await writeFile(path.join(shadow, 'info', 'exclude'), 'node_modules/\n');
  git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', 'before');
  const base = git('rev-parse', 'HEAD').trim();
  await writeFile(path.join(work, 'keep.txt'), 'a\nB\nc\n');
  await writeFile(path.join(work, 'new.txt'), 'hello\n');
  await rm(path.join(work, 'gone.txt'));
  git('add', '-A');
  const files = numstat(git('diff', '--cached', '--numstat', base)).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(files, [
    { path: 'gone.txt', added: 0, removed: 1 },
    { path: 'keep.txt', added: 2, removed: 1 },
    { path: 'new.txt', added: 1, removed: 0 },
  ]);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }).includes('.git'), false);
});
