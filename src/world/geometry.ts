import type { GroundDef, InteractableDef, MapDef, ObstacleDef } from '../content/mapTypes';
import type { InteriorDef, ObstacleProfile, RegionDef } from '../content/types';
import { EPS, lineBox3, rectContains, type Box3, type Vec3 } from '../core/math';

export interface ObstacleRuntime {
  index: number;
  id: string;
  box: Box3;
  profile: ObstacleProfile;
  floor: number;
  doorId: string | null;
  def: ObstacleDef;
}

export interface DynamicState {
  doors: Record<string, { open: boolean; locked: boolean }>;
  obstacleHp: Record<string, number>;
  smokes: { x: number; y: number; radius: number; until: number; floor: number }[];
  time: number;
}

export interface GeometryContent {
  obstacleProfile(id: string): ObstacleProfile;
  ground(id: string): GroundDef;
}

const CELL = 4;

/**
 * Static map geometry + spatial hash. Dynamic state (doors, destroyed props, smoke) is passed in by the caller
 * so this object is never serialized and can be rebuilt deterministically from the MapDef.
 */
export class WorldGeometry {
  readonly map: MapDef;
  readonly obstacles: ObstacleRuntime[] = [];
  readonly grounds: GroundDef[];
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][];
  private stamp = 1;
  private readonly marks: Uint32Array;
  readonly byId = new Map<string, ObstacleRuntime>();

  constructor(map: MapDef, content: GeometryContent, extra: ObstacleDef[] = []) {
    this.map = map;
    this.grounds = map.groundPalette.map((g) => content.ground(g));
    this.cols = Math.ceil(map.width / CELL) + 1;
    this.rows = Math.ceil(map.height / CELL) + 1;
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
    const all: ObstacleDef[] = [...map.obstacles, ...extra];
    for (const d of map.doors) {
      all.push({ id: `door:${d.id}`, profile: d.profile, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, z0: 0, z1: d.z1, floor: d.floor, tags: ['door'] });
    }
    // Invisible map bounds.
    const W = map.width;
    const H = map.height;
    all.push({ id: 'bounds:n', profile: 'core.ob.bounds', x0: -2, y0: -2, x1: W + 2, y1: 0, z0: 0, z1: 20, floor: 0 });
    all.push({ id: 'bounds:s', profile: 'core.ob.bounds', x0: -2, y0: H, x1: W + 2, y1: H + 2, z0: 0, z1: 20, floor: 0 });
    all.push({ id: 'bounds:w', profile: 'core.ob.bounds', x0: -2, y0: 0, x1: 0, y1: H, z0: 0, z1: 20, floor: 0 });
    all.push({ id: 'bounds:e', profile: 'core.ob.bounds', x0: W, y0: 0, x1: W + 2, y1: H, z0: 0, z1: 20, floor: 0 });
    for (const d of all) {
      const rt: ObstacleRuntime = {
        index: this.obstacles.length,
        id: d.id,
        box: { x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1), z0: d.z0, z1: d.z1 },
        profile: content.obstacleProfile(d.profile),
        floor: d.floor,
        doorId: d.id.startsWith('door:') ? d.id.slice(5) : null,
        def: d,
      };
      this.obstacles.push(rt);
      this.byId.set(rt.id, rt);
      const cx0 = Math.max(0, Math.floor(rt.box.x0 / CELL));
      const cy0 = Math.max(0, Math.floor(rt.box.y0 / CELL));
      const cx1 = Math.min(this.cols - 1, Math.floor(rt.box.x1 / CELL));
      const cy1 = Math.min(this.rows - 1, Math.floor(rt.box.y1 / CELL));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.cells[cy * this.cols + cx]!.push(rt.index);
    }
    this.marks = new Uint32Array(this.obstacles.length);
  }

  /** Broad-phase candidates overlapping an AABB (deduplicated, deterministic index order). */
  query(x0: number, y0: number, x1: number, y1: number): ObstacleRuntime[] {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const cx0 = Math.max(0, Math.floor(minX / CELL));
    const cy0 = Math.max(0, Math.floor(minY / CELL));
    const cx1 = Math.min(this.cols - 1, Math.floor(maxX / CELL));
    const cy1 = Math.min(this.rows - 1, Math.floor(maxY / CELL));
    this.stamp++;
    if (this.stamp === 0xffffffff) {
      this.marks.fill(0);
      this.stamp = 1;
    }
    const out: ObstacleRuntime[] = [];
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const idx of this.cells[cy * this.cols + cx]!) {
          if (this.marks[idx] === this.stamp) continue;
          this.marks[idx] = this.stamp;
          const o = this.obstacles[idx]!;
          if (o.box.x1 < minX || o.box.x0 > maxX || o.box.y1 < minY || o.box.y0 > maxY) continue;
          out.push(o);
        }
      }
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  isActive(o: ObstacleRuntime, dyn: DynamicState): boolean {
    if (o.doorId) {
      const d = dyn.doors[o.doorId];
      return !d || !d.open;
    }
    if (o.profile.destructible) {
      const hp = dyn.obstacleHp[o.id];
      if (hp !== undefined && hp <= 0) return false;
    }
    return true;
  }

  groundAt(x: number, y: number): GroundDef {
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    if (gx < 0 || gy < 0 || gx >= this.map.width || gy >= this.map.height) return this.grounds[0]!;
    return this.grounds[this.map.ground[gy * this.map.width + gx] ?? 0] ?? this.grounds[0]!;
  }

  regionAt(x: number, y: number): RegionDef | null {
    for (const r of this.map.regions) for (const rect of r.rects) if (rectContains(rect, x, y)) return r;
    return null;
  }

  /** The most specific (smallest) interior containing the point: nested rooms win over the hall around them. */
  interiorAt(x: number, y: number): InteriorDef | null {
    let best: InteriorDef | null = null;
    for (const i of this.map.interiors) {
      if (!rectContains(i.rect, x, y)) continue;
      if (!best || i.rect.w * i.rect.h < best.rect.w * best.rect.h) best = i;
    }
    return best;
  }

  /** Every interior containing the point (outer hall and nested rooms). */
  interiorsAt(x: number, y: number): InteriorDef[] {
    return this.map.interiors.filter((i) => rectContains(i.rect, x, y));
  }

  interactable(id: string): InteractableDef | undefined {
    return this.map.interactables.find((i) => i.id === id);
  }

  /** Foliage slowdown at a point (vegetation overlapping). */
  foliageMoveMult(x: number, y: number, dyn: DynamicState): number {
    let m = 1;
    for (const o of this.query(x - 0.01, y - 0.01, x + 0.01, y + 0.01)) {
      if (!o.profile.moveMult || !this.isActive(o, dyn)) continue;
      if (x >= o.box.x0 && x <= o.box.x1 && y >= o.box.y0 && y <= o.box.y1) m = Math.min(m, o.profile.moveMult);
    }
    return m;
  }

  inFoliage(x: number, y: number, dyn: DynamicState): boolean {
    for (const o of this.query(x - 0.01, y - 0.01, x + 0.01, y + 0.01)) {
      if (!o.profile.foliage || !this.isActive(o, dyn)) continue;
      if (x >= o.box.x0 && x <= o.box.x1 && y >= o.box.y0 && y <= o.box.y1) return true;
    }
    return false;
  }

  /**
   * 3D vision test between two points. Opaque obstacles block when the segment crosses their volume; vegetation
   * accumulates density per unit length; smoke clouds block after 0.6u traversal.
   */
  visionBlocked(dyn: DynamicState, a: Vec3, b: Vec3, floor: number, foliageBudget = 1): boolean {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
    if (len < EPS) return false;
    let foliage = 0;
    for (const o of this.query(a.x, a.y, b.x, b.y)) {
      if (o.floor !== floor || !o.profile.blocksVision || !this.isActive(o, dyn)) continue;
      const hit = lineBox3(a, d, o.box);
      if (!hit) continue;
      const t0 = Math.max(0, hit[0]);
      const t1 = Math.min(1, hit[1]);
      if (t1 <= t0 + 1e-6) continue;
      if (o.profile.foliage) {
        // Ignore foliage right at the endpoints (the viewer / target standing in it only reduces visibility).
        foliage += (t1 - t0) * len * o.profile.foliage;
        if (foliage >= foliageBudget) return true;
        continue;
      }
      return true;
    }
    for (const s of dyn.smokes) {
      if (s.floor !== floor || s.until <= dyn.time) continue;
      const t = segmentCircleTraversal(a.x, a.y, b.x, b.y, s.x, s.y, s.radius);
      if (t * len > 0.6) return true;
    }
    return false;
  }

  /** True when a straight projectile path at the given heights would reach b without hitting an active obstacle. */
  projectileClear(dyn: DynamicState, a: Vec3, b: Vec3, floor: number): boolean {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    for (const o of this.query(a.x, a.y, b.x, b.y)) {
      if (o.floor !== floor || !o.profile.blocksProjectile || !this.isActive(o, dyn)) continue;
      const hit = lineBox3(a, d, o.box);
      if (!hit) continue;
      if (hit[1] >= 0 && hit[0] <= 1) return false;
    }
    return true;
  }

  /** Number of sound-blocking obstacles between two points (used to attenuate AI hearing, not audio playback). */
  soundOccluders(dyn: DynamicState, ax: number, ay: number, bx: number, by: number, floor: number): number {
    let n = 0;
    const a = { x: ax, y: ay, z: 1.2 };
    const d = { x: bx - ax, y: by - ay, z: 0 };
    const eps = 1e-3;
    for (const o of this.query(ax, ay, bx, by)) {
      if (o.floor !== floor || !o.profile.blocksSound || !this.isActive(o, dyn)) continue;
      // A noise made by an obstacle itself (a door leaf closing) is not muffled by that obstacle.
      if (bx > o.box.x0 + eps && bx < o.box.x1 - eps && by > o.box.y0 + eps && by < o.box.y1 - eps) continue;
      const hit = lineBox3(a, d, o.box);
      if (!hit) continue;
      // Only count boxes the segment actually passes through: an impact on the listener-side face merely touches it.
      const t0 = Math.max(0, hit[0]);
      const t1 = Math.min(1, hit[1]);
      if ((t1 - t0) * Math.hypot(d.x, d.y) > 0.02) n++;
      if (n >= 3) break;
    }
    return n;
  }

  /** Movement blockers overlapping a circle's AABB. */
  movementBlockers(x: number, y: number, r: number, floor: number, dyn: DynamicState): ObstacleRuntime[] {
    return this.query(x - r - 0.1, y - r - 0.1, x + r + 0.1, y + r + 0.1).filter((o) => o.floor === floor && o.profile.blocksMovement && this.isActive(o, dyn));
  }

  /** Static walkability for nav grids (doors treated as passable, destructibles as solid). */
  staticBlocked(x0: number, y0: number, x1: number, y1: number, floor: number): { blocked: boolean; door: string | null } {
    let door: string | null = null;
    for (const o of this.query(x0, y0, x1, y1)) {
      if (o.floor !== floor || !o.profile.blocksMovement) continue;
      if (o.box.x1 <= x0 || o.box.x0 >= x1 || o.box.y1 <= y0 || o.box.y0 >= y1) continue;
      if (o.doorId) {
        door = o.doorId;
        continue;
      }
      return { blocked: true, door: null };
    }
    return { blocked: false, door };
  }
}

/** Fraction of segment AB inside a circle. */
export function segmentCircleTraversal(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a < EPS) return fx * fx + fy * fy <= r * r ? 1 : 0;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 0;
  const s = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - s) / (2 * a));
  const t1 = Math.min(1, (-b + s) / (2 * a));
  return Math.max(0, t1 - t0);
}
