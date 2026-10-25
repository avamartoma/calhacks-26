import * as THREE from 'three';
import { createSkyBackdrop, stackOrder, type ScreenCloud, type SkyCloud, type SkyRenderer } from './renderer';
import { createRig, random } from './renderer-3d';
import { CLOUD_WIDTH, place, type Viewport } from './sky-math';
import type { SkyPalette } from './time-of-day';
import { drawBlob, drawLabel } from './cloud-text';

// Projects as simple vector clouds, like a clean illustrated map: a flat rounded base with
// rounded bumps on top, crisp edges and flat colors. Each cloud always faces you and is sized so
// its name, description and status fit inside. Scenery clouds use the same style, smaller.

/** Cloud width in world units for your projects; height is CLOUD_SHAPE of that. */
const WIDTH = 420;
const CLOUD_SHAPE = .52;
const DEPTH_RANGE = 2600;
/** Haze by distance from the camera: clear up close, faint far away. */
const hazeAt = (distance: number) => Math.min(.78, Math.max(0, (distance - 1150) / 1500));

const vertex = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const fragment = /* glsl */`
uniform vec3 uFill, uShade, uEdge, uHaze;
uniform float uSeed, uFar, uHover, uFade, uMine, uGray;
varying vec2 vUv;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float box(vec2 p, vec2 extent, float r) { vec2 q = abs(p) - extent + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float cloud(vec2 p) {
  // A wide rounded base with three bumps on top; the seed varies their size and place.
  float a = hash(vec2(uSeed, 1.0)), b = hash(vec2(uSeed, 2.0)), c = hash(vec2(uSeed, 3.0));
  // A long, low cloud: a wide base and gentle bumps, leaving a broad body for text.
  float d = box(p - vec2(0.0, -0.2), vec2(0.9, 0.22), 0.22);
  d = smin(d, length(p - vec2(-0.5 + (a - 0.5) * 0.1, -0.02)) - (0.24 + 0.04 * a), 0.05);
  d = smin(d, length(p - vec2(0.02 + (b - 0.5) * 0.12, 0.06)) - (0.33 + 0.05 * b), 0.05);
  d = smin(d, length(p - vec2(0.52 + (c - 0.5) * 0.1, -0.04)) - (0.22 + 0.04 * c), 0.05);
  return d;
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(2.0, 2.0 * ${CLOUD_SHAPE.toFixed(2)});
  float d = cloud(p);
  float w = fwidth(d) * 0.9;
  float alpha = 1.0 - smoothstep(-w, w, d);
  if (alpha < 0.003) discard;
  // Flat color with a soft band of shade along the bottom, and a fine edge line.
  vec3 col = mix(uFill, uShade, smoothstep(-0.12, -0.36, p.y) * 0.85);
  col = mix(col, uEdge, (1.0 - smoothstep(0.0, 0.012, -d)) * 0.35);
  // Your projects carry a gold band along the base.
  float band = smoothstep(-0.3, -0.32, p.y) * (1.0 - smoothstep(0.0, 0.01, d + 0.035));
  col = mix(col, vec3(0.99, 0.88, 0.58), band * uMine);
  col += 0.04 * uHover;
  // Projects further back are gray until you zoom in to them.
  col = mix(col, vec3(dot(col, vec3(0.3, 0.55, 0.15))) * 0.86 + vec3(0.04, 0.05, 0.07), uGray);
  col = mix(col, uHaze, uFar);
  gl_FragColor = vec4(col, alpha * uFade * (1.0 - uFar * 0.2));
}
`;

type Shared = { uFill: { value: THREE.Vector3 }; uShade: { value: THREE.Vector3 }; uEdge: { value: THREE.Vector3 }; uHaze: { value: THREE.Vector3 } };
/** Cloud colors for the hour. Clouds stay light at night (moonlit), so dark text on them stays readable. */
function fill(shared: Shared, palette: SkyPalette) {
  const night = Math.min(1, Math.max(0, (palette.stars - .2) / .6));
  shared.uFill.value.set(...palette.cloudLight).lerp(new THREE.Vector3(1, 1, 1), night * .45);
  shared.uShade.value.set(...palette.cloudShadow).lerp(shared.uFill.value, .35 + night * .2);
  shared.uEdge.value.set(...palette.cloudShadow).multiplyScalar(.8);
  shared.uHaze.value.set(...palette.horizon).lerp(new THREE.Vector3(...palette.zenith), .4);
}

const depthOf = (c: SkyCloud) => c.mine ? 0 : -(1 - c.depth) * DEPTH_RANGE;
const widthOf = (c: SkyCloud) => c.id === 'you' ? WIDTH * .7 : WIDTH;
interface Shape { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; cloud?: SkyCloud; x: number; y: number; z: number; width: number }

export function createSkyRendererVector(canvas: HTMLCanvasElement): SkyRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.autoClear = false;
  const scene = new THREE.Scene(), rig = createRig();
  const sceneBackdrop = new THREE.Scene(), flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const backdrop = createSkyBackdrop(true); sceneBackdrop.add(backdrop.mesh);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const shared = { uFill: { value: new THREE.Vector3() }, uShade: { value: new THREE.Vector3() }, uEdge: { value: new THREE.Vector3() }, uHaze: { value: new THREE.Vector3() } };
  const shapes = new Map<string, Shape>();
  let view: Viewport = { width: 1, height: 1 }, dpr = 1, key = '';

  function make(id: string, x: number, y: number, z: number, width: number, seed: number, cloud?: SkyCloud): Shape {
    const material = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false,
      uniforms: { ...shared, uSeed: { value: seed * 100 }, uFar: { value: 0 }, uHover: { value: 0 }, uFade: { value: 1 }, uMine: { value: cloud?.mine && cloud.id !== 'you' ? 1 : 0 }, uGray: { value: 0 } } });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(width, width * CLOUD_SHAPE, 1);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    return { mesh, cloud, x, y, z, width };
  }
  function remove(shape: Shape) { scene.remove(shape.mesh); shape.mesh.material.dispose(); }

  // Small scenery clouds scattered around and behind, in the same style. Decoration only.
  const rand = random(.4242);
  const scenery = Array.from({ length: 34 }, (_, i) => {
    const z = -150 - Math.pow(rand(), .8) * 2700;
    return make(`scenery-${i}`, (rand() * 2 - 1) * 3600, (rand() * 2 - 1) * 1900 + 200, z, 180 + rand() * 220, rand());
  });


  return {
    // A flat cloud fills the screen with white once you are right at it.
    immerse: { start: 1.25, full: 2.3 },
    worldDepth: depthOf,
    resize(next, ratio) {
      view = next; dpr = ratio; rig.resize(next);
      renderer.setPixelRatio(ratio); renderer.setSize(next.width, next.height, false);
    },
    setClouds(clouds) {
      const next = clouds.map(c => `${c.id}:${c.x}:${c.y}:${c.depth}:${c.seed}`).join('|');
      if (next === key) return;
      key = next;
      for (const shape of shapes.values()) remove(shape);
      shapes.clear();
      for (const c of clouds) shapes.set(c.id, make(c.id, c.x, -c.y, depthOf(c), widthOf(c), c.seed, c));
    },
    project(cloud, cam): ScreenCloud {
      rig.aim(cam);
      const width = widthOf(cloud);
      const box = rig.box({ x: cloud.x, y: -cloud.y, width, height: width * CLOUD_SHAPE }, depthOf(cloud));
      // The text sits in the body of the cloud, just below its middle.
      return { ...box, label: { x: box.x, y: box.y + box.height * .06, width: box.width * .62 } };
    },
    render(frame) {
      const { camera: cam, palette, hover } = frame;
      rig.aim(cam);
      backdrop.update(frame, view, dpr, rig.camera);
      fill(shared, palette);
      const eye = rig.camera.position;
      for (const shape of [...shapes.values(), ...scenery]) {
        // Always face the camera, like a cut-out.
        shape.mesh.quaternion.copy(rig.camera.quaternion);
        const u = shape.mesh.material.uniforms;
        u.uFar.value = shape.cloud?.mine ? 0 : hazeAt(shape.mesh.position.distanceTo(eye));
        u.uHover.value = shape.cloud && hover.id === shape.cloud.id ? hover.amount : 0;
      }
      renderer.clear();
      renderer.render(sceneBackdrop, flat);
      renderer.render(scene, rig.camera);
    },
    dispose() {
      for (const shape of [...shapes.values(), ...scenery]) remove(shape);
      geometry.dispose(); backdrop.dispose(); renderer.dispose();
    }
  };
}

/** Your project clouds in the flat sky, in world units: bigger than in 3D so text has room. */
export const FLAT_WIDTH = 660;
/** Your project clouds are drawn at this share of their full size (their text with them). */
export const YOUR_SCALE = .9;
const flatSize = (c: SkyCloud) => FLAT_WIDTH * (c.size ?? 1) * (c.mine ? YOUR_SCALE : 1) / CLOUD_WIDTH;
/**
 * How far you have zoomed in to the projects further back, 0 to 1: at the home view they are
 * small and gray, as if far away; zoomed in, they are white and full size.
 */
export const backgroundNear = (zoom: number, home: number) => { const t = Math.min(1, Math.max(0, (zoom / home - 1) / .6)); return t * t * (3 - 2 * t); };
/** Size of a cloud on the flat canvas: projects further back shrink until you zoom in to them. */
const sizeAt = (c: SkyCloud, zoom: number, home: number) => flatSize(c) * zoomedOutBoost(zoom) * (c.mine ? 1 : .5 + .5 * backgroundNear(zoom, home));
/**
 * Zoomed out, clouds shrink a little less than the space between them, so more of them fit on
 * screen. Their centers keep moving with the camera, so zooming stays anchored to the cursor.
 */
export const zoomedOutBoost = (zoom: number) => zoom < 1 ? Math.pow(zoom, -.18) : 1;
/** The share of a cloud's width its text may use; the rest is margin on either side. */
export const LABEL_SHARE = .5;

/**
 * The same vector clouds on a flat 2D canvas with parallax layers: your projects move with you,
 * layers further back move and grow less. Easy to use with a trackpad, mouse or touch.
 */
export function createSkyRendererVector2D(canvas: HTMLCanvasElement): SkyRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  const backdrop = createSkyBackdrop(); scene.add(backdrop.mesh);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const shared = { uFill: { value: new THREE.Vector3() }, uShade: { value: new THREE.Vector3() }, uEdge: { value: new THREE.Vector3() }, uHaze: { value: new THREE.Vector3() } };
  let view: Viewport = { width: 1, height: 1 }, dpr = 1, clouds: SkyCloud[] = [];
  const meshes = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>>();

  /** The cloud being dragged, drawn on top; and the home zoom, for clouds further back. */
  let dragging: string | null = null, homeZoom = .3;
  function meshFor(id: string, seed: number) {
    let mesh = meshes.get(id);
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, transparent: true, depthTest: false, depthWrite: false,
        uniforms: { ...shared, uSeed: { value: seed * 100 }, uFar: { value: 0 }, uHover: { value: 0 }, uFade: { value: 1 }, uMine: { value: 0 }, uGray: { value: 0 } } }));
      meshes.set(id, mesh); scene.add(mesh);
    }
    return mesh;
  }

  // Each cloud's text and agents are drawn right after the cloud itself, so a cloud above covers
  // them exactly as it covers the cloud. Text is drawn to a texture, redrawn sharper as you zoom.
  const textMeshes = new Map<string, { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; key: string; width: number; height: number }>();
  const blobMeshes = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[]>();
  const blobTextures = new Map<string, THREE.CanvasTexture>();
  let fonts = 0;
  document.fonts?.ready.then(() => { fonts++; });
  const texture = (canvas: HTMLCanvasElement) => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  const flatMaterial = (map: THREE.Texture) => new THREE.MeshBasicMaterial({ map, transparent: true, depthTest: false, depthWrite: false });
  /** Canvas pixels per label pixel for this on-screen scale: sharp, without redrawing every frame. */
  const resolutionFor = (scale: number) => Math.min(6, Math.max(1, Math.ceil(scale * dpr * 1.5 * 2) / 2));
  function textFor(c: SkyCloud, detail: boolean, scale: number) {
    const resolution = resolutionFor(scale), text = c.text!;
    const key = `${text.title}|${text.description}|${text.width}|${text.mine}|${detail}|${resolution}|${fonts}`;
    let entry = textMeshes.get(c.id);
    if (entry?.key === key) return entry;
    const drawn = drawLabel(text, detail, resolution), map = texture(drawn.canvas);
    if (entry) { entry.mesh.material.map?.dispose(); entry.mesh.material.map = map; entry.mesh.material.needsUpdate = true; Object.assign(entry, { key, width: drawn.width, height: drawn.height }); }
    else { entry = { mesh: new THREE.Mesh(geometry, flatMaterial(map)), key, width: drawn.width, height: drawn.height }; textMeshes.set(c.id, entry); scene.add(entry.mesh); }
    return entry;
  }
  function blobTexture(color: string, scale: number) {
    const resolution = resolutionFor(scale), key = `${color}|${resolution}`;
    let t = blobTextures.get(key);
    if (!t) { t = texture(drawBlob(color, resolution)); blobTextures.set(key, t); }
    return t;
  }
  function blobsFor(id: string, count: number) {
    let list = blobMeshes.get(id) || [];
    while (list.length < count) { const mesh = new THREE.Mesh(geometry, flatMaterial(blobTexture('#8a93a4', 1))); scene.add(mesh); list.push(mesh); }
    for (const extra of list.slice(count)) { scene.remove(extra); extra.material.dispose(); }
    list = list.slice(0, count); blobMeshes.set(id, list);
    return list;
  }

  return {
    immerse: { start: 1.25, full: 2.3 },
    resize(next, ratio) {
      view = next; dpr = ratio;
      renderer.setPixelRatio(ratio); renderer.setSize(next.width, next.height, false);
      Object.assign(camera, { left: -next.width / 2, right: next.width / 2, top: next.height / 2, bottom: -next.height / 2 });
      camera.updateProjectionMatrix();
    },
    setClouds(next) { clouds = next; },
    setDragging(id) { dragging = id; },
    setHomeZoom(zoom) { if (zoom > 0) homeZoom = zoom; },
    project(cloud, cam): ScreenCloud {
      // Each cloud is exactly where it was put: nothing is moved to make room for another.
      const box = place(cloud, cam, view, sizeAt(cloud, cam.zoom, homeZoom));
      const height = box.width * CLOUD_SHAPE;
      // The text sits in the body of the cloud, just below its middle.
      // A cloud, its text and its agents are one unit: the text is centered on the cloud at a fixed
      // share of its width, and the agents stand at its bottom right, half hanging off the edge.
      return { x: box.x, y: box.y, width: box.width, height, label: { x: box.x, y: box.y + height * .02, width: box.width * LABEL_SHARE }, agents: { x: box.x + box.width * .4, y: box.y + height * .4 } };
    },
    render(frame) {
      const { camera: cam, palette, hover } = frame;
      backdrop.update(frame, view, dpr);
      fill(shared, palette);
      const seen = new Set<string>();
      // One cloud per project, far layers first so nearer clouds are drawn over them. You are a marker, not a cloud.
      clouds.filter(c => c.id !== 'you').sort((a, b) => Number(a.id === dragging) - Number(b.id === dragging) || stackOrder(a, b)).forEach((c, order) => {
        const box = this.project(c, cam);
        if (box.x + box.width / 2 < -40 || box.x - box.width / 2 > view.width + 40 || box.y + box.height / 2 < -40 || box.y - box.height / 2 > view.height + 40) return;
        const mesh = meshFor(c.id, c.seed); seen.add(c.id);
        mesh.visible = true; mesh.renderOrder = order * 3;
        mesh.position.set(box.x - view.width / 2, view.height / 2 - box.y, 0);
        mesh.scale.set(box.width, box.height, 1);
        // Its text, then its agents: drawn above this cloud and below the next one.
        const shown = frame.labels?.get(c.id);
        if (c.text && shown && box.label) {
          const scale = box.label.width / c.text.width, entry = textFor(c, shown.detail, scale);
          entry.mesh.visible = shown.opacity > .02; entry.mesh.renderOrder = order * 3 + 1;
          entry.mesh.material.opacity = shown.opacity;
          entry.mesh.position.set(box.label.x - view.width / 2, view.height / 2 - box.label.y, 0);
          entry.mesh.scale.set(entry.width * scale, entry.height * scale, 1);
          const agents = shown.detail && shown.opacity > .02 ? c.agentBlobs || [] : [], blobs = blobsFor(c.id, agents.length), spot = box.agents || { x: box.x + box.width * .4, y: box.y + box.height * .4 };
          agents.forEach((agent, i) => {
            const blob = blobs[i], map = blobTexture(agent.color, scale);
            if (blob.material.map !== map) { blob.material.map = map; blob.material.needsUpdate = true; }
            // Right-aligned along the bottom edge; an agent running something hops.
            const step = 34 * scale, x = spot.x - (agents.length - 1 - i) * step - 15 * scale;
            const hop = agent.working ? Math.max(0, Math.sin(frame.time * 7 + i * 1.3)) * 9 * scale : 0;
            blob.visible = true; blob.renderOrder = order * 3 + 2; blob.material.opacity = shown.opacity;
            blob.position.set(x - view.width / 2, view.height / 2 - spot.y + hop, 0);
            blob.scale.set(30 * scale, 31 * scale, 1);
          });
          seen.add(`text:${c.id}`);
        }
        const u = mesh.material.uniforms;
        // Layers further back are hazy, and come fully into focus as you zoom toward them.
        const near = backgroundNear(cam.zoom, homeZoom);
        u.uFar.value = c.mine ? 0 : .08 * (1 - near);
        u.uGray.value = c.mine ? 0 : 1 - near;
        u.uMine.value = c.mine ? 1 : 0;
        u.uHover.value = hover.id === c.id ? hover.amount : 0;
      });
      for (const [id, mesh] of meshes) if (!seen.has(id)) mesh.visible = false;
      for (const [id, entry] of textMeshes) if (!seen.has(`text:${id}`)) entry.mesh.visible = false;
      for (const [id, blobs] of blobMeshes) if (!seen.has(`text:${id}`)) blobs.forEach(blob => { blob.visible = false; });
      renderer.render(scene, camera);
    },
    dispose() {
      for (const mesh of meshes.values()) mesh.material.dispose();
      for (const entry of textMeshes.values()) { entry.mesh.material.map?.dispose(); entry.mesh.material.dispose(); }
      for (const blobs of blobMeshes.values()) blobs.forEach(blob => blob.material.dispose());
      for (const t of blobTextures.values()) t.dispose();
      geometry.dispose(); backdrop.dispose(); renderer.dispose();
    }
  };
}
