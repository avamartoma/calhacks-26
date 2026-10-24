import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpsGitUrl, sameRepo, listProjectFiles } from '../server/project-files.mjs';

const exec = promisify(execFile);

test('normalizes https and git remotes', () => {
  assert.equal(httpsGitUrl('git@github.com:avamartoma/calhacks-26.git'), 'https://github.com/avamartoma/calhacks-26.git');
  assert.equal(httpsGitUrl('https://github.com/avamartoma/calhacks-26'), 'https://github.com/avamartoma/calhacks-26.git');
  assert.equal(httpsGitUrl('https://user:token@github.com/a/b.git'), null);
  assert.equal(httpsGitUrl('http://github.com/a/b.git'), null);
  assert.equal(sameRepo('git@github.com:a/b.git', 'https://github.com/a/b'), true);
});

test('lists project files and skips node_modules, .git, and gitignored paths', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'iteration1-files-'));
  try {
    await mkdir(path.join(folder, 'src'));
    await mkdir(path.join(folder, 'node_modules', 'left'), { recursive: true });
    await writeFile(path.join(folder, 'src', 'app.js'), 'export const hi = 1;\n');
    await writeFile(path.join(folder, 'node_modules', 'left', 'index.js'), 'nope\n');
    await writeFile(path.join(folder, '.gitignore'), 'secret.txt\n');
    await writeFile(path.join(folder, 'secret.txt'), 'hidden\n');
    await exec('git', ['init'], { cwd: folder, windowsHide: true });
    const files = await listProjectFiles(folder);
    assert.deepEqual(files.map(file => file.replaceAll('\\', '/')).sort(), ['.gitignore', 'src/app.js']);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
