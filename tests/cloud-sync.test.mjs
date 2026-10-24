import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { busyMessage, editPaths, ignoredSegments, isGitignored, projectRelative, sandboxDead } from '../server/cloud-sync.mjs';

const exec = promisify(execFile);

test('project paths stay inside the folder and skip ignored directories', () => {
  const folder = path.join(tmpdir(), 'iteration1-sync');
  assert.equal(projectRelative(folder, 'src/app.js'), 'src/app.js');
  assert.equal(projectRelative(folder, path.join(folder, 'src', 'app.js')), 'src/app.js');
  assert.equal(projectRelative(folder, '../outside.js'), null);
  assert.equal(projectRelative(folder, 'node_modules/left/index.js'), null);
  assert.equal(ignoredSegments('.git/config'), true);
});

test('edit tools expose the file they are about to change', () => {
  assert.deepEqual(editPaths('Edit', { file_path: 'src/App.tsx' }), ['src/App.tsx']);
  assert.deepEqual(editPaths('NotebookEdit', { notebook_path: 'notes.ipynb' }), ['notes.ipynb']);
  assert.deepEqual(editPaths('Read', { file_path: 'src/App.tsx' }), []);
  assert.match(busyMessage('src/App.tsx'), /File is busy: src\/App.tsx/);
});

test('a dead sandbox is distinct from a path error', () => {
  assert.equal(sandboxDead(new Error('Session abc is stopped')), true);
  assert.equal(sandboxDead(new Error('path escapes the repo directory')), false);
});

test('gitignored files are skipped and tracked files are not', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'iteration1-ignore-'));
  try {
    await mkdir(path.join(folder, 'src'));
    await writeFile(path.join(folder, '.gitignore'), 'secret.txt\n');
    await writeFile(path.join(folder, 'secret.txt'), 'hidden\n');
    await writeFile(path.join(folder, 'src', 'app.js'), 'export const hi = 1;\n');
    await exec('git', ['init'], { cwd: folder, windowsHide: true });
    assert.equal(await isGitignored(folder, 'secret.txt'), true);
    assert.equal(await isGitignored(folder, 'src/app.js'), false);
    assert.equal(await isGitignored(folder, 'node_modules/pkg/index.js'), true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
