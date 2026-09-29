import type { ContainerSpawnDef, DecorDef, DoorDef, InteractableDef, MapDef, ObstacleDef, PoiDef, RangeTargetDef, SpawnGroupDef } from '../mapTypes';
import type { ExitDef, InteriorDef, RegionDef } from '../types';
import { CONTAINER_TYPES } from '../containerTypes';

export interface DoorSpec {
  side: 'n' | 's' | 'e' | 'w';
  at: number;
  width: number;
  id?: string;
  profile?: string;
  keyId?: string | null;
  powerFlag?: string | null;
  startOpen?: boolean;
  /** Leave an open gap without a door leaf. */
  open?: boolean;
}

/**
 * Hand-authored map construction helpers. Every coordinate is explicit in the map modules; nothing here is random,
 * so the fixed layout is identical for every seed (seeds only vary enemies, loot, events, time and weather).
 */
export class MapBuilder {
  readonly m: MapDef;
  private readonly palette = new Map<string, number>();
  private seq = 0;

  constructor(id: string, nameKey: string, kind: MapDef['kind'], w: number, h: number, base: string) {
    this.m = {
      id,
      nameKey,
      kind,
      width: w,
      height: h,
      groundPalette: [],
      ground: new Array(w * h).fill(0),
      regions: [],
      interiors: [],
      obstacles: [],
      doors: [],
      containers: [],
      pois: [],
      playerSpawns: [],
      enemyGroups: [],
      exits: [],
      interactables: [],
      lights: [],
      decor: [],
      eventSpots: {},
      ambience: 'wind',
    };
    this.tile(base);
  }

  private tile(name: string): number {
    let i = this.palette.get(name);
    if (i === undefined) {
      i = this.m.groundPalette.length;
      this.m.groundPalette.push(name);
      this.palette.set(name, i);
    }
    return i;
  }

  ground(x: number, y: number, w: number, h: number, name: string): this {
    const t = this.tile(name);
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.m.width, Math.ceil(x + w));
    const y1 = Math.min(this.m.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.m.ground[yy * this.m.width + xx] = t;
    return this;
  }

  groundCircle(cx: number, cy: number, r: number, name: string): this {
    const t = this.tile(name);
    for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++)
      for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        if (xx < 0 || yy < 0 || xx >= this.m.width || yy >= this.m.height) continue;
        if (Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) <= r) this.m.ground[yy * this.m.width + xx] = t;
      }
    return this;
  }

  /** Polyline of ground (roads, paths, canals). */
  groundPath(points: [number, number][], width: number, name: string): this {
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        this.groundCircle(ax + (bx - ax) * t, ay + (by - ay) * t, width / 2, name);
      }
    }
    return this;
  }

  box(profile: string, x0: number, y0: number, x1: number, y1: number, z1: number, opts: { id?: string; z0?: number; tags?: string[]; variant?: number } = {}): ObstacleDef {
    const o: ObstacleDef = { id: opts.id ?? `ob${++this.seq}`, profile, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), z0: opts.z0 ?? 0, z1, floor: 0, ...(opts.tags ? { tags: opts.tags } : {}), ...(opts.variant !== undefined ? { variant: opts.variant } : {}) };
    this.m.obstacles.push(o);
    return o;
  }

  /** Horizontal wall from x0 to x1 at y (top edge), with gaps [start, end). */
  wallH(x0: number, x1: number, y: number, t: number, profile: string, z1: number, gaps: [number, number][] = []): this {
    let cur = x0;
    const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
    for (const [g0, g1] of sorted) {
      if (g0 > cur) this.box(profile, cur, y, g0, y + t, z1);
      cur = Math.max(cur, g1);
    }
    if (cur < x1) this.box(profile, cur, y, x1, y + t, z1);
    return this;
  }

  wallV(x: number, y0: number, y1: number, t: number, profile: string, z1: number, gaps: [number, number][] = []): this {
    let cur = y0;
    const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
    for (const [g0, g1] of sorted) {
      if (g0 > cur) this.box(profile, x, cur, x + t, g0, z1);
      cur = Math.max(cur, g1);
    }
    if (cur < y1) this.box(profile, x, cur, x + t, y1, z1);
    return this;
  }

  /** Rectangular building shell (outer bounds x0..x1, y0..y1) with wall thickness t and doors/gaps. */
  room(x0: number, y0: number, x1: number, y1: number, t: number, profile: string, z1: number, doors: DoorSpec[] = [], windows: DoorSpec[] = []): this {
    const gaps = (side: DoorSpec['side']) => [...doors, ...windows].filter((d) => d.side === side).map((d) => [d.at, d.at + d.width] as [number, number]);
    this.wallH(x0, x1, y0, t, profile, z1, gaps('n'));
    this.wallH(x0, x1, y1 - t, t, profile, z1, gaps('s'));
    this.wallV(x0, y0 + t, y1 - t, t, profile, z1, gaps('w'));
    this.wallV(x1 - t, y0 + t, y1 - t, t, profile, z1, gaps('e'));
    for (const d of doors) {
      if (d.open) continue;
      const id = d.id ?? `door${++this.seq}`;
      const prof = d.profile ?? 'core.ob.door_wood';
      const dt = 0.2;
      let r: [number, number, number, number];
      if (d.side === 'n') r = [d.at, y0 + (t - dt) / 2, d.at + d.width, y0 + (t + dt) / 2];
      else if (d.side === 's') r = [d.at, y1 - t + (t - dt) / 2, d.at + d.width, y1 - t + (t + dt) / 2];
      else if (d.side === 'w') r = [x0 + (t - dt) / 2, d.at, x0 + (t + dt) / 2, d.at + d.width];
      else r = [x1 - t + (t - dt) / 2, d.at, x1 - t + (t + dt) / 2, d.at + d.width];
      this.door(id, r[0], r[1], r[2], r[3], prof, Math.min(z1, 2.3), { keyId: d.keyId ?? null, powerFlag: d.powerFlag ?? null, startOpen: d.startOpen ?? false });
    }
    for (const w of windows) {
      // Window: low wall under, glass pane, wall above.
      const horiz = w.side === 'n' || w.side === 's';
      const y = w.side === 'n' ? y0 : y1 - t;
      const x = w.side === 'w' ? x0 : x1 - t;
      if (horiz) {
        this.box(profile, w.at, y, w.at + w.width, y + t, 0.9);
        this.box('core.ob.glass', w.at, y + t * 0.35, w.at + w.width, y + t * 0.65, 2.1, { z0: 0.9 });
        this.box(profile, w.at, y, w.at + w.width, y + t, z1, { z0: 2.1 });
      } else {
        this.box(profile, x, w.at, x + t, w.at + w.width, 0.9);
        this.box('core.ob.glass', x + t * 0.35, w.at, x + t * 0.65, w.at + w.width, 2.1, { z0: 0.9 });
        this.box(profile, x, w.at, x + t, w.at + w.width, z1, { z0: 2.1 });
      }
    }
    return this;
  }

  door(id: string, x0: number, y0: number, x1: number, y1: number, profile: string, z1: number, opts: { keyId?: string | null; powerFlag?: string | null; startOpen?: boolean } = {}): DoorDef {
    const d: DoorDef = { id, x0, y0, x1, y1, z1, profile, keyId: opts.keyId ?? null, powerFlag: opts.powerFlag ?? null, startOpen: opts.startOpen ?? false, floor: 0 };
    this.m.doors.push(d);
    return d;
  }

  tree(x: number, y: number, kind: 'tree' | 'pine' = 'tree', variant = 0): this {
    const r = kind === 'pine' ? 0.28 : 0.3;
    this.box(kind === 'pine' ? 'core.ob.pine' : 'core.ob.tree', x - r, y - r, x + r, y + r, 4.5, { variant });
    this.m.decor.push({ kind: kind === 'pine' ? 'canopy_pine' : 'canopy', x, y, variant });
    return this;
  }

  bush(x: number, y: number, w: number, h: number): this {
    this.box('core.ob.bush', x, y, x + w, y + h, 1.1);
    return this;
  }

  reeds(x: number, y: number, w: number, h: number): this {
    this.box('core.ob.reeds', x, y, x + w, y + h, 1.7);
    return this;
  }

  crops(x: number, y: number, w: number, h: number): this {
    this.box('core.ob.crops', x, y, x + w, y + h, 1.0);
    return this;
  }

  container(id: string, type: string, x: number, y: number, lootTable: string, opts: Partial<Omit<ContainerSpawnDef, 'id' | 'type' | 'x' | 'y' | 'lootTable'>> = {}): this {
    const t = CONTAINER_TYPES.find((c) => c.id === type);
    if (!t) throw new Error(`unknown container type ${type}`);
    this.m.containers.push({ id, type, x, y, lootTable, keyId: opts.keyId ?? null, ...(opts.questItems ? { questItems: opts.questItems } : {}), ...(opts.keyItem ? { keyItem: opts.keyItem } : {}), ...(opts.eventId ? { eventId: opts.eventId } : {}), ...(opts.guaranteed ? { guaranteed: opts.guaranteed } : {}) });
    if (t.obstacleProfile) this.box(t.obstacleProfile, x - t.w / 2, y - t.h / 2, x + t.w / 2, y + t.h / 2, t.z1, { id: `prop:${id}` });
    return this;
  }

  poi(id: string, nameKey: string, x: number, y: number, radius: number, kind: PoiDef['kind'] = 'landmark'): this {
    this.m.pois.push({ id, nameKey, x, y, radius, kind });
    return this;
  }

  exit(e: ExitDef): this {
    this.m.exits.push(e);
    return this;
  }

  spawn(x: number, y: number): this {
    this.m.playerSpawns.push({ x, y });
    return this;
  }

  enemies(g: SpawnGroupDef): this {
    this.m.enemyGroups.push(g);
    return this;
  }

  interact(d: Omit<InteractableDef, 'floor' | 'radius'> & { radius?: number }): this {
    this.m.interactables.push({ radius: 0.5, floor: 0, ...d });
    return this;
  }

  light(x: number, y: number, radius: number, color = 0xffd9a0): this {
    this.m.lights.push({ x, y, radius, color });
    return this;
  }

  decor(kind: string, x: number, y: number, variant = 0): this {
    const d: DecorDef = { kind, x, y, variant };
    this.m.decor.push(d);
    return this;
  }

  region(r: RegionDef): this {
    this.m.regions.push(r);
    return this;
  }

  interior(i: InteriorDef): this {
    this.m.interiors.push(i);
    return this;
  }

  spots(key: string, pts: { x: number; y: number }[]): this {
    this.m.eventSpots[key] = [...(this.m.eventSpots[key] ?? []), ...pts];
    return this;
  }

  rangeTarget(t: RangeTargetDef): this {
    (this.m.rangeTargets ??= []).push(t);
    return this;
  }

  build(): MapDef {
    return this.m;
  }
}
