import * as THREE from 'three';
import type { SkyPalette } from './time-of-day';
import { cloudFragment, cloudVertex, skyDomeFragment, skyFragment, skyVertex } from './shaders';
import { CLOUD_ASPECT, place, type Camera, type Viewport } from './sky-math';

/** A project's cloud in the world. `depth` is 1 for your projects in front, lower further back. */
export interface SkyCloud { id: string; x: number; y: number; depth: number; seed: number; mine: boolean }
/** Where a cloud appears on screen: center and size in CSS pixels, y down. `labelY`, when set, is where its label hangs from. */
export interface ScreenCloud { x: number; y: number; width: number; height: number; labelY?: number; label?: { x: number; y: number; width: number } }
/** `emphasis` is how visible each object's label is, 0 to 1, so a renderer can draw a panel behind it. */
export interface SkyFrame { camera: Camera; time: number; palette: SkyPalette; hover: { id: string | null; amount: number }; emphasis?: Map<string, number> }

/**
 * What the sky view needs from a renderer. The view owns navigation, labels and transitions;
 * a renderer only draws and reports where clouds land on screen. There is a 3D renderer
 * (renderer-3d.ts, the default) and a flat 2D one; either can be replaced without touching
 * the view.
 */
export interface SkyRenderer {
  /** How wide the nearest object must be on screen, relative to the screen, to start filling it, and to be fully inside it. */
  immerse?: { start: number; full: number };
  /** World depth of an object, for flying to it. 3D renderers only. */
  worldDepth?(cloud: SkyCloud): number;
  resize(view: Viewport, dpr: number): void;
  setClouds(clouds: SkyCloud[]): void;
  project(cloud: SkyCloud, camera: Camera): ScreenCloud;
  render(frame: SkyFrame): void;
  dispose(): void;
}

/** Where the sun (or moon) is in a 3D sky: ahead of the default view, left to right through the day. */
export function sunDirection(palette: SkyPalette) {
  const azimuth = (palette.sunX - .5) * 1.7, elevation = palette.sunY * 1.05 - .08;
  return new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)).normalize();
}

/**
 * The sky behind everything: gradient, sun, stars, rays and cirrus. Flat for the 2D renderer;
 * for a 3D camera (`dome`), it is painted around the camera, so turning shows more sky.
 */
export function createSkyBackdrop(dome = false) {
  const vec3 = () => new THREE.Vector3();
  const material = new THREE.ShaderMaterial({
    vertexShader: skyVertex, fragmentShader: dome ? skyDomeFragment : skyFragment, depthTest: false, depthWrite: false,
    uniforms: { uZenith: { value: vec3() }, uHorizon: { value: vec3() }, uSun: { value: vec3() }, uCloudLight: { value: vec3() }, uCloudShadow: { value: vec3() }, uStars: { value: 0 }, uTime: { value: 0 }, uZoom: { value: 1 }, uDpr: { value: 1 }, uSunPos: { value: new THREE.Vector2(.5, .7) }, uRes: { value: new THREE.Vector2(1, 1) }, uCam: { value: new THREE.Vector2() },
      uSunDir: { value: vec3() }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) }, uForward: { value: new THREE.Vector3(0, 0, -1) }, uTanX: { value: 1 }, uTanY: { value: 1 } }
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.renderOrder = -1000; mesh.frustumCulled = false;
  return {
    mesh,
    update({ camera, time, palette }: SkyFrame, view: Viewport, dpr: number, eye?: THREE.PerspectiveCamera) {
      const u = material.uniforms;
      if (eye) {
        // The camera's directions and field of view, so each pixel knows where it looks.
        const e = eye.matrixWorld.elements;
        u.uRight.value.set(e[0], e[1], e[2]); u.uUp.value.set(e[4], e[5], e[6]); u.uForward.value.set(-e[8], -e[9], -e[10]);
        u.uTanY.value = Math.tan(THREE.MathUtils.degToRad(eye.fov / 2)); u.uTanX.value = u.uTanY.value * eye.aspect;
        u.uSunDir.value.copy(sunDirection(palette));
      }
      u.uZenith.value.set(...palette.zenith); u.uHorizon.value.set(...palette.horizon); u.uSun.value.set(...palette.sun);
      u.uCloudLight.value.set(...palette.cloudLight); u.uCloudShadow.value.set(...palette.cloudShadow);
      u.uStars.value = palette.stars; u.uTime.value = time; u.uZoom.value = camera.zoom; u.uDpr.value = dpr;
      u.uSunPos.value.set(palette.sunX, palette.sunY); u.uRes.value.set(view.width, view.height); u.uCam.value.set(camera.x, camera.y);
    },
    dispose() { mesh.geometry.dispose(); material.dispose(); }
  };
}

const sizeOf = (c: SkyCloud) => c.mine ? 1 : .85;

/** The flat renderer: one painted quad per cloud, with parallax layers instead of a 3D camera. */
export function createSkyRenderer2D(canvas: HTMLCanvasElement): SkyRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  let view: Viewport = { width: 1, height: 1 }, dpr = 1, clouds: SkyCloud[] = [];
  const backdrop = createSkyBackdrop(); scene.add(backdrop.mesh);

  const vec3 = () => new THREE.Vector3();
  const shared = { uLight: { value: vec3() }, uShadow: { value: vec3() }, uHaze: { value: vec3() }, uSun: { value: vec3() }, uSunDir: { value: new THREE.Vector2(-.45, .9) }, uTime: { value: 0 } };
  const geometry = new THREE.PlaneGeometry(1, 1);
  const meshes = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>>();
  function meshFor(id: string) {
    let mesh = meshes.get(id);
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
        vertexShader: cloudVertex, fragmentShader: cloudFragment, transparent: true, depthTest: false, depthWrite: false,
        uniforms: { ...shared, uSeed: { value: 0 }, uDepth: { value: 1 }, uHover: { value: 0 }, uFade: { value: 1 } }
      }));
      meshes.set(id, mesh); scene.add(mesh);
    }
    return mesh;
  }

  return {
    resize(next, ratio) {
      view = next; dpr = ratio;
      renderer.setPixelRatio(ratio); renderer.setSize(next.width, next.height, false);
      Object.assign(camera, { left: -next.width / 2, right: next.width / 2, top: next.height / 2, bottom: -next.height / 2 });
      camera.updateProjectionMatrix();
    },
    setClouds(next) { clouds = next; },
    project(cloud, cam) { return place(cloud, cam, view, sizeOf(cloud)); },
    render(frame) {
      const { camera: cam, time, palette, hover } = frame;
      backdrop.update(frame, view, dpr);
      shared.uSun.value.set(...palette.sun); shared.uLight.value.set(...palette.cloudLight); shared.uShadow.value.set(...palette.cloudShadow);
      shared.uHaze.value.set(...palette.horizon).lerp(new THREE.Vector3(...palette.zenith), .35);
      shared.uSunDir.value.set((palette.sunX - .5) * 1.4, .9).normalize();
      shared.uTime.value = time;
      const seen = new Set<string>();
      [...clouds].sort((a, b) => a.depth - b.depth).forEach((c, order) => {
        const s = place(c, cam, view, sizeOf(c));
        if (s.x + s.width / 2 < -40 || s.x - s.width / 2 > view.width + 40 || s.y + s.height / 2 < -40 || s.y - s.height / 2 > view.height + 40) return;
        const mesh = meshFor(c.id); seen.add(c.id);
        mesh.visible = true; mesh.renderOrder = order;
        mesh.position.set(s.x - view.width / 2, view.height / 2 - s.y, 0);
        mesh.scale.set(s.width, s.width * CLOUD_ASPECT, 1);
        const m = mesh.material.uniforms;
        m.uSeed.value = c.seed * 100; m.uDepth.value = c.depth; m.uHover.value = hover.id === c.id ? hover.amount : 0;
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
