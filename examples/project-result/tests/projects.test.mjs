import test from 'node:test';
import assert from 'node:assert/strict';
import { projects } from '../src/projects.js';
test('project identities are unique', () => assert.equal(new Set(projects.map(p => p.id)).size, projects.length));
