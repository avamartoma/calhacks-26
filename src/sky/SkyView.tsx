import { Folder, Sun } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { createSkyRenderer2D, stackOrder, type SkyRenderer } from './renderer';
import { createSkyRenderer3D } from './renderer-3d';
import { createSkyRendererBalloons } from './renderer-balloons';
import { LABEL_SHARE, YOUR_SCALE, createSkyRendererVector, createSkyRendererVector2D, zoomedOutBoost } from './renderer-vector';
import { localHour, paletteAt } from './time-of-day';
import { CLOUD_WIDTH, CLOUD_ASPECT, MAX_ZOOM, layerScale, baseDistance, easeInOut, fly, flyRelative, look, panBy, rayThrough, zoomAt, type Camera, type Viewport } from './sky-math';
import { agentKinds, isWorking, kindOf, type SkyAgent } from './agents';
import './sky.css';

/**
 * A project in the sky. Yours (and you) sit in the front layer (depth 1) with a label; other
 * projects you can see in the workspace sit further back, without text until you go to them.
 */
/** `placed` is where you dragged one of your clouds; it stays there instead of joining the cluster. */
export interface SkyProject { id: string; name: string; description: string; detail?: string; mine: boolean; x: number; y: number; depth: number; seed: number; kind?: 'you'; agents?: SkyAgent[]; owner?: string; size?: number; placed?: { x: number; y: number }; raise?: number }
/**
 * `clouds` is the default: vector clouds on a flat canvas with parallax layers. `balloons` is
 * the 3D option. `clouds3d` (vector clouds in 3D), `soft` (3D puff clouds) and `2d` (flat puff
 * clouds) are earlier looks, still reachable with `?sky=`.
 */
export type SkyStyle = 'clouds' | 'balloons' | 'clouds3d' | 'soft' | '2d';

/** Flat styles pan and zoom; 3D styles can also turn and fly. */
const isFlat = (style: SkyStyle) => style === 'clouds' || style === '2d';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const cssColor = (rgb: number[]) => `rgb(${rgb.map(c => Math.round(c * 255)).join(',')})`;
/** Width of a label before scaling, in CSS pixels. */
const LABEL_WIDTH = 150;
// Fonts of a cloud's label (see .vector-sky .sky-label in sky.css), for measuring text.
// Your clouds' titles are a little larger than those of projects further back.
const TITLE_FONT = '600 18px Sora, sans-serif', YOUR_TITLE_FONT = '600 21px Sora, sans-serif', OTHER_TITLE_FONT = '600 20px Sora, sans-serif', BODY_FONT = '500 12.5px Manrope, sans-serif';
let measurer: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font = TITLE_FONT) {
  if (measurer === undefined) measurer = document.createElement('canvas').getContext('2d');
  if (!measurer) return text.length * (font === BODY_FONT ? 6 : 9.5);
  measurer.font = font;
  return measurer.measureText(text).width;
}
/** Width of one agent blob and its gap, in label pixels (.agent-blob in sky.css). */
const BLOB = 27;
/**
 * How wide a project's label is, at full size: enough for its title in at most two lines (never
 * cut off). The description shows at most two lines, ending in an ellipsis. The cloud is sized
 * to match (the label is half its width), wide enough for its agents along the bottom.
 */
function labelWidthOf(p: SkyProject) {
  const font = p.mine ? YOUR_TITLE_FONT : OTHER_TITLE_FONT, words = p.name.split(/\s+/).filter(Boolean).map(word => textWidth(word, font)), space = textWidth(' ', font);
  // Lines the title takes at a width, wrapping only between words, as the cloud draws it.
  const lines = (width: number) => { let count = 1, line = 0; for (const word of words) { if (!line) line = word; else if (line + space + word <= width) line += space + word; else { count++; line = word; } } return count; };
  let width = Math.max(200, Math.ceil(Math.max(Math.max(0, ...words) + 20, (p.agents?.length || 0) * BLOB * 1.1)));
  while (width < 600 && lines(width - 20) > 2) width += 10;
  return width;
}
/** On the flat canvas, your project clouds are 660 units wide at size 1, about half as tall. */
const FLAT_CLOUD = 660;

/** Where each cloud sits, remembered in this browser, with the order you last moved them. */
type Spot = { x: number; y: number; raise?: number };
// v2: shared projects start beside yours instead of underneath them.
const POSITIONS = 'iteration1-sky-positions-v2';
function loadPositions(): Record<string, Spot> {
  try { const saved = JSON.parse(localStorage.getItem(POSITIONS) || '{}'); return saved && typeof saved === 'object' ? saved : {}; } catch { return {}; }
}
function savePositions(positions: Record<string, Spot>) { try { localStorage.setItem(POSITIONS, JSON.stringify(positions)); } catch { /* full or blocked: positions last for this visit */ } }

/** The nearest spot to `at` where a new cloud overlaps none of yours, in world units. */
function freeSpot(cloud: SkyProject, at: { x: number; y: number }, others: SkyProject[]) {
  const box = (p: SkyProject) => { const w = FLAT_CLOUD * (p.size || 1); return { w, h: w * .52 }; };
  const own = box(cloud), gap = 60;
  const clear = (x: number, y: number) => others.every(o => { const b = box(o); return Math.abs(o.x - x) >= (own.w + b.w) / 2 + gap || Math.abs(o.y - y) >= (own.h + b.h) / 2 + gap; });
  for (let r = 0; r <= 6000; r += 60) for (let k = 0; k < (r ? 24 : 1); k++) {
    const angle = k / 24 * Math.PI * 2, x = at.x + Math.cos(angle) * r, y = at.y + Math.sin(angle) * r;
    if (clear(x, y)) return { x, y };
  }
  return at;
}

/**
 * Your projects in a tight honeycomb: rows of clouds with small, even gaps, alternate rows
 * offset, so they sit close together without overlapping.
 */
function honeycomb(mine: SkyProject[]): SkyProject[] {
  if (!mine.length) return mine;
  const widest = Math.max(...mine.map(p => p.size || 1)) * FLAT_CLOUD;
  // Roughly square clusters: two over one for three, two over two for four, three over two for five.
  const columns = Math.max(1, Math.ceil(Math.sqrt(mine.length)));
  const across = widest + 60, down = widest * .52 + 70;
  const rows = Math.ceil(mine.length / columns);
  return mine.map((p, i) => {
    const row = Math.floor(i / columns), column = i % columns, inRow = Math.min(columns, mine.length - row * columns);
    return { ...p, x: (column - (inRow - 1) / 2 + (row % 2 ? .25 : -.25) * (inRow > 1 ? 1 : 0)) * across, y: (row - (rows - 1) / 2) * down };
  });
}

/** The camera that frames you and your projects, at the front layer. */
function homeCamera(projects: SkyProject[], view: Viewport, style: SkyStyle): Camera {
  const mine = projects.filter(p => p.mine);
  if (!mine.length) {
    // No projects of your own yet: frame everything shared in this workspace instead of an empty sky.
    if (style !== 'clouds' || !projects.length) return { x: 0, y: 0, zoom: 1, z: 0 };
    const half = (p: SkyProject) => FLAT_CLOUD * (p.size || 1) * .25;
    const minX = Math.min(...projects.map(p => p.x - half(p))), maxX = Math.max(...projects.map(p => p.x + half(p)));
    const minY = Math.min(...projects.map(p => p.y - half(p) * .6)), maxY = Math.max(...projects.map(p => p.y + half(p) * .6));
    const zoom = Math.min(.6, Math.max(.12, Math.min(view.width * .8 / (maxX - minX), view.height * .75 / (maxY - minY))));
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom, z: 0 };
  }
  // A balloon reaches about 130 units above its center and, with its basket, about 200 below;
  // a vector cloud is 660 wide and 340 tall on the flat canvas, 420 by 220 in 3D.
  const balloon = style === 'balloons', vector = style === 'clouds', vector3d = style === 'clouds3d';
  const half = (p: SkyProject) => balloon ? 130 : vector ? FLAT_CLOUD * (p.size || 1) / 2 : vector3d ? 210 : CLOUD_WIDTH / 2;
  const above = (p: SkyProject) => balloon ? 140 : vector ? half(p) * .52 : vector3d ? 130 : half(p) * CLOUD_ASPECT, below = (p: SkyProject) => balloon ? 200 : above(p);
  const minX = Math.min(...mine.map(p => p.x - half(p))), maxX = Math.max(...mine.map(p => p.x + half(p)));
  const minY = Math.min(...mine.map(p => p.y - above(p))), maxY = Math.max(...mine.map(p => p.y + below(p)));
  // An overview, not a close-up: your projects in the middle, with room around them for the
  // shared projects. The flat sky's bigger clouds need a wider view.
  // On the flat canvas, close enough that every one of your clouds shows its description and agents.
  const fit = Math.min(view.width * .6 / (maxX - minX), view.height * .5 / (maxY - minY));
  // On the flat canvas, a typical one of your clouds is a little over a quarter of the sky's width, with
  // room to see the shared projects around them. (Size grows as zoom^0.82 when zoomed out.)
  const typical = FLAT_CLOUD * 1.33, comfortable = Math.pow(view.width * .28 / typical, 1 / .82);
  // The flat sky opens at that comfortable size, centered on your projects, even if some sit just off screen.
  const zoom = vector ? Math.min(.6, Math.max(.12, comfortable)) : Math.min(1.3, Math.max(.45, fit));
  // In 3D, a slight angle, so the depth of the sky shows from the start.
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom, z: 0, ...(isFlat(style) ? {} : { yaw: -.16, pitch: .1 }) };
}

/**
 * The workspace sky, with a switch between two looks: projects as hot air balloons, or as
 * clouds. The choice is remembered; `?sky=` in the address overrides it.
 */
export function SkyView(props: { projects: SkyProject[]; onEnter: (id: string) => void; returnFrom?: string | null; onMove?: (id: string, x: number, y: number) => void }) {
  // Clouds only for now. The other looks (balloons in 3D among them) are kept but hidden; open
  // one with `?sky=balloons` and so on. See "Hidden sky looks" in the README before deleting them.
  const style = (new URLSearchParams(location.search).get('sky') || 'clouds') as SkyStyle;
  const [view, setView] = useState<'sky' | 'folders'>('sky');
  // "Only show my projects" hides everyone else's projects, in the sky and the folders.
  const [onlyMine, setOnlyMine] = useState(() => localStorage.getItem('iteration1-only-mine') === '1');
  useEffect(() => { localStorage.setItem('iteration1-only-mine', onlyMine ? '1' : '0'); }, [onlyMine]);
  // Commands for the sky from the corner controls.
  const [command, setCommand] = useState<SkyCommand>({ kind: 'none', n: 0 });
  const go = (kind: SkyCommand['kind']) => setCommand(c => ({ kind, n: c.n + 1 }));
  return <div className="sky-shell-view">
    <SkySpace key={style} style={style} command={command} onlyMine={onlyMine} {...props} />
    {view === 'folders' && <ProjectFolders projects={onlyMine ? props.projects.filter(p => p.mine) : props.projects} onOpen={props.onEnter} />}
    <div className="sky-corner">
      <button className="sky-home-button" onClick={() => { setView('sky'); go('home'); }} aria-label="Home: back to your projects" title="Back to your projects"><HomeIcon /></button>
      <div className="sky-view-toggle" role="tablist" aria-label="Projects view">
        <button role="tab" aria-selected={view === 'sky'} aria-label="Sky" title="Sky" className={view === 'sky' ? 'active' : ''} onClick={() => setView('sky')}><Sun size={17} /></button>
        <button role="tab" aria-selected={view === 'folders'} aria-label="Folders" title="Folders" className={view === 'folders' ? 'active' : ''} onClick={() => setView('folders')}><Folder size={17} /></button>
      </div>
      <label className="sky-only-mine"><input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} /> Only show my projects</label>
    </div>
  </div>;
}
export interface SkyCommand { kind: 'none' | 'home'; n: number }

function SearchIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
}
function HomeIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></svg>;
}

function AgentDots({ agents }: { agents?: SkyAgent[] }) {
  if (!agents?.length) return null;
  // Little blob people, as in the office: one per agent, colored by type. Working ones bob.
  return <span className="agent-dots">{agents.map((a, i) => {
    const kind = kindOf(a.role, a.manager);
    return <svg key={i} className={`agent-blob ${isWorking(a.status) ? 'working' : ''}`} viewBox="0 0 42 45" style={{ animationDelay: `${(i % 5) * .18}s` }} role="img" aria-label={`${a.role}, ${kind.label}${isWorking(a.status) ? ', working' : ''}`}>
      <title>{`${a.role} · ${kind.label}${isWorking(a.status) ? ' · working' : ''}`}</title>
      <ellipse cx="21" cy="42" rx="12" ry="2.4" fill="#1f284022" />
      <circle cx="21" cy="22" r="19" fill={kind.color} stroke="#ffffffd0" strokeWidth="2" />
      <ellipse cx="15.5" cy="18" rx="4.1" ry="5.1" fill="#f8f8ef" /><ellipse cx="26.5" cy="18" rx="4.1" ry="5.1" fill="#f8f8ef" />
      <ellipse cx="15.9" cy="18.8" rx="1.8" ry="2.4" fill="#34443b" /><ellipse cx="26.9" cy="18.8" rx="1.8" ry="2.4" fill="#34443b" />
    </svg>;
  })}</span>;
}

/** Every project as a card, in two folders: yours, and others' you can see in this workspace. */
function ProjectFolders({ projects, onOpen }: { projects: SkyProject[]; onOpen: (id: string) => void }) {
  const mine = projects.filter(p => p.mine && p.kind !== 'you'), shared = projects.filter(p => !p.mine);
  const card = (p: SkyProject) => <article key={p.id} className={`folder-card ${p.mine ? 'mine' : ''}`}>
    <header><b>{p.name}</b>{p.mine && <span className="folder-tag">Yours</span>}</header>
    <p>{p.description || 'No description yet.'}</p>
    <footer><AgentDots agents={p.agents} /><small>{p.agents?.length ? `${p.agents.length} agent${p.agents.length === 1 ? '' : 's'}` : 'No agents yet'}{p.owner ? ` · ${p.owner}` : ''}</small></footer>
    {p.mine && <div className="folder-actions"><button className="primary" onClick={() => onOpen(p.id)}>Open</button></div>}
  </article>;
  return <div className="project-folders">
    <section><h2>Your projects <small>{mine.length}</small></h2>{mine.length ? <div className="folder-grid">{mine.map(card)}</div> : <p className="folder-empty">No projects yet.</p>}</section>
    <section><h2>Shared with you <small>{shared.length}</small></h2>{shared.length ? <div className="folder-grid">{shared.map(card)}</div> : <p className="folder-empty">Nothing shared with you in this workspace yet.</p>}</section>
  </div>;
}

/**
 * A 3D sky that follows the local time of day. Drag to move and scroll to zoom. Click any
 * project to fly to it through the sky, including those further back. Zooming into one of
 * your projects (or clicking it) flies into it: the screen fills with white and its page
 * appears. Labels are HTML, placed on each object so text stays crisp and always fits.
 */
function SkySpace({ style, projects, onEnter, returnFrom, command, onMove, onlyMine }: { style: SkyStyle; projects: SkyProject[]; onEnter: (id: string) => void; returnFrom?: string | null; command?: SkyCommand; onMove?: (id: string, x: number, y: number) => void; onlyMine?: boolean }) {
  const balloons = style === 'balloons';
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), whiteout = useRef<HTMLDivElement>(null);
  const labels = useRef(new Map<string, HTMLElement>()), agentRows = useRef(new Map<string, HTMLElement>());
  // On the flat canvas each cloud is sized to its title, yours sit in a tight honeycomb, and
  // shared ones sit close around them on layers further back.
  const spread = style === 'clouds' ? 1.45 : style === 'clouds3d' ? 1.35 : 1;
  const shown = onlyMine ? projects.filter(p => p.mine) : projects;
  const list = useRef(shown);
  /** Clouds moved this visit, so a cloud stays put while its new position is being saved. */
  const moved = useRef(new Map<string, { x: number; y: number }>());
  /** Every cloud's position, kept in this browser: a cloud moves only when you move it. */
  const positions = useRef<Record<string, Spot> | null>(null);
  if (!positions.current) positions.current = loadPositions();
  if (style === 'clouds') {
    const store = positions.current, sized = shown.map(p => ({ ...p, size: labelWidthOf(p) / LABEL_WIDTH }));
    const at = (p: SkyProject) => moved.current.get(p.id) || (p.mine && p.placed) || store[p.id];
    // A cloud seen for the first time gets a spot once, which is then kept: yours start as a
    // tight cluster; a new project of yours takes the nearest free spot beside the others; a
    // shared project keeps its place further back.
    let added = false;
    const mine = sized.filter(p => p.mine), fresh = mine.filter(p => !at(p));
    if (fresh.length) {
      const known = mine.filter(p => at(p)).map(p => ({ ...p, ...at(p)! }));
      if (!known.length) for (const p of honeycomb(fresh)) store[p.id] = { x: p.x, y: p.y };
      else {
        const middle = { x: known.reduce((t, p) => t + p.x, 0) / known.length, y: known.reduce((t, p) => t + p.y, 0) / known.length };
        for (const p of fresh) { const spot = freeSpot(p, middle, known); store[p.id] = spot; known.push({ ...p, ...spot }); }
      }
      added = true;
    }
    // A shared project starts in the nearest free spot to its place around yours, never under one.
    const taken = sized.filter(p => at(p) || store[p.id]).map(p => ({ ...p, ...(at(p) || store[p.id]), size: (p.size || 1) * (p.mine ? 1 : .72) }));
    for (const p of sized) if (!p.mine && !store[p.id]) {
      const shrunk = { ...p, size: (p.size || 1) * .72 }, spot = freeSpot(shrunk, { x: p.x * spread, y: p.y * spread }, taken);
      store[p.id] = spot; taken.push({ ...shrunk, ...spot }); added = true;
    }
    if (added) savePositions(store);
    // Each cloud carries its text and agents, which the sky draws as part of the cloud.
    list.current = sized.map(p => { const spot = at(p)!; return { ...p, x: spot.x, y: spot.y, placed: spot, raise: store[p.id]?.raise,
      text: { title: p.name, description: p.description, mine: p.mine, width: labelWidthOf(p) },
      agentBlobs: (p.agents || []).map(a => ({ color: kindOf(a.role, a.manager).color, working: isWorking(a.status) })) }; });
  } else list.current = spread === 1 ? shown : shown.map(p => ({ ...p, x: p.x * spread, y: p.y * spread }));
  const enter = useRef(onEnter); enter.current = onEnter;
  const renderer = useRef<SkyRenderer | null>(null);
  const palette = paletteAt(localHour());
  const s = useRef({
    view: { width: 1, height: 1 } as Viewport, camera: { x: 0, y: 0, zoom: 1, z: 0 } as Camera,
    anim: null as null | { from: Camera; to: Camera; start: number; duration: number; done?: () => void },
    drag: null as null | { x: number; y: number; camera: Camera; moved: boolean; mode: 'look' | 'move' | 'cloud'; cloud?: SkyProject },
    hover: null as string | null, hoverAmount: 0, entering: false, palette, paletteAt: 0, homeScale: 1,
    keys: new Set<string>(), lastFrame: 0
  });
  const flat = isFlat(style);
  /** Fingers on the screen, for pinch zoom on touch devices. */
  const touches = useRef(new Map<number, { x: number; y: number }>());

  const screenOf = (p: SkyProject) => renderer.current!.project(p, s.current.camera);
  const depthOf = (p: SkyProject) => renderer.current?.worldDepth?.(p) ?? 0;
  /**
   * The home view: your projects' comfortable zoom, centered on everything in the sky, so the
   * middle of the leftmost and rightmost clouds (and the top and bottom ones) is the middle of
   * the page. Clouds further back move at their own pace, so this is measured on screen.
   */
  function home() {
    let camera = homeCamera(list.current, s.current.view, style);
    const sky = renderer.current;
    if (style !== 'clouds' || !sky || !list.current.length) return camera;
    for (let i = 0; i < 6; i++) {
      const boxes = list.current.map(p => sky.project(p, camera)).filter(b => b.width > 0);
      if (!boxes.length) break;
      const left = Math.min(...boxes.map(b => b.x - b.width / 2)), right = Math.max(...boxes.map(b => b.x + b.width / 2));
      const top = Math.min(...boxes.map(b => b.y - b.height / 2)), bottom = Math.max(...boxes.map(b => b.y + b.height / 2));
      const dx = (left + right) / 2 - s.current.view.width / 2, dy = (top + bottom) / 2 - s.current.view.height / 2;
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5) break;
      camera = { ...camera, x: camera.x + dx / camera.zoom, y: camera.y + dy / camera.zoom };
    }
    return camera;
  }
  function hit(px: number, py: number) {
    if (!renderer.current) return null;
    // The cloud you see on top wins; anything behind the camera has no size.
    const ordered = [...list.current].sort((a, b) => style === 'clouds' ? stackOrder(b, a) : depthOf(b) - depthOf(a));
    return ordered.find(p => {
      const c = screenOf(p);
      const dx = (px - c.x) / (c.width * .44), dy = (py - c.y) / (c.height * .46);
      return c.width > 0 && dx * dx + dy * dy < 1;
    }) || null;
  }
  function animate(to: Camera, duration: number, done?: () => void) {
    if (reducedMotion()) { s.current.camera = to; s.current.anim = null; done?.(); return; }
    s.current.anim = { from: { z: 0, yaw: 0, pitch: 0, ...s.current.camera }, to: { z: 0, yaw: 0, pitch: 0, ...to }, start: performance.now(), duration, done };
  }
  const immerse = () => renderer.current?.immerse || { start: 1.35, full: 2.7 };
  /** The zoom at which this project fills the screen; front-layer size grows in step with zoom. */
  function insideZoom(p: SkyProject) {
    const width = renderer.current ? renderer.current.project(p, { x: p.x, y: p.y, zoom: 1, z: 0, yaw: 0, pitch: 0 }).width : CLOUD_WIDTH;
    return Math.min(MAX_ZOOM, s.current.view.width * (immerse().full + .15) / Math.max(1, width));
  }
  /** On the flat canvas, the zoom at which a cloud on a far layer is about 380 px wide. */
  function readableZoom(p: SkyProject) {
    let low = .2, high = MAX_ZOOM;
    for (let i = 0; i < 24; i++) {
      const mid = Math.sqrt(low * high), width = renderer.current?.project(p, { x: p.x, y: p.y, zoom: mid }).width || 0;
      if (width < 380) low = mid; else high = mid;
    }
    return low;
  }
  /** Fly to a project: into yours (its page opens), or over to someone else's. */
  function flyTo(p: SkyProject) {
    if (s.current.entering) return;
    if (p.kind === 'you') { animate(home(), 900); return; }
    if (p.mine) {
      s.current.entering = true;
      const z = s.current.camera.z || 0;
      // From further back, come forward to your layer first, then into the project.
      // Turn to face it straight on while flying in.
      if (z < -40) animate({ x: p.x, y: p.y, zoom: 1.2, z: 0, yaw: 0, pitch: 0 }, 1100, () => animate({ x: p.x, y: p.y, zoom: insideZoom(p), z: 0 }, 900, () => enter.current(p.id)));
      else animate({ x: p.x, y: p.y, zoom: insideZoom(p), z: 0, yaw: 0, pitch: 0 }, 950, () => enter.current(p.id));
      return;
    }
    // Someone else's project: travel over to it, close enough that its name appears.
    if (flat) { animate({ x: p.x, y: p.y, zoom: readableZoom(p) }, 900); return; }
    const distance = Math.abs(depthOf(p) - (s.current.camera.z || 0));
    const { yaw, pitch } = s.current.camera;
    animate({ x: p.x, y: p.y, zoom: 1.45, z: depthOf(p), yaw, pitch }, Math.min(2200, 800 + distance * .5));
  }

  useEffect(() => {
    const el = host.current!, state = s.current;
    try {
      const c = canvas.current!;
      renderer.current = style === 'clouds' ? createSkyRendererVector2D(c) : style === 'balloons' ? createSkyRendererBalloons(c) : style === 'clouds3d' ? createSkyRendererVector(c) : style === 'soft' ? createSkyRenderer3D(c) : createSkyRenderer2D(c);
    }
    catch (error) { console.error('The sky could not start WebGL', error); el.classList.add('sky-fallback'); return; }
    const sky = renderer.current;

    const resize = () => {
      const box = el.getBoundingClientRect();
      state.view = { width: Math.max(1, box.width), height: Math.max(1, box.height) };
      sky.resize(state.view, Math.min(window.devicePixelRatio || 1, 1.5));
      // The home zoom, and the text scale of your clouds there: projects further back clear up,
      // and show their details, as you zoom in past it.
      const homeZoom = homeCamera(list.current, state.view, style).zoom;
      sky.setHomeZoom?.(homeZoom);
      state.homeScale = LABEL_SHARE * FLAT_CLOUD * YOUR_SCALE * homeZoom * zoomedOutBoost(homeZoom) / LABEL_WIDTH;
    };
    resize();
    sky.setClouds(list.current);
    const back = returnFrom && list.current.find(p => p.id === returnFrom && p.mine);
    if (back && !reducedMotion()) {
      // Coming out of a project: start inside it and pull back out to your projects.
      state.camera = { x: back.x, y: back.y, zoom: insideZoom(back), z: 0, yaw: 0, pitch: 0 };
      state.entering = true;
      animate(home(), 1300, () => { state.entering = false; });
    } else state.camera = home();

    // Ready for W A S D straight away, without clicking first.
    el.focus({ preventScroll: true });
    const observer = new ResizeObserver(resize); observer.observe(el);
    const emphasis = new Map<string, number>();
    let frame = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (document.hidden) return;
      const { view } = state;
      if (state.anim) {
        const a = state.anim, t = Math.min(1, (now - a.start) / a.duration), e = easeInOut(t);
        const lerp = (from = 0, to = 0) => from + (to - from) * e;
        state.camera = { x: lerp(a.from.x, a.to.x), y: lerp(a.from.y, a.to.y), z: lerp(a.from.z, a.to.z), yaw: lerp(a.from.yaw, a.to.yaw), pitch: lerp(a.from.pitch, a.to.pitch), zoom: Math.exp(Math.log(a.from.zoom) + (Math.log(a.to.zoom) - Math.log(a.from.zoom)) * e) };
        if (t >= 1) { const done = a.done; state.anim = null; done?.(); }
      }
      if (now - state.paletteAt > 30000) {
        state.palette = paletteAt(localHour()); state.paletteAt = now;
        el.style.setProperty('--sky-ink', state.palette.ink); el.style.setProperty('--sky-glow', state.palette.glow); el.style.setProperty('--sky-cloud', cssColor(state.palette.cloudLight));
      }
      sky.setClouds(list.current);
      state.hoverAmount += ((state.hover ? 1 : 0) - state.hoverAmount) * .18;
      // Held keys fly: W/S forward and back, A/D sideways, Q/E down and up.
      const dt = Math.min(.05, (now - (state.lastFrame || now)) / 1000); state.lastFrame = now;
      if (state.keys.size && !state.entering && !flat) {
        const speed = baseDistance(view) / state.camera.zoom * .9 * dt, k = (key: string) => state.keys.has(key) ? 1 : 0;
        state.anim = null;
        state.camera = flyRelative(state.camera, (k('w') - k('s')) * speed, (k('d') - k('a')) * speed, (k('e') - k('q')) * speed);
      }


      // How far inside your nearest project you are: the screen turns white as you go in.
      let immersion = 0, deepest: SkyProject | null = null;
      // How visible each cloud's text is, for the renderer, which draws it with the cloud.
      const textState = new Map<string, { opacity: number; detail: boolean }>();
      const placedNow = new Map(list.current.map(p => [p.id, screenOf(p)]));
      for (const p of list.current) {
        const c = placedNow.get(p.id)!;
        const onScreen = c.width > 0 && c.x + c.width / 2 > -40 && c.x - c.width / 2 < view.width + 40 && c.y + c.height / 2 > -40 && c.y - c.height / 2 < view.height + 40;
        if (p.mine && p.kind !== 'you' && c.width > 0 && Math.abs(state.camera.z || 0) < 40) {
          // You are inside a cloud once it is much wider than the screen and the middle of the screen
          // is well within its body. (Zooming toward the cursor keeps the point under it still, so
          // the cloud's own center may sit far off screen by then; that is fine.)
          const ex = (view.width / 2 - c.x) / (c.width * .45), ey = (view.height / 2 - c.y) / (c.height * .42);
          const inside = 1 - smooth(.6, 1, Math.hypot(ex, ey));
          const depth = smooth(immerse().start, immerse().full, c.width / view.width) * inside;
          if (depth > immersion) { immersion = depth; deepest = p; }
        }
        const label = labels.current.get(p.id);
        if (!label) continue;
        // A cloud, its text and its agents are one unit: the text keeps a fixed size and place
        // relative to the cloud, so zooming scales them together and nothing spills out.
        const spot = c.label || { x: c.x, y: c.y, width: c.width * .62 };
        const base = style === 'clouds' ? labelWidthOf(p) : LABEL_WIDTH, scale = spot.width / base;
        label.style.width = `${base}px`;
        // Text too small to read fades out rather than growing past its cloud.
        const titlePx = scale * (p.mine ? 21 : 20);
        let opacity = p.kind === 'you' ? 1 : smooth(5, 7, titlePx) * (1 - smooth(view.width * (balloons ? .5 : .8), view.width * (balloons ? .8 : 1.3), c.width));
        if (!onScreen) opacity = 0;
        emphasis.set(p.id, opacity);
        // Your clouds show their description and agents whenever they are legible; a project
        // further back shows them once its text has grown to the size of yours at the home view.
        const detail = balloons ? c.width >= 190 : p.mine ? scale * 12.5 >= 6.5 : scale >= state.homeScale * .98;
        label.style.transform = `translate(${spot.x}px, ${spot.y}px) translate(-50%, -50%) scale(${scale})`;
        label.classList.toggle('compact', !detail);
        textState.set(p.id, { opacity, detail });
        // Labels stack like their clouds: the one you moved last on top.
        label.style.zIndex = String((p.raise || 0) + (p.mine ? 1 : 0));
        // Agents stand at the cloud's bottom right, half hanging off its edge.
        const row = agentRows.current.get(p.id);
        if (row) {
          const at = c.agents || { x: c.x + c.width * .4, y: c.y + c.height * .4 };
          row.style.transform = `translate(${at.x}px, ${at.y}px) translate(-100%, -50%) scale(${scale})`;
          row.style.transformOrigin = '100% 50%';
          const shown = detail ? opacity : 0;
          row.style.opacity = shown.toFixed(3); row.style.visibility = shown < .02 ? 'hidden' : 'visible';
          row.style.zIndex = label.style.zIndex;
        }
        label.style.opacity = opacity.toFixed(3);
        label.style.visibility = opacity < .02 ? 'hidden' : 'visible';
      }
      if (whiteout.current) whiteout.current.style.opacity = immersion.toFixed(3);
      // Fully inside one of your projects from zooming: open it.
      if (immersion > .985 && deepest && !state.entering && !state.anim) { state.entering = true; enter.current(deepest.id); }

      sky.render({ camera: state.camera, time: reducedMotion() ? 0 : now / 1000, palette: state.palette, hover: { id: state.hover, amount: state.hoverAmount }, emphasis, labels: textState });
    };
    frame = requestAnimationFrame(loop);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (state.entering) return;
      state.anim = null;
      const box = el.getBoundingClientRect(), cursor = { x: e.clientX - box.left, y: e.clientY - box.top };
      // A mouse wheel moves in steps (or whole lines); a trackpad swipe moves smoothly, often sideways too.
      const wheel = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
      if (!e.ctrlKey && !wheel) {
        // Two-finger swipe: move around the sky, as when scrolling a map.
        state.camera = panBy(state.camera, -e.deltaX, -e.deltaY);
        return;
      }
      if (flat) { state.camera = zoomAt(state.camera, state.camera.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? .012 : .0016)), cursor, state.view); return; }
      // Pinch or mouse wheel: fly toward wherever the cursor points, as far as you like.
      const step = -e.deltaY * (e.ctrlKey ? 6 : 1) * baseDistance(state.view) / state.camera.zoom * .0016;
      state.camera = fly(state.camera, rayThrough(state.camera, state.view, cursor), step);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); el.removeEventListener('wheel', onWheel); sky.dispose(); renderer.current = null; };
  }, []);

  useEffect(() => {
    if (!command || command.kind === 'none' || !renderer.current) return;
    s.current.entering = false;
    if (command.kind === 'home') animate(home(), 900);
  }, [command?.n]);
  const point = (e: PointerEvent) => { const box = host.current!.getBoundingClientRect(); return { x: e.clientX - box.left, y: e.clientY - box.top }; };
  function onPointerDown(e: PointerEvent) {
    if (e.button > 2 || s.current.entering) return;
    // Keep receiving the pointer outside the sky while dragging (not possible for every pointer).
    try { host.current!.setPointerCapture(e.pointerId); } catch { /* the drag still works inside the sky */ }
    const p = point(e);
    touches.current.set(e.pointerId, p);
    // A second finger turns the gesture into a pinch.
    if (touches.current.size > 1) { s.current.drag = null; return; }
    // Drag one of your clouds to move it; drag the sky to move around; in 3D, Option-drag or
    // right-drag to turn and look around.
    const turn = (e.altKey || e.button === 2) && !flat;
    const grabbed = style === 'clouds' && e.button === 0 ? hit(p.x, p.y) : null;
    const cloud = grabbed && grabbed.kind !== 'you' ? grabbed : undefined;
    s.current.drag = { x: p.x, y: p.y, camera: { ...s.current.camera }, moved: false, mode: cloud ? 'cloud' : turn ? 'look' : 'move', cloud };
    if (cloud) {
      renderer.current?.setDragging?.(cloud.id);
      // Clicking a cloud brings it to the front, and it stays there.
      const store = positions.current!, top = Math.max(0, ...Object.values(store).map(spot => spot.raise || 0));
      if ((store[cloud.id]?.raise || 0) < top || !store[cloud.id]?.raise) {
        store[cloud.id] = { ...(store[cloud.id] || { x: cloud.x, y: cloud.y }), raise: top + 1 };
        savePositions(store);
        list.current = list.current.map(q => q.id === cloud.id ? { ...q, raise: top + 1 } : q);
        s.current.drag!.cloud = { ...cloud, raise: top + 1 };
      }
    }
  }
  function onPointerMove(e: PointerEvent) {
    const p = point(e), drag = s.current.drag;
    if (touches.current.has(e.pointerId) && touches.current.size === 2) {
      // Pinch: zoom around the point between the two fingers.
      const [a, b] = [...touches.current.values()], before = Math.hypot(a.x - b.x, a.y - b.y);
      touches.current.set(e.pointerId, p);
      const [c, d] = [...touches.current.values()], after = Math.hypot(c.x - d.x, c.y - d.y), middle = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
      if (before > 0 && !s.current.entering) { s.current.anim = null; s.current.camera = zoomAt(s.current.camera, s.current.camera.zoom * after / before, middle, s.current.view); }
      return;
    }
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, p);
    if (drag) {
      const dx = p.x - drag.x, dy = p.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; s.current.anim = null; host.current!.classList.add('dragging'); }
      if (!drag.moved) return;
      if (drag.mode === 'cloud' && drag.cloud) {
        // A cloud follows the pointer on its own layer: yours in front, shared ones further back.
        const perUnit = layerScale(drag.camera.zoom, drag.cloud.depth);
        const at = { x: drag.cloud.x + dx / perUnit, y: drag.cloud.y + dy / perUnit };
        // The cloud you are moving is drawn on top of all the others.
        moved.current.set(drag.cloud.id, at);
        const raise = Math.max(0, ...Object.values(positions.current!).map(spot => spot.raise || 0)) + 1;
        list.current = list.current.map(p => p.id === drag.cloud!.id ? { ...p, ...at, placed: at, raise } : p);
      } else s.current.camera = drag.mode === 'move' ? panBy(drag.camera, dx, dy) : look(drag.camera, dx, dy, s.current.view);
      return;
    }
    const over = hit(p.x, p.y);
    s.current.hover = over?.id || null;
    host.current!.classList.toggle('over-project', !!over);
  }
  function onPointerUp(e: PointerEvent) {
    touches.current.delete(e.pointerId);
    const drag = s.current.drag; s.current.drag = null;
    host.current!.classList.remove('dragging');
    renderer.current?.setDragging?.(null);
    if (drag?.moved && drag.mode === 'cloud' && drag.cloud) {
      // As in Finder, a cloud stays exactly where you drop it, even on top of another, and is
      // remembered: in this browser, and for your own projects on the server too.
      const at = moved.current.get(drag.cloud.id);
      if (at) {
        const store = positions.current!, top = Math.max(0, ...Object.values(store).map(spot => spot.raise || 0)) + 1;
        store[drag.cloud.id] = { x: Math.round(at.x), y: Math.round(at.y), raise: top };
        savePositions(store);
        if (drag.cloud.mine) onMove?.(drag.cloud.id, Math.round(at.x), Math.round(at.y));
      }
      return;
    }
    if (!drag || drag.moved || e.button !== 0) return;
    const p = point(e), target = hit(p.x, p.y);
    if (target) flyTo(target);
  }
  function onKeyDown(e: KeyboardEvent) {
    const { camera, view } = s.current;
    const key = e.key.toLowerCase();
    if (!flat && 'wasdqe'.includes(key) && key.length === 1 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); s.current.keys.add(key); return; }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] };
    // Arrow keys look around; with Shift (or in the flat sky) they move across it.
    if (arrows[e.key]) { e.preventDefault(); const [mx, my] = arrows[e.key]; animate(e.shiftKey || flat ? panBy(camera, -mx, -my) : look(camera, -mx, -my, view), 220); }
    else if (e.key === '+' || e.key === '=') animate(flat ? zoomAt(camera, camera.zoom * 1.35, { x: view.width / 2, y: view.height / 2 }, view) : flyRelative(camera, baseDistance(view) / camera.zoom * .3, 0, 0), 260);
    else if (e.key === '-') animate(flat ? zoomAt(camera, camera.zoom / 1.35, { x: view.width / 2, y: view.height / 2 }, view) : flyRelative(camera, -baseDistance(view) / camera.zoom * .3, 0, 0), 260);
    else if (e.key === '0' || e.key === 'Home') animate(home(), 900);
  }
  const ref = (id: string) => (el: HTMLElement | null) => { if (el) labels.current.set(id, el); else labels.current.delete(id); };
  // Placeholder search: a plain match on names and descriptions. Semantic search replaces the matching.
  const [query, setQuery] = useState(''), [searchOpen, setSearchOpen] = useState(false);
  const terms = query.trim().toLowerCase();
  const results = terms ? list.current.filter(p => p.kind !== 'you' && `${p.name} ${p.description}`.toLowerCase().includes(terms)).slice(0, 6) : [];
  function choose(p: SkyProject) { setQuery(''); setSearchOpen(false); host.current?.focus({ preventScroll: true }); flyTo(p); }

  return <div ref={host} className={`sky-view ${balloons ? 'balloon-sky' : style === 'clouds' || style === 'clouds3d' ? 'vector-sky' : 'cloud-sky'} ${style === 'clouds' ? 'drawn-text' : ''}`} tabIndex={0} role="application" aria-label="Workspace sky. Drag or use arrow keys to move, scroll or plus and minus to zoom. Click a project to fly to it; open yours from its label."
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={e => { s.current.drag = null; touches.current.delete(e.pointerId); }} onPointerLeave={() => { s.current.hover = null; }} onKeyDown={onKeyDown} onKeyUp={e => s.current.keys.delete(e.key.toLowerCase())} onBlur={() => s.current.keys.clear()} onContextMenu={e => e.preventDefault()}
    style={{ '--sky-ink': palette.ink, '--sky-glow': palette.glow, '--sky-cloud': cssColor(palette.cloudLight) } as CSSProperties}>
    <canvas ref={canvas} />
    <div className="sky-labels" aria-hidden="true">
      {list.current.filter(p => p.agents?.length).map(p => <span key={p.id} ref={el => { if (el) agentRows.current.set(p.id, el); else agentRows.current.delete(p.id); }} className="sky-agent-row"><AgentDots agents={p.agents} /></span>)}
    </div>
    <div className="sky-labels">
      {list.current.map(p => p.mine
        ? <button key={p.id} ref={ref(p.id)} className={`sky-label mine ${p.kind === 'you' ? 'you' : ''}`} onPointerDown={e => e.stopPropagation()} onClick={() => flyTo(p)} aria-label={p.kind === 'you' ? 'You. Return to your projects' : `Open ${p.name}`}>
            <b>{p.name}</b>{p.description && <span>{p.description}</span>}
          </button>
        : <div key={p.id} ref={ref(p.id)} className="sky-label other" aria-hidden="true">
            <b>{p.name}</b><span>{p.description}</span>
          </div>)}
    </div>
    {!searchOpen && <button className="sky-search-toggle" onPointerDown={e => e.stopPropagation()} onClick={() => setSearchOpen(true)} aria-label="Search projects and agents" title="Search"><SearchIcon /></button>}
    {searchOpen && <div className="sky-search" onPointerDown={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' && !query) setSearchOpen(false); }}>
      <div className="sky-search-row"><input type="search" autoFocus value={query} placeholder="Search projects and agents" aria-label="Search projects and agents" onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && results[0]) choose(results[0]); if (e.key === 'Escape') setQuery(''); }} />
        <button className="sky-search-close" onClick={() => { setQuery(''); setSearchOpen(false); }} aria-label="Close search">×</button></div>
      {terms && <div className="sky-results" role="listbox">
        {results.length ? results.map(p => <button key={p.id} role="option" aria-selected={false} onClick={() => choose(p)}><b>{p.name}</b><span>{p.mine ? 'Your project' : p.detail || 'In this workspace'}</span></button>)
          : <p>No matches.</p>}
        <p className="sky-results-note">Placeholder: matches names and descriptions. Semantic search is coming.</p>
      </div>}
    </div>}
    <div className="sky-legend" aria-label="Agent colors">{agentKinds.map(k => <span key={k.id}><i style={{ background: k.color }} />{k.label}</span>)}</div>
    <div ref={whiteout} className="sky-whiteout" />
  </div>;
}
