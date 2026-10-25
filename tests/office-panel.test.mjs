import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudStatus, cloudStatusLabel, diffFiles } from '../src/office-panel.ts';

const room = (preview, agents = [], paused = false) => ({ paused, preview, agents });

test('a cloud has one status, and a shared project is view only', () => {
  assert.equal(cloudStatus(room({ status: 'live' }, [{ status: 'working' }]), false, false), 'Preview live');
  assert.equal(cloudStatus(room({ status: 'live' }, [{ status: 'approval' }]), false, false), 'Waiting on you');
  assert.equal(cloudStatus(room({ status: 'starting' }, [{ status: 'working' }]), true, false), 'Waiting on you');
  assert.equal(cloudStatus(room(undefined, [{ status: 'paused' }], true), false, false), 'Paused');
  assert.equal(cloudStatus(room({ status: 'live' }, [{ status: 'working' }]), false, true), 'View only');
  assert.equal(cloudStatusLabel('View only'), 'View only (shared with me)');
});

test('ticket diffs split into files with added and removed counts', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '+one', '+two', '-old', 'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '+only'].join('\n');
  const files = diffFiles(diff, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(files.map(file => [file.path, file.added, file.removed]), [['src/a.ts', 2, 1], ['src/b.ts', 1, 0]]);
  assert.equal(diffFiles('', ['src/a.ts'])[0].added, 0);
});
