import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NAV_CELL, navFor, NavGrid } from '../src/ai/nav';
import { createContent } from '../src/content/core';
import type { MapDef } from '../src/content/mapTypes';
import { rectContains } from '../src/core/math';
import { newProfile, type ProfileState } from '../src/progression/profile';
import { refreshQuests } from '../src/progression/quests';
import { prepareDeploy } from '../src/progression/raidFlow';
import { player, type SimContext } from '../src/world/context';
import type { DynamicState, ObstacleRuntime } from '../src/world/geometry';
import { INTERACT_RANGE } from '../src/world/interact';
import { exitConditionMet } from '../src/world/sim';
import { createRaidSim, type RaidLaunch } from '../src/world/spawn';

/**
 * A09 — "두 Map 각 100 seed에서 필수 목표·무료 탈출·안전 spawn 유효".
 * Raids are created exactly like the game does: newProfile → quest/flag state → prepareDeploy → createRaidSim.
 * Every seed varies the profile seed and generation (so forecast seed, time and weather vary) and rotates through
 * realistic Chapter 1 progression states, so quest items / key items / boss spawn rules are exercised on and off.
 */

const content = createContent();
const SEEDS_PER_MAP = 100;

/** spawn.ts spawnSafe(): a candidate spawn is rejected when any actor is closer than 18u ... */
const SPAWN_SAFE_DIST = 18;
/** ... or when geo.movementBlockers(x, y, 0.35) is non-empty (evaluated with all doors closed). */
const SPAWN_CLEAR_RADIUS = 0.35;
const CLOSED_WORLD: DynamicState = { doors: {}, obstacleHp: {}, smokes: [], time: 0 };
/** interact.ts: world/event containers are usable within INTERACT_RANGE of their 0.5u footprint. */
const CONTAINER_REACH = INTERACT_RANGE + 0.5 - 0.05;
const BOSS_REACH = 1.5;

const Q01 = 'core.quest.q01_ready';
const Q02 = 'core.quest.q02_first_haul';
const Q03 = 'core.quest.q03_remember_road';
const Q06 = 'core.quest.q06_scrap';
const Q07 = 'core.quest.q07_restore_power';
const Q08 = 'core.quest.q08_last_signal';

interface Scenario {
  id: string;
  completed: string[];
  registerKeys: boolean;
}

/** Realistic Chapter 1 progression states (reward flags of completed quests are applied). */
const SCENARIOS: Scenario[] = [
  { id: 'Q02 active', completed: [Q01], registerKeys: false },
  { id: 'Q03 active', completed: [Q01, Q02], registerKeys: false },
  { id: 'Q07 active', completed: [Q01, Q02, Q03, Q06], registerKeys: false },
  { id: 'Q08 active', completed: [Q01, Q02, Q03, Q06, Q07], registerKeys: false },
  { id: 'free roam, keys registered', completed: [Q01, Q02, Q03, Q06, Q07, Q08], registerKeys: true },
];

interface MapCase {
  key: string;
  destId: string;
  mapId: string;
}

const MAPS: MapCase[] = [
  { key: 'main', destId: 'core.dest.quarantine_main', mapId: 'core.map.quarantine_main' },
  { key: 'outer', destId: 'core.dest.outer_supply_route', mapId: 'core.map.outer_supply_route' },
];

interface RaidCase {
  index: number;
  scenario: string;
  profileSeed: string;
  generation: number;
  launch: RaidLaunch;
  ctx: SimContext;
}

function profileFor(sc: Scenario, seed: string, slot: number, generation: number): ProfileState {
  const p = newProfile(content, slot, 'A09', seed, 0);
  for (const qid of sc.completed) {
    p.quests[qid] = { status: 'completed', progress: {} };
    for (const f of content.quest(qid).rewards.flags ?? []) p.flags[f] = true;
  }
  p.flags['deploy_allowed'] = true;
  p.flags['outer_route_unlocked'] = true;
  refreshQuests(p, content);
  if (sc.registerKeys) p.keys.registered = [...content.keys.keys()];
  p.generation = generation;
  return p;
}

function generateRaids(mc: MapCase): RaidCase[] {
  const out: RaidCase[] = [];
  for (let i = 0; i < SEEDS_PER_MAP; i++) {
    const sc = SCENARIOS[i % SCENARIOS.length]!;
    const profileSeed = `a09|${mc.key}|seed-${i}`;
    const generation = Math.floor(i / SCENARIOS.length);
    const p = profileFor(sc, profileSeed, 1 + (i % 3), generation);
    const launch = prepareDeploy(p, content, mc.destId, 0);
    const { ctx } = createRaidSim(content, launch);
    ctx.sim.credits = p.currency; // same as GameApp.deploy
    out.push({ index: i, scenario: sc.id, profileSeed, generation, launch, ctx });
  }
  return out;
}

// --- geometry helpers --------------------------------------------------------------------------------------------

function circleOverlapsBox(x: number, y: number, r: number, o: ObstacleRuntime): boolean {
  const cx = Math.max(o.box.x0, Math.min(x, o.box.x1));
  const cy = Math.max(o.box.y0, Math.min(y, o.box.y1));
  return (x - cx) ** 2 + (y - cy) ** 2 < (r - 1e-6) ** 2;
}

/** Active movement blockers that actually overlap a body circle at (x, y). */
function solidOverlaps(ctx: SimContext, x: number, y: number, r: number): ObstacleRuntime[] {
  return ctx.geo.movementBlockers(x, y, r, 0, ctx.sim).filter((o) => circleOverlapsBox(x, y, r, o));
}

/** Active movement blockers strictly containing the point (x, y). */
function solidsContaining(ctx: SimContext, x: number, y: number): ObstacleRuntime[] {
  const e = 1e-6;
  return ctx.geo.movementBlockers(x, y, 0.01, 0, ctx.sim).filter((o) => x > o.box.x0 + e && x < o.box.x1 - e && y > o.box.y0 + e && y < o.box.y1 - e);
}

type DoorOk = (doorId: string) => boolean;

function doorOkFor(ctx: SimContext): DoorOk {
  // Closed-but-unlocked doors can be opened by the player; locked doors (keys / power) are walls for this check.
  return (d) => !ctx.sim.doors[d]?.locked;
}

/** Walkable nav cell whose centre lies inside the rect, nearest to the rect centre. */
function walkableCellIn(nav: NavGrid, rect: { x: number; y: number; w: number; h: number }, doorOk: DoorOk): { x: number; y: number } | null {
  const mx = rect.x + rect.w / 2;
  const my = rect.y + rect.h / 2;
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let gy = Math.floor(rect.y / NAV_CELL); gy <= Math.floor((rect.y + rect.h) / NAV_CELL); gy++)
    for (let gx = Math.floor(rect.x / NAV_CELL); gx <= Math.floor((rect.x + rect.w) / NAV_CELL); gx++) {
      if (gx < 0 || gy < 0 || gx >= nav.w || gy >= nav.h) continue;
      const c = nav.center(gx, gy);
      if (!rectContains(rect, c.x, c.y) || !nav.passable(gy * nav.w + gx, doorOk)) continue;
      const d = Math.hypot(c.x - mx, c.y - my);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  return best;
}

/** Flood fill over the nav grid with the same rules as NavGrid.findPath (8-neighbour, no corner cutting). */
function reachableFrom(nav: NavGrid, x: number, y: number, doorOk: DoorOk): Uint8Array {
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

function reachedWithin(nav: NavGrid, seen: Uint8Array, x: number, y: number, r: number): boolean {
  const [x0, y0] = nav.cellOf(x - r, y - r);
  const [x1, y1] = nav.cellOf(x + r, y + r);
  for (let gy = y0; gy <= y1; gy++)
    for (let gx = x0; gx <= x1; gx++) {
      if (!seen[gy * nav.w + gx]) continue;
      const c = nav.center(gx, gy);
      if (Math.hypot(c.x - x, c.y - y) <= r) return true;
    }
  return false;
}

// --- per-raid checks (each returns the list of violations) ----------------------------------------------------------

function where(rc: RaidCase): string {
  return `#${rc.index} [${rc.scenario}] seed=${rc.launch.seed} ${rc.launch.phase}/${rc.launch.weather}`;
}

function checkFreeExits(rc: RaidCase, map: MapDef): string[] {
  const v: string[] = [];
  const { sim } = rc.ctx;
  const pl = player(sim);
  const free = map.exits.filter((e) => e.condition.type === 'free');
  if (free.length === 0) v.push('map defines no free exit');
  let enabled = 0;
  for (const ex of free) {
    const st = sim.exits[ex.id];
    if (!st) {
      v.push(`${ex.id}: no exit state`);
      continue;
    }
    if (!st.enabled) v.push(`${ex.id}: disabled at raid start`);
    if (st.progress !== 0) v.push(`${ex.id}: progress ${st.progress} at raid start`);
    if (!exitConditionMet(rc.ctx, ex, pl)) v.push(`${ex.id}: condition not met`);
    if (ex.x < 0 || ex.y < 0 || ex.x + ex.w > map.width || ex.y + ex.h > map.height || ex.w <= 0 || ex.h <= 0) v.push(`${ex.id}: rect outside the map`);
    if (st.enabled) enabled++;
  }
  if (enabled === 0) v.push('no enabled free exit');
  return v;
}

interface RequiredTarget {
  label: string;
  x: number;
  y: number;
  reach: number;
}

/** Required objectives derived from the map definition + launch (quest items, unregistered key items, boss). */
function requiredTargets(rc: RaidCase, map: MapDef): { targets: RequiredTarget[]; violations: string[] } {
  const v: string[] = [];
  const targets: RequiredTarget[] = [];
  const { sim } = rc.ctx;
  const { launch } = rc;
  const itemsIn = (cid: string) => (sim.store.containers[cid]?.items ?? []).map((id) => sim.store.items[id]!).filter(Boolean);
  const qtyIn = (cid: string, defId: string) => itemsIn(cid).filter((it) => it.definitionId === defId).reduce((s, it) => s + it.quantity, 0);
  const worldQty = (defId: string) => Object.values(sim.store.items).filter((it) => it.definitionId === defId).reduce((s, it) => s + it.quantity, 0);
  for (const c of map.containers) {
    const cid = `ct:${c.id}`;
    for (const q of c.questItems ?? []) {
      const needed = launch.activeQuests.includes(q.questId) && !(q.unlessFlag && launch.flags[q.unlessFlag]) && !launch.questItemsHeld.includes(q.itemId);
      const n = qtyIn(cid, q.itemId);
      if (!needed) {
        if (n !== 0) v.push(`${c.id}: ${q.itemId} placed although ${q.questId} does not need it (qty ${n})`);
        continue;
      }
      if (c.eventId) v.push(`${c.id}: required ${q.itemId} depends on raid event ${c.eventId}`);
      if (!sim.containers[cid]) {
        v.push(`${c.id}: required container for ${q.questId} missing`);
        continue;
      }
      if (n < Math.min(q.qty, content.item(q.itemId).stackMax)) v.push(`${c.id}: required ${q.itemId} for ${q.questId} missing (qty ${n})`);
      targets.push({ label: `${q.itemId}@${c.id}`, x: c.x, y: c.y, reach: CONTAINER_REACH });
    }
    if (c.keyItem) {
      const keyId = content.item(c.keyItem).keyId!;
      const shouldPlace = !launch.registeredKeys.includes(keyId) && !launch.keyItemsHeld.includes(c.keyItem);
      const n = qtyIn(cid, c.keyItem);
      if (shouldPlace) {
        if (c.eventId) v.push(`${c.id}: key item ${c.keyItem} depends on raid event ${c.eventId}`);
        if (n !== 1) v.push(`${c.id}: unregistered key item ${c.keyItem} placed ${n}× (expected 1)`);
        targets.push({ label: `${c.keyItem}@${c.id}`, x: c.x, y: c.y, reach: CONTAINER_REACH });
      } else if (worldQty(c.keyItem) !== 0) v.push(`${c.id}: key item ${c.keyItem} placed although key ${keyId} is registered/held`);
    }
  }
  // Named acceptance examples (main map).
  if (map.id === 'core.map.quarantine_main') {
    if (launch.activeQuests.includes(Q02) && worldQty('core.quest.relief_package') < 1) v.push('Q02 active but no relief package in any container');
    if (launch.activeQuests.includes(Q07) && worldQty('core.mat.power_unit') < 1) v.push('Q07 active but no power unit in any container');
    if (launch.activeQuests.includes(Q08) && !launch.bossActive) v.push('Q08 active but launch.bossActive is false');
  }
  for (const g of map.enemyGroups.filter((x) => x.boss)) {
    const bosses = sim.actors.filter((a) => a.kind === 'enemy' && g.archetypes.some((x) => x.id === a.archetypeId));
    const gated = (!!g.requiresQuest && !launch.activeQuests.includes(g.requiresQuest)) || (!!g.requiresFlag && !launch.flags[g.requiresFlag]) || (!!g.unlessFlag && !!launch.flags[g.unlessFlag]);
    const mustSpawn = launch.bossActive && !gated && g.chance >= 1;
    if (mustSpawn && bosses.length !== 1) v.push(`boss group ${g.id}: ${bosses.length} bosses spawned (expected 1)`);
    if (!launch.bossActive && bosses.length !== 0) v.push(`boss group ${g.id}: boss spawned although bossActive=false`);
    for (const b of bosses) {
      if (!b.alive || b.hp !== b.maxHp) v.push(`boss ${b.id}: not a fresh living boss`);
      if (!g.points.some((pt) => Math.hypot(pt.x - b.x, pt.y - b.y) < 1e-9)) v.push(`boss ${b.id}: not at an authored boss point`);
      targets.push({ label: `boss ${b.archetypeId}`, x: b.x, y: b.y, reach: BOSS_REACH });
    }
  }
  return { targets, violations: v };
}

function checkObjectivesReachable(rc: RaidCase, map: MapDef, nav: NavGrid): string[] {
  const { targets } = requiredTargets(rc, map);
  const pl = player(rc.ctx.sim);
  const seen = reachableFrom(nav, pl.x, pl.y, doorOkFor(rc.ctx));
  return targets.filter((t) => !reachedWithin(nav, seen, t.x, t.y, t.reach)).map((t) => `${t.label} unreachable from spawn (${pl.x},${pl.y})`);
}

/** Which spawn source produced an enemy (event guards are listed in RaidEventState.data.guards). */
function spawnSource(ctx: SimContext, actorId: string): string {
  for (const ev of ctx.sim.events) {
    const guards = String(ev.data['guards'] ?? '').split(',');
    if (guards.includes(actorId)) return `guard of ${ev.defId}`;
  }
  return 'enemy group';
}

function checkSpawnClear(rc: RaidCase): string[] {
  const v: string[] = [];
  const { ctx } = rc;
  const pl = player(ctx.sim);
  // The raid's own map: the authored start points plus the ones its procedural layout added.
  if (!ctx.geo.map.playerSpawns.some((s) => s.x === pl.x && s.y === pl.y)) v.push(`player at (${pl.x},${pl.y}) is not a start point of the raid map`);
  const hits = solidOverlaps(ctx, pl.x, pl.y, pl.radius);
  if (hits.length) v.push(`player spawn (${pl.x},${pl.y}) overlaps ${hits.map((o) => o.id).join(',')}`);
  if (ctx.geo.movementBlockers(pl.x, pl.y, SPAWN_CLEAR_RADIUS, 0, CLOSED_WORLD).length) v.push(`player spawn (${pl.x},${pl.y}) violates the spawnSafe clearance`);
  return v;
}

function checkSpawnDistance(rc: RaidCase): { violations: string[]; minHostile: number } {
  const v: string[] = [];
  const { ctx } = rc;
  const map = ctx.geo.map;
  const pl = player(ctx.sim);
  const hostiles = ctx.sim.actors.filter((a) => a.team === 'hostile' && a.alive);
  let minHostile = Infinity;
  for (const a of hostiles) {
    const d = Math.hypot(a.x - pl.x, a.y - pl.y);
    minHostile = Math.min(minHostile, d);
    if (d < SPAWN_SAFE_DIST) v.push(`hostile ${a.id} (${a.archetypeId}, ${spawnSource(ctx, a.id)}) at (${a.x.toFixed(2)},${a.y.toFixed(2)}) is ${d.toFixed(2)}u from the player spawn (${pl.x},${pl.y}) < ${SPAWN_SAFE_DIST}u`);
  }
  if (v.length) {
    // Diagnose: would any authored spawn have satisfied spawnSafe against the final actor set?
    const cands = map.playerSpawns.map((s) => {
      const d = Math.min(...hostiles.map((a) => Math.hypot(a.x - s.x, a.y - s.y)));
      const clear = ctx.geo.movementBlockers(s.x, s.y, SPAWN_CLEAR_RADIUS, 0, CLOSED_WORLD).length === 0;
      return { s, ok: clear && d >= SPAWN_SAFE_DIST, text: `(${s.x},${s.y}) nearest hostile ${d.toFixed(1)}u${clear ? '' : ' blocked'}` };
    });
    if (!cands.some((c) => c.ok)) v.push(`no authored spawn satisfies spawnSafe, createRaidSim fell back to the first shuffled spawn: ${cands.map((c) => c.text).join('; ')}`);
  }
  return { violations: v, minHostile };
}

function checkSpawnsNotInSolids(rc: RaidCase): string[] {
  const v: string[] = [];
  const { ctx } = rc;
  for (const a of ctx.sim.actors) {
    if (a.kind !== 'enemy') continue;
    const hits = solidOverlaps(ctx, a.x, a.y, a.radius);
    if (hits.length) {
      const desc = hits.map((o) => `${o.id}(${o.def.profile} x${o.box.x0}..${o.box.x1} y${o.box.y0}..${o.box.y1})`).join(',');
      v.push(`enemy ${a.id} (${a.archetypeId}, ${spawnSource(ctx, a.id)}) spawned at (${a.x},${a.y}) inside ${desc}`);
    }
  }
  for (const c of Object.values(ctx.sim.containers)) {
    if (c.kind !== 'world' && c.kind !== 'event' && c.kind !== 'deathbag') continue;
    const own = `prop:${c.id.replace(/^ct:/, '')}`;
    const inside = solidsContaining(ctx, c.x, c.y).filter((o) => o.id !== own);
    if (inside.length) v.push(`container ${c.id} at (${c.x},${c.y}) inside ${inside.map((o) => o.id).join(',')}`);
  }
  return v;
}

function checkNavPathToFreeExit(rc: RaidCase, map: MapDef, nav: NavGrid): { violations: string[]; length: number | null } {
  const { ctx } = rc;
  const pl = player(ctx.sim);
  const doorOk = doorOkFor(ctx);
  const notes: string[] = [];
  let best: number | null = null;
  for (const ex of map.exits.filter((e) => e.condition.type === 'free' && ctx.sim.exits[e.id]?.enabled)) {
    const target = walkableCellIn(nav, ex, doorOk);
    if (!target) {
      notes.push(`${ex.id}: no walkable nav cell inside the exit`);
      continue;
    }
    const path = nav.findPath(pl.x, pl.y, target.x, target.y, doorOk, 1_000_000);
    if (!path || path.length === 0) {
      notes.push(`${ex.id}: no nav path`);
      continue;
    }
    const end = path[path.length - 1]!;
    if (!rectContains(ex, end.x, end.y)) {
      notes.push(`${ex.id}: path ends outside the exit`);
      continue;
    }
    let broken = false;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1]!;
      const b = path[k]!;
      if (!nav.walkableAt(b.x, b.y, doorOk) || !nav.lineWalkable(a.x, a.y, b.x, b.y, doorOk)) broken = true;
    }
    if (broken) {
      notes.push(`${ex.id}: path crosses blocked cells`);
      continue;
    }
    let len = Math.hypot(path[0]!.x - pl.x, path[0]!.y - pl.y);
    for (let k = 1; k < path.length; k++) len += Math.hypot(path[k]!.x - path[k - 1]!.x, path[k]!.y - path[k - 1]!.y);
    best = best === null ? len : Math.min(best, len);
  }
  return { violations: best === null ? [`no nav path from spawn (${pl.x},${pl.y}) to any free exit: ${notes.join('; ')}`] : [], length: best };
}

// --- tests --------------------------------------------------------------------------------------------------------

interface CategoryResult {
  valid: number;
  total: number;
}

const report: Record<string, Record<string, CategoryResult | string | number | Record<string, number>>> = {};

afterAll(() => {
  // Aggregate evidence for the acceptance log.
  console.log(`[A09] summary\n${JSON.stringify(report, null, 2)}`);
});

describe.each(MAPS)('A09 $mapId: 100 seeds', (mc) => {
  const map = content.map(mc.mapId);
  let raids: RaidCase[] = [];
  // Every raid has its own procedural layout: reachability is checked on that raid's own geometry.
  const navOf = (rc: RaidCase): NavGrid => navFor(rc.ctx.geo);
  const rec = (report[mc.mapId] = {} as Record<string, CategoryResult | string | number | Record<string, number>>);
  const failuresPerSeed = new Map<number, string[]>();

  function category(name: string, check: (rc: RaidCase) => string[]): string[] {
    const failures: string[] = [];
    let valid = 0;
    for (const rc of raids) {
      const v = check(rc);
      if (v.length === 0) valid++;
      else {
        failures.push(...v.map((x) => `${where(rc)}: ${x}`));
        failuresPerSeed.set(rc.index, [...(failuresPerSeed.get(rc.index) ?? []), ...v]);
      }
    }
    rec[name] = { valid, total: raids.length };
    rec['all categories'] = { valid: raids.length - failuresPerSeed.size, total: raids.length };
    return failures;
  }

  beforeAll(() => {
    const t0 = performance.now();
    raids = generateRaids(mc);
    rec['generation ms'] = Math.round(performance.now() - t0);
  });

  it('every raid is played on its own seeded layout over the authored map (start points, cover, caches, anchors)', () => {
    const layouts = new Set<string>();
    let procStarts = 0;
    for (const r of raids) {
      const m = r.ctx.geo.map;
      expect(r.ctx.sim.layoutSeed, 'procedural terrain is on by default').toBe(r.launch.seed);
      // The authored structure is kept verbatim: every authored obstacle, door, exit, container and start point.
      expect(m.obstacles.slice(0, map.obstacles.length)).toEqual(map.obstacles);
      expect(m.doors).toEqual(map.doors);
      expect(m.exits).toEqual(map.exits);
      expect(m.containers.slice(0, map.containers.length)).toEqual(map.containers);
      expect(m.playerSpawns.slice(0, map.playerSpawns.length)).toEqual(map.playerSpawns);
      layouts.add(JSON.stringify([m.obstacles.length, m.containers.length, m.playerSpawns.slice(map.playerSpawns.length), m.obstacles.slice(map.obstacles.length).map((o) => [o.x0, o.y0])]));
      const pl = player(r.ctx.sim);
      if (!map.playerSpawns.some((s) => s.x === pl.x && s.y === pl.y)) procStarts++;
    }
    rec['distinct layouts'] = layouts.size;
    rec['raids starting at a generated start point'] = procStarts;
    expect(layouts.size).toBe(SEEDS_PER_MAP);
    expect(procStarts).toBeGreaterThan(SEEDS_PER_MAP / 5);
  });

  it('100 distinct raid seeds with varied time/weather across 5 progression scenarios', () => {
    expect(raids).toHaveLength(SEEDS_PER_MAP);
    const seeds = new Set(raids.map((r) => r.launch.seed));
    const phases: Record<string, number> = {};
    const weathers: Record<string, number> = {};
    for (const r of raids) {
      phases[r.launch.phase] = (phases[r.launch.phase] ?? 0) + 1;
      weathers[r.launch.weather] = (weathers[r.launch.weather] ?? 0) + 1;
      // The raid really runs with the forecast environment.
      expect(r.ctx.sim.env).toEqual({ phase: r.launch.phase, weather: r.launch.weather });
      expect(r.ctx.sim.mapId).toBe(mc.mapId);
    }
    rec['distinct raid seeds'] = seeds.size;
    rec['phases'] = phases;
    rec['weathers'] = weathers;
    rec['bosses spawned'] = raids.filter((r) => r.ctx.sim.actors.some((a) => a.archetypeId === 'core.enemy.boss')).length;
    rec['raid events'] = raids.reduce<Record<string, number>>((acc, r) => {
      for (const e of r.ctx.sim.events) acc[e.defId] = (acc[e.defId] ?? 0) + 1;
      return acc;
    }, {});
    expect(seeds.size).toBe(SEEDS_PER_MAP);
    expect(Object.keys(phases).length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(weathers).length).toBeGreaterThanOrEqual(3);
  });

  it('at least one free exit exists and every free exit is enabled at raid start', () => {
    expect(map.exits.some((e) => e.condition.type === 'free')).toBe(true);
    expect(category('free exit enabled', (rc) => checkFreeExits(rc, map))).toEqual([]);
  });

  it('required quest items, unregistered key items and the boss are present when needed', () => {
    const failures = category('required objectives present', (rc) => requiredTargets(rc, map).violations);
    // The acceptance examples must actually have been exercised on the main map.
    if (mc.key === 'main') {
      const withQ02 = raids.filter((r) => r.launch.activeQuests.includes(Q02)).length;
      const withQ07 = raids.filter((r) => r.launch.activeQuests.includes(Q07)).length;
      const withQ08 = raids.filter((r) => r.launch.activeQuests.includes(Q08)).length;
      rec['raids with Q02/Q07/Q08 active'] = `${withQ02}/${withQ07}/${withQ08}`;
      expect(withQ02).toBeGreaterThan(0);
      expect(withQ07).toBeGreaterThan(0);
      expect(withQ08).toBeGreaterThan(0);
    }
    const keyed = map.containers.filter((c) => c.keyItem).length;
    expect(keyed).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it('required objectives are reachable on foot from the player spawn (unlocked doors only)', () => {
    expect(category('required objectives reachable', (rc) => checkObjectivesReachable(rc, map, navOf(rc)))).toEqual([]);
  });

  it('player spawn is a start point of the raid map, clear of every movement-blocking obstacle', () => {
    expect(category('player spawn clear of solids', (rc) => checkSpawnClear(rc))).toEqual([]);
  });

  it(`no hostile starts within ${SPAWN_SAFE_DIST}u of the player spawn (spawn.ts spawnSafe distance)`, () => {
    let minHostile = Infinity;
    const failures = category(`player spawn ≥ ${SPAWN_SAFE_DIST}u from hostiles`, (rc) => {
      const r = checkSpawnDistance(rc);
      minHostile = Math.min(minHostile, r.minHostile);
      return r.violations;
    });
    rec['min player-hostile distance at start'] = Number(minHostile.toFixed(2));
    expect(failures).toEqual([]);
  });

  it('no enemy or container spawns inside a solid obstacle', () => {
    expect(category('no spawn inside solids', (rc) => checkSpawnsNotInSolids(rc))).toEqual([]);
  });

  it('a walkable nav path leads from the player spawn to at least one free exit', () => {
    const lengths: number[] = [];
    const failures = category('nav path spawn → free exit', (rc) => {
      const r = checkNavPathToFreeExit(rc, map, navOf(rc));
      if (r.length !== null) lengths.push(r.length);
      return r.violations;
    });
    if (lengths.length) rec['shortest exit path length (min/avg/max u)'] = `${Math.min(...lengths).toFixed(1)}/${(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1)}/${Math.max(...lengths).toFixed(1)}`;
    expect(failures).toEqual([]);
  });
});
