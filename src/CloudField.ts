import * as THREE from 'three';
import type { CloudSpot, Room } from './types';

type CloudActor = {
  id: string;
  group: THREE.Group;
  puff: THREE.Group;
  label: THREE.Sprite;
  home: THREE.Vector3;
  depth: number;
  spot: CloudSpot;
  status: string;
};

const PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ENTER_HEIGHT = 16;
const LEAVE_HEIGHT = 92;
const START_HEIGHT = 48;
const MIN_HEIGHT = 8;
const MAX_HEIGHT = 220;

function hash(value: string) {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619);
  return (n >>> 0) / 4294967296;
}

function puffTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 256);
  const blobs: [number, number, number, number][] = [
    [128, 126, 118, .95], [86, 142, 78, .7], [174, 134, 82, .72],
    [118, 88, 68, .62], [156, 168, 74, .58], [104, 168, 60, .48]
  ];
  for (const [x, y, r, a] of blobs) {
    const gradient = ctx.createRadialGradient(x, y, r * .12, x, y, r);
    gradient.addColorStop(0, `rgba(255,255,255,${a})`);
    gradient.addColorStop(.55, `rgba(246,250,255,${a * .42})`);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function labelTexture(title: string, subtitle: string, color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = '#1b2c38ee';
  ctx.beginPath();
  ctx.roundRect(18, 18, 476, 92, 18);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(52, 64, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f4f8fb';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(title.slice(0, 28), 74, 62);
  ctx.fillStyle = '#b7c6d2';
  ctx.font = '18px sans-serif';
  ctx.fillText(subtitle.slice(0, 42), 74, 90);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** One 3D cloud per project in the current workspace, living in the office three.js scene. */
export class CloudField {
  root = new THREE.Group();
  actors = new Map<string, CloudActor>();
  puffMap: THREE.CanvasTexture;
  hover: string | null = null;
  active = true;
  height = START_HEIGHT;
  pan = new THREE.Vector2();
  targetPan = new THREE.Vector2();
  dragging = false;
  dragCloud: string | null = null;
  moved = false;
  down = { x: 0, y: 0, panX: 0, panZ: 0 };
  pointer = new THREE.Vector2();
  ray = new THREE.Raycaster();
  hit = new THREE.Vector3();
  tint = '#8fb6d8';
  onEnter?: (id: string) => void;
  onLeave?: () => void;
  onPlace?: (id: string, spot: { x: number; y: number }) => void;
  onHover?: (id: string | null) => void;
  private lastRooms = '';
  entered = false;

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private canvas: HTMLElement) {
    this.root.name = 'Iteration1 cloud field';
    this.puffMap = puffTexture();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 20),
      new THREE.MeshBasicMaterial({ color: '#5d92bc', side: THREE.BackSide, depthWrite: false })
    );
    dome.scale.y = .62;
    this.root.add(dome);
    const haze = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshBasicMaterial({ color: '#8bb4d2', transparent: true, opacity: .22, depthWrite: false })
    );
    haze.rotation.x = -Math.PI / 2;
    haze.position.y = -18;
    this.root.add(haze);
    this.scene.add(this.root);
    this.canvas.addEventListener('wheel', this.wheel, { passive: false });
  }

  worldOf(spot: CloudSpot) {
    return new THREE.Vector3(spot.x, 5.4 + (spot.depth || 0) * 1.7, spot.y);
  }

  setTint(color: string) { this.tint = color || '#8fb6d8'; }

  setRooms(rooms: Room[]) {
    const live = rooms.filter(room => !room.archived);
    const signature = live.map(room => [room.id, room.name, room.goal, room.paused, room.demo, room.cloud?.x, room.cloud?.y, room.cloud?.depth, room.agents.filter(a => a.turnId).length, room.workItems.filter(t => !t.archived && t.status !== 'done').length].join(':')).join('|');
    if (signature === this.lastRooms) return;
    const firstLayout = !this.lastRooms;
    this.lastRooms = signature;
    const keep = new Set(live.map(room => room.id));
    for (const [id, actor] of this.actors) {
      if (keep.has(id)) continue;
      this.root.remove(actor.group);
      this.disposeGroup(actor.group);
      this.actors.delete(id);
    }
    live.forEach((room, index) => {
      const spot = room.cloud && Number.isFinite(room.cloud.x) && Number.isFinite(room.cloud.y)
        ? { x: room.cloud.x, y: room.cloud.y, depth: room.cloud.depth ?? ((index * 7) % 5) - 2 }
        : { x: 0, y: 0, depth: 0 };
      const existing = this.actors.get(room.id);
      const open = room.workItems.filter(t => !t.archived && t.status !== 'done').length;
      const running = room.agents.filter(a => !!a.turnId).length;
      const status = running ? 'working' : room.paused ? 'paused' : open ? 'ready' : 'quiet';
      if (!existing) {
        const actor = this.makeCloud(room, spot, status, open, running);
        this.actors.set(room.id, actor);
        this.root.add(actor.group);
      } else {
        existing.spot = spot;
        existing.depth = spot.depth;
        existing.home.copy(this.worldOf(spot));
        existing.status = status;
        if (!this.dragCloud || this.dragCloud !== room.id) existing.group.position.copy(existing.home);
        const map = this.labelMap(room.name, `${open} open · ${running} running`, status);
        const material = existing.label.material as THREE.SpriteMaterial;
        material.map?.dispose();
        material.map = map;
        material.needsUpdate = true;
      }
    });
    if (firstLayout && live.length && this.pan.length() < .01) {
      const cx = live.reduce((sum, room) => sum + (room.cloud?.x || 0), 0) / live.length;
      const cz = live.reduce((sum, room) => sum + (room.cloud?.y || 0), 0) / live.length;
      this.pan.set(cx, cz);
      this.targetPan.set(cx, cz);
    }
  }

  private labelMap(title: string, subtitle: string, status: string) {
    const colors: Record<string, string> = { working: '#4d8ec8', paused: '#b88732', ready: '#3d8a72', quiet: '#8aa0b0' };
    return labelTexture(title, subtitle, colors[status] || this.tint);
  }

  private makeCloud(room: Room, spot: CloudSpot, status: string, open: number, running: number): CloudActor {
    const group = new THREE.Group();
    const seed = hash(room.id);
    const puff = new THREE.Group();
    group.add(puff);
    const material = new THREE.MeshLambertMaterial({
      map: this.puffMap, alphaMap: this.puffMap, color: '#fff6ee', transparent: true, opacity: .97,
      depthWrite: false, emissive: '#f4f0e6', emissiveIntensity: .35
    });
    const lobes = 6 + Math.floor(seed * 3);
    for (let i = 0; i < lobes; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(.9 + (hash(room.id + i) * .55), 18, 14), material);
      const angle = i * 1.9 + seed * 4;
      const radius = .7 + hash(room.id + ':' + i) * 1.15;
      mesh.position.set(Math.cos(angle) * radius, (hash(room.id + 'y' + i) - .35) * .85, Math.sin(angle) * radius * .72);
      mesh.scale.set(1.15 + hash(room.id + 's' + i) * .7, .72 + hash(room.id + 't' + i) * .45, 1.05 + hash(room.id + 'u' + i) * .5);
      mesh.castShadow = true;
      puff.add(mesh);
    }
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 24),
      new THREE.MeshBasicMaterial({ color: '#2a4052', transparent: true, opacity: .16, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -4.6;
    group.add(shadow);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.labelMap(room.name, `${open} open · ${running} running`, status), transparent: true, depthWrite: false }));
    label.scale.set(7.2, 1.8, 1);
    label.position.y = 3.4;
    group.add(label);
    group.userData.roomId = room.id;
    puff.traverse(object => { object.userData.roomId = room.id; });
    const home = this.worldOf(spot);
    group.position.copy(home);
    group.scale.setScalar(2.8);
    return { id: room.id, group, puff, label, home, depth: spot.depth, spot, status };
  }

  setActive(value: boolean) {
    this.active = value;
    this.root.visible = value || this.height < LEAVE_HEIGHT;
    if (value) this.entered = false;
    this.canvas.style.cursor = value ? 'grab' : '';
  }

  look() {
    const look = new THREE.Vector3(this.pan.x, 0, this.pan.y);
    this.camera.position.set(this.pan.x, this.height, this.pan.y + this.height * .46);
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld();
    return look;
  }

  restoreView() {
    this.height = START_HEIGHT;
    this.pan.set(0, 0);
    this.targetPan.set(0, 0);
    this.entered = false;
    this.look();
  }

  focusCloud(id: string) {
    const actor = this.actors.get(id);
    if (!actor) return;
    this.targetPan.set(actor.home.x, actor.home.z);
    this.height = Math.max(this.height, ENTER_HEIGHT + 8);
  }

  nearest(point: THREE.Vector3) {
    let best: CloudActor | null = null;
    let distance = Infinity;
    for (const actor of this.actors.values()) {
      const d = actor.group.position.distanceTo(point);
      if (d < distance) { distance = d; best = actor; }
    }
    return best && distance < 18 ? best : null;
  }

  planePoint(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    return this.ray.ray.intersectPlane(PLANE, this.hit) ? this.hit.clone() : null;
  }

  pick(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hit = this.ray.intersectObjects([...this.actors.values()].map(a => a.puff), true)[0];
    return hit?.object.userData.roomId as string | undefined;
  }

  pointerDown = (e: PointerEvent) => {
    if (!this.active) return false;
    this.dragging = true;
    this.moved = false;
    this.down = { x: e.clientX, y: e.clientY, panX: this.pan.x, panZ: this.pan.y };
    this.dragCloud = this.pick(e.clientX, e.clientY) || null;
    this.canvas.style.cursor = this.dragCloud ? 'move' : 'grabbing';
    return true;
  };

  pointerMove = (e: PointerEvent) => {
    const nextHover = this.pick(e.clientX, e.clientY) || null;
    if (nextHover !== this.hover) {
      this.hover = nextHover;
      this.onHover?.(nextHover);
    }
    if (!this.active || !this.dragging) return this.active;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) this.moved = true;
    if (this.dragCloud) {
      const point = this.planePoint(e.clientX, e.clientY);
      const actor = this.actors.get(this.dragCloud);
      if (point && actor) {
        actor.group.position.x = point.x;
        actor.group.position.z = point.z;
        actor.spot = { ...actor.spot, x: point.x, y: point.z };
      }
    } else {
      const scale = this.height * .0028;
      this.pan.set(this.down.panX - (e.clientX - this.down.x) * scale, this.down.panZ - (e.clientY - this.down.y) * scale);
      this.targetPan.copy(this.pan);
    }
    return true;
  };

  pointerUp = (e: PointerEvent) => {
    if (!this.active) return false;
    const dragged = this.dragCloud;
    const moved = this.moved;
    this.dragging = false;
    this.canvas.style.cursor = 'grab';
    if (dragged && moved) {
      const actor = this.actors.get(dragged);
      if (actor) {
        actor.home.copy(actor.group.position);
        this.onPlace?.(dragged, { x: actor.spot.x, y: actor.spot.y });
      }
    } else if (!moved) {
      const id = this.pick(e.clientX, e.clientY);
      if (id) this.onEnter?.(id);
    }
    this.dragCloud = null;
    this.moved = false;
    return true;
  };

  wheel = (e: WheelEvent) => {
    if (!this.active) return;
    e.preventDefault();
    const before = this.planePoint(e.clientX, e.clientY);
    const factor = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 240) * .0018);
    this.height = THREE.MathUtils.clamp(this.height * factor, MIN_HEIGHT, MAX_HEIGHT);
    this.look();
    const after = this.planePoint(e.clientX, e.clientY);
    if (before && after) {
      this.pan.add(new THREE.Vector2(before.x - after.x, before.z - after.z));
      this.targetPan.copy(this.pan);
    }
    const focus = this.hover || this.nearest(before || new THREE.Vector3(this.pan.x, 0, this.pan.y))?.id || null;
    if (this.height <= ENTER_HEIGHT && focus && e.deltaY < 0) {
      this.entered = true;
      this.onEnter?.(focus);
    }
  };

  maybeLeaveFromProject(distance: number) {
    if (this.active || !this.entered) return;
    if (distance > 46) this.onLeave?.();
  }

  update(elapsed: number, reduced: boolean) {
    this.root.visible = this.active || this.height < LEAVE_HEIGHT;
    if (!this.active && !this.root.visible) return;
    if (!this.dragging && !this.dragCloud) this.pan.lerp(this.targetPan, reduced ? 1 : .12);
    if (this.active) this.look();
    const camera = this.camera.position;
    for (const actor of this.actors.values()) {
      const parallax = actor.depth * 0.085;
      if (this.active && this.dragCloud !== actor.id) {
        actor.group.position.x = actor.home.x + (camera.x - actor.home.x) * parallax * 0.04;
        actor.group.position.z = actor.home.z + (camera.z - actor.home.z) * parallax * 0.04;
        actor.group.position.y = actor.home.y;
      }
      const hovered = this.hover === actor.id;
      const lift = hovered ? .55 : 0;
      actor.puff.position.y = THREE.MathUtils.lerp(actor.puff.position.y, lift + (reduced ? 0 : Math.sin(elapsed * .7 + actor.depth) * .18), .12);
      actor.puff.rotation.y = reduced ? 0 : elapsed * .05 + actor.depth * .2;
      actor.group.scale.setScalar(THREE.MathUtils.lerp(actor.group.scale.x, hovered ? 3.05 : 2.8, .16));
      actor.label.visible = this.active;
    }
  }

  private disposeGroup(group: THREE.Group) {
    group.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      for (const item of Array.isArray(material) ? material : material ? [material] : []) {
        const map = (item as THREE.MeshStandardMaterial).map;
        if (map && map !== this.puffMap) map.dispose();
        item.dispose();
      }
    });
  }

  dispose() {
    this.canvas.removeEventListener('wheel', this.wheel);
    for (const actor of this.actors.values()) this.disposeGroup(actor.group);
    this.actors.clear();
    this.disposeGroup(this.root);
    this.puffMap.dispose();
    this.scene.remove(this.root);
  }
}
