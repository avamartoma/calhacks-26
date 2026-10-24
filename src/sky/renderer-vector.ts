import * as THREE from 'three';
import { createSkyBackdrop, type ScreenCloud, type SkyCloud, type SkyRenderer } from './renderer';
import { createRig, random } from './renderer-3d';
import { CLOUD_WIDTH, place, type Viewport } from './sky-math';
import type { SkyPalette } from './time-of-day';

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
uniform float uSeed, uFar, uHover, uFade, uMine;
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
      uniforms: { ...shared, uSeed: { value: seed * 100 }, uFar: { value: 0 }, uHover: { value: 0 }, uFade: { value: 1 }, uMine: { value: cloud?.mine && cloud.id !== 'you' ? 1 : 0 } } });
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
const flatSize = (c: SkyCloud) => (c.id === 'you' ? FLAT_WIDTH * .62 : c.mine ? FLAT_WIDTH : FLAT_WIDTH * .82) / CLOUD_WIDTH;

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
  function meshFor(id: string, seed: number) {
    let mesh = meshes.get(id);
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, transparent: true, depthTest: false, depthWrite: false,
        uniforms: { ...shared, uSeed: { value: seed * 100 }, uFar: { value: 0 }, uHover: { value: 0 }, uFade: { value: 1 }, uMine: { value: 0 } } }));
      meshes.set(id, mesh); scene.add(mesh);
    }
    return mesh;
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
    project(cloud, cam): ScreenCloud {
      const box = place(cloud, cam, view, flatSize(cloud));
      const height = box.width * CLOUD_SHAPE;
      // The text sits in the body of the cloud, just below its middle.
      return { x: box.x, y: box.y, width: box.width, height, label: { x: box.x, y: box.y + height * .02, width: box.width * .5 } };
    },
    render(frame) {
      const { camera: cam, palette, hover } = frame;
      backdrop.update(frame, view, dpr);
      fill(shared, palette);
      const seen = new Set<string>();
      // One cloud per project, far layers first so nearer clouds are drawn over them. You are a marker, not a cloud.
      clouds.filter(c => c.id !== 'you').sort((a, b) => a.depth - b.depth || Number(a.mine) - Number(b.mine)).forEach((c, order) => {
        const box = this.project(c, cam);
        if (box.x + box.width / 2 < -40 || box.x - box.width / 2 > view.width + 40 || box.y + box.height / 2 < -40 || box.y - box.height / 2 > view.height + 40) return;
        const mesh = meshFor(c.id, c.seed); seen.add(c.id);
        mesh.visible = true; mesh.renderOrder = order;
        mesh.position.set(box.x - view.width / 2, view.height / 2 - box.y, 0);
        mesh.scale.set(box.width, box.height, 1);
        const u = mesh.material.uniforms;
        // Layers further back are hazy, and come fully into focus as you zoom toward them.
        const t = Math.min(1, Math.max(0, (box.width - 90) / 170)), clear = t * t * (3 - 2 * t);
        u.uFar.value = c.mine ? 0 : Math.min(.75, (1 - c.depth) * 1.05) * (1 - clear);
        u.uMine.value = c.mine ? 1 : 0;
        u.uHover.value = hover.id === c.id ? hover.amount : 0;
      });
      for (const [id, mesh] of meshes) if (!seen.has(id)) mesh.visible = false;
      renderer.render(scene, camera);
    },
    dispose() {
      for (const mesh of meshes.values()) mesh.material.dispose();
      geometry.dispose(); backdrop.dispose(); renderer.dispose();
    }
  };
}
