import { describe, expect, it } from 'vitest';
import { canSee, visionRange } from '../src/ai/senses';
import { updateAim } from '../src/combat/aim';
import { totalRounds } from '../src/combat/reload';
import { processFire, roundsInWeapon, weaponStats } from '../src/combat/weapons';
import type { MapDef } from '../src/content/mapTypes';
import { SIM_DT } from '../src/core/clock';
import { Rng } from '../src/core/rng';
import { attachChild, instantiate } from '../src/inventory/store';
import type { PlayerCommand } from '../src/world/command';
import { activeWeaponItem, allCarriedItemIds } from '../src/world/context';
import { toggleDoor } from '../src/world/interact';
import { spawnEnemy } from '../src/world/spawn';
import type { ActorState, AIMode, SimEvent } from '../src/world/state';
import { aimCmd, arena, equip, settle, tick, world, type TestWorld } from './helpers';

/**
 * A08 — AI vision / hearing / cover / reload; no exact tracking through walls; no infinite ammo.
 * Every enemy is a real spawnEnemy() actor (finite, seeded loadout) driven by the real tickAI inside stepSim.
 */

const SEC = 60; // simulation ticks per second (fixed 60 Hz)
const COMBAT_MODES: AIMode[] = ['Combat', 'Cover', 'Flank', 'Reload'];

type Fx<K extends SimEvent['t']> = Extract<SimEvent, { t: K }>;
function fxOf<K extends SimEvent['t']>(t: TestWorld, kind: K, from = 0): Fx<K>[] {
  return t.ctx.sim.fx.slice(from).filter((f): f is Fx<K> => f.t === kind);
}

/** Real enemy with a finite loadout rolled from a fixed seed (the AI itself uses the sim's own seeded 'enemy' stream). */
function spawn(t: TestWorld, archetypeId: string, x: number, y: number, seed = 'a08-3'): ActorState {
  return spawnEnemy(t.content, t.ctx.sim, archetypeId, x, y, Rng.fromSeed(seed));
}

/** Look at (x, y) and keep that facing while Idle (Idle only re-rolls its facing when nextDecisionAt passes). */
function face(e: ActorState, x: number, y: number): void {
  const ang = Math.atan2(y - e.y, x - e.x);
  e.aim.dirX = Math.cos(ang);
  e.aim.dirY = Math.sin(ang);
  e.ai!.facing = ang;
  e.ai!.nextDecisionAt = 1e9;
}

function sees(t: TestWorld, e: ActorState): boolean {
  return canSee(t.ctx, e, t.player, t.content.enemy(e.archetypeId!).behavior).visible;
}

/** Ticks (player idle) until the enemy is in Combat; -1 if it never gets there within maxTicks. */
function ticksToCombat(t: TestWorld, e: ActorState, maxTicks: number): number {
  for (let i = 1; i <= maxTicks; i++) {
    tick(t, null);
    if (e.ai!.mode === 'Combat') return i;
  }
  return -1;
}

function shotsBy(t: TestWorld, e: ActorState, from = 0): number {
  return fxOf(t, 'shot', from).filter((s) => s.actorId === e.id).length;
}

/** Every round of a caliber the actor owns: chamber/tube + magazines (inserted or carried) + loose stacks + anything it dropped. */
function roundsHeld(t: TestWorld, a: ActorState, caliber: string): number {
  const dropped = Object.values(t.ctx.sim.containers)
    .filter((c) => c.kind === 'drop')
    .flatMap((c) => t.ctx.sim.store.containers[c.id]?.items ?? []);
  return totalRounds(t.ctx, [...new Set([...allCarriedItemIds(t.ctx.sim, a), ...dropped])], caliber);
}

/** Pellet log entries fired by an actor (shot ids are `<prefix>-shot-<actorId>-<n>`). */
function pelletsOf(t: TestWorld, a: ActorState) {
  return t.ctx.sim.shotLog.filter((l) => l.shotId.includes(`-shot-${a.id}-`));
}

function fitSuppressor(t: TestWorld, weaponId: string): void {
  const s = instantiate(t.content, t.ctx.sim.ids, 'core.att.suppressor');
  t.ctx.sim.store.items[s.instanceId] = s;
  attachChild(t.ctx.sim.store, weaponId, s.instanceId, { attachment: 'muzzle' });
}

/** senses.hear(): estimate = source + gaussish()·err on each axis, gaussish ∈ [-3, 3], err = 0.8 + 0.15·distance. */
const hearErr = (d: number): number => 0.8 + 0.15 * d;

// ---------------------------------------------------------------------------------------------------------------
// a) Vision
// ---------------------------------------------------------------------------------------------------------------
describe('A08 a) vision: high walls block sight; darkness and posture behind low cover change detection', () => {
  // Enemy at (5,5) looks east at the player 10u away: inside the 100° FOV and the 18u Day/Clear range.
  const walled = arena('a08.vision.wall', 30, 10, (b) => b.box('core.ob.wall_concrete', 9.5, 0, 10.5, 10, 3, { id: 'wall' }));
  const open = arena('a08.vision.open', 30, 10);
  const sandbag = arena('a08.vision.sandbag', 30, 10, (b) => b.box('core.ob.sandbag', 14.2, 3.5, 14.6, 6.5, 1.15, { id: 'sb' }));

  function watcher(map: MapDef, px: number, opts: { phase?: 'Day' | 'Night'; crouch?: boolean } = {}) {
    const t = world(map, px, 5);
    t.ctx.sim.env.phase = opts.phase ?? 'Day';
    if (opts.crouch) t.player.stance = 'crouch';
    const e = spawn(t, 'core.enemy.sentry', 5, 5);
    face(e, px, 5);
    return { t, e };
  }

  it('a 3u concrete wall hides the player at 10u in daylight: no sight, no suspicion, no detection for 6 s', () => {
    const { t, e } = watcher(walled, 15);
    for (let i = 0; i < 6 * SEC; i++) {
      expect(sees(t, e)).toBe(false);
      tick(t, null);
    }
    expect(e.ai!.mode).toBe('Idle');
    expect(e.ai!.detection).toBe(0);
    expect(e.ai!.targetId).toBeNull();
    expect(e.ai!.lastSeenTime).toBe(-99);
    // It looked straight at the player the whole time: the wall, not the view cone, hid the player.
    expect(e.aim.dirX).toBeCloseTo(1, 9);
  });

  it('the same layout without the wall is detected within a bounded confirm time (0.35 s < t <= 1.0 s)', () => {
    const { t, e } = watcher(open, 15);
    expect(sees(t, e)).toBe(true);
    const n = ticksToCombat(t, e, 3 * SEC);
    expect(n).toBeGreaterThan(0.35 * SEC);
    expect(n).toBeLessThanOrEqual(1.0 * SEC);
    expect(e.ai!.targetId).toBe('player');
    expect([e.ai!.lastSeenX, e.ai!.lastSeenY]).toEqual([15, 5]);
  });

  it('Night cuts the vision range (18u -> 10.8u without lights): detected at 12u by Day, never by Night; slower at 10u', () => {
    const run = (phase: 'Day' | 'Night', px: number) => {
      const { t, e } = watcher(open, px, { phase });
      const range = visionRange(t.ctx, t.content.enemy('core.enemy.sentry').behavior, t.player);
      return { range, ticks: ticksToCombat(t, e, 6 * SEC) };
    };
    const day12 = run('Day', 17);
    const night12 = run('Night', 17);
    const day10 = run('Day', 15);
    const night10 = run('Night', 15);
    expect(day12.range).toBeCloseTo(18, 9);
    expect(night12.range).toBeCloseTo(18 * 0.6, 9);
    expect(day12.ticks).toBeGreaterThan(0);
    expect(night12.ticks).toBe(-1);
    expect(day10.ticks).toBeGreaterThan(0);
    expect(night10.ticks).toBeGreaterThan(day10.ticks);
  });

  it('crouched behind 1.15u sandbags the player is never detected; standing there the head shows and is detected, slower than in the open', () => {
    const inOpen = watcher(open, 15);
    const openTicks = ticksToCombat(inOpen.t, inOpen.e, 6 * SEC);
    const standing = watcher(sandbag, 15);
    const standTicks = ticksToCombat(standing.t, standing.e, 6 * SEC);
    const crouched = watcher(sandbag, 15, { crouch: true });
    for (let i = 0; i < 6 * SEC; i++) {
      expect(sees(crouched.t, crouched.e)).toBe(false);
      tick(crouched.t, null);
    }
    expect(crouched.e.ai!.mode).toBe('Idle');
    expect(crouched.e.ai!.detection).toBe(0);
    expect(openTicks).toBeGreaterThan(0);
    expect(standTicks).toBeGreaterThan(openTicks);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// b) Hearing
// ---------------------------------------------------------------------------------------------------------------
describe('A08 b) hearing: NoiseEvents give approximate positions; walls and suppressors shrink the radius', () => {
  it('a gunshot behind a concrete wall sends blind idle enemies to Investigate a nearby but never exact point', () => {
    const map = arena('a08.hear.wall', 40, 12, (b) => b.box('core.ob.wall_concrete', 12, 0, 13, 12, 3, { id: 'wall' }));
    const t = world(map, 5, 6);
    equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj');
    const listeners = [16, 20, 25, 30, 35].map((x, i) => {
      const e = spawn(t, 'core.enemy.sentry', x, 3 + i * 1.5, `a08-h${i}`);
      face(e, 40, e.y);
      return e;
    });
    tick(t, aimCmd(1, 6, 1.0)); // shoot west, away from everybody (so the impact noise stays far from the listeners)
    const fx0 = t.ctx.sim.fx.length;
    tick(t, aimCmd(1, 6, 1.0, { firePressed: true, fireHeld: true }));
    const shot = fxOf(t, 'shot', fx0)[0]!; // the gunshot NoiseEvent is emitted at the muzzle
    const points = new Set<string>();
    for (const e of listeners) {
      const ai = e.ai!;
      expect(sees(t, e)).toBe(false);
      expect(ai.detection).toBe(0);
      expect(ai.mode).toBe('Investigate');
      const err = hearErr(Math.hypot(e.x - shot.x, e.y - shot.y));
      const ex = ai.investigateX - shot.x;
      const ey = ai.investigateY - shot.y;
      expect(Math.abs(ex)).toBeLessThanOrEqual(3 * err); // near …
      expect(Math.abs(ey)).toBeLessThanOrEqual(3 * err);
      expect(Math.hypot(ex, ey)).toBeGreaterThan(0.05); // … but not the exact muzzle position
      expect(Math.hypot(ai.investigateX - t.player.x, ai.investigateY - t.player.y)).toBeGreaterThan(0.05); // nor the shooter's
      expect([ai.lastHeardX, ai.lastHeardY]).toEqual([ai.investigateX, ai.investigateY]);
      points.add(`${ai.investigateX}|${ai.investigateY}`);
    }
    expect(points.size).toBe(listeners.length); // independent error per listener
  });

  it('each sound-blocking wall scales the gunshot radius by 0.55 (AR556 at 20u: heard through 1 wall, not through 2)', () => {
    const run = (walls: number): AIMode => {
      const map = arena(`a08.hear.occ${walls}`, 40, 12, (b) => {
        b.box('core.ob.wall_concrete', 10, 0, 10.5, 12, 3, { id: 'w1' });
        if (walls > 1) b.box('core.ob.wall_concrete', 18, 0, 18.5, 12, 3, { id: 'w2' });
      });
      const t = world(map, 5, 6);
      equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj');
      const e = spawn(t, 'core.enemy.sentry', 24.05, 6); // exactly 20u from the muzzle at x = 5 − 0.95
      face(e, 39, 6);
      tick(t, aimCmd(1, 6, 1.0));
      tick(t, aimCmd(1, 6, 1.0, { firePressed: true, fireHeld: true }));
      return e.ai!.mode;
    };
    expect(run(1)).toBe('Investigate'); // 60 × 0.55  = 33u    > 20u
    expect(run(2)).toBe('Idle'); //        60 × 0.55² = 18.15u < 20u
  });

  it('a fitted suppressor (×0.55): an enemy 46u away hears the bare AR556 (60u) but not the suppressed one (33u)', () => {
    const run = (suppressed: boolean) => {
      const t = world(arena('a08.hear.sup', 60, 12), 5, 6);
      const wid = equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj');
      if (suppressed) fitSuppressor(t, wid);
      const stats = weaponStats(t.ctx, t.ctx.sim.store.items[wid]!, null);
      const e = spawn(t, 'core.enemy.sentry', 50.05, 6);
      face(e, 59, 6);
      tick(t, aimCmd(1, 6, 1.0));
      const at = { x: e.x, y: e.y }; // listener position when the shot is fired
      const fx0 = t.ctx.sim.fx.length;
      tick(t, aimCmd(1, 6, 1.0, { firePressed: true, fireHeld: true }));
      const shot = fxOf(t, 'shot', fx0)[0]!;
      const dist = Math.hypot(at.x - shot.x, at.y - shot.y);
      const modeAfterShot = e.ai!.mode;
      tick(t, aimCmd(1, 6, 1.0), 2 * SEC);
      return { radius: stats.noiseRadius, flag: shot.suppressed, dist, modeAfterShot, modeLater: e.ai!.mode, heardAt: e.ai!.lastHeardTime };
    };
    const bare = run(false);
    const sup = run(true);
    expect(bare.radius).toBe(60);
    expect(sup.radius).toBeCloseTo(33, 9);
    expect([bare.flag, sup.flag]).toEqual([false, true]);
    expect(bare.dist).toBeCloseTo(46, 6); // between the suppressed (33u) and the bare (60u) radius
    expect(sup.dist).toBeCloseTo(46, 6);
    expect(bare.modeAfterShot).toBe('Investigate');
    expect(sup.modeAfterShot).toBe('Idle');
    expect(sup.modeLater).toBe('Idle');
    expect(sup.heardAt).toBe(-99);
  });

  it("the suppressor only affects gunshots: the suppressed player's footsteps and bullet impacts are still heard", () => {
    // Footsteps: walk up behind an idle enemy that looks the other way.
    const ts = world(arena('a08.hear.steps', 30, 12), 3, 6);
    fitSuppressor(ts, equip(ts, 'core.weapon.ar556', 'core.ammo.556.fmj'));
    const walker = spawn(ts, 'core.enemy.sentry', 10, 6);
    face(walker, 29, 6);
    for (let i = 0; i < 3 * SEC && walker.ai!.mode === 'Idle'; i++) tick(ts, aimCmd(20, 6, 1.0, { moveX: 1 }));
    expect(fxOf(ts, 'footstep').filter((f) => f.actorId === 'player').length).toBeGreaterThan(0);
    expect(walker.ai!.mode).toBe('Suspicious');
    expect(walker.ai!.detection).toBe(0); // it heard the player before it ever saw them
    expect(walker.ai!.lastSeenTime).toBe(-99);
    expect(Math.hypot(walker.x - ts.player.x, walker.y - ts.player.y)).toBeGreaterThan(1.8);

    // Impact: the suppressed shot (33u) is out of earshot, the bullet's impact on sandbags 3.5u from the guard is not.
    const ti = world(arena('a08.hear.impact', 60, 20, (b) => b.box('core.ob.sandbag', 40, 3, 41, 9, 3, { id: 'tgt' })), 3, 6);
    ti.ctx.sim.debug.noSpread = true;
    fitSuppressor(ti, equip(ti, 'core.weapon.ar556', 'core.ammo.556.fmj'));
    const guard = spawn(ti, 'core.enemy.sentry', 37.5, 8.5);
    face(guard, 59, 8.5);
    tick(ti, aimCmd(40, 6, 1.0));
    const fx0 = ti.ctx.sim.fx.length;
    tick(ti, aimCmd(40, 6, 1.0, { firePressed: true, fireHeld: true }));
    const shot = fxOf(ti, 'shot', fx0)[0]!;
    expect(Math.hypot(guard.x - shot.x, guard.y - shot.y)).toBeGreaterThan(33);
    expect(guard.ai!.mode).toBe('Idle'); // the suppressed gunshot itself was not heard
    settle(ti, 120, aimCmd(40, 6, 1.0));
    tick(ti, aimCmd(40, 6, 1.0), 2);
    const impact = fxOf(ti, 'impact')[0]!;
    expect(Math.hypot(guard.x - impact.x, guard.y - impact.y)).toBeLessThan(5);
    expect(guard.ai!.mode).toBe('Suspicious'); // tag 'impact' → Suspicious (a gunshot would give Investigate)
  });

  it('a noise made on a sound-blocking surface is not muffled by that same surface for a listener on the open side', () => {
    // (1) Bullet impact on the shooter-side face of a target block; listener 3.5u away on the same side (impact radius 5u).
    const impactHeard = (profile: string): boolean => {
      const t = world(arena(`a08.selfocc.${profile}`, 60, 20, (b) => b.box(profile, 40, 3, 41, 9, 3, { id: 'tgt' })), 3, 6);
      t.ctx.sim.debug.noSpread = true;
      fitSuppressor(t, equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj'));
      const e = spawn(t, 'core.enemy.sentry', 37.5, 8.5);
      face(e, 59, 8.5);
      tick(t, aimCmd(40, 6, 1.0));
      tick(t, aimCmd(40, 6, 1.0, { firePressed: true, fireHeld: true }));
      settle(t, 120, aimCmd(40, 6, 1.0));
      tick(t, aimCmd(40, 6, 1.0), 2);
      return e.ai!.mode !== 'Idle';
    };
    // (2) The player closes a free-standing door leaf; listener 4.1u away in the open (door radius 6u).
    const doorHeard = (profile: string): boolean => {
      const t = world(arena(`a08.selfocc.door.${profile}`, 40, 12, (b) => void b.door('d1', 20, 4, 20.2, 8, profile, 2.3)), 26, 6);
      t.ctx.sim.doors['d1'] = { open: true, locked: false };
      const e = spawn(t, 'core.enemy.sentry', 16, 6);
      face(e, 1, 6);
      tick(t, null);
      toggleDoor(t.ctx, t.player, 'd1'); // the same call interact() makes
      expect(t.ctx.sim.doors['d1']!.open).toBe(false);
      tick(t, null);
      return e.ai!.mode !== 'Idle';
    };
    expect({
      impactOnSandbag: impactHeard('core.ob.sandbag'),
      impactOnConcrete: impactHeard('core.ob.wall_concrete'),
      woodDoorClosing: doorHeard('core.ob.door_wood'),
      metalDoorClosing: doorHeard('core.ob.door_metal'),
    }).toEqual({ impactOnSandbag: true, impactOnConcrete: true, woodDoorClosing: true, metalDoorClosing: true });
  });

  it('a spotter shares only a local, approximate alert: an ally within 12u investigates near the sighting, one beyond 12u is not told', () => {
    const t = world(arena('a08.share', 40, 24), 15, 5);
    t.player.hp = t.player.maxHp = 1e5;
    const spotter = spawn(t, 'core.enemy.sentry', 5, 5, 'a08-s1');
    face(spotter, 15, 5);
    const near = spawn(t, 'core.enemy.sentry', 5, 12, 'a08-s2'); // 7u from the spotter, looking away
    face(near, 0, 12);
    const far = spawn(t, 'core.enemy.sentry', 5, 18.5, 'a08-s3'); // 13.5u from the spotter, looking away
    face(far, 0, 18.5);
    for (let i = 0; i < 4 * SEC && near.ai!.mode === 'Idle'; i++) tick(t, null);
    expect(COMBAT_MODES).toContain(spotter.ai!.mode);
    expect(near.ai!.mode).toBe('Investigate');
    expect(near.ai!.detection).toBe(0); // it was told, it did not see
    expect(near.ai!.lastSeenTime).toBe(-99);
    const dx = near.ai!.investigateX - spotter.ai!.lastSeenX;
    const dy = near.ai!.investigateY - spotter.ai!.lastSeenY;
    expect(Math.abs(dx)).toBeLessThanOrEqual(6); // lastSeen ± gaussish·2
    expect(Math.abs(dy)).toBeLessThanOrEqual(6);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0.01);
    expect(Math.hypot(near.ai!.investigateX - t.player.x, near.ai!.investigateY - t.player.y)).toBeGreaterThan(0.01);
    expect(far.ai!.mode).toBe('Idle');
    expect(far.ai!.lastHeardTime).toBe(-99);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// c) Finite ammo and reloads through the player's fire/reload pipeline
// ---------------------------------------------------------------------------------------------------------------
interface DrainRun {
  weapon: string;
  r0: number;
  shots: number;
  finalRounds: number;
  conservationBreaks: string[];
  reloadStarts: { type: string; inWeapon: number }[];
  reloadSteps: Set<string>;
  sawOwnProjectile: boolean;
  exhaustedTick: number;
  shotsAfterDry: number;
  alertsAfterDry: number;
  durability: number;
  playerHpLost: number;
  projectileHpLoss: number;
  enemyAlive: boolean;
}

const drainCache = new Map<string, DrainRun>();

/** Enemy vs a visible, practically unkillable player in an empty arena until it has fired everything, then 10 s more. */
function drain(archetypeId: string, seed: string, opts: { debugInfiniteAmmo?: boolean } = {}): DrainRun {
  const key = `${archetypeId}|${seed}|${!!opts.debugInfiniteAmmo}`;
  const cached = drainCache.get(key);
  if (cached) return cached;
  const t = world(arena(`a08.ammo.${archetypeId}`, 40, 12), 16, 6);
  t.player.hp = t.player.maxHp = 1e6;
  if (opts.debugInfiniteAmmo) t.ctx.sim.debug.infiniteAmmo = true; // documented as a player-only developer cheat
  const e = spawn(t, archetypeId, 6, 6, seed);
  face(e, 16, 6);
  const w = activeWeaponItem(t.ctx, e)!;
  const cal = w.def.weapon!.caliber;
  const r0 = roundsHeld(t, e, cal);
  const run: DrainRun = {
    weapon: w.def.id,
    r0,
    shots: 0,
    finalRounds: r0,
    conservationBreaks: [],
    reloadStarts: [],
    reloadSteps: new Set(),
    sawOwnProjectile: false,
    exhaustedTick: -1,
    shotsAfterDry: 0,
    alertsAfterDry: 0,
    durability: 0,
    playerHpLost: 0,
    projectileHpLoss: 0,
    enemyAlive: true,
  };
  let cursor = 0;
  let lastAction: object | null = null;
  for (let i = 0; i < 120 * SEC; i++) {
    tick(t, null);
    const fx = t.ctx.sim.fx;
    for (; cursor < fx.length; cursor++) {
      const f = fx[cursor]!;
      if (f.t === 'shot' && f.actorId === e.id) {
        run.shots++;
        if (run.exhaustedTick >= 0) run.shotsAfterDry++;
      } else if (f.t === 'reload' && f.actorId === e.id) run.reloadSteps.add(f.step);
      else if (f.t === 'alert' && f.actorId === e.id && run.exhaustedTick >= 0) run.alertsAfterDry++;
    }
    const act = e.action;
    if (act && act !== lastAction && (act.type === 'reload' || act.type === 'tubeReload' || act.type === 'refillMag')) {
      run.reloadStarts.push({ type: act.type, inWeapon: roundsInWeapon(t.ctx, w.item) });
    }
    lastAction = act;
    if (t.ctx.sim.projectiles.some((p) => p.ownerId === e.id && p.team === 'hostile')) run.sawOwnProjectile = true;
    const held = roundsHeld(t, e, cal);
    if (held !== r0 - run.shots) run.conservationBreaks.push(`tick ${t.ctx.sim.tick}: held ${held} != ${r0} - ${run.shots}`);
    if (run.exhaustedTick < 0 && held === 0) run.exhaustedTick = t.ctx.sim.tick;
    if (run.exhaustedTick >= 0 && t.ctx.sim.tick - run.exhaustedTick >= 10 * SEC) break;
  }
  settle(t);
  run.finalRounds = roundsHeld(t, e, cal);
  run.durability = w.item.durability ?? -1;
  run.playerHpLost = 1e6 - t.player.hp;
  run.projectileHpLoss = pelletsOf(t, e)
    .filter((l) => l.firstHit === 'actor:player')
    .reduce((s, l) => s + l.actualHPLoss, 0);
  run.enemyAlive = e.alive;
  drainCache.set(key, run);
  return run;
}

describe('A08 c) finite ammo: real projectiles, exact round accounting, reloads, nothing after the last round', () => {
  const cases = [
    { name: 'sentry P9 (magazines + loose-round refill)', arch: 'core.enemy.sentry', seed: 'a08-3', weapon: 'core.weapon.p9', reloads: ['refillMag', 'reload'], steps: ['magOut', 'magIn', 'chamber'], projectileOnlyDamage: true },
    { name: 'rusher SG-P (tube + loose shells)', arch: 'core.enemy.rusher', seed: 'a08-4', weapon: 'core.weapon.sgp', reloads: ['tubeReload'], steps: ['open', 'shell', 'close'], projectileOnlyDamage: false },
  ] as const;
  for (const c of cases) {
    it(`${c.name}: fires exactly its loadout, reloads only when empty, then never fires again`, () => {
      const r = drain(c.arch, c.seed);
      expect(r.weapon).toBe(c.weapon);
      expect(r.r0).toBeGreaterThan(0);
      expect(r.sawOwnProjectile).toBe(true); // real ProjectileState owned by the enemy
      expect(r.conservationBreaks).toEqual([]); // rounds held == initial − rounds fired, on every tick
      expect(r.shots).toBe(r.r0); // the whole finite loadout …
      expect(r.finalRounds).toBe(0);
      expect(r.exhaustedTick).toBeGreaterThan(0);
      expect(r.shotsAfterDry).toBe(0); // … and not a single round more in the following 10 s
      expect(r.reloadStarts.length).toBeGreaterThanOrEqual(1);
      expect(r.reloadStarts.every((s) => s.inWeapon === 0)).toBe(true); // reloads begin when the gun is empty
      expect([...new Set(r.reloadStarts.map((s) => s.type))].sort()).toEqual([...c.reloads]);
      for (const s of c.steps) expect(r.reloadSteps.has(s)).toBe(true);
      expect(r.durability).toBeCloseTo(100 - 0.05 * r.shots, 6); // same per-shot wear as the player's guns
      expect(r.enemyAlive).toBe(true);
      if (c.projectileOnlyDamage) {
        expect(r.playerHpLost).toBeGreaterThan(0);
        expect(r.playerHpLost).toBeCloseTo(r.projectileHpLoss, 6); // every HP point came from a resolved projectile hit
      }
    });
  }

  it('support AR556 with the debug infinite-ammo flag on: the flag is player-only, the enemy still runs dry', () => {
    const r = drain('core.enemy.support', 'a08-4', { debugInfiniteAmmo: true });
    expect(r.weapon).toBe('core.weapon.ar556');
    expect(r.conservationBreaks).toEqual([]);
    expect(r.shots).toBe(r.r0);
    expect(r.finalRounds).toBe(0);
    expect(r.shotsAfterDry).toBe(0);
    expect(r.reloadStarts.filter((s) => s.type === 'reload').length).toBeGreaterThanOrEqual(2);
    expect(r.reloadStarts.every((s) => s.inWeapon === 0)).toBe(true);
    expect(r.playerHpLost).toBeGreaterThan(0);
    expect(r.playerHpLost).toBeCloseTo(r.projectileHpLoss, 6);
  });

  it('after running dry the enemy settles instead of re-entering Combat (and re-alerting) every tick', () => {
    const r = drain('core.enemy.sentry', 'a08-3');
    expect(r.exhaustedTick).toBeGreaterThan(0);
    // Tolerates up to one fresh alert per second for a design that legitimately re-engages; forbids per-tick thrashing.
    expect(r.alertsAfterDry).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// d) No wall-hack   e) Enemy shots obey ballistics
// ---------------------------------------------------------------------------------------------------------------
/** Closed concrete room x 20..32 × y 2..18 with an unglazed window in the west wall (y 8..12, open between z 0.6 and 2.1). */
function bunker(): MapDef {
  return arena('a08.bunker', 40, 20, (b) => {
    b.box('core.ob.wall_concrete', 20, 2, 32, 2.5, 3, { id: 'room-n' });
    b.box('core.ob.wall_concrete', 20, 17.5, 32, 18, 3, { id: 'room-s' });
    b.box('core.ob.wall_concrete', 31.5, 2, 32, 18, 3, { id: 'room-e' });
    b.box('core.ob.wall_concrete', 20, 2, 20.5, 8, 3, { id: 'room-w1' });
    b.box('core.ob.wall_concrete', 20, 12, 20.5, 18, 3, { id: 'room-w2' });
    b.box('core.ob.wall_concrete', 20, 8, 20.5, 12, 0.6, { id: 'room-sill' }); // cannot be walked through …
    b.box('core.ob.wall_concrete', 20, 8, 20.5, 12, 3, { id: 'room-lintel', z0: 2.1 }); // … but can be seen and shot through
  });
}

interface Sample {
  tick: number;
  seen: boolean;
  px: number;
  py: number;
  hp: number;
  mode: AIMode;
  lsX: number;
  lsY: number;
  aimX: number;
  aimY: number;
  enemyShots: number;
}

interface BunkerRun {
  e: ActorState;
  engagedShots: number;
  samples: Sample[];
  lastVisibleTick: number;
  hiddenShot: { x: number; y: number; heardX: number; heardY: number; heardAt: number; shotTime: number; enemyX: number; enemyY: number };
  search: { mode: AIMode; investigateX: number; investigateY: number; px: number; py: number };
}

let bunkerCache: BunkerRun | null = null;

/**
 * The support sees the player through the window and opens fire; the player steps behind the solid wall, keeps moving
 * inside the room (never visible again), fires one AR556 round into the far wall (heard, not seen) and walks on until
 * the enemy's 4 s memory runs out and it switches to Search.
 */
function runBunker(): BunkerRun {
  if (bunkerCache) return bunkerCache;
  const t = world(bunker(), 23, 10);
  t.player.hp = t.player.maxHp = 1e5;
  equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj');
  const e = spawn(t, 'core.enemy.support', 8, 10, 'a08-4');
  face(e, 23, 10);
  const samples: Sample[] = [];
  let enemyShots = 0;
  let cursor = 0;
  const step = (cmd: PlayerCommand): void => {
    tick(t, cmd);
    for (const fx = t.ctx.sim.fx; cursor < fx.length; cursor++) {
      const f = fx[cursor]!;
      if (f.t === 'shot' && f.actorId === e.id) enemyShots++;
    }
    const ai = e.ai!;
    samples.push({ tick: t.ctx.sim.tick, seen: sees(t, e), px: t.player.x, py: t.player.y, hp: t.player.hp, mode: ai.mode, lsX: ai.lastSeenX, lsY: ai.lastSeenY, aimX: e.aim.targetX, aimY: e.aim.targetY, enemyShots });
  };
  // 1) Engagement through the window.
  for (let i = 0; i < 6 * SEC && (e.ai!.mode !== 'Combat' || enemyShots < 4); i++) step(aimCmd(30, 10, 1));
  const engagedShots = enemyShots;
  // 2) Step north behind the solid wall section, 3) keep moving east inside the room.
  while (t.player.y > 4.5) step(aimCmd(t.player.x, t.player.y - 3, 1, { moveY: -1 }));
  while (t.player.x < 29) step(aimCmd(t.player.x + 3, t.player.y, 1, { moveX: 1 }));
  // 4) One round into the east wall: heard through the wall, never seen.
  for (let i = 0; i < 6; i++) step(aimCmd(34, t.player.y, 1));
  const fx0 = t.ctx.sim.fx.length;
  const shotTime = t.ctx.sim.time;
  step(aimCmd(34, t.player.y, 1, { firePressed: true, fireHeld: true }));
  const pshot = fxOf(t, 'shot', fx0).find((s) => s.actorId === 'player')!;
  const hiddenShot = { x: pshot.x, y: pshot.y, heardX: e.ai!.lastHeardX, heardY: e.ai!.lastHeardY, heardAt: e.ai!.lastHeardTime, shotTime, enemyX: e.x, enemyY: e.y };
  // 5) Walk back west until the enemy's memory runs out.
  for (let i = 0; i < 6 * SEC && e.ai!.mode !== 'Search'; i++) step(aimCmd(t.player.x - 3, t.player.y, 1, { moveX: t.player.x > 23 ? -1 : 0 }));
  const lastVisibleTick = Math.max(-1, ...samples.filter((s) => s.seen).map((s) => s.tick));
  bunkerCache = {
    e,
    engagedShots,
    samples,
    lastVisibleTick,
    hiddenShot,
    search: { mode: e.ai!.mode, investigateX: e.ai!.investigateX, investigateY: e.ai!.investigateY, px: t.player.x, py: t.player.y },
  };
  return bunkerCache;
}

describe('A08 d) no wall-hack: out of sight, the enemy only knows the last sighting / approximate noises', () => {
  it('behind the wall the enemy keeps the last sighting; its memory, aim and search point never follow the moving player', () => {
    const r = runBunker();
    expect(r.engagedShots).toBeGreaterThanOrEqual(1); // it really was engaging through the window
    expect(r.lastVisibleTick).toBeGreaterThan(0);
    const lastSeen = r.samples.find((s) => s.tick === r.lastVisibleTick)!;
    const hidden = r.samples.filter((s) => s.tick > r.lastVisibleTick);
    expect(hidden.length).toBeGreaterThan(3 * SEC);
    // Vision gave the exact position while the player was visible …
    expect([hidden[0]!.lsX, hidden[0]!.lsY]).toEqual([lastSeen.px, lastSeen.py]);
    let travelled = 0;
    for (let i = 0; i < hidden.length; i++) {
      const s = hidden[i]!;
      expect(s.seen).toBe(false);
      // … and after that nothing: the remembered position and the aim point are frozen at the last sighting.
      expect([s.lsX, s.lsY]).toEqual([lastSeen.px, lastSeen.py]);
      if (COMBAT_MODES.includes(s.mode)) expect([s.aimX, s.aimY]).toEqual([lastSeen.px, lastSeen.py]);
      if (i > 0) travelled += Math.hypot(s.px - hidden[i - 1]!.px, s.py - hidden[i - 1]!.py);
    }
    expect(travelled).toBeGreaterThan(8);
    const end = hidden[hidden.length - 1]!;
    expect(Math.hypot(end.px - lastSeen.px, end.py - lastSeen.py)).toBeGreaterThan(4);
    // The hidden gunshot was heard (same tick) as an approximate point — near, never exact.
    const h = r.hiddenShot;
    expect(h.heardAt).toBeCloseTo(h.shotTime, 9);
    const err = hearErr(Math.hypot(h.enemyX - h.x, h.enemyY - h.y));
    expect(Math.abs(h.heardX - h.x)).toBeLessThanOrEqual(3 * err);
    expect(Math.abs(h.heardY - h.y)).toBeLessThanOrEqual(3 * err);
    expect(Math.hypot(h.heardX - h.x, h.heardY - h.y)).toBeGreaterThan(0.05);
    // Memory ran out: Search is seeded at the last sighting, not at the player's true position.
    expect(r.search.mode).toBe('Search');
    expect([r.search.investigateX, r.search.investigateY]).toEqual([lastSeen.px, lastSeen.py]);
    expect(Math.hypot(r.search.px - lastSeen.px, r.search.py - lastSeen.py)).toBeGreaterThan(4);
  });

  it("rounds fired through a vision-blocking wooden wall never hand the enemy the shooter's exact position as the shooter moves", () => {
    const map = arena('a08.memory.wood', 30, 12, (b) => b.box('core.ob.wall_wood', 10, 0, 10.2, 12, 3, { id: 'wood' }));
    const t = world(map, 5, 6);
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj');
    const e = spawn(t, 'core.enemy.sentry', 15, 6);
    e.hp = e.maxHp = 1e4;
    face(e, 29, 6);
    const leaks: string[] = [];
    let n = 0;
    for (const py of [6, 4.5, 7.5]) {
      while (Math.abs(t.player.y - py) > 0.025) tick(t, aimCmd(e.x, e.y, 1.0, { moveY: Math.sign(py - t.player.y) }, e.id));
      tick(t, aimCmd(e.x, e.y, 1.0, {}, e.id), 12);
      const hits0 = fxOf(t, 'hit').filter((f) => f.actorId === e.id).length;
      const sx = t.player.x;
      const sy = t.player.y;
      tick(t, aimCmd(e.x, e.y, 1.0, { firePressed: true, fireHeld: true }, e.id));
      settle(t, 120, aimCmd(e.x, e.y, 1.0, {}, e.id));
      n++;
      expect(fxOf(t, 'hit').filter((f) => f.actorId === e.id).length).toBe(hits0 + 1); // the round went through the wood
      expect(sees(t, e)).toBe(false);
      const ai = e.ai!;
      const memory: Record<string, [number, number]> = {
        lastHeard: [ai.lastHeardX, ai.lastHeardY],
        investigate: [ai.investigateX, ai.investigateY],
        lastSeen: [ai.lastSeenX, ai.lastSeenY],
        goal: [ai.goalX, ai.goalY],
      };
      for (const [k, [x, y]] of Object.entries(memory)) {
        if (Math.hypot(x - sx, y - sy) < 0.05) leaks.push(`shot ${n}: ai.${k} = (${x.toFixed(3)}, ${y.toFixed(3)}) = shooter's exact position (${sx.toFixed(3)}, ${sy.toFixed(3)})`);
      }
    }
    expect(e.ai!.lastSeenTime).toBe(-99); // it never saw the shooter
    expect(leaks).toEqual([]);
  });
});

describe('A08 e) enemy shots obey ballistics: a high wall stops them all', () => {
  it('shots fired through the enemy fire pipeline at the last known position behind a 3u wall all stop at the wall', () => {
    const map = arena('a08.ballistics.wall', 30, 12, (b) => b.box('core.ob.wall_concrete', 10, 0, 11, 12, 3, { id: 'wall' }));
    const t = world(map, 16, 6);
    const e = spawn(t, 'core.enemy.support', 5, 6, 'a08-4');
    t.ctx.sim.debug.freezeAI = true; // we pull the trigger ourselves, with the very call brain.act() makes
    const r0 = roundsHeld(t, e, '556');
    const hp0 = t.player.hp;
    let sawProjectile = false;
    for (let i = 0; i < 0.5 * SEC; i++) {
      updateAim(e, { x: t.player.x, y: t.player.y, z: 1.2, actorId: null }); // exact last known position
      processFire(t.ctx, e, { held: true, pressed: i === 0 }, t.ctx.sim.time, SIM_DT);
      if (t.ctx.sim.projectiles.some((p) => p.ownerId === e.id)) sawProjectile = true;
      tick(t, null);
    }
    settle(t);
    const shots = shotsBy(t, e);
    const pellets = pelletsOf(t, e);
    expect(sawProjectile).toBe(true);
    expect(shots).toBeGreaterThanOrEqual(5);
    expect(pellets.length).toBe(shots);
    expect([...new Set(pellets.map((l) => l.firstHit))]).toEqual(['obstacle:wall']);
    expect(t.player.hp).toBe(hp0);
    expect(fxOf(t, 'hit').filter((h) => h.actorId === 'player')).toEqual([]);
    expect(roundsHeld(t, e, '556')).toBe(r0 - shots); // blocked rounds are still spent
  });

  it('with its own brain the enemy fires nothing blind and lands nothing once the player is behind the wall', () => {
    const r = runBunker();
    expect(r.engagedShots).toBeGreaterThanOrEqual(1); // real projectiles while it could see the player …
    const atHide = r.samples.find((s) => s.tick === r.lastVisibleTick)!;
    expect(atHide.hp).toBeLessThan(1e5); // … and some of them hit, so the HP check below is not vacuous
    const hidden = r.samples.filter((s) => s.tick > r.lastVisibleTick);
    expect(hidden[hidden.length - 1]!.enemyShots - atHide.enemyShots).toBe(0); // it may, but does not, fire at the last known position
    // After in-flight rounds (fired while visible) have resolved, the player's HP never changes again.
    const settled = hidden.filter((s) => s.tick > r.lastVisibleTick + SEC / 2);
    expect(settled.length).toBeGreaterThan(2 * SEC);
    expect(new Set(settled.map((s) => s.hp)).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// f) Cover
// ---------------------------------------------------------------------------------------------------------------
describe('A08 f) cover: shielded positions chosen from real ballistic checks', () => {
  const withSandbags = (id: string) => arena(id, 40, 20, (b) => b.box('core.ob.sandbag', 12, 12, 12.6, 14.5, 1.15, { id: 'sb' }));

  it('under fire, a sentry takes a shielded, peekable spot behind nearby sandbags, crouches there, and the sandbags stop the incoming rounds', () => {
    const t = world(withSandbags('a08.cover.sentry'), 25, 10);
    t.player.hp = t.player.maxHp = 1e5;
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj', 6);
    const e = spawn(t, 'core.enemy.sentry', 10, 10);
    e.hp = e.maxHp = 1e4;
    face(e, 25, 10);
    const beh = t.content.enemy('core.enemy.sentry').behavior;
    // The player keeps up aimed fire at the enemy's head height (one round every 0.5 s) for the whole test.
    let i = 0;
    const fire = (): void => {
      tick(t, aimCmd(e.x, e.y, 1.0, i % 30 === 0 ? { firePressed: true, fireHeld: true } : {}, e.id));
      i++;
    };
    while (i < 4 * SEC && e.ai!.coverX === null) fire();
    expect(e.ai!.mode).toBe('Combat');
    expect(e.hp).toBeLessThan(1e4); // it is being hit in the open
    const cover = { x: e.ai!.coverX!, y: e.ai!.coverY! };
    const threat = { x: t.player.x, y: t.player.y };
    // Chosen within the search radius of where it stood (it may have moved one tick toward the spot already).
    expect(Math.hypot(cover.x - e.x, cover.y - e.y)).toBeLessThanOrEqual(beh.coverSeekRadius + 0.1);
    expect(t.ctx.geo.projectileClear(t.ctx.sim, { ...threat, z: 1.25 }, { ...cover, z: 0.8 }, 0)).toBe(false); // shielded
    expect(t.ctx.geo.projectileClear(t.ctx.sim, { ...threat, z: 1.3 }, { ...cover, z: 1.55 }, 0)).toBe(true); // can peek over
    const deadline = i + 4 * SEC;
    while (i < deadline && !(Math.hypot(e.x - cover.x, e.y - cover.y) < 0.6 && e.stance === 'crouch')) fire();
    expect(Math.hypot(e.x - cover.x, e.y - cover.y)).toBeLessThan(0.6);
    expect(e.stance).toBe('crouch');
    // Pinned: 2 s of aimed fire at the crouched enemy all ends in the sandbags.
    const log0 = t.ctx.sim.shotLog.length;
    const hp0 = e.hp;
    for (let k = 0; k < 2 * SEC; k++) fire();
    settle(t, 60, aimCmd(e.x, e.y, 1.0, {}, e.id));
    const mine = t.ctx.sim.shotLog.slice(log0).filter((l) => l.shotId.includes('-shot-player-'));
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(mine.map((l) => l.firstHit))]).toEqual(['obstacle:sb']);
    expect(e.hp).toBe(hp0);
  });

  it('an emptied flanker reloads behind cover: Reload mode picks a shielded spot, runs there and crouches while reloading', () => {
    const t = world(withSandbags('a08.cover.reload'), 24, 10);
    t.player.hp = t.player.maxHp = 1e5;
    const e = spawn(t, 'core.enemy.flanker', 10, 10);
    face(e, 24, 10);
    const w = activeWeaponItem(t.ctx, e)!;
    w.item.weapon!.chamber = null; // it has just fired its last chambered round; spare magazines are still carried
    t.ctx.sim.store.items[w.item.weapon!.magazineId!]!.mag!.rounds = [];
    let reloadingInCover = 0;
    let shieldedChecks = 0;
    for (let k = 0; k < 6 * SEC; k++) {
      tick(t, null);
      const ai = e.ai!;
      if (ai.mode !== 'Reload' || ai.coverX === null) continue;
      expect(t.ctx.geo.projectileClear(t.ctx.sim, { x: t.player.x, y: t.player.y, z: 1.25 }, { x: ai.coverX, y: ai.coverY!, z: 0.8 }, 0)).toBe(false);
      shieldedChecks++;
      if (Math.hypot(e.x - ai.coverX, e.y - ai.coverY!) < 0.6 && e.stance === 'crouch' && e.action?.type === 'reload') reloadingInCover++;
    }
    expect(shieldedChecks).toBeGreaterThan(0);
    expect(reloadingInCover).toBeGreaterThan(SEC / 4);
    expect(w.item.weapon!.chamber).not.toBeNull(); // the reload completed
  });

  it('with no cover candidate in reach the sentry holds the spot where it engaged as its "cover"', () => {
    const t = world(arena('a08.cover.none', 40, 20), 25, 10);
    t.player.hp = t.player.maxHp = 1e5;
    const e = spawn(t, 'core.enemy.sentry', 10, 10);
    face(e, 25, 10);
    for (let k = 0; k < 4 * SEC && e.ai!.coverX === null; k++) tick(t, null);
    expect(COMBAT_MODES).toContain(e.ai!.mode);
    expect([e.ai!.coverX, e.ai!.coverY]).toEqual([e.x, e.y]); // findCover found nothing → falls back to where it stands
    const hold = { x: e.x, y: e.y };
    for (let k = 0; k < SEC; k++) {
      tick(t, null);
      expect(Math.hypot(e.x - hold.x, e.y - hold.y)).toBeLessThan(0.6);
    }
  });
});
