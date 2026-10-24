import * as THREE from 'three';
import { createSkyBackdrop, sunDirection, type ScreenCloud, type SkyCloud, type SkyRenderer } from './renderer';
import { createPuffLayer, createRig, random, type PuffCloud } from './renderer-3d';
import type { Viewport } from './sky-math';

// Projects as hot air balloons in a 3D sky, with soft clouds as scenery around them.
// Your balloons sit in front (z = 0) at full color; other people's sit further back, smaller and
// faded into the sky haze. Colors stay muted on purpose, so it reads as calm illustration
// rather than a game.

/** Envelope radius in world units: about 210 px wide at zoom 1, room for a label panel. */
const R = 105;
const DEPTH_RANGE = 2600;
/** Haze by distance from the camera: clear up close, faint far away. */
export const hazeAt = (distance: number) => Math.min(.8, Math.max(0, (distance - 1150) / 1500));

/** Muted fabric pairs: main color and accent. */
const fabrics: [string, string][] = [
  ['#c8664f', '#efe2cc'], ['#5b7fa6', '#ece6d8'], ['#d2a04a', '#f3ead6'], ['#6f9a82', '#efe6cf'],
  ['#9a7bb0', '#f1e4ea'], ['#c97f86', '#f6ece2'], ['#4f8f95', '#e9d9b4'], ['#b56a4a', '#3f5a7a']
];
/** Your own balloon: cream and gold, so it stands apart from your projects. */
const yourFabric: [string, string] = ['#f2e6cc', '#d9a441'];

const envelopeVertex = /* glsl */`
varying vec2 vUv;
varying vec3 vNormal, vWorld;
varying float vHeight;
uniform float uTime, uBob;
void main() {
  vUv = uv; vHeight = position.y;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;
const envelopeFragment = /* glsl */`
const float PANEL_Y = 0.36;
uniform vec3 uMain, uAccent, uLight, uAmbient, uSky, uHaze, uSunDir;
uniform float uPattern, uFar, uHover, uNight, uPanel;
varying vec2 vUv;
varying vec3 vNormal, vWorld;
varying float vHeight;
void main() {
  float gores = 12.0, g = vUv.x * gores, seamDist = min(fract(g), 1.0 - fract(g));
  float alt = mod(floor(g), 2.0);
  vec3 base = uMain;
  if (uPattern < 0.5) base = mix(uMain, uAccent, alt);                                   // alternating gores
  else if (uPattern < 1.5) base = abs(vUv.y - 0.58) < 0.07 ? uAccent : uMain;              // a band at the widest point
  else if (uPattern < 2.5) base = vUv.y > 0.82 ? uAccent : mix(uMain, uAccent, alt * step(vUv.y, 0.3)); // crown and skirt
  else base = mix(uMain, uAccent, step(0.5, fract(g * 0.5 + floor(vUv.y * 6.0) * 0.5)));  // checks
  base *= 1.0 - 0.1 * (1.0 - smoothstep(0.0, 0.05, seamDist));                             // gore seams

  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  // A cream panel on the side facing you, where the project's name is shown.
  vec3 toCam = normalize(cameraPosition - vWorld);
  float across = acos(clamp(dot(normalize(n.xz + 1e-4), normalize(toCam.xz + 1e-4)), -1.0, 1.0)) / 0.95;
  float panel = length(vec2(across, (vHeight - PANEL_Y) / 0.46));
  float inside = (1.0 - smoothstep(0.93, 1.0, panel)) * uPanel;
  float ring = smoothstep(0.84, 0.88, panel) * (1.0 - smoothstep(0.93, 0.97, panel)) * uPanel;
  base = mix(base, vec3(0.99, 0.96, 0.9), inside);
  base = mix(base, uAccent * 0.85, ring * 0.7);
  float d = dot(n, uSunDir);
  // Soft painted shading: a broad lit side and a gentle shadow side.
  float diffuse = smoothstep(-0.35, 0.85, d);
  float shade = mix(diffuse, 0.5 * smoothstep(0.3, 0.42, diffuse) + 0.5 * smoothstep(0.68, 0.8, diffuse), 0.4);
  vec3 col = base * (uAmbient + uLight * shade);
  float rim = pow(1.0 - abs(dot(n, normalize(cameraPosition - vWorld))), 3.0);
  col += uSky * rim * 0.16;
  // At night, the burner lights the fabric from inside, so nearby balloons glow like lanterns.
  float glow = uNight * (1.0 - uFar * 1.4) * (0.35 + 0.65 * smoothstep(0.75, 0.05, vUv.y));
  col += base * vec3(1.0, 0.62, 0.32) * max(glow, 0.0) * 0.75;
  col += 0.05 * uHover;
  col = mix(col, uHaze, uFar);
  gl_FragColor = vec4(col, 1.0);
}
`;
const solidVertex = /* glsl */`
varying vec3 vNormal;
void main() { vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const solidFragment = /* glsl */`
uniform vec3 uColor, uLight, uAmbient, uHaze, uSunDir;
uniform float uFar;
varying vec3 vNormal;
void main() {
  float shade = smoothstep(-0.3, 0.9, dot(normalize(vNormal), uSunDir));
  gl_FragColor = vec4(mix(uColor * (uAmbient + uLight * shade), uHaze, uFar), 1.0);
}
`;

function envelopeGeometry() {
  // The classic balloon profile, from the throat up to the crown.
  const profile = [[.16, -1], [.21, -.92], [.38, -.72], [.62, -.42], [.84, -.08], [.97, .25], [1, .5], [.95, .75], [.8, .95], [.55, 1.1], [.28, 1.18], [0, 1.2]];
  const curve = new THREE.SplineCurve(profile.map(([x, y]) => new THREE.Vector2(x, y)));
  const points = curve.getPoints(48).map(p => new THREE.Vector2(Math.max(0, p.x), p.y));
  return new THREE.LatheGeometry(points, 64);
}

interface Balloon { group: THREE.Group; envelope: THREE.ShaderMaterial; solids: THREE.ShaderMaterial[]; ropes: THREE.LineBasicMaterial; cloud: SkyCloud; z: number; seed: number; far: number }

/** Where a balloon sits in depth: yours in front, others further back. */
const depthOf = (c: SkyCloud) => c.mine ? 0 : -(1 - c.depth) * DEPTH_RANGE;
const isYou = (c: SkyCloud) => c.id === 'you';

export function createSkyRendererBalloons(canvas: HTMLCanvasElement): SkyRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.autoClear = false;
  const scene = new THREE.Scene(), rig = createRig();
  const sceneBackdrop = new THREE.Scene(), flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const backdrop = createSkyBackdrop(true); sceneBackdrop.add(backdrop.mesh);
  // Scenery clouds draw after the balloons and respect their depth, so balloons pass in front.
  const scenery = createPuffLayer({ depthTest: true });
  scene.add(scenery.group);
  let view: Viewport = { width: 1, height: 1 }, dpr = 1, key = '';

  const envelope = envelopeGeometry();
  const skirt = new THREE.CylinderGeometry(.17, .13, .16, 24, 1, true);
  const basket = new THREE.BoxGeometry(.36, .26, .36);
  const rim = new THREE.BoxGeometry(.4, .05, .4);
  const ropeGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([
    -.15, -1, -.15, -.16, -1.42, -.16, .15, -1, -.15, .16, -1.42, -.16, -.15, -1, .15, -.16, -1.42, .16, .15, -1, .15, .16, -1.42, .16
  ], 3));
  const balloons = new Map<string, Balloon>();
  const shared = { uNight: { value: 0 }, uLight: { value: new THREE.Vector3() }, uAmbient: { value: new THREE.Vector3() }, uSky: { value: new THREE.Vector3() }, uHaze: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3(0, 1, .5) } };

  function makeBalloon(c: SkyCloud): Balloon {
    const seed = c.seed, rand = random(seed + .77), z = depthOf(c);
    const [main, accent] = isYou(c) ? yourFabric : fabrics[Math.floor(rand() * fabrics.length)];
    // The back layer fades well into the haze, so your front layer stands out.
    const far = c.mine ? 0 : Math.min(.8, .5 + (1 - c.depth) * .5);
    const group = new THREE.Group();
    const envelopeMaterial = new THREE.ShaderMaterial({
      vertexShader: envelopeVertex, fragmentShader: envelopeFragment, side: THREE.DoubleSide,
      uniforms: { ...shared, uMain: { value: new THREE.Color(main) }, uAccent: { value: new THREE.Color(accent) }, uPattern: { value: isYou(c) ? 1 : Math.floor(rand() * 4) }, uFar: { value: far }, uHover: { value: 0 }, uTime: { value: 0 }, uBob: { value: 0 }, uPanel: { value: 0 } }
    });
    group.add(new THREE.Mesh(envelope, envelopeMaterial));
    const solid = (color: string) => new THREE.ShaderMaterial({ vertexShader: solidVertex, fragmentShader: solidFragment, uniforms: { ...shared, uColor: { value: new THREE.Color(color) }, uFar: { value: far } } });
    const skirtMaterial = solid(accent === '#3f5a7a' ? '#3f5a7a' : '#8a5a3c'), basketMaterial = solid('#9b6b43'), rimMaterial = solid('#6e4a2e');
    const skirtMesh = new THREE.Mesh(skirt, skirtMaterial); skirtMesh.position.y = -1.06; group.add(skirtMesh);
    const basketMesh = new THREE.Mesh(basket, basketMaterial); basketMesh.position.y = -1.55; group.add(basketMesh);
    const rimMesh = new THREE.Mesh(rim, rimMaterial); rimMesh.position.y = -1.42; group.add(rimMesh);
    const ropes = new THREE.LineBasicMaterial({ color: '#5a4636', transparent: true, opacity: 1 - far * .6 });
    group.add(new THREE.LineSegments(ropeGeometry, ropes));
    const size = isYou(c) ? R * .78 : R;
    group.scale.setScalar(size);
    group.position.set(c.x, -c.y, z);
    group.rotation.y = rand() * Math.PI * 2;
    scene.add(group);
    return { group, envelope: envelopeMaterial, solids: [skirtMaterial, basketMaterial, rimMaterial], ropes, cloud: c, z, seed, far };
  }
  function drop(b: Balloon) {
    scene.remove(b.group);
    b.envelope.dispose(); b.solids.forEach(m => m.dispose()); b.ropes.dispose();
  }

  /** Scenery clouds, scattered around and behind the balloons. They are decoration only. */
  function sceneryClouds(): PuffCloud[] {
    const rand = random(.4242);
    return Array.from({ length: 36 }, (_, i) => {
      const z = -150 - Math.pow(rand(), .8) * 2700;
      return { id: `scenery-${i}`, x: (rand() * 2 - 1) * 3600, y: (rand() * 2 - 1) * 1900 - 200, z, width: 240 + rand() * 340, seed: rand(), count: 40, far: Math.min(.85, -z / 3000) };
    });
  }
  scenery.build(sceneryClouds());

  const sizeOf = (c: SkyCloud) => (isYou(c) ? R * .78 : R);
  return {
    // A balloon fills the screen sooner than a cloud does.
    immerse: { start: 1.1, full: 2.05 },
    worldDepth: depthOf,
    resize(next, ratio) {
      view = next; dpr = ratio; rig.resize(next);
      renderer.setPixelRatio(ratio); renderer.setSize(next.width, next.height, false);
    },
    setClouds(clouds) {
      const next = clouds.map(c => `${c.id}:${c.x}:${c.y}:${c.depth}:${c.seed}`).join('|');
      if (next === key) return;
      key = next;
      const keep = new Set(clouds.map(c => c.id));
      for (const [id, b] of balloons) if (!keep.has(id)) { drop(b); balloons.delete(id); }
      for (const c of clouds) {
        const existing = balloons.get(c.id);
        if (existing && existing.cloud.x === c.x && existing.cloud.y === c.y && existing.cloud.depth === c.depth) continue;
        if (existing) drop(existing);
        balloons.set(c.id, makeBalloon(c));
      }
    },
    project(cloud, cam): ScreenCloud {
      rig.aim(cam);
      const size = sizeOf(cloud), z = depthOf(cloud), b = balloons.get(cloud.id);
      const bob = b ? b.group.position.y + cloud.y : 0;
      // The envelope's box, and the point just under the basket where its banner hangs.
      const box = rig.box({ x: cloud.x, y: -cloud.y + bob + size * .1, width: size * 2, height: size * 2.2 }, z);
      // The label sits on the panel, on the side of the envelope facing you.
      // PANEL_Y in the shader: the widest part of the envelope, on the side facing the camera.
      const eye = rig.camera.position, cx = cloud.x, cy = -cloud.y + bob + size * .36;
      const toward = new THREE.Vector3(eye.x - cx, 0, eye.z - z).normalize().multiplyScalar(size * .98);
      const panel = rig.toScreen(cx + toward.x, cy, z + toward.z);
      return { ...box, label: { x: panel.x, y: panel.y, width: box.width * .54 } };
    },
    render(frame) {
      const { camera: cam, time, palette, hover } = frame;
      rig.aim(cam);
      backdrop.update(frame, view, dpr, rig.camera);
      scenery.update(palette, time);
      scenery.sort(rig.camera);
      // Lit from the sun's real direction, nudged toward the default view so faces read well.
      const sun = sunDirection(palette).add(new THREE.Vector3(0, .25, .9)).normalize();
      shared.uSunDir.value.copy(sun);
      shared.uLight.value.set(...palette.cloudLight).multiplyScalar(palette.stars > .5 ? .45 : .5);
      shared.uAmbient.value.set(...palette.cloudShadow).multiplyScalar(palette.stars > .5 ? .7 : .85);
      shared.uNight.value = Math.min(1, Math.max(0, (palette.stars - .2) / .6));
      shared.uSky.value.set(...palette.zenith).lerp(new THREE.Vector3(...palette.horizon), .5);
      shared.uHaze.value.set(...palette.horizon).lerp(new THREE.Vector3(...palette.zenith), .45);
      for (const b of balloons.values()) {
        // A slow drift: gentle rise and fall, a little turn.
        const t = time * (b.cloud.mine ? 1 : .7);
        b.group.position.y = -b.cloud.y + Math.sin(t * .45 + b.seed * 20) * (b.cloud.mine ? 6 : 4);
        b.group.rotation.y += .0006;
        b.group.rotation.z = Math.sin(t * .3 + b.seed * 9) * .025;
        b.envelope.uniforms.uHover.value = hover.id === b.cloud.id ? hover.amount : 0;
        // Other people's balloons are faint from afar and come into full color as you approach.
        if (!b.cloud.mine) {
          const far = hazeAt(b.group.position.distanceTo(rig.camera.position));
          b.envelope.uniforms.uFar.value = far; b.solids.forEach(m => { m.uniforms.uFar.value = far; }); b.ropes.opacity = 1 - far * .6;
        }
        const target = frame.emphasis?.get(b.cloud.id) ?? 0, current = b.envelope.uniforms.uPanel.value;
        b.envelope.uniforms.uPanel.value = current + (target - current) * .2;
      }
      renderer.clear();
      renderer.render(sceneBackdrop, flat);
      renderer.render(scene, rig.camera);
    },
    dispose() {
      for (const b of balloons.values()) drop(b);
      envelope.dispose(); skirt.dispose(); basket.dispose(); rim.dispose(); ropeGeometry.dispose();
      scenery.dispose(); backdrop.dispose(); renderer.dispose();
    }
  };
}
