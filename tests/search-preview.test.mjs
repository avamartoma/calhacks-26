import test from 'node:test';
import assert from 'node:assert/strict';
import { projects, searchProjects } from '../public/demo/search.mjs';
test('interactive sample: empty query returns all projects',()=>assert.deepEqual(searchProjects(projects,'  '),projects));
test('interactive sample: case-insensitive query matches project name',()=>assert.equal(searchProjects(projects,' CUSTOMER ')[0].name,'Customer portal'));
test('interactive sample: query matches project description',()=>assert.equal(searchProjects(projects,'deployment')[0].name,'Release console'));
test('interactive sample: unmatched query returns an empty result',()=>assert.deepEqual(searchProjects(projects,'not-present'),[]));
