import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CityEnvironment } from './CityEnvironment';
import { TeamDistrict } from './TeamDistrict';
import { officePosition } from './office-layout';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Agent, Room } from './types';
import { accessoriesFor, costumeColors } from './costume';

interface Actor { beacon: THREE.Mesh<THREE.RingGeometry,THREE.MeshBasicMaterial>; workStatus: string; group: THREE.Group; home: THREE.Vector3; agent: Agent; screen: THREE.CanvasTexture; label: THREE.Sprite; signature: string; eyes: THREE.Group[]; pupils: THREE.Mesh[]; body: THREE.Group; phase: number; visiting: boolean; meetingUntil:number; route: THREE.Vector3[]; outbound: THREE.Vector3[] }
const modelLook = (model: string) => model.toLowerCase().includes('grok') ? { label: 'GROK', color: '#3d8eb8' } : model.toLowerCase().includes('cursor') ? { label: 'CURSOR', color: '#3d8eb8' } : model.includes('astra') ? { label: 'ASTRA', color: '#e06a3c' } : model.includes('sol') ? { label: 'SOL', color: '#e2b043' } : model.includes('terra') ? { label: 'TERRA', color: '#3d9a68' } : model.includes('luna') ? { label: 'LUNA', color: '#9a62b8' } : model.includes('5.5') ? { label: '5.5', color: '#3d6eae' } : { label: 'AUTO', color: '#3a9a8c' };
function visibleAgents(room: Room) {
  const available = room.agents.filter(a => a.status !== 'ejected');
  const manager = available.filter(a => a.manager).at(-1);
  const workers = available.filter(a => !a.manager);
  const running = workers.filter(a => ['working','talking','approval'].includes(a.status));
  const others = workers.filter(a => !running.includes(a)).slice().reverse();
  const chosen=[...running,...others].slice(0,6).sort((a,b)=>workers.indexOf(a)-workers.indexOf(b));
  return [...(manager ? [manager] : []), ...chosen];
}
export class OfficeScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, .1, 3000);
  rig = new THREE.Group();
  controls: OrbitControls;
  world = new THREE.Group();
  walkOnly = new THREE.Group();
  actors = new Map<string, Actor>();
  ray = new THREE.Raycaster();
  clickable: THREE.Object3D[] = [];
  obstacles: THREE.Box3[] = [];
  keys = new Set<string>();
  walk = false; xrSupported = false; selected: string | null = null;
  clock = new THREE.Clock();
  elapsed = 0; yaw = 0; pitch = 0; dragging = false; down = { x: 0, y: 0 };
  reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  resizeObserver: ResizeObserver;
  roomId = ''; room?: Room; frameCount = 0; controllers: THREE.Group[] = [];
  shell: THREE.Group | null = null; disposed = false;
  private renderingEnabled = true;
  private graphicsLost = false;
  onGraphicsLost?: () => void;
  city: CityEnvironment;
  district: TeamDistrict;
  onOfficeSelect?: (id:string) => void;
  composer: EffectComposer;
  occlusion: SSAOPass;
  panorama?: THREE.DataTexture;
  whipArmed = false;
  whipReactions = new Map<string, number>();
  viewScale = 1;
  flow = new THREE.Group(); flowSignature=''; flowPaths:{curve:THREE.CatmullRomCurve3; dot:THREE.Mesh}[]=[]; departures:THREE.Group[]=[];
  onWhip?: (id: string) => void;
  onMode?: (walk: boolean) => void;
  onStatus?: (message: string) => void;
  onMarkers?: (markers: {id:string;x:number;y:number;status:string}[]) => void;
  panelWidth=0;
  cinemaStep:number|null=null;
  cinemaShot: {position:THREE.Vector3;target:THREE.Vector3}|null=null;
  neighborWorld=new THREE.Group();neighborActors=new Map<string,Actor>();neighborClickable:THREE.Object3D[]=[];neighborId='';neighborFlow=new THREE.Group();neighborFlowSignature='';
  onTeammate?:()=>void;
  constructor(public container: HTMLElement, public onSelect: (id: string) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.xr.enabled = true;
    this.renderer.setClearColor('#e3eae3');
    // The city supplies its own atmospheric depth; keep the interior clear at overview distances.
    this.scene.fog = null;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D office. Use the agent roster for keyboard accessible desk selection.');
    this.renderer.domElement.tabIndex = 0;
    this.scene.add(this.rig); this.rig.add(this.camera); this.scene.add(this.world); this.scene.add(this.flow);
    this.scene.add(this.walkOnly);this.scene.add(this.neighborWorld);this.scene.add(this.neighborFlow);
    this.city = new CityEnvironment(this.renderer, this.scene);
    this.district = new TeamDistrict(this.city);this.scene.add(this.district.root);
    this.camera.position.set(16, 15, 20);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(-.4, .7, -.3); this.controls.enableDamping = true; this.controls.dampingFactor = .08;
    this.controls.minDistance = 16; this.controls.maxDistance = 52; this.controls.maxPolarAngle = Math.PI / 2.25; this.controls.minPolarAngle = .2;
    this.controls.enablePan = true; this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    const ambient = new THREE.HemisphereLight('#f2f6fb', '#b7b89e', 1.32); this.scene.add(ambient);
    const sun = new THREE.DirectionalLight('#fff2dc', 2.85); sun.position.set(-90, 72, -75); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -95; sun.shadow.camera.right = 95; sun.shadow.camera.top = 95; sun.shadow.camera.bottom = -95; sun.shadow.camera.far = 330; sun.shadow.normalBias = .04; sun.shadow.bias = -.0003;
    const fill = new THREE.DirectionalLight('#e7f1f4', .72); fill.position.set(28, 20, 34);
    this.scene.add(sun); this.scene.add(fill);
    this.city.bakeReflections(this.renderer,this.scene);
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(1);
    this.composer.renderTarget1.samples=4;this.composer.renderTarget2.samples=4;
    this.composer.addPass(new RenderPass(this.scene,this.camera));
    this.occlusion = new SSAOPass(this.scene,this.camera,640,400,24);
    this.occlusion.kernelRadius = .55; this.occlusion.minDistance = .00003; this.occlusion.maxDistance = .001;
    const renderOcclusion = this.occlusion.render.bind(this.occlusion);
    this.occlusion.render = (...args) => {
      // Glazing and sky must not become opaque occluders in the normal pass.
      const hidden: THREE.Object3D[] = [];
      this.scene.traverse(object => {
        const mesh=object as THREE.Mesh;
        if(object.visible && (object===this.city.sky || (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.transparent))) { hidden.push(object); object.visible=false; }
      });
      try { renderOcclusion(...args); } finally { hidden.forEach(object=>object.visible=true); }
    };
    this.composer.addPass(this.occlusion); this.composer.addPass(new OutputPass());
    this.resizeObserver = new ResizeObserver(this.resize); this.resizeObserver.observe(container); this.resize();
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.pointerMove);
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.renderer.domElement.addEventListener('contextmenu', this.contextMenu);
    window.addEventListener('keydown', this.keyDown); window.addEventListener('keyup', this.keyUp); window.addEventListener('blur', this.blur);
    document.addEventListener('visibilitychange', this.syncRendering);
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
    this.renderer.xr.addEventListener('sessionstart', this.syncRendering);
    this.renderer.xr.addEventListener('sessionend', this.sessionEnded);
    navigator.xr?.isSessionSupported('immersive-vr').then(s => { this.xrSupported = s; }).catch(() => {});
    new GLTFLoader().load('/models/office-shell.glb', gltf => {
      if (this.disposed) return;
      this.neighborId='';this.shell = gltf.scene; this.renderer.domElement.dataset.asset = 'blender-office-shell';
      if (this.room) { this.build(this.room); this.update(this.room, this.selected); }
    }, undefined, () => { if (!this.disposed) this.onStatus?.('Detailed office asset could not load. Showing the lightweight layout.'); });
    this.syncRendering();
    this.box(this.walkOnly, 0, 4.26, 0, 22, .16, 18, '#dce0db');
    for (let x = -10; x <= 10; x += 1.2) this.box(this.walkOnly, x, 4.17, 0, .025, .012, 17.7, '#b0b8b1');
    for (let z = -8; z <= 8; z += 1.2) this.box(this.walkOnly, 0, 4.17, z, 21.7, .012, .025, '#b0b8b1');
    this.box(this.walkOnly, -10.75, 2.1, 3.25, .18, 4.2, 11.5, '#dfe3dc');
    this.box(this.walkOnly, -3.1, 2.1, 8.8, 15.2, 4.2, .18, '#dfe3dc');
    this.box(this.walkOnly, 9, 2.1, 8.8, 3.5, 4.2, .18, '#dfe3dc');
    this.walkOnly.visible = false;
  }
  mat(color: string, roughness = .8) { return new THREE.MeshStandardMaterial({ color, roughness }); }
  box(parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, color: string, round = 0) {
    const geometry = round ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geometry, this.mat(color)); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  cylinder(parent: THREE.Object3D, x: number, y: number, z: number, r: number, h: number, color: string, bottom = r) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, bottom, h, 16), this.mat(color)); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  sphere(parent: THREE.Object3D, x: number, y: number, z: number, r: number, color: string, sy = 1) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), this.mat(color, .62)); mesh.position.set(x, y, z); mesh.scale.y = sy; mesh.castShadow = true; parent.add(mesh); return mesh;
  }
  textTexture(title: string, subtitle: string, color = '#24493d', screen = false, body = '', progress = 0, hint = 'CLICK TO INSPECT WORK') {
    const canvas = document.createElement('canvas'); canvas.width = screen ? 768 : 512; canvas.height = screen ? 480 : 144;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = screen ? '#182d29' : '#f6f4e9'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (screen) {
      ctx.fillStyle = '#2c4840'; ctx.fillRect(0, 0, 768, 44); ctx.fillStyle = '#b8d4b2'; ctx.font = '18px sans-serif'; ctx.fillText('FOURTEENTH  /  WORKSPACE', 24, 29);
      ctx.fillStyle = color; ctx.fillRect(24, 71, 9, 9); ctx.fillStyle = '#e9f0dd'; ctx.font = 'bold 30px sans-serif'; ctx.fillText(title.slice(0, 32), 47, 95);
      ctx.fillStyle = '#9cbbab'; ctx.font = '20px sans-serif'; ctx.fillText(subtitle.slice(0, 58), 24, 137);
      ctx.strokeStyle = '#3f574c'; ctx.beginPath(); ctx.moveTo(24, 157); ctx.lineTo(744, 157); ctx.stroke();
      ctx.fillStyle = '#d5e5d2'; ctx.font = '21px sans-serif';
      const words = body.replace(/\s+/g, ' ').split(' '); let line = '', y = 200;
      for (const word of words) { if (ctx.measureText(line + word).width > 690) { ctx.fillText(line, 24, y); line = ''; y += 31; if (y > 360) break; } line += word + ' '; }
      if (y <= 360) ctx.fillText(line, 24, y);
      ctx.fillStyle = '#35554a'; ctx.fillRect(24, 407, 716, 5); ctx.fillStyle = color; ctx.fillRect(24, 407, 716 * Math.max(0, Math.min(100,progress)) / 100, 5); ctx.fillStyle = '#9cbbab'; ctx.font = '16px sans-serif'; ctx.fillText(hint, 24, 450);
    } else {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(31, 46, 8, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#233b32'; ctx.font = 'bold 36px sans-serif'; ctx.fillText(title.slice(0, 22), 53, 58);
      ctx.fillStyle = '#5e6f63'; ctx.font = '18px sans-serif'; ctx.fillText(subtitle.slice(0, 36), 25, 104);
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 8); return texture;
  }
  sign(text: string, sub: string, x: number, y: number, z: number, scale = 3) {
    const texture = this.textTexture(text, sub); const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true })); sprite.scale.set(scale, scale * 144 / 512, 1); sprite.position.set(x, y, z); this.world.add(sprite); return sprite;
  }
  plant(x: number, z: number, scale = 1) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(scale); this.world.add(g);
    this.cylinder(g, 0, .35, 0, .34, .65, '#dfd2b9', .24); this.cylinder(g, 0, .68, 0, .28, .03, '#655240');
    for (let i = 0; i < 7; i++) { const angle = i * 2.4; const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), this.mat(i % 2 ? '#547950' : '#385e45')); leaf.scale.set(.17, .55 + (i % 3) * .12, .22); leaf.position.set(Math.cos(angle) * .23, 1.1 + (i % 3) * .18, Math.sin(angle) * .23); leaf.rotation.z = Math.sin(angle) * .5; leaf.rotation.x = Math.cos(angle) * .5; leaf.castShadow = true; g.add(leaf); }
  }
  chair(x: number, z: number, color = '#496b58', rotation = 0) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotation; this.world.add(g);
    this.box(g, 0, .68, 0, .85, .18, .8, color, .1); this.box(g, 0, .88, .35, .83, .38, .15, color, .08);
    this.cylinder(g, 0, .34, 0, .055, .5, '#666e65'); this.box(g, 0, .12, 0, .8, .055, .07, '#565e57'); this.box(g, 0, .12, 0, .07, .055, .8, '#565e57');
    this.box(g, -.49, .91, .03, .07, .1, .6, '#414e45'); this.box(g, .49, .91, .03, .07, .1, .6, '#414e45');
  }
  desk(x: number, z: number, a: Agent | null, manager = false) {
    const width = manager ? 3.8 : 2.9;
    this.box(this.world, x, 1.15, z, width, .11, 1.5, this.shell ? '#785039' : '#d8b98a', .025);
    for (const dx of [-width / 2 + .18, width / 2 - .18]) this.box(this.world, x + dx, .55, z, .1, 1.1, 1.27, '#e2e4d7');
    this.box(this.world, x + width / 2 - .48, .73, z, .66, .75, 1.1, '#e3e2d5', .025);
    for (const yy of [.55, .82]) this.box(this.world, x + width / 2 - .48, yy, z + .56, .22, .025, .035, '#8c9a88');
    this.box(this.world, x, 1.27, z - .24, .65, .06, .4, '#4c5b51', .03); this.box(this.world, x, 1.54, z - .3, .085, .55, .08, '#4c5b51');
    const monitor = this.box(this.world, x, 1.95, z - .27, 1.7, 1.02, .11, '#273c33', .045);
    if(a){monitor.userData.agentId = a.id; this.clickable.push(monitor);}
    const texture = this.textTexture(a?.name || 'AVAILABLE DESK', a?.title || a?.role || 'Ready for the next assignment', a?.color || '#789288', true, a?.task || 'Research, implementation support and independent review.',0,a?'CLICK TO INSPECT WORK':'NO AGENT ASSIGNED');
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.58, .89), new THREE.MeshBasicMaterial({ map: texture })); screen.position.set(x, 1.95, z - .207); this.world.add(screen);if(a){screen.userData.agentId = a.id;this.clickable.push(screen);}else (screen.material as THREE.MeshBasicMaterial).color.set('#789087');
    this.box(this.world, x - .1, 1.27, z + .46, 1.0, .045, .31, '#dadfd3', .015);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 11; col++) this.box(this.world, x - .5 + col * .08, 1.30, z + .36 + row * .085, .055, .012, .05, '#aab6a8');
    this.box(this.world, x + .65, 1.27, z + .47, .33, .013, .34, '#516a58'); this.box(this.world, x + .65, 1.32, z + .47, .13, .06, .21, '#e2e5d8', .025);
    this.cylinder(this.world, x - width / 2 + .25, 1.4, z + .3, .095, .29, a?.color || '#849386'); this.cylinder(this.world, x - width / 2 + .25, 1.55, z + .3, .07, .012, '#61422b');
    this.box(this.world, x + .95, 1.26, z + .3, .25, .02, .25, '#e6ce66');
    this.chair(x, z + 1.23, manager ? '#bf845c' : '#4f6b5b');
    this.obstacles.push(new THREE.Box3(new THREE.Vector3(x - width / 2 - .22, 0, z - .98), new THREE.Vector3(x + width / 2 + .22, 2.4, z + .95)));
    // Small task lights and desk pads make vacant workstations feel furnished too.
    this.cylinder(this.world,x-width/2+.3,1.28,z-.45,.16,.055,'#3e4945');
    this.cylinder(this.world,x-width/2+.3,1.55,z-.45,.026,.5,'#b9ab88');
    this.box(this.world,x-width/2+.45,1.82,z-.45,.46,.07,.19,'#dccbae',.025);
    if(!a)return;
    const avatar = this.avatar(a); avatar.position.set(x, 0, z + 1.12); this.world.add(avatar);
    const label = this.sign(a.name, a.title || a.role, x, 3.15, z + .4, 2.65); label.userData.agentId = a.id; this.clickable.push(label);
    const beacon=new THREE.Mesh(new THREE.RingGeometry(.72,.8,48),new THREE.MeshBasicMaterial({color:'#477ead',transparent:true,opacity:.85,side:THREE.DoubleSide,depthWrite:false}));
    beacon.rotation.x=-Math.PI/2;beacon.position.set(x,.09,z+1.12);beacon.userData.agentId=a.id;this.world.add(beacon);
    this.actors.set(a.id, { beacon,workStatus:'queued',group: avatar, home: avatar.position.clone(), agent: a, screen: texture, label, signature: '', eyes: avatar.userData.eyes, pupils: avatar.userData.pupils, body: avatar.userData.body, phase: x * 2.17 + z * .6, visiting: false, meetingUntil:0, route: [], outbound: [] });
  }
  avatar(a: Agent) {
    const g = new THREE.Group(); const body = new THREE.Group(); body.position.y = 1.5; g.add(body);
    const look = modelLook(a.effectiveModel || a.model);
    // A true sphere: expression comes from the eyes, and the costume marks the role.
    const geometry = new THREE.SphereGeometry(.5, 40, 28);
    const skin = new THREE.MeshStandardMaterial({ color: look.color, roughness: .48, metalness: 0, emissive: look.color, emissiveIntensity: .04, envMapIntensity: 0 });
    skin.customProgramCacheKey = () => 'fourteenth-blob-v3';
    skin.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, diffuseColor.rgb, .28);\n#include <opaque_fragment>');
    };
    const blob = new THREE.Mesh(geometry, skin); blob.castShadow = true; blob.receiveShadow = true; body.add(blob); blob.userData.agentId = a.id; this.clickable.push(blob);
    const eyes: THREE.Group[] = [], pupils: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Group(); eye.position.set(side * .165, .17, .449); body.add(eye); eyes.push(eye);
      const white = new THREE.Mesh(new THREE.SphereGeometry(.126, 20, 14), new THREE.MeshStandardMaterial({ color: '#faf9ef', roughness: .34 })); white.scale.set(.9, 1.14, .49); eye.add(white);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(.056, 16, 12), new THREE.MeshStandardMaterial({ color: '#27302b', roughness: .3 })); pupil.position.set(0, 0, .068); pupil.scale.z = .5; eye.add(pupil); pupils.push(pupil);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(.014, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffef' })); glint.position.set(-.017, .019, .025); pupil.add(glint);
    }
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 80;
    const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, 256, 80); ctx.fillStyle = '#2c3e37'; ctx.textAlign = 'center'; ctx.font = 'bold 48px sans-serif'; ctx.fillText((a.name || look.label).slice(0, 12), 128, 58);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(.4, .13), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })); badge.position.set(0, -.16, .481); body.add(badge);
    const backBadge = badge.clone(); backBadge.rotation.y = Math.PI; backBadge.position.z = -.481; body.add(backBadge);
    this.wear(body, a);
    g.userData.eyes = eyes; g.userData.pupils = pupils; g.userData.body = body;
    return g;
  }
  wear(body: THREE.Group, agent: Agent) {
    const { kind, hat, bow, coffee } = accessoriesFor(agent);
    const colors = costumeColors[kind];
    if (hat) {
      const crown = new THREE.Group(); crown.position.y = .42; body.add(crown);
      const brim = (r = .42, y = .02) => this.cylinder(crown, 0, y, 0, r, .04, colors.hat);
      if (kind === 'manager') { brim(.46); this.cylinder(crown, 0, .18, 0, .2, .28, colors.hat, .24); this.cylinder(crown, 0, .08, 0, .252, .05, colors.trim); }
      else if (kind === 'research') { this.sphere(crown, 0, .12, 0, .28, colors.hat, .5); this.box(crown, 0, .03, .3, .38, .03, .22, colors.hat); }
      else if (kind === 'build') { brim(.48); this.sphere(crown, 0, .14, 0, .34, colors.hat, .46); this.box(crown, 0, .16, .32, .08, .05, .04, colors.trim); }
      else if (kind === 'test') { this.sphere(crown, 0, .12, 0, .28, colors.hat, .48); this.sphere(crown, -.26, 0, 0, .1, colors.hat, 1.35); this.sphere(crown, .26, 0, 0, .1, colors.hat, 1.35); this.box(crown, 0, .03, .28, .3, .025, .16, colors.trim); }
      else { this.cylinder(crown, 0, .1, 0, .24, .14, colors.hat); const visor = this.box(crown, 0, .05, .26, .44, .025, .22, colors.hat); visor.rotation.x = -.35; this.cylinder(crown, 0, .16, 0, .248, .035, colors.trim); }
    }
    if (bow) {
      const tie = new THREE.Group(); tie.position.set(0, -.36, .42); tie.scale.setScalar(kind === 'manager' || kind === 'review' ? 1.15 : 1); body.add(tie);
      const left = this.sphere(tie, -.12, 0, 0, .09, colors.bow, .62); left.scale.x = 1.5; left.rotation.z = .55;
      const right = this.sphere(tie, .12, 0, 0, .09, colors.bow, .62); right.scale.x = 1.5; right.rotation.z = -.55;
      this.sphere(tie, 0, 0, .03, .045, colors.bow);
    }
    if (coffee) {
      const cup = new THREE.Group(); cup.position.set(.48, -.02, .16); cup.rotation.z = -.15; body.add(cup);
      this.cylinder(cup, 0, 0, 0, .075, .2, '#f3eee4', .06);
      this.cylinder(cup, 0, .09, 0, .062, .025, '#4a3428');
      this.cylinder(cup, 0, -.02, 0, .078, .05, '#c4785a');
      const handle = new THREE.Mesh(new THREE.TorusGeometry(.05, .012, 6, 12, Math.PI), this.mat('#f3eee4', .55));
      handle.position.set(.08, 0, 0); handle.rotation.y = Math.PI / 2; handle.castShadow = true; cup.add(handle);
    }
  }
  clearWorld() {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    this.world.traverse(obj => { const m = obj as THREE.Mesh; if (m.geometry) geometries.add(m.geometry); if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) { materials.add(mat); const map = (mat as THREE.MeshStandardMaterial).map; if (map) textures.add(map); } });
    for (const a of this.actors.values()) textures.add(a.screen);
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); this.world.clear(); this.actors.clear(); this.clickable = []; this.obstacles = [];
  }
  build(room: Room) {
    const previousPositions=new Map([...this.actors].map(([id,actor])=>[id,actor.group.position.clone()]));
    this.departures=[];this.flowSignature='';this.clearWorld(); this.roomId = room.id;
    if (!this.shell) {
    this.box(this.world, 0, -.33, 0, 22, .65, 18, '#b4bbaa', .13);
    this.box(this.world, 0, .006, 0, 21.8, .025, 17.8, '#ddd5bd');
    for (let x = -10.5; x < 11; x += .68) this.box(this.world, x, .028, 0, .012, .012, 17.7, '#c5bea8');
    for (let x = -10.2; x < 11; x += .68) for (let z = -8; z < 9; z += 3.7) this.box(this.world, x, .035, z + Math.sin(x * 7) * .8, .66, .008, .012, '#c4bca6');
    // Rear structural wall and openable right-side window bays, 14 stories above the city.
    this.box(this.world, 0, .56, -8.7, 22, 1.12, .24, '#f0eee0');
    for (let x = -10.5; x <= 10.7; x += 3.5) this.box(this.world, x, 2.6, -8.7, .14, 4.1, .25, '#e2e6d8');
    this.box(this.world, 0, 4.65, -8.7, 22, .22, .27, '#e2e6d8'); this.box(this.world, 0, 2.8, -8.7, 22, .09, .18, '#d3dacd');
    const glass = new THREE.MeshPhysicalMaterial({ color: '#bbd7cf', transparent: true, opacity: .11, roughness: .1, depthWrite: false, side: THREE.DoubleSide });
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(21, 3.5), glass); pane.position.set(0, 2.82, -8.78); this.world.add(pane);
    this.box(this.world, 10.7, .52, -3.7, .24, 1.04, 10.2, '#f0eee0');
    for (let z = -8.5; z <= 1.5; z += 3.3) this.box(this.world, 10.7, 2.55, z, .18, 4.1, .16, '#e1e5d9');
    this.box(this.world, 10.7, 4.65, -3.6, .22, .2, 10.4, '#e1e5d9');
    // Manager suite, an open front and a glass side wall.
    this.box(this.world, -6.1, .06, -5.2, 8.5, .06, 5.8, '#b6baa0');
    this.box(this.world, -10.5, 1.6, -5.2, .15, 3.2, 6.3, '#e8e5d5');
    this.box(this.world, -1.7, 3.5, -5.4, .07, .07, 6, '#647a69');
    const suiteGlass = new THREE.Mesh(new THREE.BoxGeometry(.035, 3.3, 5.8), new THREE.MeshPhysicalMaterial({ color: '#c7ddd2', transparent: true, opacity: .2, roughness: .15, depthWrite: false })); suiteGlass.position.set(-1.7, 1.75, -5.4); this.world.add(suiteGlass);
    this.box(this.world, -1.7, 1.65, -5.4, .08, 3.3, .08, '#5e7666');
    this.sign('MANAGER’S OFFICE', 'A little perspective goes a long way.', -6.1, 4.1, -7.8, 4.3);
    this.plant(-9.5, -7.4, 1.3); this.plant(-2.7, -7.8, 1);
    // Work bays with acoustic dividers.
    this.box(this.world, -3.6, .055, 3.7, 11.6, .05, 9.6, '#9cae98');
    for (let x = -8.7; x < 2.3; x += .55) this.box(this.world, x, .083, 3.7, .014, .005, 9.4, '#a7b6a1');
    // Break room: sofa, table, coffee bar, water cooler and plants.
    this.box(this.world, 6.0, .06, -4.8, 7.7, .04, 6.1, '#dad0b4');
    this.box(this.world, 6.1, .46, -7.0, 3.8, .54, 1.15, '#b87950', .15); this.box(this.world, 6.1, 1.02, -7.42, 3.8, .9, .3, '#b87950', .12);
    for (const x of [4.35, 7.85]) this.box(this.world, x, .85, -7.0, .25, .65, 1.2, '#a76947', .08);
    for (const x of [5, 6.1, 7.2]) this.box(this.world, x, .78, -6.9, .97, .12, .93, '#c38a5f', .07);
    this.cylinder(this.world, 6, .62, -4.7, 1.05, .12, '#e1c18d'); this.cylinder(this.world, 6, .3, -4.7, .18, .58, '#858873');
    this.box(this.world, 6.2, .71, -4.7, .43, .02, .56, '#d5905f'); this.cylinder(this.world, 5.6, .78, -4.55, .09, .23, '#f0e9d6');
    this.box(this.world, 2.5, .68, -6.45, .72, 1.34, .78, '#eef0e3', .07); this.box(this.world, 2.5, .97, -6.04, .43, .43, .05, '#445c51');
    this.cylinder(this.world, 2.5, 1.77, -6.45, .28, .76, '#96bfca'); this.cylinder(this.world, 2.5, 1.36, -6.45, .14, .15, '#d5e0d8');
    this.box(this.world, 2.39, .99, -5.99, .055, .08, .05, '#679db1'); this.box(this.world, 2.62, .99, -5.99, .055, .08, .05, '#be7658');
    this.sign('THE WATER COOLER', 'Good work travels between desks.', 5.8, 3.8, -7.5, 4.2);
    this.plant(9.5, -7.4, 1.5); this.plant(9.5, -.7, 1.3); this.plant(-9.5, 6.8, 1.15);
    // Central pinboard and arrival mat.
    this.box(this.world, 8.2, 1.6, .5, 3.7, 2.1, .18, '#bc9f72', .035);
    for (const x of [6.8, 9.6]) this.box(this.world, x, .65, .5, .065, 1.3, .065, '#536c59');
    const board = new THREE.Mesh(new THREE.PlaneGeometry(3.48, 1.88), new THREE.MeshBasicMaterial({ map: this.textTexture('THE OFFICE BOARD', room.demo ? 'DEMO OFFICE · FLOOR 14' : 'LIVE OFFICE · FLOOR 14', '#d8a466', true, room.goal || 'Your next big idea starts here. Assign a mission to the manager.') })); board.position.set(8.2, 1.6, .6); this.world.add(board);
    this.box(this.world, 6.1, .06, 6.2, 4.4, .04, 2.1, '#687f66');
    this.sign('14 / FOURTEENTH', 'A place for your agents to do their thing.', 6.1, .55, 7.3, 3.4);
    } else {
      this.shell.updateMatrixWorld(true);
      // Batch the authored static architecture by material, keeping draw calls bounded for XR.
      const batches = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
      this.shell.traverse(object => {
        const mesh = object as THREE.Mesh; if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        // The new blob occupants use the task-chair bases as stools: keep their eyes and body labels unobstructed.
        if (/backrest|breathable_mesh|lumbar_support|support_spine|adjustable_headrest|pneumatic_lift|lift_cover|five_star|twin_wheel|seat_shell|seat_cushion|seat_adjustment|armrest|cubicle|partition_stabilizer|pinned_task_sheet/i.test(mesh.name)) return;
        const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone(); geometry.applyMatrix4(mesh.matrixWorld);
        if (!batches.has(mesh.material.uuid)) batches.set(mesh.material.uuid, { material: mesh.material.clone(), geometries: [] });
        batches.get(mesh.material.uuid)!.geometries.push(geometry);
      });
      for (const { material, geometries } of batches.values()) {
        const geometry = mergeGeometries(geometries, false); geometries.forEach(g => g.dispose());
        if (!geometry) continue;
        const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = !material.transparent; mesh.receiveShadow = true;
        if (material.transparent) material.depthWrite = false;
        this.world.add(mesh);
      }
      this.sign('MANAGER’S OFFICE', 'PROJECT DIRECTION / FLOOR 14', -6.1, 3.9, -7.8, 3.8);
      this.sign('BREAK ROOM', 'CONVERSATIONS & HANDOFFS', 5.8, 3.8, -7.5, 3.7);
      this.box(this.world, 8.2, 1.6, .5, 3.7, 2.1, .12, '#303936', .025);
      for (const x of [6.8, 9.6]) this.box(this.world, x, .65, .5, .045, 1.3, .045, '#505957');
      const board = new THREE.Mesh(new THREE.PlaneGeometry(3.48, 1.88), new THREE.MeshBasicMaterial({ map: this.textTexture('THE OFFICE BOARD', room.demo ? 'DEMO OFFICE / FLOOR 14' : 'LIVE OFFICE / FLOOR 14', '#d8a466', true, room.goal || 'Assign a mission to your manager.') })); board.position.set(8.2, 1.6, .571); this.world.add(board);
      // Lounge furniture and the front suite glass participate in walking collision.
      this.obstacles.push(new THREE.Box3(new THREE.Vector3(4.05,0,-7.4),new THREE.Vector3(8.15,2,-5.95)),new THREE.Box3(new THREE.Vector3(4.8,0,-5.6),new THREE.Vector3(7.2,1,-3.2)),new THREE.Box3(new THREE.Vector3(7.6,0,2.7),new THREE.Vector3(9.3,2,5.9)),new THREE.Box3(new THREE.Vector3(-10.5,0,-2.4),new THREE.Vector3(-6.6,4,-1.85)),new THREE.Box3(new THREE.Vector3(-3.55,0,-2.4),new THREE.Vector3(-1.6,4,-1.85)));
    }
    this.obstacles.push(new THREE.Box3(new THREE.Vector3(6.2,0,.2),new THREE.Vector3(10.2,2.7,.8)));
    // Furnish all six specialist seats; occupants represent actual room agents only.
    const visible = visibleAgents(room), manager=visible.find(a=>a.manager), workers=visible.filter(a=>!a.manager);
    this.desk(-6.2,-5.1,manager || null,true);
    for(let i=0;i<6;i++) {
      const x=i%2===0?-5.8:-.7,z=.7+Math.floor(i/2)*2.9;
      this.box(this.world,x,.63,z-.91,3.1,1.1,.08,'#71817b',.02);
      this.box(this.world,x,1.21,z-.91,3.12,.035,.12,'#c1c6b7');
      this.desk(x,z,workers[i] || null);
    }
    this.sign('PROJECT TEAM','SIX SPECIALIST DESKS',-3.3,3.3,7.9,3.4);
    this.plant(-9.1,2.7,.9);this.plant(1.2,6.8,.85);
    // Meeting area stays open to the central aisle and outside the lounge collision.
    const meetingMat=new THREE.Mesh(new THREE.CircleGeometry(1.35,48),this.mat('#aabbb0'));
    meetingMat.rotation.x=-Math.PI/2;meetingMat.position.set(3.7,.055,-2.8);this.world.add(meetingMat);
    for(const departed of room.agents.filter(a=>a.status==='ejected' && (a.ejectedAt || 0)>Date.now()-1800)) {
      const ghost=this.avatar(departed);ghost.userData.departedAt=departed.ejectedAt;ghost.position.set(departed.manager?-6.2:-5.8,0,departed.manager?-3.98:1.82);if(previousPositions.has(departed.id))ghost.position.copy(previousPositions.get(departed.id)!);ghost.userData.origin=ghost.position.clone();this.world.add(ghost);this.departures.push(ghost);
    }
    this.batchStatic();
    this.world.traverse(object=>{const mesh=object as THREE.Mesh;if(mesh.material)for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])(material as THREE.MeshStandardMaterial).fog=false;});
  }
  batchStatic() {
    this.world.updateMatrixWorld(true);
    const groups = new Map<string, THREE.Mesh[]>();
    for (const object of this.world.children) {
      const mesh = object as THREE.Mesh; if (!mesh.isMesh || mesh.userData.agentId || Array.isArray(mesh.material)) continue;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const key = [mat.type, mat.color?.getHexString(), mat.roughness, mat.metalness, mat.transparent, mat.opacity, mat.side, mat.map?.uuid, Object.keys(mesh.geometry.attributes).sort().join(',')].join('|');
      if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(mesh);
    }
    for (const meshes of groups.values()) {
      if (meshes.length < 2) continue;
      const parts = meshes.map(m => { const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone(); return g.applyMatrix4(m.matrixWorld); });
      const merged = mergeGeometries(parts, false); parts.forEach(g => g.dispose()); if (!merged) continue;
      const material = (meshes[0].material as THREE.Material).clone();
      for (const mesh of meshes) { this.world.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
      const mesh = new THREE.Mesh(merged, material); mesh.castShadow = !material.transparent; mesh.receiveShadow = true; this.world.add(mesh);
    }
  }
  update(room: Room, selected: string | null, includeTeam=true) {
    this.room = room; this.selected = selected;
    const visible = visibleAgents(room);
    if (this.roomId !== room.id || this.actors.size!==visible.length || visible.some(a => !this.actors.has(a.id) || (this.actors.get(a.id)!.agent.effectiveModel || this.actors.get(a.id)!.agent.model)!==(a.effectiveModel || a.model) || this.actors.get(a.id)!.agent.name!==a.name || this.actors.get(a.id)!.agent.title!==a.title || this.actors.get(a.id)!.agent.role!==a.role)) this.build(room);
    for (const a of room.agents) {
      const actor = this.actors.get(a.id); if (!actor) continue; actor.agent = a;
      const task=(a.currentWorkItemId?room.workItems?.find(t=>t.id===a.currentWorkItemId):room.workItems?.find(t=>t.agentId===a.id && t.status!=='done')) || room.workItems?.find(t=>t.agentId===a.id);
      const status=task?.status || (a.status==='error'?'blocked':a.status==='done'?'review':a.status==='working'?'working':'ready');
      const colors:Record<string,string>={ready:'#8a969f',working:'#477ead',blocked:'#b55c48',review:'#b88732',done:'#38826c',queued:'#8a969f'};
      const labels:Record<string,string>={ready:'READY',working:'WORKING',blocked:'BLOCKED',review:'REVIEW',done:'VERIFIED',queued:'QUEUED'};
      actor.workStatus=status;actor.beacon.material.color.set(colors[status]);
      const checks=task?.checks?.filter(c=>c.passed).length || 0;
      const sig = [a.name,a.title,a.status,a.effectiveModel,a.model,status,task?.evidence.length,checks,a.events.at(-1)?.text,a.task,selected===a.id].join('|');
      if (sig !== actor.signature) {
        actor.signature = sig;
        const receiptLine=task ? `${task.evidence.length} evidence items / ${checks} of ${task.acceptanceCriteria.length} checks. ` : '';
        const replacement = this.textTexture(a.name, `${labels[status]} / ${a.title || a.role}`, colors[status], true, (task?.title || a.task).split('\n')[0].slice(0,100)+'\n'+(task?.blocker || a.events.filter(e=>e.kind==='update').at(-1)?.text || receiptLine).replace(/\s+/g,' ').slice(0,180),a.progress);
        actor.screen.image = replacement.image; actor.screen.needsUpdate = true; replacement.dispose();
        const material=actor.label.material as THREE.SpriteMaterial;material.map?.dispose();material.map=this.textTexture(a.name, a.title || labels[status], colors[status]);material.needsUpdate=true;
      }

    }
    this.updateFlows(room);
    if(includeTeam)this.updateNeighbor(room);
  }
  updateNeighbor(room:Room) {
    const remote=room.team?.remote;
    const offices=room.team?.offices || (remote?[remote]:[]);
    this.district.update(offices,remote?.id);
    this.renderer.domElement.dataset.officeCount=String(offices.length+1);
    this.renderer.domElement.dataset.detailedOffices=String(remote?2:1);
    this.neighborWorld.visible=!!remote;this.neighborFlow.visible=!!remote;
    if(!remote){if(this.neighborId){this.neighborId='';this.setWalk(false);}return;}
    const position=officePosition(Math.max(0,offices.findIndex(o=>o.id===remote.id)));
    const neighbor:Room={id:remote.id,name:remote.name,path:'',tag:'TEAM',demo:false,goal:remote.name,paused:remote.paused,budget:6,skills:[],timeline:[],checkpoints:[],messages:[],agents:remote.agents.map(a=>({...a,events:[],plan:[],tokens:0,progress:0})),workItems:remote.workItems.map(t=>({...t,description:'',dependsOn:[],acceptanceCriteria:[],evidence:[],createdAt:0,updatedAt:0}))};
    const saved={world:this.world,actors:this.actors,clickable:this.clickable,obstacles:this.obstacles,roomId:this.roomId,room:this.room,selected:this.selected,departures:this.departures,flow:this.flow,flowPaths:this.flowPaths,flowSignature:this.flowSignature};
    const first=this.neighborId!==remote.id;
    this.neighborWorld.position.set(0,0,0);this.neighborWorld.updateMatrixWorld(true);
    try {
      this.world=this.neighborWorld;this.actors=this.neighborActors;this.clickable=this.neighborClickable;this.obstacles=[];this.roomId=this.neighborId;this.departures=[];this.flow=this.neighborFlow;this.flowPaths=[];this.flowSignature=this.neighborFlowSignature;
      this.update(neighbor,null,false);
      this.neighborId=remote.id;this.neighborActors=this.actors;this.neighborClickable=this.clickable;this.neighborFlowSignature=this.flowSignature;
    } finally {Object.assign(this,saved);this.neighborWorld.position.set(position.x,0,position.z);this.neighborFlow.position.set(position.x,0,position.z);}
    if(first)this.focusOffice();
  }
  focusOffice(){if(!this.room?.team?.remote)return;this.setWalk(false);this.setCinema(null);this.controls.maxDistance=280;const p=this.neighborWorld.position;this.controls.target.set(p.x,1,p.z);const fit=Math.max(1,1/this.camera.aspect);this.camera.position.set(p.x+24*fit,24*fit,p.z+30*fit);this.controls.update();}
  focusTeam(){
    if(!this.room?.team?.remote)return;
    this.setWalk(false);this.setCinema(null);this.controls.maxDistance=600;
    const offices=this.room.team.offices || [this.room.team.remote];
    const centers=[{x:0,z:0},...offices.map((_,i)=>officePosition(i))];
    const bounds=new THREE.Box3();
    for(const p of centers){bounds.expandByPoint(new THREE.Vector3(p.x-14,-6,p.z-12));bounds.expandByPoint(new THREE.Vector3(p.x+14,7,p.z+12));}
    const target=bounds.getCenter(new THREE.Vector3());
    const direction=new THREE.Vector3(.55,.9,1).normalize();
    const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),direction).normalize();
    const up=new THREE.Vector3().crossVectors(direction,right).normalize();
    const vertical=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2));
    const horizontal=vertical*this.camera.aspect;
    let distance=0;
    for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
      const delta=new THREE.Vector3(x,y,z).sub(target),depth=delta.dot(direction);
      distance=Math.max(distance,depth+Math.abs(delta.dot(right))/horizontal,depth+Math.abs(delta.dot(up))/vertical);
    }
    // Fit the actual occupied floors, rather than always pulling out for nine lots.
    this.controls.target.copy(target);this.camera.position.copy(target).addScaledVector(direction,distance*1.18);this.controls.update();
  }
  updateFlows(room:Room) {
    const signature=JSON.stringify([this.selected,room.demo,room.workItems?.map(t=>[t.id,t.agentId,t.status,t.dependsOn])]);if(signature===this.flowSignature)return;this.flowSignature=signature;
    this.flow.traverse(o=>{const mesh=o as THREE.Mesh;if(mesh.geometry)mesh.geometry.dispose();if(mesh.material)(mesh.material as THREE.Material).dispose();});this.flow.clear();this.flowPaths=[];
    for(const task of room.workItems || [])for(const id of task.dependsOn){
      const dependency=room.workItems.find(t=>t.id===id);const from=this.actors.get(dependency?.agentId || '');const to=this.actors.get(task.agentId || '');if(!from || !to || from===to)continue;if(!room.demo && task.agentId!==this.selected && dependency?.agentId!==this.selected)continue;
      const start=from.home.clone().setY(.16), end=to.home.clone().setY(.16);
      const curve=new THREE.CatmullRomCurve3([start,new THREE.Vector3(1.7,.16,start.z),new THREE.Vector3(1.7,.16,end.z),end]);
      const color=dependency?.status==='done'?'#38826c':task.status==='blocked'?'#b55c48':'#b88732';
      const line=new THREE.Mesh(new THREE.TubeGeometry(curve,36,.025,5,false),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.65,depthWrite:false}));this.flow.add(line);
      const dot=new THREE.Mesh(new THREE.SphereGeometry(.085,8,6),new THREE.MeshBasicMaterial({color}));this.flow.add(dot);this.flowPaths.push({curve,dot});
    }
  }
  resize = () => {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setSize(w, h); this.camera.aspect = w / Math.max(h, 1);
    if (!this.walk && !this.renderer.xr.isPresenting) {
      const fit = Math.max(1, 1.3 / this.camera.aspect);
      this.camera.position.sub(this.controls.target).multiplyScalar(fit / this.viewScale).add(this.controls.target);
      this.viewScale = fit; this.controls.maxDistance = (this.room?.team?.remote?600:52) * fit;
    }
    this.camera.clearViewOffset(); if(this.panelWidth && !this.walk && w>650)this.camera.setViewOffset(w,h,Math.min(this.panelWidth,w*.45)*.5,0,w,h); this.camera.updateProjectionMatrix();
    this.composer.setSize(w,h);this.occlusion.setSize(Math.max(1,Math.floor(w/2)),Math.max(1,Math.floor(h/2)));
    if(this.cinemaStep!==null)this.setCinema(this.cinemaStep);
  };
  setCinema(step:number|null){
    this.cinemaStep=step;
    if(step===null){this.cinemaShot=null;this.controls.enabled=!this.walk;return;}
    const shots=[[[16,15,20],[-.4,.7,-.3]],[[11,8,12],[1,.8,-1]],[[12,9,12],[1,.5,-2]],[[11,8,11],[-3,1,-3]],[[13,12,17],[-1,.8,1]],[[16,15,20],[-.4,.7,-.3]]];
    const [p,t]=shots[Math.min(step,5)];const target=new THREE.Vector3(...t);const position=new THREE.Vector3(...p).sub(target).multiplyScalar(Math.max(1,1.05/this.camera.aspect)).add(target);
    this.cinemaShot={position,target};this.controls.enabled=false;
    if(this.reduced){this.camera.position.copy(position);this.controls.target.copy(target);this.camera.lookAt(target);}
  }
  tourStop(stop:number){
    this.setCinema(null);this.setWalk(true);
    const poses=[[2.7,1.7,6.7,.04,-.05],[-4.8,1.7,-.5,.22,-.04],[-1.5,1.7,3.7,.85,-.08],[3.1,1.7,-.7,-.35,-.04]];
    const [x,y,z,yaw,pitch]=poses[Math.max(0,Math.min(3,stop))];
    this.camera.position.set(x,y,z);this.yaw=yaw;this.pitch=pitch;
    this.camera.rotation.set(pitch,yaw,0);this.keys.clear();
  }
  setRendering(enabled: boolean) { this.renderingEnabled = enabled; this.syncRendering(); }
  private syncRendering = () => {
    if (this.disposed) return;
    this.clock.getDelta();
    const active = !this.graphicsLost && (this.renderer.xr.isPresenting || (this.renderingEnabled && !document.hidden));
    if (!active) this.keys.clear();
    this.renderer.setAnimationLoop(active ? this.animate : null);
  };
  private contextLost = (event: Event) => {
    event.preventDefault();
    if (this.disposed) return;
    // Recreate the complete scene on Retry, including generated reflection maps.
    this.graphicsLost = true;
    this.syncRendering();
    this.onMarkers?.([]);
    this.onGraphicsLost?.();
  };
  private sessionEnded = () => {
    this.rig.position.set(0, 0, 0); this.rig.rotation.set(0, 0, 0);
    this.setWalk(false); this.syncRendering();
    this.onStatus?.('Returned to the office overview');
  };
  setPanelWidth(width:number){if(width===this.panelWidth)return;this.panelWidth=width;this.resize();}
  setWalk(value: boolean) {
    this.walk = value; this.keys.clear(); this.controls.enabled = !value; this.rig.position.set(0, 0, 0); this.rig.rotation.set(0, 0, 0);
    if (value) { this.camera.position.set(2.7, 1.7, 6.7); this.yaw = .04; this.pitch = -.05; this.camera.rotation.order = 'YXZ'; this.camera.rotation.set(this.pitch, this.yaw, 0); }
    else { this.camera.position.set(16, 15, 20); this.controls.target.set(-.4, .7, -.3); this.viewScale = 1; this.controls.update(); }
    this.resize();
    this.onMode?.(value);
  }
  focus(id: string) { const a = this.actors.get(id); if (!a) return; if (this.walk) { this.camera.position.copy(a.home).add(new THREE.Vector3(0, 1.7, 1.5)); this.yaw = 0; this.pitch = -.05; } else { this.controls.target.copy(a.home).add(new THREE.Vector3(0, .9, -.4)); this.camera.position.copy(a.home).add(new THREE.Vector3(8, 8, 10)); } }
  zoom(factor: number) { if (this.walk) return; this.camera.position.sub(this.controls.target).multiplyScalar(factor).add(this.controls.target); this.controls.update(); }
  pointerDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY }; this.dragging = true; if (this.walk) this.renderer.domElement.setPointerCapture(e.pointerId); };
  pointerMove = (e: PointerEvent) => { if (this.walk && this.dragging) { this.yaw -= e.movementX * .004; this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * .004, -1.1, 1.1); } };
  pointerUp = (e: PointerEvent) => { this.dragging = false; if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6) return; const rect = this.renderer.domElement.getBoundingClientRect(); this.ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.camera); this.selectHit(); };
  contextMenu = (e: Event) => { e.preventDefault(); };
  keyDown = (e: KeyboardEvent) => { if(this.cinemaStep!==null)return; if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return; if (this.walk && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(e.key.toLowerCase())) { e.preventDefault(); this.keys.add(e.key.toLowerCase()); } if (e.key === 'Escape' && this.walk) this.setWalk(false); if (e.key.toLowerCase() === 'e' && this.walk) { this.ray.setFromCamera(new THREE.Vector2(0, 0), this.camera); this.selectHit(); } };
  keyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };
  blur = () => { this.keys.clear(); this.dragging = false; };
  selectHit() { const hit = this.ray.intersectObjects([...this.clickable,...(this.neighborWorld.visible?this.neighborClickable:[])]).find(h => h.object.visible && h.object.parent?.visible !== false); if (hit?.object.userData.agentId) { if(this.neighborActors.has(hit.object.userData.agentId)){this.onTeammate?.();return;}if (this.whipArmed) this.onWhip?.(hit.object.userData.agentId); else this.onSelect(hit.object.userData.agentId); if (this.renderer.xr.isPresenting) this.onStatus?.('Desk selected. Inspect its screen or return to desktop for task controls.'); } else {const office=this.district.hit(this.ray);if(office){if(office===this.room?.team?.remote?.id)this.focusOffice();else this.onOfficeSelect?.(office);}} }
  setWhip(armed: boolean) { this.whipArmed = armed; this.renderer.domElement.style.cursor = armed ? 'crosshair' : ''; this.controls.enableRotate = !armed; }
  reactToWhip(id: string) { this.whipReactions.set(id, this.elapsed + .65); }
  move(dx: number, dz: number) {
    const p = this.camera.position;
    const legal = (x: number, z: number) => x > -10.1 && x < 10 && z > -8.05 && z < 8.1 && !this.obstacles.some(b => x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z) && !(Math.abs(x + 1.7) < .3 && z < -2.3);
    if (legal(p.x + dx, p.z)) p.x += dx; if (legal(p.x, p.z + dz)) p.z += dz;
  }
  async enterVR() {
    if (!navigator.xr || !await navigator.xr.isSessionSupported('immersive-vr')) throw new Error('No VR headset detected. Connect a WebXR headset in a compatible browser.');
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    this.controls.enabled = false; this.walk = false; this.camera.clearViewOffset(); this.camera.position.set(0, 0, 0); this.camera.rotation.set(0, 0, 0); this.rig.position.set(2.7, 0, 6.7);
    if (!this.controllers.length) for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i); this.rig.add(controller); this.controllers.push(controller);
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -10)]);
      controller.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: '#e4ba70' })));
      controller.addEventListener('selectstart', () => {
        const rotation = new THREE.Matrix4().extractRotation(controller.matrixWorld);
        this.ray.ray.origin.setFromMatrixPosition(controller.matrixWorld); this.ray.ray.direction.set(0, 0, -1).applyMatrix4(rotation);
        const target = this.ray.intersectObjects(this.clickable)[0];
        if (target) { this.onSelect(target.object.userData.agentId); return; }
        const point = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
        if (point && Math.abs(point.x) < 9.8 && Math.abs(point.z) < 7.9 && !this.obstacles.some(b => point.x > b.min.x && point.x < b.max.x && point.z > b.min.z && point.z < b.max.z)) {
          const head = this.renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
          this.rig.position.x += point.x - head.x; this.rig.position.z += point.z - head.z;
        }
      });
    }
    await this.renderer.xr.setSession(session);
  }
  animate = () => {
    if (this.disposed || this.graphicsLost || (!this.renderer.xr.isPresenting && (!this.renderingEnabled || document.hidden))) return;
    const dt = Math.min(this.clock.getDelta(), .05); this.elapsed += dt; this.frameCount++;
    this.walkOnly.visible = this.walk || this.renderer.xr.isPresenting;
    if (this.walk && !this.renderer.xr.isPresenting) {
      this.camera.rotation.set(this.pitch, this.yaw, 0);
      const forward = Number(this.keys.has('w') || this.keys.has('arrowup')) - Number(this.keys.has('s') || this.keys.has('arrowdown'));
      const side = Number(this.keys.has('d') || this.keys.has('arrowright')) - Number(this.keys.has('a') || this.keys.has('arrowleft'));
      const speed = dt * (this.keys.has('shift') ? 6 : 3.4) / Math.max(1, Math.hypot(forward, side));
      this.move((side * Math.cos(this.yaw) - forward * Math.sin(this.yaw)) * speed, (-forward * Math.cos(this.yaw) - side * Math.sin(this.yaw)) * speed);
    } else if (!this.renderer.xr.isPresenting) {
      if(this.cinemaShot){const amount=this.reduced?1:1-Math.exp(-dt*1.65);this.camera.position.lerp(this.cinemaShot.position,amount);this.controls.target.lerp(this.cinemaShot.target,amount);this.camera.lookAt(this.controls.target);}else this.controls.update();
    }
    let chatting = 0;
    for (const actor of this.actors.values()) {
      const a = actor.agent;
      if (a.status === 'ejected') {
        const t = Math.min((Date.now() - (a.ejectedAt || 0)) / 1800, 1);
        actor.label.visible = false;actor.beacon.visible=false;
        if (this.reduced || t >= 1) actor.group.visible = false;
        else { actor.group.position.lerpVectors(actor.home, new THREE.Vector3(19, -13, -4), t); actor.group.position.y += Math.sin(t * Math.PI) * 7; actor.body.rotation.z = t * 12; actor.body.rotation.x = t * 6; actor.eyes.forEach(eye => eye.scale.y = 1.3); }
        continue;
      }
      const crossMeeting=['working','talking'].includes(a.status) && this.room?.messages.some(m=>m.status!=='queued' && m.fromOfficeId && (m.fromId===a.id || m.toId===a.id) && (m.receivedAt || 0)>Date.now()-9000);
      const requestedMeeting = crossMeeting || a.status === 'talking' || (a.talkingUntil || 0) > Date.now();
      const talking = requestedMeeting || (actor.visiting && (actor.route.length>0 || this.elapsed<actor.meetingUntil));
      const meetingIndex=talking?chatting++:0;
      const coolerSpot = crossMeeting?new THREE.Vector3(12,0,4):new THREE.Vector3(3.05 + (meetingIndex % 2) * 1.3, 0, -2.8-Math.floor(meetingIndex/2)*1.1);
      if (actor.visiting !== talking) {
        actor.visiting = talking;actor.meetingUntil=0;
        if (talking) { actor.outbound = a.manager ? [new THREE.Vector3(-4.9,0,-1.3),new THREE.Vector3(2,0,-1.3),coolerSpot] : [new THREE.Vector3(actor.home.x,0,actor.home.z+.3),new THREE.Vector3(2,0,actor.home.z+.3),new THREE.Vector3(2,0,-1.3),coolerSpot]; actor.route = actor.outbound.map(p => p.clone()); }
        else actor.route = [...actor.outbound.slice(0,-1).reverse().map(p=>p.clone()),actor.home.clone()];
      }
      const target = actor.route[0] || (talking ? actor.outbound.at(-1) || coolerSpot : actor.home);
      const distance = actor.group.position.distanceTo(target);
      const step = this.reduced ? distance : Math.min(distance, dt * 3);
      if (distance > .01) actor.group.position.add(target.clone().sub(actor.group.position).normalize().multiplyScalar(step));
      if (distance <= .08 && actor.route.length) actor.route.shift();
      if(talking && !actor.route.length && !actor.meetingUntil)actor.meetingUntil=this.elapsed+3;
      actor.group.rotation.y = talking ? ((actor.outbound.at(-1)?.x || 3.05)<3.7?Math.PI/2:-Math.PI/2) : .08;
      const t = this.elapsed + actor.phase;
      if (!this.reduced) {
        const targetHeight = talking || actor.route.length ? .51 : 1.5;
        actor.body.position.y = THREE.MathUtils.lerp(actor.body.position.y, targetHeight, Math.min(dt*5,1));
        if (distance > .07) { actor.body.rotation.z += dt * 5; }
        else { actor.body.rotation.z = Math.sin(t * (talking ? 3 : 1.5)) * (talking ? .2 : .055); actor.body.rotation.x = a.status === 'working' ? Math.sin(t * 2) * .055 : 0; }
        const blink = Math.sin(t * .87) > .994;
        for (const [i, eye] of actor.eyes.entries()) {
          eye.scale.y = blink ? .08 : ['paused', 'idle'].includes(a.status) ? .58 : ['approval', 'error'].includes(a.status) ? 1.18 : 1;
          const pupil = actor.pupils[i]; pupil.position.x = ['approval', 'error'].includes(a.status) ? Math.cos(t * 2) * .027 : Math.sin(t * .65) * .022;
          pupil.position.y = a.status === 'done' ? .028 : a.status === 'working' ? -.017 : Math.sin(t) * .018;
        }
      }
      const reaction = (this.whipReactions.get(a.id) || 0) - this.elapsed;
      if (!this.reduced && reaction > 0) { actor.body.rotation.z = Math.sin(reaction * 18) * .3; actor.eyes.forEach(eye => eye.scale.y = 1.28); }
      actor.label.position.set(actor.group.position.x, 3.12, actor.group.position.z - .65);
      actor.label.visible = this.walk && (this.selected === a.id || this.whipArmed);
      actor.label.scale.setScalar(1);actor.label.scale.set(this.selected===a.id?2.9:2.5,this.selected===a.id?.816:.703,1);
      actor.beacon.position.x=actor.group.position.x;actor.beacon.position.z=actor.group.position.z;actor.beacon.material.opacity=this.reduced?.8:(actor.workStatus==='working'?.68+Math.sin(t*2)*.16:.8);
    }
    if(this.neighborWorld.visible)for(const actor of this.neighborActors.values()){
      const visiting=['working','talking'].includes(actor.agent.status) && this.room?.messages.some(m=>m.status!=='queued' && m.fromOfficeId && (m.fromId===actor.agent.id || m.toId===actor.agent.id) && (m.receivedAt || 0)>Date.now()-9000);
      const target=visiting?new THREE.Vector3(-12,0,4):actor.home;
      const distance=actor.group.position.distanceTo(target);const step=this.reduced?distance:Math.min(distance,dt*3);
      if(distance>.01)actor.group.position.add(target.clone().sub(actor.group.position).normalize().multiplyScalar(step));
      actor.body.position.y=THREE.MathUtils.lerp(actor.body.position.y,visiting?.51:1.5,Math.min(1,dt*5));
      if(!this.reduced){actor.body.rotation.z=distance>.08?actor.body.rotation.z+dt*5:Math.sin(this.elapsed+actor.phase)*.04;actor.eyes.forEach(eye=>eye.scale.y=Math.sin(this.elapsed*.87+actor.phase)>.994?.08:1);}
      actor.label.visible=false;actor.beacon.position.x=actor.group.position.x;actor.beacon.position.z=actor.group.position.z;
    }
    for(const {curve,dot} of this.flowPaths)dot.position.copy(curve.getPoint(this.reduced?.5:(this.elapsed*.15)%1));
    for(const ghost of this.departures){const t=Math.min((Date.now()-ghost.userData.departedAt)/(this.cinemaShot?2800:1800),1);ghost.visible=!this.reduced && t<1;ghost.position.lerpVectors(ghost.userData.origin,new THREE.Vector3(19,-13,-4),t);ghost.position.y+=Math.sin(t*Math.PI)*7;ghost.userData.body.rotation.z=t*12;}
    if(this.frameCount%4===0 && this.onMarkers){
      const w=this.container.clientWidth,h=this.container.clientHeight;
      const markers=[...this.actors.values()].filter(a=>a.agent.status!=='ejected').map(actor=>{const p=actor.group.position.clone().add(new THREE.Vector3(0,2.6,0)).project(this.camera);return {id:actor.agent.id,x:Math.round((p.x+1)*w/2),y:Math.round((1-p.y)*h/2),status:actor.workStatus,depth:p.z};}).filter(p=>p.depth>0 && p.depth<1);
      const inspectingTeammate=this.controls.target.length()>20 || this.camera.position.distanceTo(this.controls.target)>100;
      this.onMarkers(this.walk || this.renderer.xr.isPresenting || inspectingTeammate ? [] : markers);
    }
    this.city.update(this.elapsed, this.reduced);
    this.renderer.info.autoReset=false;this.renderer.info.reset();
    if(!this.renderer.xr.isPresenting && this.container.clientWidth>=700) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    if (this.frameCount % 60 === 0) { this.renderer.domElement.dataset.drawCalls = String(this.renderer.info.render.calls); this.renderer.domElement.dataset.triangles = String(this.renderer.info.render.triangles); }
  };
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    document.removeEventListener('visibilitychange', this.syncRendering);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer.xr.removeEventListener('sessionstart', this.syncRendering);
    this.renderer.xr.removeEventListener('sessionend', this.sessionEnded);
    const own=this.world;this.world=this.neighborWorld;const actors=this.actors;this.actors=this.neighborActors;this.clearWorld();this.world=own;this.actors=actors;
    this.district.dispose();this.city.dispose();this.composer.passes.forEach(pass=>pass.dispose());this.composer.dispose();
    this.resizeObserver.disconnect(); this.controls.dispose(); this.clearWorld();
    this.flow.traverse(o=>{const m=o as THREE.Mesh;if(m.geometry)m.geometry.dispose();if(m.material)(m.material as THREE.Material).dispose();});this.flow.clear();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown); this.renderer.domElement.removeEventListener('pointermove', this.pointerMove); this.renderer.domElement.removeEventListener('pointerup', this.pointerUp); this.renderer.domElement.removeEventListener('contextmenu', this.contextMenu);
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.blur); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
  }
}
