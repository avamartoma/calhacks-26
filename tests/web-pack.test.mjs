import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { keep, packFolder } from '../src/web/pack.ts';

const file = (relative, text) => { const f = new File([text], relative.split('/').at(-1), { lastModified: 1_700_000_000_000 }); Object.defineProperty(f, 'webkitRelativePath', { value: relative }); return f; };

test('a picked folder packs into a tar.gz that tar can extract, without dependencies or git', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iteration1-pack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const long = `src/${'deep/'.repeat(25)}file.ts`;
  const packed = await packFolder([
    file('notes-api/package.json', '{"name":"notes"}'),
    file('notes-api/src/index.ts', 'export const ok = 1;\n'),
    file(`notes-api/${long}`, 'long path'),
    file('notes-api/node_modules/left/index.js', 'skip'),
    file('notes-api/.git/HEAD', 'skip'),
  ]);
  assert.equal(packed.name, 'notes-api');
  assert.equal(packed.files, 3);
  assert.equal(packed.skipped, 2);
  const archive = path.join(dir, 'project.tgz');
  await writeFile(archive, Buffer.from(await packed.archive.arrayBuffer()));
  const listed = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listed, ['package.json', 'src/index.ts', long].sort());
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  assert.equal(await readFile(path.join(dir, 'src/index.ts'), 'utf8'), 'export const ok = 1;\n');
  assert.equal(await readFile(path.join(dir, long), 'utf8'), 'long path');
});

test('large files and build output stay out of uploads', () => {
  assert.equal(keep('dist/app.js', 10), false);
  assert.equal(keep('a/b/__pycache__/x.pyc', 10), false);
  assert.equal(keep('video.mp4', 6_000_000), false);
  assert.equal(keep('src/app.ts', 10), true);
});
