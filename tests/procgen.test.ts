import { describe, expect, it } from 'vitest';
import { NavGrid } from '../src/ai/nav';
import { createContent } from '../src/content/core';
import type { MapDef } from '../src/content/mapTypes';
import { newProfile } from '../src/progression/profile';
import { refreshQuests } from '../src/progression/quests';
import { prepareDeploy } from '../src/progression/raidFlow';
import { deserializeSim, serializeSim } from '../src/save/schema';
import { WorldGeometry } from '../src/world/geometry';
import { layoutStats, PROCGEN, raidMap } from '../src/world/procgen';
import { createRaidSim, raidGeometry } from '../src/world/spawn';

/** Procedural raid layout (world/procgen.ts): a seeded layer that never breaks the authored map. */

const content = createContent();
const MAPS = ['core.map.quarantine_main', 'core.map.outer_supply_route'];
const SEEDS = Array.from({ length: 16 }, (_, i) => `procgen-${i}`);

function flood(nav: NavGrid, x: number, y: number): Uint8Array {
  const seen = new Uint8Array(nav.w * nav.h);
  const all = () => true;
  let [sx, sy] = nav.cellOf(x, y);
  if (!nav.passable(sy * nav.w + sx, all)) [sx, sy] = nav.cellOf(nav.nearestWalkable(x, y, 2)!.x, nav.nearestWalkable(x, y, 2)!.y);
  const q = [sy * nav.w + sx];
  seen[q[0]!] = 1;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    const cx = c % nav.w;
    const cy = (c - cx) / nav.w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= nav.w || ny >= nav.h) continue;
        const ni = ny * nav.w + nx;
        if (seen[ni] || !nav.passable(ni, all)) continue;
        if (dx && dy && (!nav.passable(cy * nav.w + nx, all) || !nav.passable(ny * nav.w + cx, all))) continue;
        seen[ni] = 1;
        q.push(ni);
      }
  }
  return seen;
}

const boxDist = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }) =>
  Math.hypot(Math.max(b.x0 - a.x1, 0, a.x0 - b.x1), Math.max(b.y0 - a.y1, 0, a.y0 - b.y1));

describe('procedural raid layout', () => {
  it('is deterministic per (map, seed), differs between seeds and never mutates the authored map', () => {
    for (const id of MAPS) {
      const base = content.map(id);
      const before = JSON.stringify(base);
      const a = raidMap(content, id, 'det-1');
      expect(JSON.parse(JSON.stringify(raidMap(createContent(), id, 'det-1')))).toEqual(JSON.parse(JSON.stringify(a)));
      expect(JSON.stringify(raidMap(content, id, 'det-2'))).not.toBe(JSON.stringify(a));
      expect(JSON.stringify(base), 'authored map untouched').toBe(before);
    }
  });

  it('every seed adds start points, cover clusters, loot caches, enemy anchors and ground patches', () => {
    for (const id of MAPS) {
      const base = content.map(id);
      const stats = SEEDS.map((s) => layoutStats(base, raidMap(content, id, s)));
      const min = (k: keyof (typeof stats)[number]) => Math.min(...stats.map((x) => x[k]));
      console.info(`[procgen] ${id}: ${JSON.stringify(stats[0])} … min ${JSON.stringify({ spawns: min('spawns'), obstacles: min('obstacles'), caches: min('caches'), anchors: min('anchors'), patchedCells: min('patchedCells') })}`);
      expect(min('spawns')).toBeGreaterThanOrEqual(1);
      expect(min('obstacles')).toBeGreaterThanOrEqual(8);
      expect(min('caches')).toBeGreaterThanOrEqual(1);
      expect(min('anchors')).toBeGreaterThanOrEqual(5);
      expect(min('patchedCells')).toBeGreaterThan(20);
    }
  });

  it('keeps every lane walkable: all ground reachable on the authored map stays reachable (16 seeds × 2 maps)', () => {
    for (const id of MAPS) {
      const base = content.map(id);
      const baseNav = new NavGrid(new WorldGeometry(base, content));
      const start = base.playerSpawns[0]!;
      const baseReach = flood(baseNav, start.x, start.y);
      for (const s of SEEDS) {
        const nav = new NavGrid(new WorldGeometry(raidMap(content, id, s), content));
        const reach = flood(nav, start.x, start.y);
        let lost = 0;
        for (let i = 0; i < reach.length; i++) if (baseReach[i] && !nav.blocked[i] && !reach[i]) lost++;
        expect(lost, `${id} ${s}: cells cut off by the layout`).toBe(0);
      }
    }
  });

  it('keeps its clearances: nothing inside buildings or near doors, exits, containers and start points; far starts', () => {
    for (const id of MAPS) {
      const base = content.map(id);
      for (const s of SEEDS) {
        const m: MapDef = raidMap(content, id, s);
        const added = m.obstacles.slice(base.obstacles.length);
        for (const o of added) {
          const where = `${id} ${s} ${o.id}`;
          for (const i of base.interiors) expect(boxDist(o, { x0: i.rect.x, y0: i.rect.y, x1: i.rect.x + i.rect.w, y1: i.rect.y + i.rect.h }), `${where} vs ${i.id}`).toBeGreaterThan(0);
          for (const d of base.doors) expect(boxDist(o, d), `${where} vs ${d.id}`).toBeGreaterThanOrEqual(PROCGEN.door - 1e-6);
          for (const e of base.exits) expect(boxDist(o, { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h }), `${where} vs ${e.id}`).toBeGreaterThanOrEqual(PROCGEN.exit - 1e-6);
          if (o.id.startsWith('prop:')) continue;
          for (const c of base.containers) expect(boxDist(o, { x0: c.x, y0: c.y, x1: c.x, y1: c.y }), `${where} vs ${c.id}`).toBeGreaterThanOrEqual(PROCGEN.container - 0.5);
        }
        const free = base.exits.filter((e) => e.condition.type === 'free');
        for (const sp of m.playerSpawns.slice(base.playerSpawns.length))
          for (const e of free) expect(boxDist({ x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y }, { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h })).toBeGreaterThanOrEqual(PROCGEN.spawnFreeExit - 1e-6);
      }
    }
  });

  it('a deployed raid uses it (loot caches filled), a resumed raid rebuilds the identical layout, and the setting turns it off', () => {
    const p = newProfile(content, 1, 'Proc', 'procgen-raid', 0);
    p.quests['core.quest.q01_ready'] = { status: 'completed', progress: {} };
    for (const f of content.quest('core.quest.q01_ready').rewards.flags ?? []) p.flags[f] = true;
    refreshQuests(p, content);
    const launch = prepareDeploy(p, content, 'core.dest.quarantine_main', 0);
    expect(launch.layoutSeed).toBe(launch.seed);
    const { sim, ctx } = createRaidSim(content, launch);
    expect(sim.layoutSeed).toBe(launch.seed);
    const cache = Object.values(sim.containers).find((c) => c.id.startsWith('ct:proc_'));
    expect(cache, 'a procedural loot cache exists in the raid').toBeTruthy();
    expect(sim.store.containers[cache!.id]!.items.length).toBeGreaterThan(0);
    const restored = deserializeSim(serializeSim(sim));
    const geo2 = raidGeometry(content, restored);
    expect(geo2.obstacles.map((o) => [o.id, o.box])).toEqual(ctx.geo.obstacles.map((o) => [o.id, o.box]));
    expect(geo2.map.ground).toEqual(ctx.geo.map.ground);

    const off = newProfile(content, 2, 'Off', 'procgen-off', 0);
    off.flags['deploy_allowed'] = true;
    off.settings.proceduralTerrain = false;
    const l2 = prepareDeploy(off, content, 'core.dest.quarantine_main', 0);
    expect(l2.layoutSeed).toBeUndefined();
    expect(createRaidSim(content, l2).ctx.geo.map).toBe(content.map('core.map.quarantine_main'));
  });
});
