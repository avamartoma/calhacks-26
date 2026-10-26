import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFromPackageJson } from '../convex/lib/previewCommand.ts';

const pkg = value => JSON.stringify(value);

test('a dev script runs with host flags, Next.js with its own', () => {
  assert.equal(commandFromPackageJson(pkg({ scripts: { dev: 'vite' } }), 3000).serve, 'npm run dev -- --host 0.0.0.0 --port 3000');
  assert.equal(commandFromPackageJson(pkg({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }), 3000).serve, 'npm run dev -- --hostname 0.0.0.0 --port 3000');
  assert.equal(commandFromPackageJson(pkg({ scripts: { dev: 'vite' } }), 3000).install, 'npm install');
});

test('only a start script runs npm start', () => {
  const detected = commandFromPackageJson(pkg({ scripts: { start: 'node server.js' } }), 3000);
  assert.equal(detected.serve, 'npm start');
  assert.equal(detected.install, 'npm install');
});

test('no package.json, or nothing to run, serves the files as a static site', () => {
  for (const source of [null, pkg({ name: 'site' }), pkg({ scripts: { build: 'eleventy' } })]) {
    const detected = commandFromPackageJson(source, 3000);
    assert.equal(detected.install, undefined);
    assert.match(detected.serve, /python3 -m http\.server 3000 --bind 0\.0\.0\.0/);
    assert.match(detected.serve, /for dir in \. docs public dist build _site site/);
  }
});

test('a broken package.json still says so', () => {
  assert.throws(() => commandFromPackageJson('{oops', 3000), /not valid JSON/);
});
