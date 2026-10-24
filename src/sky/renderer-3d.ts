import * as THREE from 'three';
import { createSkyBackdrop, type ScreenCloud, type SkyCloud, type SkyRenderer } from './renderer';
import type { SkyPalette } from './time-of-day';
import { CLOUD_ASPECT, CLOUD_WIDTH, FOV, baseDistance as distanceFor, basis, type Camera, type Viewport } from './sky-math';

// A 3D sky. Each cloud is a cluster of soft, overlapping puffs in real 3D space, lit from the
// sun's side, the usual way to get fluffy, painterly clouds in real time. The camera only moves
// (it never turns), so puffs are sorted back to front once and drawn in a single call.
// Zooming in moves the camera into the cloud's puffs, so the screen fills with cloud.

/** How far behind your projects the furthest background clouds sit. */
const DEPTH_RANGE = 2600;

const vertex = /* glsl */`
attribute vec3 aOffset;
attribute float aSize, aShade, aSide, aVariant, aCloud, aFar;
uniform float uTime;
varying vec2 vUv, vAtlas;
varying float vShade, vSide, vFar, vCloud;
void main() {
  vec3 o = aOffset + vec3(sin(uTime * 0.11 + aCloud * 1.7 + aShade * 2.3) * 3.0, sin(uTime * 0.07 + aCloud) * 1.5, 0.0);
  vec4 mv = modelViewMatrix * vec4(o, 1.0);
  mv.xy += position.xy * aSize;
  gl_Position = projectionMatrix * mv;
  // Clouds further back fade by distance from the camera, so they clear up as you approach.
  vFar = aFar > 0.0 ? clamp((distance(o, cameraPosition) - 1150.0) / 1500.0, 0.0, 0.8) : 0.0;
  vUv = uv; vShade = aShade; vSide = aSide; vCloud = aCloud;
  vAtlas = vec2(mod(aVariant, 2.0), floor(aVariant / 2.0)) * 0.5;
}
`;
const fragment = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uLight, uShadow, uHaze, uSun;
uniform vec2 uSunDir;
uniform float uSunLow, uHoverCloud, uHoverAmount;
varying vec2 vUv, vAtlas;
varying float vShade, vSide, vFar, vCloud;
void main() {
  float a = texture2D(uMap, vAtlas + vUv * 0.5).a;
  if (a < 0.008) discard;
  // Light falls on the top of the cloud, the top of each puff, and the side facing the sun.
  float sunSide = 0.5 + 0.5 * dot(normalize(vec2(vSide, 0.7)), uSunDir);
  float light = smoothstep(0.12, 0.88, 0.62 * vShade + 0.26 * vUv.y + 0.22 * sunSide - 0.08);
  vec3 col = mix(uShadow, uLight, light);
  // A gold rim along the top edges when the sun is low, as in sunset skies.
  float edge = smoothstep(0.04, 0.3, a) * (1.0 - smoothstep(0.3, 0.75, a));
  col += uSun * edge * vUv.y * vShade * uSunLow * 0.7;
  if (abs(vCloud - uHoverCloud) < 0.5) col += 0.05 * uHoverAmount;
  col = mix(col, uHaze, vFar * 0.5);
  gl_FragColor = vec4(col, a * (0.93 - vFar * 0.2));
}
`;

/** Four soft, lumpy puff shapes in one texture, drawn once on a canvas. */
function puffAtlas() {
  const size = 256, cell = size / 2, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * cell, oy = Math.floor(v / 2) * cell;
    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, cell, cell); ctx.clip();
    for (let i = 0; i < 42; i++) {
      const angle = rand() * Math.PI * 2, dist = Math.pow(rand(), .8) * cell * .24;
      const x = ox + cell / 2 + Math.cos(angle) * dist, y = oy + cell / 2 + Math.sin(angle) * dist * .85;
      const r = cell * (.09 + rand() * .13);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(.72, 'rgba(255,255,255,.75)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // Keep each puff inside a soft round falloff.
    ctx.globalCompositeOperation = 'destination-in';
    const fade = ctx.createRadialGradient(ox + cell / 2, oy + cell / 2, cell * .36, ox + cell / 2, oy + cell / 2, cell * .48);
    fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fade; ctx.fillRect(ox, oy, cell, cell);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export function random(seed: number) {
  let t = Math.floor(seed * 1e9) || 1;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ t >>> 15, 1 | t); r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
}

/** A soft cloud in world space (y up). `far` fades it into the sky haze: 0 near, 1 far. */
export interface PuffCloud { id: string; x: number; y: number; z: number; width: number; seed: number; count: number; far: number }
export interface Extent { x: number; y: number; width: number; height: number }

/** Clouds made of soft puffs, drawn in one call. Used for project clouds and for scenery. */
export function createPuffLayer({ depthTest = false } = {}) {
  const atlas = puffAtlas();
  const vec3 = () => new THREE.Vector3();
  const material = new THREE.ShaderMaterial({
    // With solid objects in the scene, depth testing lets them pass in front of clouds.
    vertexShader: vertex, fragmentShader: fragment, transparent: true, depthTest, depthWrite: false,
    uniforms: { uMap: { value: atlas }, uTime: { value: 0 }, uLight: { value: vec3() }, uShadow: { value: vec3() }, uHaze: { value: vec3() }, uSun: { value: vec3() }, uSunDir: { value: new THREE.Vector2(-.4, .9) }, uSunLow: { value: 0 }, uHoverCloud: { value: -1 }, uHoverAmount: { value: 0 } }
  });
  const group = new THREE.Group();
  const extents = new Map<string, Extent>();
  let mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> | null = null, key = '', order: string[] = [];
  type Puff = { o: [number, number, number]; size: number; shade: number; side: number; variant: number; cloud: number; far: number };
  let all: Puff[] = [], sortedFor = '';
  const fields: [string, number, (p: Puff) => number[]][] = [
    ['aOffset', 3, p => p.o], ['aSize', 1, p => [p.size]], ['aShade', 1, p => [p.shade]], ['aSide', 1, p => [p.side]],
    ['aVariant', 1, p => [p.variant]], ['aCloud', 1, p => [p.cloud]], ['aFar', 1, p => [p.far]]];
  function write(puffs: Puff[]) {
    if (!mesh) return;
    for (const [name, size, read] of fields) {
      const attribute = mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
      const array = attribute.array as Float32Array;
      puffs.forEach((p, i) => { const values = read(p); for (let k = 0; k < size; k++) array[i * size + k] = values[k]; });
      attribute.needsUpdate = true;
    }
  }
  /** Soft puffs blend in order, so they are drawn back to front for the current view. */
  function sort(camera: THREE.Camera) {
    if (!mesh || !all.length) return;
    const e = camera.matrixWorld.elements, key = e.map(v => v.toFixed(1)).join(',');
    if (key === sortedFor) return;
    sortedFor = key;
    const px = e[12], py = e[13], pz = e[14], fx = -e[8], fy = -e[9], fz = -e[10];
    const depth = (p: Puff) => (p.o[0] - px) * fx + (p.o[1] - py) * fy + (p.o[2] - pz) * fz;
    write([...all].sort((a, b) => depth(b) - depth(a)));
  }

  function build(clouds: PuffCloud[]) {
    const next = clouds.map(c => `${c.id}:${c.x}:${c.y}:${c.z}:${c.width}`).join('|');
    if (next === key) return;
    key = next; order = clouds.map(c => c.id);
    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); mesh = null; }
    extents.clear();
    const puffs: { o: [number, number, number]; size: number; shade: number; side: number; variant: number; cloud: number; far: number }[] = [];
    clouds.forEach((c, index) => {
      const rand = random(c.seed + .123), W = c.width, H = W * CLOUD_ASPECT;
      const base = c.y - H * .3;
      const local: typeof puffs = [];
      for (let k = 0; k < c.count; k++) {
        const raw = rand() * 2 - 1, u = Math.sign(raw) * Math.pow(Math.abs(raw), .85);
        const hmax = Math.pow(1 - u * u, .6);
        const v = Math.pow(rand(), 1.35) * hmax;
        const size = W * (.26 + .2 * (1 - Math.abs(u))) * (.8 + .4 * rand()) * (1.05 - .4 * v);
        // Cumulus have flat bases: no puff hangs below the base line.
        const y = Math.max(base + v * H * .78, base + size * .3);
        local.push({ o: [c.x + u * W * .36, y, c.z + (rand() * 2 - 1) * W * .14 * (.6 + .4 * (1 - u * u))], size, shade: v, side: u, variant: Math.floor(rand() * 4), cloud: index, far: c.far });
      }
      const top = Math.max(...local.map(p => p.shade)) || 1;
      local.forEach(p => { p.shade /= top; });
      const reach = (p: typeof puffs[number]) => p.size * .36;
      const minX = Math.min(...local.map(p => p.o[0] - reach(p))), maxX = Math.max(...local.map(p => p.o[0] + reach(p)));
      const minY = Math.min(...local.map(p => p.o[1] - reach(p))), maxY = Math.max(...local.map(p => p.o[1] + reach(p)));
      extents.set(c.id, { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY });
      puffs.push(...local);
    });
    all = puffs; sortedFor = '';
    if (!puffs.length) return;
    puffs.sort((a, b) => a.o[2] - b.o[2]);
    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geometry.index = quad.index; geometry.setAttribute('position', quad.getAttribute('position')); geometry.setAttribute('uv', quad.getAttribute('uv'));
    const attr = (name: string, size: number, read: (p: typeof puffs[number]) => number[]) => geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(puffs.flatMap(read)), size));
    attr('aOffset', 3, p => p.o); attr('aSize', 1, p => [p.size]); attr('aShade', 1, p => [p.shade]); attr('aSide', 1, p => [p.side]);
    attr('aVariant', 1, p => [p.variant]); attr('aCloud', 1, p => [p.cloud]); attr('aFar', 1, p => [p.far]);
    geometry.instanceCount = puffs.length;
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  function update(palette: SkyPalette, time: number, hover: { id: string | null; amount: number } = { id: null, amount: 0 }) {
    const u = material.uniforms;
    u.uTime.value = time;
    u.uLight.value.set(...palette.cloudLight); u.uShadow.value.set(...palette.cloudShadow); u.uSun.value.set(...palette.sun);
    u.uHaze.value.set(...palette.horizon).lerp(new THREE.Vector3(...palette.zenith), .4);
    u.uSunDir.value.set((palette.sunX - .5) * 1.4, .9).normalize();
    // Gold edges matter only when the sun is low.
    u.uSunLow.value = palette.stars < .5 ? Math.max(0, 1 - palette.sunY / .45) : 0;
    u.uHoverCloud.value = hover.id ? order.indexOf(hover.id) : -1; u.uHoverAmount.value = hover.amount;
  }
  return { group, extents, build, update, sort, dispose() { if (mesh) mesh.geometry.dispose(); material.dispose(); atlas.dispose(); } };
}

/**
 * The 3D camera shared by the 3D renderers. It only moves, never turns: x and y pan, and zoom
 * moves it toward the front layer (z = 0), where one world unit is one pixel at zoom 1.
 */
export function createRig() {
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 20000);
  let view: Viewport = { width: 1, height: 1 }, last = '';
  const point = new THREE.Vector3();
  const baseDistance = () => distanceFor(view);
  return {
    camera,
    resize(next: Viewport) { view = next; last = ''; },
    aim(cam: Camera) {
      const key = `${cam.x},${cam.y},${cam.zoom},${cam.z || 0},${cam.yaw || 0},${cam.pitch || 0},${view.width},${view.height}`;
      if (key === last) return;
      last = key;
      camera.aspect = view.width / view.height;
      // Orbit: stand back from the target along the turned direction, and look at it.
      const { back } = basis(cam), distance = baseDistance() / cam.zoom, z = cam.z || 0;
      camera.position.set(cam.x + back[0] * distance, -cam.y + back[1] * distance, z + back[2] * distance);
      camera.lookAt(cam.x, -cam.y, z);
      camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    },
    toScreen(x: number, y: number, z: number) {
      point.set(x, y, z).project(camera);
      return { x: (point.x + 1) / 2 * view.width, y: (1 - point.y) / 2 * view.height, behind: point.z > 1 };
    },
    /** Screen box of a world-space extent at depth z. */
    box(extent: Extent, z: number): ScreenCloud {
      // Measure the width along the camera's own right direction, so turning doesn't squash it.
      const e = camera.matrixWorld.elements, half = extent.width / 2;
      const center = this.toScreen(extent.x, extent.y, z), edge = this.toScreen(extent.x + e[0] * half, extent.y + e[1] * half, z + e[2] * half);
      if (center.behind) return { x: center.x, y: center.y, width: 0, height: 0 };
      const scale = Math.abs(edge.x - center.x) * 2 / extent.width;
      return { x: center.x, y: center.y, width: extent.width * scale, height: extent.height * scale };
    }
  };
}

const worldZ = (c: SkyCloud) => c.mine ? 0 : -(1 - c.depth) * DEPTH_RANGE;
const worldWidth = (c: SkyCloud) => CLOUD_WIDTH * (c.mine ? 1 : 1.3);

/** Projects as clouds (`?sky=clouds`). */
export function createSkyRenderer3D(canvas: HTMLCanvasElement): SkyRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' });
  const scene = new THREE.Scene(), rig = createRig();
  const sceneBackdrop = new THREE.Scene(), flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const backdrop = createSkyBackdrop(true); sceneBackdrop.add(backdrop.mesh);
  const puffs = createPuffLayer(); scene.add(puffs.group);
  renderer.autoClear = false;
  let view: Viewport = { width: 1, height: 1 }, dpr = 1;
  return {
    resize(next, ratio) {
      view = next; dpr = ratio; rig.resize(next);
      renderer.setPixelRatio(ratio); renderer.setSize(next.width, next.height, false);
    },
    setClouds(clouds) {
      puffs.build(clouds.map(c => ({ id: c.id, x: c.x, y: -c.y, z: worldZ(c), width: worldWidth(c), seed: c.seed, count: c.mine ? 64 : 42, far: c.mine ? 0 : 1 - c.depth })));
    },
    worldDepth: worldZ,
    project(cloud: SkyCloud, cam: Camera): ScreenCloud {
      rig.aim(cam);
      const box = puffs.extents.get(cloud.id) || { x: cloud.x, y: -cloud.y, width: worldWidth(cloud), height: worldWidth(cloud) * CLOUD_ASPECT };
      return rig.box(box, worldZ(cloud));
    },
    render(frame) {
      rig.aim(frame.camera);
      backdrop.update(frame, view, dpr, rig.camera);
      puffs.update(frame.palette, frame.time, frame.hover);
      puffs.sort(rig.camera);
      renderer.clear();
      renderer.render(sceneBackdrop, flat);
      renderer.render(scene, rig.camera);
    },
    dispose() { puffs.dispose(); backdrop.dispose(); renderer.dispose(); }
  };
}
