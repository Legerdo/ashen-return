import { NavGrid } from '../ai/nav';
import { CONTAINER_TYPES } from '../content/containerTypes';
import type { ContainerSpawnDef, DecorDef, MapDef, MapRect, ObstacleDef, ProcTheme, SpawnGroupDef } from '../content/mapTypes';
import type { ContentRegistry } from '../content/registry';
import { Rng } from '../core/rng';
import { WorldGeometry, type DynamicState } from './geometry';

/**
 * Procedural raid layout — a seeded layer drawn over an authored raid map (MapDef.procgen). The authored structure
 * (buildings, roads, water, doors, exits, quest / key containers, boss arena, enemy groups) is never touched; each
 * layout seed adds:
 *   · start points   — extra player start candidates in edge zones (clear, reachable, far from free exits),
 *   · cover clusters — ruins, crates, hay, sandbags, wrecks, trees… in open ground, each ringed by a free lane,
 *   · loot caches    — extra containers (`proc_<n>`) behind a little cover, loot tables by area,
 *   · enemy anchors  — jittered extra points for every non-boss spawn group (same region / interior, clear),
 *   · ground patches — dirt / mud / gravel / snow repainted over the listed outdoor grounds.
 * Connectivity is preserved by construction: a cluster only goes where its bounding box, grown by PROCGEN.gap,
 * touches no other obstacle, interior, door, exit, container, start point or enemy anchor, so every lane around it
 * stays walkable (A09 checks reachability and exit paths on 100 seeds per map).
 * Pure and deterministic: the same (map, seed) always gives the same MapDef (a raid snapshot stores the seed only).
 */

/** TUNABLE: clearances (u) and sampling of the procedural layer. */
export const PROCGEN = {
  /** Free ring around every cluster's bounding box (to any other obstacle). */
  gap: 1.6,
  door: 4,
  container: 4,
  interactable: 3,
  exit: 3,
  spawn: 5,
  enemyPoint: 2,
  patrolPoint: 1.5,
  eventSpot: 3,
  interior: 1,
  edge: 2,
  /** Generated start points: distance to free exits, to any exit, to other starts; clear radius. */
  spawnFreeExit: 30,
  spawnAnyExit: 8,
  spawnSpacing: 6,
  spawnClear: 0.8,
  /** Enemy anchor jitter distance range. */
  jitter: [2, 5] as [number, number],
  attempts: 28,
} as const;

interface Piece {
  profile: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z1: number;
  canopy?: 'canopy' | 'canopy_pine';
  /** Loot cache: container type (the piece box is its footprint) and loot table. */
  container?: string;
  table?: string;
}

const box = (profile: string, x0: number, y0: number, x1: number, y1: number, z1: number): Piece => ({ profile, x0, y0, x1, y1, z1 });
const tree = (x: number, y: number, pine = false): Piece => {
  const r = pine ? 0.28 : 0.3;
  return { profile: pine ? 'core.ob.pine' : 'core.ob.tree', x0: x - r, y0: y - r, x1: x + r, y1: y + r, z1: 4.5, canopy: pine ? 'canopy_pine' : 'canopy' };
};

/** Cluster shapes (local coordinates, turned / mirrored at placement). */
const TEMPLATES: Record<string, Piece[]> = {
  hay: [box('core.ob.hay', 0, 0, 1.6, 1.1, 1.1), box('core.ob.hay', 1.9, 0.3, 3.5, 1.4, 1.1)],
  crates: [box('core.ob.crate_wood', 0, 0, 1, 1, 1.0), box('core.ob.crate_wood', 1.15, 0.1, 2.15, 1.1, 1.0), box('core.ob.crate_wood', 0.5, 1.25, 1.5, 2.25, 1.0)],
  ruin: [box('core.ob.wall_brick', 0, 0, 3.4, 0.35, 1.9), box('core.ob.wall_brick', 0, 0.35, 0.35, 2.6, 1.3), box('core.ob.crate_wood', 1.4, 1.2, 2.3, 2.1, 0.9)],
  ruin_tall: [box('core.ob.wall_concrete', 0, 0, 0.4, 3.2, 2.4), box('core.ob.wall_concrete', 0.4, 2.8, 2.8, 3.2, 1.6)],
  fence: [box('core.ob.fence_wood', 0, 0, 1.7, 0.2, 1.0), box('core.ob.fence_wood', 2.5, 0, 4.2, 0.2, 1.0)],
  wreck: [box('core.ob.car', 0, 0, 2.2, 1.5, 1.4)],
  bushes: [box('core.ob.bush', 0, 0, 2.4, 1.8, 1.1), box('core.ob.bush', 2.8, 0.6, 4.6, 2.2, 1.1)],
  trees: [tree(0.3, 0.3), tree(2.6, 1.4)],
  pines: [tree(0.3, 0.3, true), tree(2.0, 1.6, true), tree(3.4, 0.2, true)],
  reeds: [box('core.ob.reeds', 0, 0, 2.2, 3.2, 1.7)],
  sandbags: [box('core.ob.sandbag', 0, 0, 2.6, 0.6, 1.15), box('core.ob.sandbag', 0, 0.6, 0.6, 2.2, 1.15)],
  barriers: [box('core.ob.barrier', 0, 0, 2.2, 0.6, 1.0), box('core.ob.barrier', 3.0, 0, 5.2, 0.6, 1.0)],
  metal: [box('core.ob.crate_metal', 0, 0, 1.4, 1.2, 1.2), box('core.ob.crate_metal', 1.6, 0.2, 3.0, 1.4, 1.2)],
  container: [box('core.ob.container', 0, 0, 6, 2.4, 2.6)],
  tent: [box('core.ob.tent', 0, 0, 4, 3, 1.8)],
};

/** Per theme: weighted cluster shapes, and the loot caches it may hold (container type + loot table). */
const THEMES: Record<ProcTheme, { templates: [string, number][]; caches: [string, string, number][] }> = {
  farm: { templates: [['hay', 3], ['crates', 2], ['ruin', 2], ['fence', 2], ['wreck', 1], ['trees', 2], ['bushes', 1]], caches: [['core.ct.crate', 'core.loot.farm_food', 3], ['core.ct.toolbox', 'core.loot.tools', 2], ['core.ct.scrap', 'core.loot.scrap', 2]] },
  meadow: { templates: [['bushes', 3], ['trees', 3], ['ruin', 2], ['hay', 1], ['crates', 1]], caches: [['core.ct.crate', 'core.loot.farm_food', 2], ['core.ct.toolbox', 'core.loot.tools', 1]] },
  canal: { templates: [['reeds', 3], ['sandbags', 2], ['crates', 1], ['bushes', 1]], caches: [['core.ct.toolbox', 'core.loot.tools', 2], ['core.ct.crate', 'core.loot.medical', 1], ['core.ct.scrap', 'core.loot.scrap', 1]] },
  checkpoint: { templates: [['sandbags', 3], ['barriers', 3], ['wreck', 2], ['metal', 1], ['ruin_tall', 1]], caches: [['core.ct.ammo', 'core.loot.ammo', 3], ['core.ct.crate', 'core.loot.office', 1], ['core.ct.supply', 'core.loot.military', 1]] },
  yard: { templates: [['metal', 3], ['container', 1], ['barriers', 2], ['sandbags', 1]], caches: [['core.ct.toolbox', 'core.loot.tools', 2], ['core.ct.ammo', 'core.loot.ammo', 2], ['core.ct.supply', 'core.loot.military', 1]] },
  rail: { templates: [['metal', 2], ['container', 1], ['crates', 2], ['barriers', 1]], caches: [['core.ct.toolbox', 'core.loot.tools', 2], ['core.ct.scrap', 'core.loot.scrap', 2]] },
  forest: { templates: [['pines', 4], ['bushes', 3], ['crates', 1], ['ruin', 1], ['tent', 1]], caches: [['core.ct.crate', 'core.loot.valuables', 1], ['core.ct.toolbox', 'core.loot.tools', 2], ['core.ct.ammo', 'core.loot.ammo', 2]] },
  freight: { templates: [['metal', 2], ['crates', 2], ['barriers', 2], ['container', 1], ['wreck', 1]], caches: [['core.ct.crate', 'core.loot.freight', 3], ['core.ct.toolbox', 'core.loot.tools', 1], ['core.ct.ammo', 'core.loot.ammo', 1]] },
};

interface Box2 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const CLOSED: DynamicState = { doors: {}, obstacleHp: {}, smokes: [], time: 0 };

function rectOf(r: MapRect): Box2 {
  return { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
}
function grow(b: Box2, m: number): Box2 {
  return { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m };
}
function overlaps(a: Box2, b: Box2): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}
/** Distance from a point to a box (0 inside). */
function pointBoxDist(b: Box2, x: number, y: number): number {
  const dx = Math.max(b.x0 - x, 0, x - b.x1);
  const dy = Math.max(b.y0 - y, 0, y - b.y1);
  return Math.hypot(dx, dy);
}
function boxBoxDist(a: Box2, b: Box2): number {
  const dx = Math.max(b.x0 - a.x1, 0, a.x0 - b.x1);
  const dy = Math.max(b.y0 - a.y1, 0, a.y0 - b.y1);
  return Math.hypot(dx, dy);
}
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Pieces turned q × 90° clockwise (after an optional mirror), normalised so the cluster's box starts at (0, 0). */
function transform(pieces: Piece[], q: number, mirror: boolean): { pieces: Piece[]; w: number; h: number } {
  const tp = (x: number, y: number): [number, number] => {
    let px = mirror ? -x : x;
    let py = y;
    for (let k = 0; k < q; k++) [px, py] = [-py, px];
    return [px, py];
  };
  const out = pieces.map((p) => {
    const [ax, ay] = tp(p.x0, p.y0);
    const [bx, by] = tp(p.x1, p.y1);
    return { ...p, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  });
  const minX = Math.min(...out.map((p) => p.x0));
  const minY = Math.min(...out.map((p) => p.y0));
  for (const p of out) {
    p.x0 -= minX;
    p.x1 -= minX;
    p.y0 -= minY;
    p.y1 -= minY;
  }
  return { pieces: out, w: Math.max(...out.map((p) => p.x1)), h: Math.max(...out.map((p) => p.y1)) };
}

/** Static analysis of an authored map: geometry, nav grid and what is reachable on foot from its first start point. */
interface BaseInfo {
  geo: WorldGeometry;
  nav: NavGrid;
  /** Reachable from the authored start through doors unlocked at raid start. */
  reachOpen: Uint8Array;
  /** Reachable through every door (keys / power included). */
  reachAll: Uint8Array;
}

const baseCache = new WeakMap<MapDef, BaseInfo>();

function flood(nav: NavGrid, x: number, y: number, doorOk: (d: string) => boolean): Uint8Array {
  const seen = new Uint8Array(nav.w * nav.h);
  let [sx, sy] = nav.cellOf(x, y);
  if (!nav.passable(sy * nav.w + sx, doorOk)) {
    const n = nav.nearestWalkable(x, y, 2, doorOk);
    if (!n) return seen;
    [sx, sy] = nav.cellOf(n.x, n.y);
  }
  const queue = [sy * nav.w + sx];
  seen[queue[0]!] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const cx = cur % nav.w;
    const cy = (cur - cx) / nav.w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= nav.w || ny >= nav.h) continue;
        const ni = ny * nav.w + nx;
        if (seen[ni] || !nav.passable(ni, doorOk)) continue;
        if (dx !== 0 && dy !== 0 && (!nav.passable(cy * nav.w + nx, doorOk) || !nav.passable(ny * nav.w + cx, doorOk))) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
  }
  return seen;
}

function baseInfo(content: ContentRegistry, map: MapDef): BaseInfo {
  let b = baseCache.get(map);
  if (!b) {
    const geo = new WorldGeometry(map, content);
    const nav = new NavGrid(geo);
    const start = map.playerSpawns[0] ?? { x: map.width / 2, y: map.height / 2 };
    const unlocked = new Set(map.doors.filter((d) => !d.keyId && !d.powerFlag).map((d) => d.id));
    b = { geo, nav, reachOpen: flood(nav, start.x, start.y, (d) => unlocked.has(d)), reachAll: flood(nav, start.x, start.y, () => true) };
    baseCache.set(map, b);
  }
  return b;
}

function reached(nav: NavGrid, reach: Uint8Array, x: number, y: number): boolean {
  const [cx, cy] = nav.cellOf(x, y);
  return reach[cy * nav.w + cx] === 1;
}

const layoutCache = new Map<string, MapDef>();

/**
 * The map a raid is played on: the authored map with its procedural layer for this layout seed (the authored map
 * itself when it has no `procgen`). Cached per (map, seed); the returned MapDef must be treated as read-only.
 */
export function raidMap(content: ContentRegistry, mapId: string, seed: string): MapDef {
  const base = content.map(mapId);
  if (!base.procgen) return base;
  const key = `${mapId}|${seed}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const m = generateLayout(content, base, seed);
  layoutCache.set(key, m);
  if (layoutCache.size > 8) layoutCache.delete(layoutCache.keys().next().value!);
  return m;
}

/** Everything the layer must keep clear of (authored features plus what it already placed). */
interface Keep {
  boxes: Box2[];
  containers: { x: number; y: number }[];
  spawns: { x: number; y: number }[];
}

function generateLayout(content: ContentRegistry, base: MapDef, seed: string): MapDef {
  const def = base.procgen!;
  const info = baseInfo(content, base);
  const rng = Rng.fromSeed(`${seed}|layout|${base.id}`);
  const interiors = base.interiors.map((i) => grow(rectOf(i.rect), PROCGEN.interior));
  const doors = base.doors.map((d) => ({ x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) }));
  const exits = base.exits.map((e) => rectOf(e));
  const freeExits = base.exits.filter((e) => e.condition.type === 'free').map((e) => rectOf(e));
  const groupPoints = base.enemyGroups.flatMap((g) => g.points);
  const patrolPoints = base.enemyGroups.flatMap((g) => g.patrol);
  const eventSpots = Object.values(base.eventSpots).flat();
  const keep: Keep = { boxes: [], containers: base.containers.map((c) => ({ x: c.x, y: c.y })), spawns: [...base.playerSpawns] };
  const inInterior = (x: number, y: number) => interiors.some((b) => pointBoxDist(b, x, y) === 0);

  // --- start points --------------------------------------------------------------------------------------------
  const spawns: { x: number; y: number }[] = [];
  const spawnN = def.spawnZones.length ? rng.int(def.spawnCount[0], def.spawnCount[1]) : 0;
  for (let i = 0; i < spawnN; i++) {
    for (let a = 0; a < PROCGEN.attempts; a++) {
      const z = rng.pick(def.spawnZones);
      const x = round1(z.x + rng.next() * z.w);
      const y = round1(z.y + rng.next() * z.h);
      if (x < 1 || y < 1 || x > base.width - 1 || y > base.height - 1 || inInterior(x, y)) continue;
      if (info.geo.movementBlockers(x, y, PROCGEN.spawnClear, 0, CLOSED).length) continue;
      if (!reached(info.nav, info.reachOpen, x, y)) continue;
      if (freeExits.some((e) => pointBoxDist(e, x, y) < PROCGEN.spawnFreeExit)) continue;
      if (exits.some((e) => pointBoxDist(e, x, y) < PROCGEN.spawnAnyExit)) continue;
      if (keep.spawns.some((s) => Math.hypot(s.x - x, s.y - y) < PROCGEN.spawnSpacing)) continue;
      spawns.push({ x, y });
      keep.spawns.push({ x, y });
      break;
    }
  }

  // --- cover clusters and loot caches ----------------------------------------------------------------------------
  const obstacles: ObstacleDef[] = [];
  const decor: DecorDef[] = [];
  const containers: ContainerSpawnDef[] = [];
  let seq = 0;
  const groundName = (x: number, y: number) => base.groundPalette[base.ground[Math.floor(y) * base.width + Math.floor(x)] ?? 0] ?? '';

  const fits = (pieces: Piece[], w: number, h: number, ax: number, ay: number): boolean => {
    const bb: Box2 = { x0: ax, y0: ay, x1: ax + w, y1: ay + h };
    if (bb.x0 < PROCGEN.edge || bb.y0 < PROCGEN.edge || bb.x1 > base.width - PROCGEN.edge || bb.y1 > base.height - PROCGEN.edge) return false;
    const ring = grow(bb, PROCGEN.gap);
    for (const o of info.geo.query(ring.x0, ring.y0, ring.x1, ring.y1)) {
      if (o.id.startsWith('bounds:')) continue;
      if (overlaps(ring, o.box)) return false;
    }
    if (keep.boxes.some((b) => overlaps(ring, b))) return false;
    if (interiors.some((b) => overlaps(bb, b))) return false;
    if (doors.some((d) => boxBoxDist(bb, d) < PROCGEN.door)) return false;
    if (exits.some((e) => boxBoxDist(bb, e) < PROCGEN.exit)) return false;
    if (keep.containers.some((c) => pointBoxDist(bb, c.x, c.y) < PROCGEN.container)) return false;
    if (base.interactables.some((it) => pointBoxDist(bb, it.x, it.y) < PROCGEN.interactable)) return false;
    if (keep.spawns.some((s) => pointBoxDist(bb, s.x, s.y) < PROCGEN.spawn)) return false;
    if (groupPoints.some((p) => pointBoxDist(bb, p.x, p.y) < PROCGEN.enemyPoint)) return false;
    if (patrolPoints.some((p) => pointBoxDist(bb, p.x, p.y) < PROCGEN.patrolPoint)) return false;
    if (eventSpots.some((p) => pointBoxDist(bb, p.x, p.y) < PROCGEN.eventSpot)) return false;
    for (const poi of base.pois) {
      const r = poi.kind === 'area' ? 2 : poi.radius + 1;
      if (pointBoxDist(bb, poi.x, poi.y) < r) return false;
    }
    // Whole cluster on reachable open ground; only reeds may stand in shallow water.
    for (const p of pieces) {
      const cx = ax + (p.x0 + p.x1) / 2;
      const cy = ay + (p.y0 + p.y1) / 2;
      if (!reached(info.nav, info.reachAll, cx, cy)) return false;
      if (groundName(cx, cy) === 'water' && p.profile !== 'core.ob.reeds') return false;
    }
    return true;
  };

  const place = (pieces: Piece[], w: number, h: number, ax: number, ay: number): void => {
    keep.boxes.push({ x0: ax, y0: ay, x1: ax + w, y1: ay + h });
    for (const p of pieces) {
      const x0 = round2(ax + p.x0);
      const y0 = round2(ay + p.y0);
      const x1 = round2(ax + p.x1);
      const y1 = round2(ay + p.y1);
      if (p.container) {
        const t = CONTAINER_TYPES.find((c) => c.id === p.container)!;
        const id = `proc_${++seq}`;
        const cx = round2((x0 + x1) / 2);
        const cy = round2((y0 + y1) / 2);
        containers.push({ id, type: t.id, x: cx, y: cy, lootTable: p.table!, keyId: null });
        keep.containers.push({ x: cx, y: cy });
        if (t.obstacleProfile) obstacles.push({ id: `prop:${id}`, profile: t.obstacleProfile, x0: round2(cx - t.w / 2), y0: round2(cy - t.h / 2), x1: round2(cx + t.w / 2), y1: round2(cy + t.h / 2), z0: 0, z1: t.z1, floor: 0 });
        continue;
      }
      const variant = rng.int(0, 3);
      obstacles.push({ id: `proc:${++seq}`, profile: p.profile, x0, y0, x1, y1, z0: 0, z1: p.z1, floor: 0, variant });
      if (p.canopy) decor.push({ kind: p.canopy, x: round2((x0 + x1) / 2), y: round2((y0 + y1) / 2), variant });
    }
  };

  const tryPlace = (zone: MapRect, make: () => Piece[]): boolean => {
    for (let a = 0; a < PROCGEN.attempts; a++) {
      const t = transform(make(), rng.int(0, 3), rng.next() < 0.5);
      if (t.w > zone.w || t.h > zone.h) continue;
      const ax = round2(zone.x + rng.next() * (zone.w - t.w));
      const ay = round2(zone.y + rng.next() * (zone.h - t.h));
      if (!fits(t.pieces, t.w, t.h, ax, ay)) continue;
      place(t.pieces, t.w, t.h, ax, ay);
      return true;
    }
    return false;
  };

  // Loot caches first (they matter more than decoration); a cache that finds no room in its zone tries the others.
  const caches = def.clusterZones.length ? rng.int(def.cacheCount[0], def.cacheCount[1]) : 0;
  for (let i = 0; i < caches; i++) {
    const first = rng.weighted(def.clusterZones.map((c) => ({ weight: c.rect.w * c.rect.h, value: c })));
    for (const z of [first, ...def.clusterZones.filter((c) => c !== first)]) {
      const [type, table] = rng.weighted(THEMES[z.theme].caches.map(([t, tb, w]) => ({ weight: w, value: [t, tb] as const })));
      const ct = CONTAINER_TYPES.find((c) => c.id === type)!;
      const w = Math.max(1, ct.w);
      const h = Math.max(0.8, ct.h);
      const ok = tryPlace(z.rect, () => [
        { ...box('', 0, 0, w, h, ct.z1), container: type, table },
        box('core.ob.crate_wood', -0.2, h + 0.6, 0.8, h + 1.6, 1.0),
        box('core.ob.sandbag', w + 0.6, -0.1, w + 1.2, h + 0.9, 1.15),
      ]);
      if (ok) break;
    }
  }
  for (const z of def.clusterZones) {
    const theme = THEMES[z.theme];
    const n = rng.int(z.count[0], z.count[1]);
    for (let i = 0; i < n; i++) tryPlace(z.rect, () => TEMPLATES[rng.weighted(theme.templates.map(([id, wt]) => ({ weight: wt, value: id })))]!);
  }

  const layered: MapDef = {
    ...base,
    obstacles: [...base.obstacles, ...obstacles],
    containers: [...base.containers, ...containers],
    decor: [...base.decor, ...decor],
    playerSpawns: [...base.playerSpawns, ...spawns],
  };

  // --- enemy anchors (checked against the final obstacles) --------------------------------------------------------
  const geo = new WorldGeometry(layered, content);
  const regionOf = (x: number, y: number) => geo.regionAt(x, y)?.id ?? null;
  const interiorOf = (x: number, y: number) => geo.interiorAt(x, y)?.id ?? null;
  const groups: SpawnGroupDef[] = base.enemyGroups.map((g) => {
    if (g.boss || def.enemyJitter <= 0) return g;
    const extra: { x: number; y: number }[] = [];
    for (const p of g.points)
      for (let k = 0; k < def.enemyJitter; k++)
        for (let a = 0; a < 8; a++) {
          const ang = rng.next() * Math.PI * 2;
          const r = PROCGEN.jitter[0] + rng.next() * (PROCGEN.jitter[1] - PROCGEN.jitter[0]);
          const x = round1(p.x + Math.cos(ang) * r);
          const y = round1(p.y + Math.sin(ang) * r);
          if (x < 1 || y < 1 || x > base.width - 1 || y > base.height - 1) continue;
          if (regionOf(x, y) !== g.regionId || interiorOf(x, y) !== interiorOf(p.x, p.y)) continue;
          if (geo.movementBlockers(x, y, 0.5, 0, CLOSED).length) continue;
          if (!reached(info.nav, info.reachAll, x, y)) continue;
          if ([...g.points, ...extra].some((q) => Math.hypot(q.x - x, q.y - y) < 1.5)) continue;
          if (layered.containers.some((c) => Math.hypot(c.x - x, c.y - y) < 1.5)) continue;
          extra.push({ x, y });
          break;
        }
    return extra.length ? { ...g, points: [...g.points, ...extra] } : g;
  });

  // --- ground patches ------------------------------------------------------------------------------------------------
  const palette = [...base.groundPalette];
  const ground = [...base.ground];
  const tile = (name: string) => {
    let i = palette.indexOf(name);
    if (i < 0) {
      i = palette.length;
      palette.push(name);
    }
    return i;
  };
  for (const pd of def.patches) {
    const on = new Set(pd.on);
    const n = rng.int(pd.count[0], pd.count[1]);
    for (let i = 0; i < n; i++) {
      const cx = pd.rect.x + rng.next() * pd.rect.w;
      const cy = pd.rect.y + rng.next() * pd.rect.h;
      const r = pd.radius[0] + rng.next() * (pd.radius[1] - pd.radius[0]);
      const paint = tile(rng.pick(pd.paint));
      for (let gy = Math.floor(cy - r); gy <= Math.ceil(cy + r); gy++)
        for (let gx = Math.floor(cx - r); gx <= Math.ceil(cx + r); gx++) {
          if (gx < 0 || gy < 0 || gx >= base.width || gy >= base.height) continue;
          if (Math.hypot(gx + 0.5 - cx, gy + 0.5 - cy) > r) continue;
          const cur = palette[ground[gy * base.width + gx] ?? 0]!;
          if (on.has(cur)) ground[gy * base.width + gx] = paint;
        }
    }
  }

  return { ...layered, enemyGroups: groups, groundPalette: palette, ground };
}

/** Summary of what a layout seed added (tests / diagnostics). */
export function layoutStats(base: MapDef, m: MapDef): { spawns: number; obstacles: number; caches: number; anchors: number; patchedCells: number } {
  let patched = 0;
  for (let i = 0; i < m.ground.length; i++) if (m.groundPalette[m.ground[i]!] !== base.groundPalette[base.ground[i]!]) patched++;
  return {
    spawns: m.playerSpawns.length - base.playerSpawns.length,
    obstacles: m.obstacles.filter((o) => o.id.startsWith('proc:')).length,
    caches: m.containers.length - base.containers.length,
    anchors: m.enemyGroups.reduce((s, g, i) => s + g.points.length - base.enemyGroups[i]!.points.length, 0),
    patchedCells: patched,
  };
}
