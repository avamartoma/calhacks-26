import { z } from 'zod';
import { uid } from './domain.mjs';

// A workspace groups projects. The cloud canvas shows one workspace at a time, so this
// is what keeps an unrelated project's clouds out of the sky while you work.
export const skyPalette = ['#8fb6d8', '#c4a6d4', '#8fd0c0', '#e0b48a', '#b9c48f', '#d8a0a8'];

/** A workspace picture: a small PNG, JPEG or WebP image, inlined. The app shrinks uploads first. */
const workspaceImage = z.string().max(60000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/, 'Use a PNG, JPEG or WebP image.');

export const workspaceFields = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().trim().regex(/^#[0-9a-f]{6}$/i).optional(),
  // null removes the picture.
  image: workspaceImage.nullable().optional()
}).strict();

/** Clouds sit on a ring that widens as projects are added, so a new one never lands on an old one. */
export function cloudSpot(index) {
  const ring = Math.floor((Math.sqrt(8 * index + 1) - 1) / 2);
  const start = (ring * (ring + 1)) / 2;
  const span = ring + 1;
  const step = index - start;
  const angle = (step / span) * Math.PI * 2 + ring * 0.7;
  const radius = 26 + ring * 21;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.62, depth: ((index * 7) % 5) - 2 };
}

/**
 * Brings older saved state forward: before workspaces existed every project lived in one
 * flat list, so they are gathered into a first workspace rather than disappearing.
 */
export function initWorkspaces(state) {
  if (!Array.isArray(state.workspaces) || !state.workspaces.length) {
    state.workspaces = [{ id: uid(), name: 'My workspace', color: skyPalette[0], createdAt: Date.now() }];
  }
  const fallback = state.workspaces[0].id;
  const known = new Set(state.workspaces.map(w => w.id));
  state.rooms.forEach((room, index) => {
    if (!room.workspaceId || !known.has(room.workspaceId)) room.workspaceId = fallback;
    if (!room.cloud || typeof room.cloud.x !== 'number' || typeof room.cloud.y !== 'number') room.cloud = cloudSpot(index);
  });
  return state.workspaces;
}
export function workspaceBy(state, id) {
  const found = initWorkspaces(state).find(w => w.id === id);
  if (!found) throw new Error('That workspace no longer exists.');
  return found;
}

export function roomsIn(state, workspaceId) {
  return state.rooms.filter(room => room.workspaceId === workspaceId);
}

export function createWorkspace(state, body) {
  const input = workspaceFields.parse(body);
  const existing = initWorkspaces(state);
  if (existing.length >= 24) throw new Error('That is as many workspaces as the canvas holds. Remove one first.');
  const workspace = { id: uid(), name: input.name, color: input.color || skyPalette[existing.length % skyPalette.length], ...(input.image ? { image: input.image } : {}), createdAt: Date.now() };
  state.workspaces.push(workspace);
  return workspace;
}

export function renameWorkspace(state, id, body) {
  const workspace = workspaceBy(state, id);
  const input = workspaceFields.partial().parse(body);
  if (input.name) workspace.name = input.name;
  if (input.color) workspace.color = input.color;
  if (input.image) workspace.image = input.image;
  if (input.image === null) delete workspace.image;
  return workspace;
}

/**
 * Projects are never orphaned: they move to another workspace rather than vanishing from
 * every canvas, and the final workspace cannot be removed because nothing could hold them.
 */
export function removeWorkspace(state, id) {
  const workspace = workspaceBy(state, id);
  if (state.workspaces.length === 1) throw new Error('This is the only workspace. Create another before removing this one.');
  const moveTo = state.workspaces.find(w => w.id !== id);
  const moved = roomsIn(state, id);
  for (const room of moved) room.workspaceId = moveTo.id;
  state.workspaces = state.workspaces.filter(w => w.id !== id);
  return { workspace, movedTo: moveTo, moved: moved.length };
}

/** Moving a project re-spots its cloud so it does not land on top of one already in that sky. */
export function assignRoom(state, room, workspaceId) {
  const workspace = workspaceBy(state, workspaceId);
  if (room.workspaceId === workspace.id) return room;
  room.workspaceId = workspace.id;
  room.cloud = cloudSpot(roomsIn(state, workspace.id).length - 1);
  return room;
}

/**
 * Where a project's cloud sits. `sky: true` saves where you dragged it on the workspace sky, in
 * that sky's own units, kept apart from the position the older 3D view uses.
 */
export function placeCloud(state, room, spot) {
  const input = z.object({ x: z.number().finite().min(-1e6).max(1e6), y: z.number().finite().min(-1e6).max(1e6), sky: z.boolean().optional() }).strict().parse(spot);
  if (input.sky) room.cloud = { ...room.cloud, sky: { x: input.x, y: input.y } };
  else room.cloud = { ...room.cloud, x: input.x, y: input.y };
  return room.cloud;
}
