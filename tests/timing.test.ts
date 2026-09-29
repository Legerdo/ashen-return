import { describe, expect, it } from 'vitest';
import { requestReload } from '../src/combat/reload';
import { createContent } from '../src/content/core';
import { FixedStepClock, SIM_DT } from '../src/core/clock';
import { Rng } from '../src/core/rng';
import { startCraft, tickCrafting } from '../src/economy/crafting';
import { instantiate, placeNew } from '../src/inventory/store';
import { grantItems, newProfile, type ProfileState } from '../src/progression/profile';
import { activeWeaponItem } from '../src/world/context';
import { BLEED_RATE, startMedical } from '../src/world/medical';
import { MOVE, resolveSpeed } from '../src/world/movement';
import { stepSim } from '../src/world/sim';
import { spawnEnemy } from '../src/world/spawn';
import type { ActorState, SimEvent } from '../src/world/state';
import { launchVelocity, predictTrajectory, startThrow, THROW_WINDUP, throwOrigin } from '../src/world/throwables';
import { aimCmd, arena, bagOf, equip, target, tick, world, type TestWorld } from './helpers';

/**
 * A13 — medical, throwables, explosion occlusion, and pause/hidden time consistency.
 * Everything here is advanced either by stepSim (fixed SIM_DT) or through FixedStepClock exactly like App.frame().
 */

const SEC = 60;
const FPS = [30, 60, 144] as const;
/** The App builds a command every step; the player's timed actions only tick inside playerTick, so tests always pass one. */
const idle = aimCmd(20, 6, 1.0);

type Fx<K extends SimEvent['t']> = Extract<SimEvent, { t: K }>;
function fxOf<K extends SimEvent['t']>(t: TestWorld, kind: K): Fx<K>[] {
  return t.ctx.sim.fx.filter((f): f is Fx<K> => f.t === kind);
}

function give(t: TestWorld, defId: string, qty = 1): string {
  const it = instantiate(t.content, t.ctx.sim.ids, defId, { quantity: qty });
  it.quantity = qty;
  const r = placeNew(t.ctx.sim.store, t.content, it, { containerId: bagOf(t) });
  if (!r.ok) throw new Error(`cannot give ${defId}: ${r.error}`);
  return it.instanceId;
}

/** Feed `frames` render frames of `frameDt` real seconds into the clock; returns the simulation steps run. */
function feed(clock: FixedStepClock, frames: number, frameDt: number, step: (dt: number) => void): number {
  let steps = 0;
  for (let i = 0; i < frames; i++) steps += clock.advance(frameDt, step).steps;
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------
// a) Medical
// ---------------------------------------------------------------------------------------------------------------
describe('A13 a) medical timing follows simulation time', () => {
  it('first aid (pool 40, 10 HP/s) cancelled after 2 s: exactly +20 HP and pool 20; a later use spends only the remaining 20', () => {
    const t = world(arena('a13.med.fa', 20, 10));
    t.player.hp = 50;
    const kit = give(t, 'core.med.firstaid');
    expect(startMedical(t.ctx, t.player, kit)).toBe('started');
    expect(t.player.hp).toBe(50); // nothing happens until simulation time passes
    tick(t, idle, 2 * SEC);
    stepSim(t.ctx, { cmd: { ...idle, cancel: true }, ops: [] });
    expect(t.player.action).toBeNull();
    expect(t.player.hp).toBeCloseTo(70, 9);
    expect(t.ctx.sim.store.items[kit]!.medPool).toBeCloseTo(20, 9);
    tick(t, idle, 3 * SEC); // cancelled → no further healing
    expect(t.player.hp).toBeCloseTo(70, 9);
    expect(startMedical(t.ctx, t.player, kit)).toBe('started');
    tick(t, idle, 3 * SEC);
    expect(t.player.hp).toBeCloseTo(90, 9);
    expect(t.ctx.sim.store.items[kit]).toBeUndefined(); // pool spent → kit consumed
    expect(t.ctx.sim.stats.healed).toBeCloseTo(40, 9);
  });

  it('bandage: no effect or consumption before 2.0 s, then bleeding stops on the 120th step and one bandage is used; a cancelled bandage does nothing', () => {
    const t = world(arena('a13.med.bandage', 20, 10));
    t.player.hp = 80;
    t.player.status.bleeding = true;
    const band = give(t, 'core.med.bandage', 3);
    expect(startMedical(t.ctx, t.player, band)).toBe('started');
    tick(t, idle, 2 * SEC - 1);
    expect(t.player.status.bleeding).toBe(true);
    expect(t.ctx.sim.store.items[band]!.quantity).toBe(3);
    tick(t, idle, 1);
    expect(t.player.status.bleeding).toBe(false);
    expect(t.ctx.sim.store.items[band]!.quantity).toBe(2);
    // Bled 0.8 HP/s until the commit (stepSim order: timed actions run before status, so the commit step does not bleed).
    expect(80 - t.player.hp).toBeCloseTo((BLEED_RATE * (2 * SEC - 1)) / SEC, 9);
    const hp = t.player.hp;
    tick(t, idle, 5 * SEC);
    expect(t.player.hp).toBe(hp);
    t.player.status.bleeding = true;
    expect(startMedical(t.ctx, t.player, band)).toBe('started');
    tick(t, idle, 1.5 * SEC);
    stepSim(t.ctx, { cmd: { ...idle, cancel: true }, ops: [] });
    tick(t, idle, SEC);
    expect(t.player.status.bleeding).toBe(true);
    expect(t.ctx.sim.store.items[band]!.quantity).toBe(2);
  });

  it('painkiller: commits after 2 s, lifts the <30 HP pain slow-down for 60 s of simulation time (not wall time), heals nothing', () => {
    const t = world(arena('a13.med.pk', 20, 10));
    t.player.hp = 20;
    const pk = give(t, 'core.med.painkiller', 2);
    const speed = () => resolveSpeed(t.ctx, t.player, { x: 1, y: 0, sprint: false, ads: false }, 0).speed;
    expect(speed()).toBeCloseTo(MOVE.walk * MOVE.painMult, 9);
    expect(startMedical(t.ctx, t.player, pk)).toBe('started');
    tick(t, idle, 2 * SEC - 1);
    expect(t.ctx.sim.store.items[pk]!.quantity).toBe(2);
    tick(t, idle, 1);
    const commit = t.ctx.sim.time;
    expect(t.ctx.sim.store.items[pk]!.quantity).toBe(1);
    expect(t.player.action).toBeNull();
    expect(speed()).toBeCloseTo(MOVE.walk, 9);
    expect(t.player.hp).toBe(20);
    const until = t.player.status.painkillerUntil;
    expect(until - commit).toBeGreaterThan(60 - 2 * SIM_DT);
    expect(until - commit).toBeLessThanOrEqual(60);
    // Two minutes of wall time with the clock paused: the effect's remaining time does not move.
    const clock = new FixedStepClock();
    clock.paused = true;
    expect(feed(clock, 120 * SEC, 1 / SEC, (dt) => stepSim(t.ctx, { cmd: idle, ops: [] }, dt))).toBe(0);
    expect(t.ctx.sim.time).toBe(commit);
    tick(t, idle, 59 * SEC); // 59 s of simulation later: still active
    expect(speed()).toBeCloseTo(MOVE.walk, 9);
    tick(t, idle, 1 * SEC); // past 60 s: the pain penalty is back
    expect(speed()).toBeCloseTo(MOVE.walk * MOVE.painMult, 9);
    expect(t.player.hp).toBe(20);
  });

  it('healing and bleeding depend only on simulation steps: 3 s at 30/60/144 fps equals 180 direct steps, bit for bit', () => {
    const run = (fps: number | null) => {
      const t = world(arena('a13.med.fps', 20, 10));
      t.player.hp = 50;
      t.player.status.bleeding = true;
      const kit = give(t, 'core.med.firstaid');
      startMedical(t.ctx, t.player, kit);
      if (fps === null) tick(t, idle, 3 * SEC);
      else feed(new FixedStepClock(), 3 * fps, 1 / fps, (dt) => stepSim(t.ctx, { cmd: idle, ops: [] }, dt));
      return { tick: t.ctx.sim.tick, hp: t.player.hp, pool: t.ctx.sim.store.items[kit]?.medPool ?? null, healed: t.ctx.sim.stats.healed, elapsed: t.player.action?.elapsed ?? null };
    };
    const direct = run(null);
    expect(direct.tick).toBe(3 * SEC);
    expect(direct.healed).toBeCloseTo(30, 9);
    expect(direct.hp).toBeCloseTo(50 + 30 - BLEED_RATE * 3, 9);
    for (const fps of FPS) expect(run(fps)).toEqual(direct);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// b) Throwables
// ---------------------------------------------------------------------------------------------------------------
describe('A13 b) throwables: one trajectory integrator, simulation-time fuse, occluded blasts', () => {
  it('the HUD-predicted arc is the real grenade path point for point; it bursts 2.8 s of simulation after the release step, at the predicted end point', () => {
    const t = world(arena('a13.throw.arc', 30, 20), 4, 10);
    const nade = give(t, 'core.throw.frag', 2);
    const aim = aimCmd(14, 10, 0);
    tick(t, aim);
    // What App.updateThrowPreview() draws while G is held.
    const origin = throwOrigin(t.player);
    const predicted = predictTrajectory(t.ctx.geo, t.ctx.sim, 0, origin, launchVelocity(origin, { x: t.player.aim.targetX, y: t.player.aim.targetY }, 11), 2.8);
    const startedAt = t.ctx.sim.time;
    expect(startThrow(t.ctx, t.player, nade, { x: t.player.aim.targetX, y: t.player.aim.targetY })).toBe(true);
    const real: { x: number; y: number; z: number }[] = [];
    let releaseTime = -1;
    let boomTick = -1;
    for (let i = 0; i < 6 * SEC && boomTick < 0; i++) {
      const stepStart = t.ctx.sim.time;
      tick(t, aim);
      const g = t.ctx.sim.thrown[0];
      if (g && releaseTime < 0) {
        releaseTime = stepStart;
        expect(g.fuseAt).toBeCloseTo(stepStart + 2.8, 9);
        expect(t.ctx.sim.store.items[nade]!.quantity).toBe(1); // consumed at release, not before
      }
      if (g) real.push({ x: g.x, y: g.y, z: g.z });
      if (fxOf(t, 'explosion').length > 0) boomTick = t.ctx.sim.tick;
    }
    expect(releaseTime - startedAt).toBeCloseTo(THROW_WINDUP - SIM_DT, 9); // released in the step that completes the 0.35 s wind-up
    expect(real.length).toBeGreaterThan(predicted.length / 2);
    for (let k = 0; k < real.length; k++) expect(real[k]).toEqual(predicted[Math.min(k + 1, predicted.length - 1)]);
    expect(boomTick * SIM_DT).toBeCloseTo(releaseTime + 2.8, 9); // the burst step ends exactly at release + fuse
    const boom = fxOf(t, 'explosion')[0]!;
    const end = predicted[predicted.length - 1]!;
    expect([boom.x, boom.y]).toEqual([end.x, end.y]);
  });

  it('frag blast: an open target 2.5u from the burst takes exactly 40, one behind a 3u wall at the same distance takes 0, one at 4.6u takes 0', () => {
    // A long 3u wall parallel to the throw line (y = 10), 1.7–2.1u south of it; it never touches the arc.
    const map = arena('a13.throw.blast', 30, 20, (b) => b.box('core.ob.wall_concrete', 0.5, 7.9, 29.5, 8.3, 3, { id: 'wall' }));
    const t = world(map, 4, 10);
    const nade = give(t, 'core.throw.frag');
    const aim = aimCmd(14, 10, 0);
    tick(t, aim);
    const origin = throwOrigin(t.player);
    const pts = predictTrajectory(t.ctx.geo, t.ctx.sim, 0, origin, launchVelocity(origin, { x: 14, y: 10 }, 11), 2.8);
    const burst = pts[pts.length - 1]!;
    const open = target(t, burst.x, burst.y + 2.5, { hp: 500, id: 'open' });
    const shielded = target(t, burst.x, burst.y - 2.5, { hp: 500, id: 'shielded' });
    const outside = target(t, burst.x + 4.6, burst.y, { hp: 500, id: 'outside' });
    expect(startThrow(t.ctx, t.player, nade, { x: 14, y: 10 })).toBe(true);
    for (let i = 0; i < 5 * SEC && fxOf(t, 'explosion').length === 0; i++) tick(t, aim);
    const boom = fxOf(t, 'explosion')[0]!;
    expect([boom.x, boom.y]).toEqual([burst.x, burst.y]);
    expect(Math.hypot(open.x - boom.x, open.y - boom.y)).toBeCloseTo(2.5, 9);
    expect(Math.hypot(shielded.x - boom.x, shielded.y - boom.y)).toBeCloseTo(2.5, 9);
    expect(500 - open.hp).toBeCloseTo(80 * (1 - (2.5 - 1) / (4 - 1)), 9);
    expect(shielded.hp).toBe(500);
    expect(outside.hp).toBe(500);
    expect(t.player.hp).toBe(100);
  });

  it('the fuse counts simulation time only: same burst tick at 30/60/144 fps, and a 30 s pause or hidden tab freezes the grenade', () => {
    const run = (fps: number, stop: 'paused' | 'hidden' | null) => {
      const t = world(arena('a13.throw.fuse', 30, 20), 4, 10);
      const nade = give(t, 'core.throw.frag');
      t.player.aim.targetX = 14;
      t.player.aim.targetY = 10;
      expect(startThrow(t.ctx, t.player, nade, { x: 14, y: 10 })).toBe(true);
      const clock = new FixedStepClock();
      let boomTick = -1;
      const step = (dt: number) => {
        stepSim(t.ctx, { cmd: aimCmd(14, 10, 0), ops: [] }, dt);
        if (boomTick < 0 && t.ctx.sim.fx.some((f) => f.t === 'explosion')) boomTick = t.ctx.sim.tick;
      };
      feed(clock, fps, 1 / fps, step); // 1 s: the grenade has been released and is live
      expect(t.ctx.sim.thrown.length).toBe(1);
      const frozen = { tick: t.ctx.sim.tick, g: { ...t.ctx.sim.thrown[0]! } };
      if (stop) {
        clock[stop] = true;
        feed(clock, 30 * fps, 1 / fps, step);
        expect({ tick: t.ctx.sim.tick, g: { ...t.ctx.sim.thrown[0]! } }).toEqual(frozen);
        clock[stop] = false;
      }
      for (let i = 0; i < 10 * fps && boomTick < 0; i++) clock.advance(1 / fps, step);
      return boomTick;
    };
    const ref = run(60, null);
    // Wind-up (21 steps) + fuse (168 steps), both counted in simulation steps; the fuse is armed with the start time of the
    // step that completes the wind-up, so the two share that step: 21 + 168 − 1 = 188.
    expect(ref).toBe(Math.round((THROW_WINDUP + 2.8) / SIM_DT) - 1);
    for (const fps of FPS) expect(run(fps, null)).toBe(ref);
    expect(run(60, 'paused')).toBe(ref);
    expect(run(144, 'hidden')).toBe(ref);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// c) Pause / hidden
// ---------------------------------------------------------------------------------------------------------------
describe('A13 c) pause/hidden: no simulation time passes, and resuming does not catch up', () => {
  it('FixedStepClock: paused or hidden → zero steps for any amount of real time; the first frame after a stall is capped', () => {
    for (const flag of ['paused', 'hidden'] as const) {
      const clock = new FixedStepClock();
      let steps = 0;
      const count = (): void => {
        steps++;
      };
      clock.advance(SIM_DT / 2, count); // leave half a step in the accumulator
      const acc0 = clock.accumulator;
      clock[flag] = true;
      expect(clock.running).toBe(false);
      feed(clock, 10_000, 1 / 60, count);
      for (const dt of [0.25, 5, 3600, Infinity, Number.NaN, -1, 0]) expect(clock.advance(dt, count).steps).toBe(0);
      expect(steps).toBe(0);
      expect(clock.tick).toBe(0);
      expect(clock.accumulator).toBe(acc0); // nothing accumulated while stopped
      clock[flag] = false;
      const r = clock.advance(30, count); // e.g. the first rAF delta after returning to the tab
      expect(r.steps).toBe(clock.maxStepsPerAdvance);
      expect(r.steps * SIM_DT).toBeLessThanOrEqual(clock.maxFrameSeconds);
      expect(r.droppedSeconds).toBeGreaterThan(29.5); // dropped, not simulated
      expect(clock.advance(1 / 60, count).steps).toBe(1); // normal cadence right away, no burst
      expect(steps).toBe(clock.maxStepsPerAdvance + 1);
    }
  });

  interface Harness {
    t: TestWorld;
    p: ProfileState;
    enemy: ActorState;
    step: (dt: number) => void;
    snap: () => unknown;
  }

  /**
   * One raid sim with every timer running at once — bleeding, a timed player action (P9 tactical reload or first aid),
   * an enemy's tactical reload (AI action), the extraction countdown and raid time — plus a shelter crafting job driven
   * from the same fixed-step callback (App.step → baseTick → tickCrafting).
   */
  function harness(action: 'reload' | 'firstaid'): Harness {
    const map = arena('a13.harness', 40, 12, (b) => void b.exit({ id: 'x.test', nameKey: 'map.shelter.name', x: 0, y: 0, w: 8, h: 12, condition: { type: 'free' } }));
    const t = world(map, 3, 6);
    t.player.hp = 90;
    t.player.status.bleeding = true;
    const wid = equip(t, 'core.weapon.p9', 'core.ammo.9.fmj', 2);
    const weapon = t.ctx.sim.store.items[wid]!;
    let kit: string | null = null;
    if (action === 'reload') {
      t.ctx.sim.store.items[weapon.weapon!.magazineId!]!.mag!.rounds.splice(5);
      expect(requestReload(t.ctx, t.player, false)).toBe('started');
    } else {
      kit = give(t, 'core.med.firstaid');
      expect(startMedical(t.ctx, t.player, kit)).toBe('started');
    }
    const enemy = spawnEnemy(t.content, t.ctx.sim, 'core.enemy.sentry', 35, 6, Rng.fromSeed('a13-enemy'));
    const ew = activeWeaponItem(t.ctx, enemy)!.item;
    t.ctx.sim.store.items[ew.weapon!.magazineId!]!.mag!.rounds.splice(3);
    expect(requestReload(t.ctx, enemy, false)).toBe('started');
    const p = newProfile(t.content, 1, 'A13', 'a13-profile', 0);
    grantItems(p, t.content, 'core.mat.cloth', 2, 'a13-grant');
    startCraft(p, t.content, 'core.recipe.bandage');
    const step = (dt: number): void => {
      stepSim(t.ctx, { cmd: idle, ops: [] }, dt);
      tickCrafting(p, dt);
    };
    const snap = () => {
      const s = t.ctx.sim;
      const act = t.player.action;
      const eact = enemy.action;
      const mag = weapon.weapon!.magazineId ? s.store.items[weapon.weapon!.magazineId] : undefined;
      return {
        tick: s.tick,
        time: s.time,
        hp: t.player.hp,
        bleeding: t.player.status.bleeding,
        action: act ? { type: act.type, elapsed: act.elapsed, steps: [...act.steps] } : null,
        chamber: weapon.weapon!.chamber,
        magazine: weapon.weapon!.magazineId,
        magRounds: mag?.mag?.rounds.length ?? null,
        medPool: kit ? (s.store.items[kit]?.medPool ?? null) : null,
        exitProgress: s.exits['x.test']?.progress ?? 0,
        craftRemaining: p.crafting.jobs.map((j) => j.remaining),
        enemy: { x: enemy.x, y: enemy.y, mode: enemy.ai!.mode, facing: enemy.ai!.facing, action: eact ? { type: eact.type, elapsed: eact.elapsed, steps: [...eact.steps] } : null },
        rng: JSON.stringify(s.rng),
      };
    };
    return { t, p, enemy, step, snap };
  }

  for (const action of ['reload', 'firstaid'] as const) {
    it(`[${action}] bleeding, ${action}, enemy reload, exit countdown, crafting and raid time: identical after 1 s at 30/60/144 fps`, () => {
      const direct = harness(action);
      for (let i = 0; i < SEC; i++) direct.step(SIM_DT);
      const ref = direct.snap() as { tick: number; time: number; hp: number; exitProgress: number; craftRemaining: number[]; action: { elapsed: number } | null; enemy: { action: { elapsed: number } | null } };
      expect(ref.tick).toBe(SEC);
      expect(ref.time).toBeCloseTo(1, 9);
      expect(ref.exitProgress).toBeCloseTo(1, 9);
      expect(ref.craftRemaining[0]).toBeCloseTo(1, 9);
      expect(ref.action?.elapsed).toBeCloseTo(1, 9);
      expect(ref.enemy.action?.elapsed).toBeCloseTo(1, 9);
      expect(ref.hp).toBeCloseTo(action === 'firstaid' ? 90 + 10 - BLEED_RATE : 90 - BLEED_RATE, 9);
      for (const fps of FPS) {
        const h = harness(action);
        const clock = new FixedStepClock();
        expect(feed(clock, fps, 1 / fps, h.step)).toBe(SEC);
        expect(h.snap()).toEqual(ref);
      }
    });

    it(`[${action}] paused or hidden: 60 s of frames plus one 100 s frame change nothing; resuming advances exactly and caps the first frame`, () => {
      for (const flag of ['paused', 'hidden'] as const) {
        const h = harness(action);
        const clock = new FixedStepClock();
        feed(clock, 30, 1 / 60, h.step); // 0.5 s of play
        const before = h.snap();
        clock[flag] = true;
        expect(feed(clock, 60 * 60, 1 / 60, h.step)).toBe(0);
        expect(clock.advance(100, h.step).steps).toBe(0);
        expect(h.snap()).toEqual(before);
        clock[flag] = false;
        // First frame after the stall: at most maxStepsPerAdvance steps — no burst of bleeding/crafting/extraction.
        const hp0 = h.t.player.hp;
        const craft0 = h.p.crafting.jobs[0]!.remaining;
        const r = clock.advance(30, h.step);
        expect(r.steps).toBe(clock.maxStepsPerAdvance);
        expect(h.t.ctx.sim.tick).toBe(30 + clock.maxStepsPerAdvance);
        expect(h.p.crafting.jobs[0]!.remaining).toBeCloseTo(craft0 - clock.maxStepsPerAdvance * SIM_DT, 9);
        if (action === 'reload') expect(hp0 - h.t.player.hp).toBeCloseTo(BLEED_RATE * clock.maxStepsPerAdvance * SIM_DT, 9);
        // Then it simply continues at 60 steps per simulated second.
        expect(feed(clock, 60, 1 / 60, h.step)).toBe(SEC);
        expect(h.t.ctx.sim.time).toBeCloseTo((30 + clock.maxStepsPerAdvance + SEC) * SIM_DT, 9);
      }
    });
  }

  it('a shelter crafting job completes after 2 s of simulation at any frame rate and never while paused or hidden', () => {
    const content = createContent();
    const run = (fps: number, stop: 'paused' | 'hidden' | null) => {
      const p = newProfile(content, 1, 'A13', 'a13-craft', 0);
      grantItems(p, content, 'core.mat.cloth', 2, 'a13-grant');
      const job = startCraft(p, content, 'core.recipe.bandage');
      const clock = new FixedStepClock();
      let doneStep = -1;
      const step = (dt: number): void => {
        if (tickCrafting(p, dt).includes(job.jobId) && doneStep < 0) doneStep = clock.tick;
      };
      feed(clock, fps, 1 / fps, step); // 1 s of shelter time
      const mid = job.remaining;
      if (stop) {
        clock[stop] = true;
        feed(clock, 60 * fps, 1 / fps, step);
        expect(job.remaining).toBe(mid);
        expect(doneStep).toBe(-1);
        clock[stop] = false;
      }
      for (let i = 0; i < 10 * fps && doneStep < 0; i++) clock.advance(1 / fps, step);
      return { total: job.total, mid, doneStep };
    };
    const ref = run(60, null);
    expect(ref.total).toBe(2);
    expect(ref.mid).toBeCloseTo(1, 9);
    // Never early; the float countdown (remaining -= 1/60) lands on the 120th or, with rounding residue, the 121st step.
    expect(ref.doneStep).toBeGreaterThanOrEqual(2 * SEC);
    expect(ref.doneStep).toBeLessThanOrEqual(2 * SEC + 1);
    for (const fps of FPS) expect(run(fps, null)).toEqual(ref);
    expect(run(60, 'paused')).toEqual(ref);
    expect(run(30, 'hidden')).toEqual(ref);
  });
});
