// Camera and parallax for the sky. One function places clouds for both the renderer and the
// HTML labels, so labels always sit on their clouds. The far-cloud shader layer uses the same
// layer scale (see layerWorld in shaders.ts).

/**
 * Where you are. The camera looks at a point (x and y across the sky, y down; z in depth, 0 is
 * your projects and negative is further back) from a distance set by zoom, turned by yaw (left
 * and right) and pitch (up and down), in radians.
 */
export interface Camera { x: number; y: number; zoom: number; z?: number; yaw?: number; pitch?: number }

type Vec = [number, number, number];
/** Direction from the target to the camera, and the camera's right and up directions, in world space (y up). */
export function basis(camera: Camera): { back: Vec; right: Vec; up: Vec } {
  const yaw = camera.yaw || 0, pitch = camera.pitch || 0;
  const back: Vec = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const right: Vec = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up: Vec = [back[1] * right[2] - back[2] * right[1], back[2] * right[0] - back[0] * right[2], back[0] * right[1] - back[1] * right[0]];
  return { back, right, up };
}
/** Moves the camera's target by a screen offset in pixels, in the plane facing the camera. */
function shift(camera: Camera, px: number, py: number, scale: number): Camera {
  const { right, up } = basis(camera);
  const tx = camera.x + (right[0] * px - up[0] * py) * scale;
  const ty = -camera.y + (right[1] * px - up[1] * py) * scale;
  const tz = (camera.z || 0) + (right[2] * px - up[2] * py) * scale;
  return { ...camera, x: tx, y: -ty, z: tz };
}
/** Drag to move: the sky follows the pointer. */
export function panBy(camera: Camera, dx: number, dy: number): Camera { return shift(camera, -dx, -dy, 1 / camera.zoom); }
/** Vertical field of view of the 3D camera, in degrees. */
export const FOV = 35;
/** Camera distance from what it looks at, at zoom 1: there, one world unit is one pixel. */
export const baseDistance = (view: Viewport) => view.height / (2 * Math.tan(FOV * Math.PI / 360));
/** Where the camera is, in world space (y up). */
export function eyeOf(camera: Camera, view: Viewport): Vec {
  const { back } = basis(camera), d = baseDistance(view) / camera.zoom;
  return [camera.x + back[0] * d, -camera.y + back[1] * d, (camera.z || 0) + back[2] * d];
}
/** Drag to look around: turn in place, left and right freely, up and down within limits. */
export function look(camera: Camera, dx: number, dy: number, view: Viewport): Camera {
  const eye = eyeOf(camera, view), d = baseDistance(view) / camera.zoom;
  const turned = { ...camera, yaw: (camera.yaw || 0) + dx * .004, pitch: Math.max(-1.2, Math.min(1.2, (camera.pitch || 0) - dy * .004)) };
  // Keep the camera where it is and swing what it looks at around it.
  const { back } = basis(turned);
  return { ...turned, x: eye[0] - back[0] * d, y: -(eye[1] - back[1] * d), z: eye[2] - back[2] * d };
}
/** The direction the camera looks through a point on screen, in world space. */
export function rayThrough(camera: Camera, view: Viewport, cursor: { x: number; y: number }): Vec {
  const { back, right, up } = basis(camera), tanY = Math.tan(FOV * Math.PI / 360), tanX = tanY * view.width / view.height;
  const nx = (cursor.x / view.width) * 2 - 1, ny = 1 - (cursor.y / view.height) * 2;
  const dir: Vec = [-back[0] + right[0] * nx * tanX + up[0] * ny * tanY, -back[1] + right[1] * nx * tanX + up[1] * ny * tanY, -back[2] + right[2] * nx * tanX + up[2] * ny * tanY];
  const length = Math.hypot(...dir);
  return [dir[0] / length, dir[1] / length, dir[2] / length];
}
/** Fly: move the camera along a world direction, keeping where it looks. There is no limit. */
export function fly(camera: Camera, dir: Vec, amount: number): Camera {
  return { ...camera, x: camera.x + dir[0] * amount, y: camera.y - dir[1] * amount, z: (camera.z || 0) + dir[2] * amount };
}
/** Moves relative to where the camera faces: forward, right and up, in world units. */
export function flyRelative(camera: Camera, forward: number, sideways: number, rise: number): Camera {
  const { back, right } = basis(camera);
  const dir: Vec = [-back[0] * forward + right[0] * sideways, -back[1] * forward + rise, -back[2] * forward + right[2] * sideways];
  return fly(camera, dir, 1);
}
export interface Viewport { width: number; height: number }

/** Width of a cloud in world units at depth 1. Height is 0.62 of the width. */
export const CLOUD_WIDTH = 320;
export const CLOUD_ASPECT = 0.62;
export const MIN_ZOOM = 0.22;
export const MAX_ZOOM = 14;

/** How much a layer at this depth scales: depth 1 moves with the camera; far layers move and grow less. */
export function layerScale(zoom: number, depth: number) {
  return Math.pow(zoom, 0.5 + 0.5 * depth) * (0.4 + 0.6 * depth);
}

export interface Placed { x: number; y: number; width: number; height: number; scale: number }
/** Screen position (center, CSS pixels, y down) and size of a cloud. */
export function place(world: { x: number; y: number; depth: number }, camera: Camera, view: Viewport, sizeFactor = 1): Placed {
  const scale = layerScale(camera.zoom, world.depth);
  const width = CLOUD_WIDTH * sizeFactor * scale;
  return { x: view.width / 2 + (world.x - camera.x) * scale, y: view.height / 2 + (world.y - camera.y) * scale, width, height: width * CLOUD_ASPECT, scale };
}

/** Keeps the world point under the cursor still while zooming, measured on the front layer. */
export function zoomAt(camera: Camera, nextZoom: number, cursor: { x: number; y: number }, view: Viewport): Camera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  const ox = cursor.x - view.width / 2, oy = cursor.y - view.height / 2;
  // Move toward the point under the cursor, in the plane facing the camera.
  return { ...shift(camera, ox, oy, 1 / camera.zoom - 1 / zoom), zoom };
}

/** A stable number in [0, 1) from a string, so each project keeps its own cloud shape. */
export function seedOf(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

export const easeInOut = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
