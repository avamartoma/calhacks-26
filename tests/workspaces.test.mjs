import test from 'node:test';
import assert from 'node:assert/strict';
import { initWorkspaces, createWorkspace, renameWorkspace, removeWorkspace, assignRoom, placeCloud, roomsIn, cloudSpot, workspaceBy } from '../server/workspaces.mjs';

const room = (name, extra = {}) => ({ id: name, name, agents: [], workItems: [], ...extra });
const fixture = (...rooms) => ({ version: 1, rooms, approvals: [] });

test('saved state from before workspaces keeps every project, gathered into one sky', () => {
  const state = fixture(room('alpha'), room('beta'));
  const workspaces = initWorkspaces(state);
  assert.equal(workspaces.length, 1, 'one workspace is created to hold the existing projects');
  assert.equal(roomsIn(state, workspaces[0].id).length, 2, 'no project is left out of the canvas');
  assert.ok(state.rooms.every(r => Number.isFinite(r.cloud.x) && Number.isFinite(r.cloud.y)), 'every project gets a cloud position');
});

test('migration is idempotent and repairs a project pointing at a deleted workspace', () => {
  const state = fixture(room('alpha'));
  const first = initWorkspaces(state)[0].id;
  const spot = { ...state.rooms[0].cloud };
  initWorkspaces(state);
  assert.equal(state.workspaces.length, 1, 'running it again does not add another workspace');
  assert.deepEqual(state.rooms[0].cloud, spot, 'an existing cloud position is left where the user put it');
  state.rooms[0].workspaceId = 'deleted-long-ago';
  initWorkspaces(state);
  assert.equal(state.rooms[0].workspaceId, first, 'a dangling reference falls back rather than hiding the project');
});

test('clouds are spaced so a new project never lands on an existing one', () => {
  const spots = Array.from({ length: 24 }, (_, i) => cloudSpot(i));
  for (let a = 0; a < spots.length; a++) {
    for (let b = a + 1; b < spots.length; b++) {
      const distance = Math.hypot(spots[a].x - spots[b].x, spots[a].y - spots[b].y);
      assert.ok(distance > 8, `clouds ${a} and ${b} are ${distance.toFixed(1)} apart`);
    }
  }
});

test('a workspace holds only its own projects', () => {
  const state = fixture(room('alpha'), room('beta'));
  const home = initWorkspaces(state)[0];
  const side = createWorkspace(state, { name: 'Side quests' });
  assert.equal(roomsIn(state, side.id).length, 0, 'a new workspace starts empty');
  assignRoom(state, state.rooms[1], side.id);
  assert.deepEqual(roomsIn(state, home.id).map(r => r.name), ['alpha']);
  assert.deepEqual(roomsIn(state, side.id).map(r => r.name), ['beta']);
});

test('moving a project re-spots its cloud instead of stacking it on another', () => {
  const state = fixture(room('alpha'), room('beta'), room('carol'));
  initWorkspaces(state);
  const side = createWorkspace(state, { name: 'Side quests' });
  assignRoom(state, state.rooms[0], side.id);
  assignRoom(state, state.rooms[1], side.id);
  const [a, b] = roomsIn(state, side.id);
  assert.ok(Math.hypot(a.cloud.x - b.cloud.x, a.cloud.y - b.cloud.y) > 8, 'the two moved clouds do not overlap');
  const before = { ...a.cloud };
  assignRoom(state, a, side.id);
  assert.deepEqual(a.cloud, before, 'assigning to the workspace it is already in does not move it');
});

test('removing a workspace rehomes its projects rather than orphaning them', () => {
  const state = fixture(room('alpha'), room('beta'));
  const home = initWorkspaces(state)[0];
  const side = createWorkspace(state, { name: 'Side quests' });
  assignRoom(state, state.rooms[1], side.id);
  const result = removeWorkspace(state, side.id);
  assert.equal(result.moved, 1);
  assert.equal(result.movedTo.id, home.id);
  assert.equal(roomsIn(state, home.id).length, 2, 'the moved project is visible again, not lost');
  assert.ok(state.rooms.every(r => state.workspaces.some(w => w.id === r.workspaceId)), 'no project points at a removed workspace');
});

test('the last workspace cannot be removed, because nothing could hold its projects', () => {
  const state = fixture(room('alpha'));
  const home = initWorkspaces(state)[0];
  assert.throws(() => removeWorkspace(state, home.id), /only workspace/);
  assert.equal(roomsIn(state, home.id).length, 1);
});
test('workspace names are validated and a missing one is reported clearly', () => {
  const state = fixture(room('alpha'));
  initWorkspaces(state);
  assert.throws(() => createWorkspace(state, { name: '   ' }));
  assert.throws(() => createWorkspace(state, { name: 'ok', colour: '#ffffff' }), /Unrecognized|unrecognized/);
  assert.throws(() => workspaceBy(state, 'nope'), /no longer exists/);
  const renamed = renameWorkspace(state, state.workspaces[0].id, { name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');
});
test('a cloud can be dragged to a new spot and the move is rejected if it is not a point', () => {
  const state = fixture(room('alpha'));
  initWorkspaces(state);
  const moved = placeCloud(state, state.rooms[0], { x: 12.5, y: -4 });
  assert.equal(moved.x, 12.5);
  assert.equal(moved.y, -4);
  assert.ok(Number.isFinite(moved.depth), 'depth survives a move so parallax stays stable');
  assert.throws(() => placeCloud(state, state.rooms[0], { x: Number.NaN, y: 0 }));
});

test('a workspace can have a picture, which must be a small PNG, JPEG or WebP image', () => {
  const state = { rooms: [] };
  const workspace = createWorkspace(state, { name: 'Design' });
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(renameWorkspace(state, workspace.id, { image: png }).image, png);
  assert.throws(() => renameWorkspace(state, workspace.id, { image: 'data:image/svg+xml;base64,PHN2Zz4=' }), /PNG, JPEG or WebP/);
  assert.throws(() => renameWorkspace(state, workspace.id, { image: 'https://example.com/x.png' }), /PNG, JPEG or WebP/);
  assert.throws(() => renameWorkspace(state, workspace.id, { image: `data:image/png;base64,${'A'.repeat(70000)}` }));
  assert.equal(renameWorkspace(state, workspace.id, { image: null }).image, undefined);
  assert.equal(renameWorkspace(state, workspace.id, { name: 'Design team' }).name, 'Design team');
});

test('a cloud dragged on the sky keeps its own position, apart from the older 3D spot', () => {
  const state = { rooms: [{ id: 'r1', name: 'One', agents: [] }] };
  initWorkspaces(state);
  const before = { ...state.rooms[0].cloud };
  const placed = placeCloud(state, state.rooms[0], { x: 900, y: -250, sky: true });
  assert.deepEqual(placed.sky, { x: 900, y: -250 });
  assert.equal(placed.x, before.x); assert.equal(placed.y, before.y);
  assert.throws(() => placeCloud(state, state.rooms[0], { x: 1, y: 1, sky: true, extra: 1 }));
  assert.throws(() => placeCloud(state, state.rooms[0], { x: 1e9, y: 0, sky: true }));
});
