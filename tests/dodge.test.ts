import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { updateAim } from '../src/combat/aim';
import { processFire } from '../src/combat/weapons';
import { SIM_DT } from '../src/core/clock';
import { instantiate, placeNew } from '../src/inventory/store';
import { DODGE, dodgeProgress, startDodge } from '../src/world/dodge';
import { startMelee } from '../src/world/melee';
import { createBaseSim } from '../src/world/range';
import { stepSim } from '../src/world/sim';
import { giveLoadedWeapon, spawnEnemy } from '../src/world/spawn';
import { eqContainerId, inIframes, type ActorState, type SimEvent } from '../src/world/state';
import { Rng } from '../src/core/rng';
import { carriedWeightKg, normalLimitKg, weightMoveMult } from '../src/world/movement';
import { Px } from '../src/presentation/pixel';
import { BIRDS, birdSheet, FRAME_COUNT, FRAME_H, FRAME_W, FRAMES, quarterTurn } from '../src/presentation/sprites';
import { aimCmd, arena, bagOf, equip, target, tick, world, type TestWorld } from './helpers';

/** Dodge roll through the real simulation (stepSim → playerTick → dodge / projectiles / throwables / melee). */

const ROLL_TICKS = Math.ceil(DODGE.duration / SIM_DT - 1e-9);
const east = aimCmd(20, 5, 1.1);

/** A hostile, AI-less shooter with a loaded 9 mm pistol. */
function shooter(t: TestWorld, x: number, y: number): ActorState {
  const s = target(t, x, y, { id: 'shooter', hp: 100 });
  giveLoadedWeapon(t.content, t.ctx.sim, eqContainerId(s.id, 'secondary'), 'core.weapon.p9', 'core.ammo.9.fmj', 0, 0, null);
  s.activeSlot = 'secondary';
  return s;
}

/** One exact (no-spread) shot from `s` at a world point, fired inside the coming tick. */
function fireAt(t: TestWorld, s: ActorState, x: number, y: number, z: number): void {
  updateAim(s, { x, y, z, actorId: null });
  s.handling.semiBufferedUntil = -1;
  processFire(t.ctx, s, { held: true, pressed: true }, t.ctx.sim.time, SIM_DT);
}

function settleShots(t: TestWorld, cmd = aimCmd(20, 5, 1.1)): void {
  for (let i = 0; i < 120 && t.ctx.sim.projectiles.length > 0; i++) tick(t, cmd);
}

describe('dodge roll', () => {
  it('covers exactly DODGE.distance along the move input in DODGE.duration, costs stamina, stands up and blocks firing', () => {
    expect(dodgeProgress(DODGE.duration, 3)).toBeCloseTo(3, 12);
    const t = world(arena('dodge.move', 30, 12), 5, 4);
    equip(t, 'core.weapon.p9', 'core.ammo.9.fmj');
    t.player.stance = 'crouch';
    tick(t, east, 2);
    const st0 = t.player.stamina;
    tick(t, { ...east, dodge: true, moveY: 1 });
    expect(t.player.action?.type).toBe('dodge');
    expect(t.player.stance).toBe('stand');
    expect(t.player.stamina).toBeCloseTo(st0 - DODGE.stamina, 9);
    expect(t.ctx.sim.fx.some((f) => f.t === 'dodge' && f.actorId === 'player' && f.dirY === 1)).toBe(true);
    // Holding the trigger and a different move key mid-roll changes nothing: the roll owns movement, no shot leaves.
    tick(t, { ...east, moveX: 1, fireHeld: true, firePressed: true }, ROLL_TICKS - 2);
    expect(t.player.action?.type).toBe('dodge');
    expect(t.ctx.sim.stats.shotsFired).toBe(0);
    tick(t, east);
    expect(t.player.action).toBeNull();
    expect(t.player.x).toBeCloseTo(5, 9);
    expect(t.player.y).toBeCloseTo(4 + DODGE.distance, 6);
  });

  it('with no move input it rolls toward the aim; a wall stops it', () => {
    const t = world(arena('dodge.wall', 30, 12, (b) => b.box('core.ob.wall_concrete', 6.5, 2, 7, 8, 3, { id: 'wall' })), 5, 5);
    tick(t, east, 2);
    tick(t, { ...east, dodge: true });
    tick(t, east, ROLL_TICKS + 2);
    expect(t.player.y).toBeCloseTo(5, 9);
    expect(t.player.x).toBeGreaterThan(6.1);
    expect(t.player.x).toBeLessThanOrEqual(6.5 - t.player.radius + 1e-6);
  });

  it('needs stamina, and waits DODGE.cooldown after a roll before the next', () => {
    const t = world(arena('dodge.stamina', 30, 12), 5, 5);
    tick(t, east, 2);
    t.player.stamina = DODGE.stamina - 1;
    tick(t, { ...east, dodge: true, moveY: 1 });
    expect(t.player.action).toBeNull();
    expect(t.ctx.sim.fx.some((f) => f.t === 'message' && f.key === 'dodge.no_stamina')).toBe(true);
    t.player.stamina = 100;
    tick(t, { ...east, dodge: true, moveY: 1 });
    expect(t.player.action?.type).toBe('dodge');
    tick(t, east, ROLL_TICKS - 1);
    expect(t.player.action).toBeNull();
    tick(t, { ...east, dodge: true, moveY: -1 });
    expect(t.player.action, 'still recovering').toBeNull();
    tick(t, east, Math.ceil(DODGE.cooldown / SIM_DT));
    tick(t, { ...east, dodge: true, moveY: -1 });
    expect(t.player.action?.type).toBe('dodge');
  });

  it('interrupts a bandage but never a melee swing', () => {
    const t = world(arena('dodge.cancel', 30, 12), 5, 5);
    placeNew(t.ctx.sim.store, t.content, instantiate(t.content, t.ctx.sim.ids, 'core.melee.knife'), { containerId: eqContainerId('player', 'melee') });
    tick(t, east, 2);
    t.player.action = { type: 'heal', start: t.ctx.sim.time, duration: 3, elapsed: 0, steps: [] };
    tick(t, { ...east, dodge: true, moveY: 1 });
    expect(t.player.action?.type).toBe('dodge');
    tick(t, east, ROLL_TICKS + Math.ceil(DODGE.cooldown / SIM_DT) + 1);
    expect(startMelee(t.ctx, t.player)).toBe(true);
    expect(startDodge(t.ctx, t.player, 0, 1)).toBe('busy');
    expect(t.player.action?.type).toBe('melee');
  });

  it('bullets pass through during the invulnerability window and hit again once it is over', () => {
    const t = world(arena('dodge.bullet', 40, 12), 10, 5);
    t.ctx.sim.debug.noSpread = true;
    const s = shooter(t, 24, 5);
    tick(t, east, 2);
    // Control: standing still, the shot lands.
    fireAt(t, s, t.player.x, t.player.y, 1.1);
    settleShots(t);
    const afterHit = t.player.hp;
    expect(afterHit).toBeLessThan(100);
    // Roll straight away from the shooter: the body stays on the line of fire, only the i-frames save it.
    tick(t, east, 60);
    tick(t, { ...east, dodge: true, moveX: -1 });
    expect(inIframes(t.ctx.sim, t.player)).toBe(true);
    fireAt(t, s, t.player.x, t.player.y, 1.1);
    settleShots(t, east);
    expect(t.player.hp, 'rolled through the round').toBe(afterHit);
    const log = t.ctx.sim.shotLog[t.ctx.sim.shotLog.length - 1]!;
    expect(log.firstHit).not.toBe('player');
    // After the window: hit again.
    tick(t, east, 30);
    expect(inIframes(t.ctx.sim, t.player)).toBe(false);
    fireAt(t, s, t.player.x, t.player.y, 1.1);
    settleShots(t);
    expect(t.player.hp).toBeLessThan(afterHit);
  });

  it('frag blasts and melee swings inside the window miss; the same blast without a roll hurts', () => {
    const blast = (roll: boolean): number => {
      const t = world(arena(`dodge.frag.${roll}`, 30, 12), 10, 5);
      tick(t, east, 2);
      if (roll) tick(t, { ...east, dodge: true, moveY: 1 });
      t.ctx.sim.thrown.push({ id: 'th-test', ownerId: 'nobody', itemDefId: 'core.throw.frag', x: 10.5, y: 5, z: 0, vx: 0, vy: 0, vz: 0, fuseAt: t.ctx.sim.time, resting: true, floor: 0 });
      tick(t, east, 2);
      return t.player.hp;
    };
    expect(blast(false)).toBeLessThan(100);
    expect(blast(true)).toBe(100);

    // A knife swing timed with the roll: a wall behind the player keeps it in reach, so only the i-frames matter.
    const t = world(arena('dodge.melee', 30, 12, (b) => b.box('core.ob.wall_concrete', 9, 2, 9.69, 8, 3, { id: 'wall' })), 10, 5);
    const foe = target(t, 10.9, 5, { id: 'knifer', hp: 100 });
    placeNew(t.ctx.sim.store, t.content, instantiate(t.content, t.ctx.sim.ids, 'core.melee.knife'), { containerId: eqContainerId(foe.id, 'melee') });
    tick(t, east, 2);
    expect(startMelee(t.ctx, foe)).toBe(true);
    tick(t, { ...east, dodge: true, moveX: -1 });
    tick(t, east, 40);
    expect(t.ctx.sim.fx.filter((f) => f.t === 'melee' && f.actorId === foe.id).map((f) => (f as { hit: boolean }).hit)).toEqual([false]);
    expect(t.player.hp).toBe(100);
    expect(startMelee(t.ctx, foe)).toBe(true);
    tick(t, east, 40);
    expect(t.player.hp, 'the next swing lands').toBeLessThan(100);
  });

  it('a heavy load shortens the roll like it slows walking', () => {
    const t = world(arena('dodge.heavy', 30, 12), 5, 4);
    // 7 × 10 scrap = 35 kg in the bag: over the 25 kg normal limit.
    for (let i = 0; i < 7; i++) {
      const st = instantiate(t.content, t.ctx.sim.ids, 'core.mat.scrap', { quantity: 10 });
      st.quantity = 10;
      expect(placeNew(t.ctx.sim.store, t.content, st, { containerId: bagOf(t) }).ok).toBe(true);
    }
    const kg = carriedWeightKg(t.ctx, t.player);
    const mult = weightMoveMult(kg, normalLimitKg(t.ctx, t.player));
    expect(mult).toBeLessThan(0.8);
    tick(t, east, 2);
    tick(t, { ...east, dodge: true, moveY: 1 });
    tick(t, east, ROLL_TICKS);
    expect(t.player.y - 4).toBeCloseTo(DODGE.distance * mult, 6);
  });

  it('is free in the shelter (training sim), with the same movement', () => {
    const ctx = createBaseSim(createContent(), { seed: 'dodge', flags: {}, perks: {}, extraObstacles: [] });
    const p = ctx.sim.actors.find((a) => a.kind === 'player')!;
    const y0 = p.y;
    stepSim(ctx, { cmd: { ...aimCmd(p.x, p.y + 5, 1), dodge: true, moveY: 1 }, ops: [] }, SIM_DT);
    expect(p.action?.type).toBe('dodge');
    for (let i = 0; i < ROLL_TICKS; i++) stepSim(ctx, { cmd: aimCmd(p.x, p.y + 5, 1), ops: [] }, SIM_DT);
    expect(p.stamina).toBe(p.staminaMax);
    expect(p.y - y0).toBeGreaterThan(2.5);
  });
});

describe('dodge roll presentation frames', () => {
  it('the four tumble frames are lossless quarter turns of the crouched frame, kept inside the frame', () => {
    const opaque = (p: Px, fx: number) => {
      let n = 0;
      for (let y = 0; y < FRAME_H; y++) for (let x = 0; x < FRAME_W; x++) if (p.data[(y * p.w + fx * FRAME_W + x) * 4 + 3]! > 0) n++;
      return n;
    };
    for (const b of BIRDS) {
      const sheet = birdSheet(b);
      expect(sheet.w).toBe(FRAME_W * FRAME_COUNT);
      const n = opaque(sheet, FRAMES.crouch0);
      for (const f of [FRAMES.roll0, FRAMES.roll1, FRAMES.roll2, FRAMES.roll3]) expect(opaque(sheet, f), `${b.id} frame ${f}`).toBe(n);
    }
    const one = new Px(FRAME_W, FRAME_H);
    one.set(20, 30, 0xff0000);
    const back = quarterTurn(quarterTurn(quarterTurn(quarterTurn(one, 1), 1), 1), 1);
    expect(Array.from(back.data)).toEqual(Array.from(one.data));
  });
});

// ------------------------------------------------------------------------------------------------ AI rolls

const SEC = 60;

/** Player (god mode, endless 5.56) facing one live-AI enemy in the open; the enemy itself is invulnerable. */
function duel(id: string, archetypeId: string): { t: TestWorld; e: ActorState } {
  const t = world(arena(id, 44, 24), 6, 12);
  t.ctx.sim.debug.god = true;
  t.ctx.sim.debug.infiniteAmmo = true;
  t.ctx.sim.debug.noSpread = true;
  equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj', 2);
  const e = spawnEnemy(t.content, t.ctx.sim, archetypeId, 22, 12, Rng.fromSeed(`dodge|${id}`), { mode: 'Investigate', investigate: { x: 6, y: 12 } });
  e.invulnerable = true;
  return { t, e };
}

const aimAtFoe = (e: ActorState, fire: boolean) => aimCmd(e.x, e.y, 1.1, fire ? { fireHeld: true, firePressed: true } : {});

function rollsOf(t: TestWorld, e: ActorState): Extract<SimEvent, { t: 'dodge' }>[] {
  return t.ctx.sim.fx.filter((f): f is Extract<SimEvent, { t: 'dodge' }> => f.t === 'dodge' && f.actorId === e.id);
}

describe('boss / elite evasive rolls (AI)', () => {
  it('the elite never rolls unprovoked, rolls sideways out of sustained fire, and keeps the per-archetype cooldown', () => {
    const { t, e } = duel('dodge.ai.elite', 'core.enemy.elite');
    const spec = t.content.enemy('core.enemy.elite').dodge!;
    for (let i = 0; i < 4 * SEC; i++) tick(t, aimAtFoe(e, false));
    expect(rollsOf(t, e), 'no roll while nobody shoots at it').toEqual([]);
    const times: number[] = [];
    for (let i = 0; i < 20 * SEC; i++) {
      const before = rollsOf(t, e).length;
      // Trigger held and re-pressed every tick: a steady stream of rounds at the enemy (infinite ammo, no spread).
      tick(t, aimAtFoe(e, true));
      if (rollsOf(t, e).length > before) times.push(t.ctx.sim.time);
    }
    const rolls = rollsOf(t, e);
    expect(rolls.length, 'rolled out of the line of fire at least once').toBeGreaterThanOrEqual(1);
    for (const r of rolls) {
      // Perpendicular to the line of fire (player → enemy at the moment of the roll).
      const lx = r.x - t.player.x;
      const ly = r.y - t.player.y;
      const l = Math.hypot(lx, ly);
      expect(Math.abs((r.dirX * lx + r.dirY * ly) / l), 'sideways roll').toBeLessThan(0.35);
    }
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, 'cooldown between rolls').toBeGreaterThanOrEqual(spec.cooldown - 1e-6);
    console.info(`[dodge] elite: ${rolls.length} rolls in 20 s of fire at t=${times.map((x) => x.toFixed(2)).join(', ')}; shots ${t.ctx.sim.stats.shotsFired}`);
  });

  it('the facility commander rolls too; archetypes without `dodge` never do', () => {
    const { t, e } = duel('dodge.ai.boss', 'core.enemy.boss');
    for (let i = 0; i < 20 * SEC; i++) tick(t, aimAtFoe(e, true));
    expect(rollsOf(t, e).length).toBeGreaterThanOrEqual(1);
    for (const arch of ['core.enemy.sentry', 'core.enemy.flanker', 'core.enemy.rusher', 'core.enemy.support']) {
      const d = duel(`dodge.ai.none.${arch}`, arch);
      for (let i = 0; i < 8 * SEC; i++) tick(d.t, aimAtFoe(d.e, true));
      expect(rollsOf(d.t, d.e), arch).toEqual([]);
    }
  });
});
