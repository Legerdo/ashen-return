import { describe, expect, it } from 'vitest';
import { navFor, type NavGrid } from '../src/ai/nav';
import { totalRounds } from '../src/combat/reload';
import { createContent } from '../src/content/core';
import type { InteriorDef } from '../src/content/types';
import { SIM_DT } from '../src/core/clock';
import { rectContains } from '../src/core/math';
import { validateStore } from '../src/inventory/store';
import { newProfile } from '../src/progression/profile';
import { refreshQuests } from '../src/progression/quests';
import { prepareDeploy } from '../src/progression/raidFlow';
import { deserializeSim, serializeSim } from '../src/save/schema';
import { idleCommand, type PlayerCommand, type RaidOp } from '../src/world/command';
import { allCarriedItemIds, makeContext, player, type SimContext } from '../src/world/context';
import { stepSim } from '../src/world/sim';
import { createRaidSim, raidGeometry } from '../src/world/spawn';
import type { ActorState, SimEvent, SimState } from '../src/world/state';

/**
 * A10 — "실내 왕복과 raid 재개에서 적/상자/잔탄 복제·재추첨 없음".
 * Raids are created through the real deployment path (newProfile → prepareDeploy → createRaidSim) and stepped
 * with stepSim exactly like GameApp.step (fx drained after every tick). Resume uses the checkpoint path:
 * ctx.sim.rng = ctx.rng.getState() → serializeSim → deserializeSim → makeContext(raidGeometry) (same layout seed).
 */

const content = createContent();
const MAIN_DEST = 'core.dest.quarantine_main';
const OUTER_DEST = 'core.dest.outer_supply_route';
const Q01 = 'core.quest.q01_ready';
const CALIBERS = ['9', '45', '556', '762r', '762d', '12g'];

function startRaid(seed: string, destId = MAIN_DEST): SimContext {
  const p = newProfile(content, 1, 'A10', seed, 0);
  p.quests[Q01] = { status: 'completed', progress: {} };
  for (const f of content.quest(Q01).rewards.flags ?? []) p.flags[f] = true;
  p.flags['outer_route_unlocked'] = true;
  refreshQuests(p, content);
  const launch = prepareDeploy(p, content, destId, 0);
  const { ctx } = createRaidSim(content, launch);
  ctx.sim.credits = p.currency;
  return ctx;
}

/** One GameApp-style step: the transient fx list is drained and returned. */
function step(ctx: SimContext, cmd: PlayerCommand | null, ops: RaidOp[] = []): SimEvent[] {
  stepSim(ctx, { cmd, ops }, SIM_DT);
  const fx = ctx.sim.fx;
  ctx.sim.fx = [];
  return fx;
}

function aimCmd(x: number, y: number, z = 1.2, extra: Partial<PlayerCommand> = {}): PlayerCommand {
  return { ...idleCommand(), aim: { x, y, z, actorId: null, viewDistPx: 999 }, ...extra };
}

function teleport(a: ActorState, x: number, y: number): void {
  a.x = a.px = x;
  a.y = a.py = y;
  a.vx = a.vy = 0;
}

/** Drive the player with movement commands toward (x, y). Returns ticks used, or -1 if not reached. */
function walkTo(ctx: SimContext, x: number, y: number, maxTicks = 900, onFx?: (fx: SimEvent[]) => void): number {
  const pl = player(ctx.sim);
  for (let t = 0; t < maxTicks; t++) {
    const dx = x - pl.x;
    const dy = y - pl.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.12) return t;
    const fx = step(ctx, aimCmd(pl.x + (dx / d) * 6, pl.y + (dy / d) * 6, 1.2, { moveX: dx / d, moveY: dy / d }));
    onFx?.(fx);
  }
  return -1;
}

function roundsOf(ctx: SimContext, ids: string[]): number {
  return CALIBERS.reduce((s, cal) => s + totalRounds(ctx, ids, cal), 0);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Everything that must never re-roll or respawn: enemies, containers, contents, item ids, ammo per actor. */
function persistentWorld(ctx: SimContext) {
  const s = ctx.sim;
  return clone({
    actorIds: s.actors.map((a) => a.id),
    enemies: s.actors
      .filter((a) => a.kind !== 'player')
      .map((a) => ({ id: a.id, archetypeId: a.archetypeId, alive: a.alive, hp: a.hp, maxHp: a.maxHp, x: a.x, y: a.y, deathEventId: a.deathEventId, activeSlot: a.activeSlot })),
    // The convoy cart legitimately drives along its route, so event-container coordinates are not compared.
    containers: Object.values(s.containers).map((c) => ({ id: c.id, kind: c.kind, typeId: c.typeId, searched: c.searched, searchProgress: c.searchProgress, locked: c.locked, opened: c.opened, keyId: c.keyId, ...(c.kind === 'event' ? {} : { x: c.x, y: c.y }) })),
    storeContainers: s.store.containers,
    items: s.store.items,
    ammo: Object.fromEntries(s.actors.map((a) => [a.id, roundsOf(ctx, allCarriedItemIds(s, a))])),
    idsNext: s.ids.next,
    rng: s.rng,
    processedDeaths: s.processedDeaths,
  });
}

/** JSON-level hazards: values that would not survive serializeSim → deserializeSim unchanged. */
function jsonHazards(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): void => {
    if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) out.push(`${path}: non-finite number ${v}`);
      else if (Object.is(v, -0)) out.push(`${path}: negative zero`);
      return;
    }
    if (typeof v !== 'object') {
      out.push(`${path}: ${typeof v}`);
      return;
    }
    if (seen.has(v)) {
      out.push(`${path}: shared or cyclic reference`);
      return;
    }
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x, i) => (x === undefined ? out.push(`${path}[${i}]: undefined array element`) : walk(x, `${path}[${i}]`)));
      return;
    }
    const proto = Object.getPrototypeOf(v) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      out.push(`${path}: non-plain object ${(v as { constructor?: { name?: string } }).constructor?.name ?? '?'}`);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(root, '$');
  return out;
}

function diffPaths(a: unknown, b: unknown, path = '$', out: string[] = [], limit = 12): string[] {
  if (out.length >= limit || Object.is(a, b)) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${String(JSON.stringify(a)).slice(0, 90)} != ${String(JSON.stringify(b)).slice(0, 90)}`);
    return out;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) diffPaths(ra[k], rb[k], `${path}.${k}`, out, limit);
  return out;
}

/** Persisted form used for state comparison (fx is transient by contract). */
function normalized(sim: SimState): unknown {
  return clone({ ...sim, fx: [] });
}

function resume(ctx: SimContext): { ctx: SimContext; json: string } {
  ctx.sim.rng = ctx.rng.getState(); // GameApp.checkpointRaid
  const json = serializeSim(ctx.sim);
  const restored = deserializeSim(json);
  return { ctx: makeContext(restored, content, raidGeometry(content, restored)), json };
}

function idCounter(id: string, prefix: string): number | null {
  const m = new RegExp(`^${prefix.replace(/[-]/g, '\\-')}-[a-z]+-([0-9a-z]+)$`).exec(id);
  return m ? parseInt(m[1]!, 36) : null;
}

// --- interior helpers -------------------------------------------------------------------------------------------

function solidAt(ctx: SimContext, x: number, y: number, r: number): boolean {
  return ctx.geo.movementBlockers(x, y, r, 0, ctx.sim).some((o) => {
    const cx = Math.max(o.box.x0, Math.min(x, o.box.x1));
    const cy = Math.max(o.box.y0, Math.min(y, o.box.y1));
    return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
  });
}

/** A walkable, unoccupied standing spot among nav cell centres selected by `accept`, nearest to (cx, cy). */
function standingSpot(ctx: SimContext, nav: NavGrid, rect: { x: number; y: number; w: number; h: number }, accept: (x: number, y: number) => boolean, cx: number, cy: number): { x: number; y: number } | null {
  const cands: { x: number; y: number; d: number }[] = [];
  for (let gy = Math.floor(rect.y / 0.5); gy <= Math.floor((rect.y + rect.h) / 0.5); gy++)
    for (let gx = Math.floor(rect.x / 0.5); gx <= Math.floor((rect.x + rect.w) / 0.5); gx++) {
      if (gx < 0 || gy < 0 || gx >= nav.w || gy >= nav.h) continue;
      const c = nav.center(gx, gy);
      if (!accept(c.x, c.y)) continue;
      cands.push({ ...c, d: Math.hypot(c.x - cx, c.y - cy) });
    }
  cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  for (const c of cands) {
    if (!nav.walkableAt(c.x, c.y) || solidAt(ctx, c.x, c.y, 0.35)) continue;
    if (ctx.sim.actors.some((a) => a.kind !== 'player' && Math.hypot(a.x - c.x, a.y - c.y) < 1.5)) continue;
    return { x: c.x, y: c.y };
  }
  return null;
}

function roundTripAllInteriors(ctx: SimContext, laps: number, ticks: number, onFx?: (fx: SimEvent[]) => void, shootInside = false): { inter: InteriorDef; inside: { x: number; y: number }; outside: { x: number; y: number } }[] {
  const nav = navFor(ctx.geo);
  const pl = player(ctx.sim);
  const map = ctx.geo.map;
  const inAny = (x: number, y: number) => map.interiors.some((i) => rectContains(i.rect, x, y));
  const plan = map.interiors.map((inter) => {
    const r = inter.rect;
    const inside = standingSpot(ctx, nav, r, (x, y) => rectContains(r, x, y), r.x + r.w / 2, r.y + r.h / 2);
    const grown = { x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 };
    const outside = standingSpot(ctx, nav, grown, (x, y) => !inAny(x, y), r.x + r.w / 2, r.y + r.h + 1.5);
    expect(inside, `standing spot inside ${inter.id}`).not.toBeNull();
    expect(outside, `standing spot outside ${inter.id}`).not.toBeNull();
    return { inter, inside: inside!, outside: outside! };
  });
  const stay = (n: number, shoot: boolean) => {
    for (let t = 0; t < n; t++) {
      // One explicit shot per visit (when requested) makes noise so live AI reacts; it is counted like any other shot.
      const fire = shoot && t === 10 ? { firePressed: true, fireHeld: true } : {};
      const fx = step(ctx, aimCmd(pl.x + 5, pl.y, 1.2, fire));
      if (onFx) onFx(fx);
    }
  };
  for (let lap = 0; lap < laps; lap++)
    for (const { inter, inside, outside } of plan) {
      teleport(pl, inside.x, inside.y);
      stay(ticks, shootInside);
      expect(rectContains(inter.rect, pl.x, pl.y), `player inside ${inter.id}`).toBe(true);
      teleport(pl, outside.x, outside.y);
      stay(ticks, false);
      expect(inAny(pl.x, pl.y), `player outside ${inter.id}`).toBe(false);
    }
  return plan;
}

// --- A10 (a) interior round trips ----------------------------------------------------------------------------------

describe('A10 (a) interior round trips never respawn enemies or re-roll containers/ammo', () => {
  it('walking in and out of the farm warehouse 3× (movement commands through the open main door) changes nothing (AI frozen)', () => {
    const ctx = startRaid('a10|walk-warehouse');
    ctx.sim.debug.freezeAI = true;
    ctx.sim.debug.god = true;
    const pl = player(ctx.sim);
    const warehouse = ctx.geo.map.interiors.find((i) => i.id === 'core.interior.farm_warehouse')!;
    const outside = { x: 29.6, y: 72.6 };
    const inside = { x: 29.6, y: 65 };
    teleport(pl, outside.x, outside.y);
    step(ctx, aimCmd(29.6, 60));
    const before = persistentWorld(ctx);
    let ticks = 0;
    for (let lap = 0; lap < 3; lap++) {
      const tIn = walkTo(ctx, inside.x, inside.y);
      expect(tIn, `lap ${lap}: reached the warehouse interior`).toBeGreaterThan(0);
      expect(rectContains(warehouse.rect, pl.x, pl.y)).toBe(true);
      expect(ctx.geo.interiorAt(pl.x, pl.y)?.id).toBe(warehouse.id);
      for (let t = 0; t < 45; t++) step(ctx, aimCmd(pl.x, pl.y - 5));
      const tOut = walkTo(ctx, outside.x, outside.y);
      expect(tOut, `lap ${lap}: walked back out`).toBeGreaterThan(0);
      expect(ctx.geo.interiorAt(pl.x, pl.y)).toBeNull();
      ticks += tIn + tOut + 45;
    }
    expect(ticks).toBeGreaterThan(300); // real walking, not teleports
    expect(ctx.sim.progress.discovered).toContain(warehouse.id);
    expect(persistentWorld(ctx)).toEqual(before);
    expect(validateStore(ctx.sim.store, content)).toEqual([]);
  });

  it.each([
    ['core.map.quarantine_main', MAIN_DEST],
    ['core.map.outer_supply_route', OUTER_DEST],
  ])('teleport round trips through every interior of %s (2 laps) keep the world identical (AI frozen)', (_mapId, dest) => {
    const ctx = startRaid(`a10|sweep|${dest}`, dest);
    ctx.sim.debug.freezeAI = true;
    ctx.sim.debug.god = true;
    step(ctx, aimCmd(0, 0));
    const before = persistentWorld(ctx);
    const tick0 = ctx.sim.tick;
    const plan = roundTripAllInteriors(ctx, 2, 20);
    expect(plan.length).toBe(ctx.geo.map.interiors.length);
    expect(ctx.sim.tick - tick0).toBe(2 * plan.length * 2 * 20);
    for (const { inter } of plan) expect(ctx.sim.progress.discovered).toContain(inter.regionId);
    expect(persistentWorld(ctx)).toEqual(before);
    expect(validateStore(ctx.sim.store, content)).toEqual([]);
  });

  it('with live AI (player invulnerable) round trips never create enemies/items or re-roll containers; ammo only drops by shots fired', () => {
    const ctx = startRaid('a10|live-ai');
    ctx.sim.debug.god = true;
    step(ctx, aimCmd(0, 0));
    const s = ctx.sim;
    const actorIds = s.actors.map((a) => a.id);
    const itemIds = new Set(Object.keys(s.store.items));
    const lootStream = clone(s.rng.loot);
    const worldContainers = clone(
      Object.values(s.containers)
        .filter((c) => c.kind === 'world' || c.kind === 'event')
        .map((c) => ({ id: c.id, searched: c.searched, items: s.store.containers[c.id]!.items.map((id) => ({ id, def: s.store.items[id]!.definitionId, qty: s.store.items[id]!.quantity })) })),
    );
    // Ammo is tracked on each actor's own item instances (they keep their ids even when moved to a corpse).
    const actorItems = new Map(s.actors.map((a) => [a.id, allCarriedItemIds(s, a)]));
    const roundsBefore = new Map([...actorItems].map(([id, ids]) => [id, roundsOf(ctx, ids)]));
    const hpBefore = new Map(s.actors.map((a) => [a.id, a.hp]));
    const shots = new Map<string, number>();
    const count = (fx: SimEvent[]) => {
      for (const e of fx) if (e.t === 'shot') shots.set(e.actorId, (shots.get(e.actorId) ?? 0) + 1);
    };
    const tick0 = s.tick;
    const plan = roundTripAllInteriors(ctx, 2, 150, count, true);
    expect(s.tick - tick0).toBe(2 * plan.length * 2 * 150);
    // No respawns or new spawns, dead stay dead, nobody heals back up.
    expect(s.actors.map((a) => a.id)).toEqual(actorIds);
    for (const a of s.actors) if (a.kind === 'enemy') expect(a.hp, `${a.id} hp`).toBeLessThanOrEqual(hpBefore.get(a.id)!);
    // No new item instances; world containers keep exactly their rolled contents and search state.
    for (const id of Object.keys(s.store.items)) expect(itemIds.has(id), `new item ${id}`).toBe(true);
    const now = Object.values(s.containers)
      .filter((c) => c.kind === 'world' || c.kind === 'event')
      .map((c) => ({ id: c.id, searched: c.searched, items: s.store.containers[c.id]!.items.map((id) => ({ id, def: s.store.items[id]!.definitionId, qty: s.store.items[id]!.quantity })) }));
    expect(clone(now)).toEqual(worldContainers);
    expect(s.rng.loot).toEqual(lootStream);
    // Per-actor ammo conservation: rounds held in the actor's own items only decrease by the shots it fired.
    let enemyShots = 0;
    for (const [id, ids] of actorItems) {
      const fired = shots.get(id) ?? 0;
      if (id !== 'player') enemyShots += fired;
      expect(roundsOf(ctx, ids), `${id} rounds after ${fired} shots`).toBe(roundsBefore.get(id)! - fired);
    }
    expect(shots.get('player') ?? 0).toBeGreaterThan(0);
    expect(enemyShots, 'live AI actually fought during the round trips').toBeGreaterThan(0);
    expect(validateStore(s.store, content)).toEqual([]);
    console.log(`[A10a] live-AI interior sweep: ${s.tick - tick0} ticks over ${plan.length} interiors ×2 laps, player shots ${shots.get('player') ?? 0}, enemy shots ${enemyShots} by ${[...shots.keys()].filter((k) => k !== 'player').length} enemies, enemy deaths ${s.actors.filter((a) => a.kind === 'enemy' && !a.alive).length}`);
  });

  it('entering each interior registers it as discovered (nested interiors included)', () => {
    for (const dest of [MAIN_DEST, OUTER_DEST]) {
      const ctx = startRaid(`a10|discover|${dest}`, dest);
      ctx.sim.debug.freezeAI = true;
      ctx.sim.debug.god = true;
      roundTripAllInteriors(ctx, 1, 5);
      const missing = ctx.geo.map.interiors.map((i) => i.id).filter((id) => !ctx.sim.progress.discovered.includes(id));
      expect(missing, `${ctx.sim.mapId}: interiors entered but never discovered`).toEqual([]);
    }
  });
});

// --- A10 (b) resume determinism ------------------------------------------------------------------------------------

const TOWER_BOX = 'ct:farm_tower_box';

/** Scripted input: movement, shots, reloads, container interaction and inventory ops (ids read from `sim`). */
function script(t: number, sim: SimState): { cmd: PlayerCommand; ops: RaidOp[] } {
  const pl = player(sim);
  const ops: RaidOp[] = [];
  let cmd = aimCmd(60, 80, 1.2);
  if (t < 92) cmd = aimCmd(34, 85, 0.6, { interact: t === 0 });
  if (t === 90) ops.push({ op: 'takeAll' });
  if (t === 91) ops.push({ op: 'closeLoot' });
  if ([100, 115, 130, 250, 262, 274, 340, 360].includes(t)) cmd = { ...cmd, firePressed: true, fireHeld: true };
  if (t >= 140 && t < 200) cmd = { ...cmd, moveX: 1 };
  if (t >= 200 && t < 240) cmd = { ...cmd, moveY: -1 };
  if (t === 205 || t === 400) cmd = { ...cmd, reload: true };
  if (t >= 240 && t < 300) cmd = { ...cmd, moveX: -1 };
  if (t === 300) {
    const band = allCarriedItemIds(sim, pl).map((id) => sim.store.items[id]!).find((it) => it.definitionId === 'core.med.bandage' && it.quantity >= 2);
    const bag = sim.store.containers['eq:player:backpack']!.items[0]!;
    if (band) ops.push({ op: 'split', itemId: band.instanceId, qty: 1, target: { containerId: `bag:${bag}` } });
  }
  if (t === 310) {
    const one = allCarriedItemIds(sim, pl).map((id) => sim.store.items[id]!).filter((it) => it.definitionId === 'core.med.bandage').sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    if (one.length) ops.push({ op: 'drop', itemId: one[one.length - 1]!.instanceId });
  }
  if (t === 320) cmd = { ...cmd, crouchToggle: true };
  if (t >= 320 && t < 400) cmd = { ...cmd, moveY: 1 };
  if (t === 410) cmd = { ...cmd, crouchToggle: true };
  if (t >= 420 && t < 600) {
    cmd = { ...cmd, moveX: Math.sin(t / 20) > 0 ? 1 : -1, sprint: t >= 500 && t < 540 };
    if (t % 45 === 0) cmd = { ...cmd, firePressed: true, fireHeld: true };
  }
  if (t >= 600) {
    const ang = t / 40;
    cmd = aimCmd(pl.x + Math.cos(ang) * 8, pl.y + Math.sin(ang) * 8, 1.2, { firePressed: t % 70 === 0, fireHeld: t % 70 === 0 });
  }
  return { cmd, ops };
}

function enemyAmmoView(sim: SimState): Record<string, { id: string; def: string; chamber: string | null; mag: number | null; tube: number | null; qty: number }[]> {
  const out: Record<string, { id: string; def: string; chamber: string | null; mag: number | null; tube: number | null; qty: number }[]> = {};
  for (const a of sim.actors) {
    if (a.kind !== 'enemy') continue;
    out[a.id] = allCarriedItemIds(sim, a)
      .map((id) => sim.store.items[id]!)
      .filter((it) => it.weapon || it.mag || content.item(it.definitionId).ammo)
      .map((it) => ({ id: it.instanceId, def: it.definitionId, chamber: it.weapon?.chamber ?? null, mag: it.mag ? it.mag.rounds.length : null, tube: it.weapon?.tube ? it.weapon.tube.length : null, qty: it.quantity }))
      .sort((x, y) => x.id.localeCompare(y.id));
  }
  return out;
}

describe('A10 (b) raid resume (checkpoint → serialize → restore) is deterministic and never re-rolls', () => {
  it('original and restored raids stay identical for 600 ticks of scripted play with live AI', () => {
    const N = 240;
    const M = 600;
    const A = startRaid('a10|resume');
    A.sim.debug.god = true;
    const pl = player(A.sim);
    teleport(pl, 34, 86);
    let enemyShotsBefore = 0;
    for (let t = 0; t < N; t++) {
      const { cmd, ops } = script(t, A.sim);
      for (const e of step(A, cmd, ops)) if (e.t === 'shot' && e.actorId !== 'player') enemyShotsBefore++;
    }
    // The container was opened and (partially) searched before the snapshot; loot session closed by the script.
    const boxBefore = clone({ state: A.sim.containers[TOWER_BOX]!, items: A.sim.store.containers[TOWER_BOX]!.items.map((id) => A.sim.store.items[id] ?? null) });
    expect(boxBefore.state.opened).toBe(true);
    expect(boxBefore.state.searched).toBeGreaterThan(0);
    expect(A.sim.loot).toBeNull();
    expect(A.sim.stats.shotsFired).toBe(3);
    const midRaidHazards = jsonHazards({ ...A.sim, fx: [] });

    const snap = resume(A);
    const B = snap.ctx;
    const snapState = JSON.parse(snap.json) as SimState;
    // Immediately after restore: nothing re-rolled or respawned.
    expect(B.sim.containers[TOWER_BOX]).toEqual(boxBefore.state);
    expect(B.sim.store.containers[TOWER_BOX]!.items.map((id) => B.sim.store.items[id] ?? null)).toEqual(boxBefore.items);
    expect(enemyAmmoView(B.sim)).toEqual(clone(enemyAmmoView(A.sim)));
    expect(Object.keys(B.sim.store.items)).toEqual(Object.keys(A.sim.store.items));
    expect(B.sim.actors.map((a) => a.id)).toEqual(A.sim.actors.map((a) => a.id));
    expect(B.sim.ids).toEqual(A.sim.ids);
    expect(B.sim.rng).toEqual(A.sim.rng);
    expect(serializeSim(B.sim)).toBe(snap.json); // restoring is lossless and idempotent

    let checkpoints = 0;
    let enemyShotsAfter = 0;
    for (let t = N; t < N + M; t++) {
      const { cmd, ops } = script(t, A.sim);
      const fxA = step(A, cmd, ops);
      step(B, clone(cmd), clone(ops));
      for (const e of fxA) if (e.t === 'shot' && e.actorId !== 'player') enemyShotsAfter++;
      if ((t + 1 - N) % 60 === 0) {
        const a = normalized(A.sim);
        const b = normalized(B.sim);
        const diff = diffPaths(a, b);
        expect(diff, `divergence at tick ${A.sim.tick}`).toEqual([]);
        checkpoints++;
      }
    }
    expect(checkpoints).toBe(M / 60);
    expect(normalized(B.sim)).toEqual(normalized(A.sim));
    // Mid-raid state (in-flight reload action, noises, projectiles, AI paths) is JSON-safe at snapshot and at the end.
    expect(midRaidHazards).toEqual([]);
    expect(jsonHazards({ ...A.sim, fx: [] })).toEqual([]);
    // The continuation really exercised the systems (player shots/reload/ops and hostile AI).
    expect(A.sim.stats.shotsFired).toBeGreaterThan(3);
    expect(Object.values(A.sim.containers).some((c) => c.kind === 'drop')).toBe(true);
    // Item ids: unique, owned once, and every id allocated after the restore is fresh (no collision with pre-snapshot ids).
    expect(validateStore(B.sim.store, content)).toEqual([]);
    const prefix = snapState.ids.prefix;
    const newIds = Object.keys(B.sim.store.items).filter((id) => !(id in snapState.store.items));
    expect(newIds.length).toBeGreaterThan(0);
    for (const id of newIds) expect(idCounter(id, prefix), `new id ${id}`).toBeGreaterThanOrEqual(snapState.ids.next);
    for (const id of Object.keys(B.sim.store.items)) {
      const n = idCounter(id, prefix);
      if (n !== null) expect(n, id).toBeLessThan(B.sim.ids.next);
    }
    console.log(`[A10b] resume: snapshot at tick ${N}, ${M} ticks continued, ${checkpoints} checkpoints identical; enemy shots before/after snapshot ${enemyShotsBefore}/${enemyShotsAfter}; new item ids after restore: ${newIds.join(',')}`);
  });
});

/** Stand next to a world container (nav cell within reach, clear LOS) and open it. Returns the standing spot. */
function openContainerNearby(ctx: SimContext, cid: string): { x: number; y: number } {
  const sim = ctx.sim;
  const nav = navFor(ctx.geo);
  const wc = sim.containers[cid]!;
  const pl = player(sim);
  const spots: { x: number; y: number; d: number }[] = [];
  for (let gy = Math.floor((wc.y - 2) / 0.5); gy <= Math.floor((wc.y + 2) / 0.5); gy++)
    for (let gx = Math.floor((wc.x - 2) / 0.5); gx <= Math.floor((wc.x + 2) / 0.5); gx++) {
      if (gx < 0 || gy < 0 || gx >= nav.w || gy >= nav.h) continue;
      const c = nav.center(gx, gy);
      const d = Math.hypot(c.x - wc.x, c.y - wc.y);
      if (d >= 0.8 && d <= 1.8 && nav.walkableAt(c.x, c.y) && !solidAt(ctx, c.x, c.y, 0.35)) spots.push({ ...c, d });
    }
  spots.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  for (const s of spots) {
    teleport(pl, s.x, s.y);
    step(ctx, aimCmd(wc.x, wc.y, 0.6, { interact: true }));
    if (sim.loot?.containerId === cid) return { x: s.x, y: s.y };
  }
  throw new Error(`could not open ${cid}`);
}

describe('A10 (b2) a partially searched container resumes its search without re-rolling', () => {
  it('searched count, search progress and item order survive the restore; both copies reveal identical items', () => {
    const A = startRaid('a10|partial-search');
    A.sim.debug.freezeAI = true;
    A.sim.debug.god = true;
    // Largest world container of this raid (deterministic for the seed).
    const cid = Object.values(A.sim.containers)
      .filter((c) => c.kind === 'world' && !c.locked)
      .sort((a, b) => A.sim.store.containers[b.id]!.items.length - A.sim.store.containers[a.id]!.items.length || a.id.localeCompare(b.id))[0]!.id;
    const rolled = clone(A.sim.store.containers[cid]!.items.map((id) => A.sim.store.items[id]!));
    expect(rolled.length).toBeGreaterThanOrEqual(3);
    const spot = openContainerNearby(A, cid);
    while (A.sim.containers[cid]!.searched < 1) step(A, aimCmd(A.sim.containers[cid]!.x, A.sim.containers[cid]!.y, 0.6));
    for (let t = 0; t < 7; t++) step(A, aimCmd(A.sim.containers[cid]!.x, A.sim.containers[cid]!.y, 0.6));
    step(A, aimCmd(0, 0), [{ op: 'closeLoot' }]);
    const wcA = clone(A.sim.containers[cid]!);
    expect(wcA.searched).toBeGreaterThanOrEqual(1);
    expect(wcA.searched).toBeLessThan(rolled.length);
    expect(wcA.searchProgress).toBeGreaterThan(0);

    const { ctx: B } = resume(A);
    expect(B.sim.containers[cid]).toEqual(wcA);
    expect(B.sim.store.containers[cid]!.items.map((id) => B.sim.store.items[id])).toEqual(rolled);
    // Re-open in both copies at the same spot and finish the search.
    for (const X of [A, B]) {
      teleport(player(X.sim), spot.x, spot.y);
      step(X, aimCmd(X.sim.containers[cid]!.x, X.sim.containers[cid]!.y, 0.6, { interact: true }));
      expect(X.sim.loot?.containerId).toBe(cid);
      for (let t = 0; t < 60 * 6 && X.sim.containers[cid]!.searched < rolled.length; t++) step(X, aimCmd(X.sim.containers[cid]!.x, X.sim.containers[cid]!.y, 0.6));
      expect(X.sim.containers[cid]!.searched).toBe(rolled.length);
      expect(clone(X.sim.store.containers[cid]!.items.map((id) => X.sim.store.items[id]))).toEqual(rolled);
    }
    expect(diffPaths(normalized(A.sim), normalized(B.sim))).toEqual([]);
    console.log(`[A10b2] ${cid}: ${rolled.length} items, ${wcA.searched} revealed + ${wcA.searchProgress.toFixed(3)}s progress at snapshot; identical reveal order after resume`);
  });
});

// --- A10 (c) JSON round trip of a fresh raid ----------------------------------------------------------------------

describe('A10 (c) a fresh raid survives the JSON round trip unchanged (no hidden non-serializable state)', () => {
  it.each([
    [MAIN_DEST, 'a10|fresh|1'],
    [MAIN_DEST, 'a10|fresh|2'],
    [OUTER_DEST, 'a10|fresh|3'],
    [OUTER_DEST, 'a10|fresh|4'],
  ])('%s %s', (dest, seed) => {
    const A = startRaid(seed, dest);
    expect(jsonHazards(A.sim)).toEqual([]);
    const { ctx: B, json } = resume(A);
    expect(B.sim).toEqual(A.sim);
    expect(serializeSim(B.sim)).toBe(json);
    // Rebuilt helpers (geometry, nav grid cache, RNG objects) carry no hidden state: both run identically.
    for (let t = 0; t < 300; t++) {
      const cmd = aimCmd(48, 48, 1.2, { moveX: t < 150 ? 1 : 0, moveY: t >= 150 ? -1 : 0, firePressed: t % 50 === 25, fireHeld: t % 50 === 25 });
      step(A, cmd);
      step(B, clone(cmd));
    }
    expect(diffPaths(normalized(A.sim), normalized(B.sim))).toEqual([]);
  });
});
