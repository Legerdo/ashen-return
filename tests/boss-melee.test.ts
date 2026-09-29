import { describe, expect, it } from 'vitest';
import { computeDamage } from '../src/combat/damage';
import { Rng } from '../src/core/rng';
import { instantiate, placeNew } from '../src/inventory/store';
import { CIPHER_MODULE, processDeath } from '../src/world/death';
import { meleeArcRadius, meleeHitRange } from '../src/world/melee';
import { spawnEnemy } from '../src/world/spawn';
import { eqContainerId, pocketContainerId, type ActorState, type AIMode, type SimEvent } from '../src/world/state';
import { aimCmd, arena, target, tick, world, type TestWorld } from './helpers';

/**
 * AI-BOSS and MELEE-THROW behaviour through the real simulation (stepSim → tickAI / combat / throwables / melee).
 * The facility commander is a real spawnEnemy() actor (AR762, 3 real frag grenades, first aid); the player is in
 * debug god mode so the fight can run long enough to observe every phase.
 */

const SEC = 60;
const COMBAT: AIMode[] = ['Combat', 'Cover', 'Flank', 'Reload'];
const VISIBLE = { x: 24, y: 20 }; // in the open, in front of the commander
const HIDDEN = { x: 14, y: 9 }; // behind the 3u concrete wall

function bossArena(id: string) {
  return arena(id, 44, 24, (b) => {
    b.box('core.ob.wall_concrete', 18, 2, 19, 16, 3, { id: 'wall' });
    b.spots('boss_cover', [{ x: 30, y: 12 }]);
    b.spots('boss_flank', [{ x: 30, y: 12 }]);
    b.spots('boss_support', [{ x: 40, y: 3 }, { x: 40, y: 21 }]);
  });
}

function place(a: ActorState, p: { x: number; y: number }): void {
  a.x = a.px = p.x;
  a.y = a.py = p.y;
  a.vx = a.vy = 0;
}

function bossWorld(id: string): { t: TestWorld; boss: ActorState } {
  const t = world(bossArena(id), VISIBLE.x, VISIBLE.y);
  t.ctx.sim.debug.god = true;
  const boss = spawnEnemy(t.content, t.ctx.sim, 'core.enemy.boss', 30, 12, Rng.fromSeed(`boss|${id}`));
  // Harness: hits from its own support squad must not move the HP thresholds under test.
  boss.invulnerable = true;
  const ang = Math.atan2(VISIBLE.y - boss.y, VISIBLE.x - boss.x);
  boss.aim.dirX = Math.cos(ang);
  boss.aim.dirY = Math.sin(ang);
  boss.ai!.facing = ang;
  boss.ai!.nextDecisionAt = 1e9;
  return { t, boss };
}

function engage(t: TestWorld, boss: ActorState): void {
  for (let i = 0; i < 6 * SEC && !COMBAT.includes(boss.ai!.mode); i++) tick(t, null);
  expect(COMBAT, 'commander engages the visible player').toContain(boss.ai!.mode);
}

const supports = (t: TestWorld) => t.ctx.sim.actors.filter((a) => a.archetypeId === 'core.enemy.support');
const fragsCarried = (t: TestWorld, boss: ActorState) =>
  (t.ctx.sim.store.containers[pocketContainerId(boss.id)]?.items ?? []).map((id) => t.ctx.sim.store.items[id]!).filter((it) => it.definitionId === 'core.throw.frag').reduce((s, it) => s + it.quantity, 0);

describe('AI-BOSS facility commander', () => {
  it('phases follow HP (≥60 % → 1, ≥30 % → 2, below → 3); upward transitions call support at most twice in total', () => {
    const { t, boss } = bossWorld('boss.phase');
    expect(boss.ai!.grenadesLeft).toBe(3);
    engage(t, boss);
    expect(boss.ai!.phase).toBe(1);
    const setHp = (f: number) => {
      boss.hp = boss.maxHp * f;
      tick(t, null, 20);
    };
    setHp(0.5);
    expect(boss.ai!.phase).toBe(2);
    expect(supports(t)).toHaveLength(1);
    setHp(0.2);
    expect(boss.ai!.phase).toBe(3);
    expect(supports(t)).toHaveLength(2);
    // Healing back up and dropping again re-enters the phases but never calls a third squad member.
    setHp(0.9);
    expect(boss.ai!.phase).toBe(1);
    setHp(0.5);
    expect(boss.ai!.phase).toBe(2);
    setHp(0.2);
    expect(boss.ai!.phase).toBe(3);
    expect(supports(t)).toHaveLength(2);
    expect(boss.ai!.supportsCalled).toBe(2);
    // The squad spawns at the authored support spots with real, finite loadouts.
    const spots = [{ x: 40, y: 3 }, { x: 40, y: 21 }];
    for (const s of supports(t)) {
      expect(spots.some((p) => Math.hypot(p.x - s.ai!.homeX, p.y - s.ai!.homeY) < 0.01), `${s.id} at a boss_support spot`).toBe(true);
      const armed = (['primary1', 'secondary'] as const).some((slot) => (t.ctx.sim.store.containers[eqContainerId(s.id, slot)]?.items.length ?? 0) === 1);
      expect(armed, `${s.id} carries a real weapon`).toBe(true);
    }
    expect(t.ctx.sim.fx.filter((f) => f.t === 'message' && f.key === 'boss.support')).toHaveLength(2);
  });

  it('targeted grenades: only while the player is out of sight in phase 2, each consumes one carried frag, never more than 3', () => {
    const { t, boss } = bossWorld('boss.grenades');
    expect(fragsCarried(t, boss)).toBe(3);
    engage(t, boss);
    boss.hp = boss.maxHp * 0.5; // phase 2
    const thrown = new Set<string>();
    const run = (ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        tick(t, null);
        for (const th of t.ctx.sim.thrown) if (th.ownerId === boss.id) thrown.add(th.id);
        expect(boss.ai!.grenadesLeft).toBeGreaterThanOrEqual(0);
      }
    };
    run(SEC); // visible: no grenade while the commander can see the target
    expect(thrown.size).toBe(0);
    for (let cycle = 0; cycle < 6; cycle++) {
      place(t.player, VISIBLE);
      run(2 * SEC); // re-sighted
      place(t.player, HIDDEN);
      run(10 * SEC); // out of sight behind the wall
    }
    run(4 * SEC); // let the last fuse burn
    expect(thrown.size, 'at least one targeted grenade').toBeGreaterThanOrEqual(1);
    expect(thrown.size, 'never more than 3').toBeLessThanOrEqual(3);
    expect(fragsCarried(t, boss), 'every throw consumed a real carried grenade').toBe(3 - thrown.size);
    expect(boss.ai!.grenadesLeft).toBe(3 - thrown.size);
    expect(t.ctx.sim.fx.filter((f) => f.t === 'explosion').length).toBe(thrown.size);
  });

  it('every burst is announced by a telegraph and no commander round leaves before the telegraph ends', () => {
    const { t, boss } = bossWorld('boss.telegraph');
    // Record every event with its tick time from the very first tick (engagement included).
    const events: { time: number; e: SimEvent }[] = [];
    let seen = t.ctx.sim.fx.length;
    for (let i = 0; i < 16 * SEC; i++) {
      tick(t, null);
      for (const e of t.ctx.sim.fx.slice(seen)) events.push({ time: t.ctx.sim.time, e });
      seen = t.ctx.sim.fx.length;
    }
    expect(COMBAT).toContain(boss.ai!.mode);
    const teles = events.filter((x) => x.e.t === 'telegraph' && x.e.actorId === boss.id) as { time: number; e: Extract<SimEvent, { t: 'telegraph' }> }[];
    const shots = events.filter((x) => x.e.t === 'shot' && x.e.actorId === boss.id);
    expect(teles.length, 'telegraphs').toBeGreaterThanOrEqual(2);
    expect(shots.length, 'commander shots').toBeGreaterThanOrEqual(3);
    for (const s of shots) {
      const last = [...teles].reverse().find((x) => x.time <= s.time);
      expect(last, `shot at ${s.time.toFixed(3)} s preceded by a telegraph`).toBeTruthy();
      expect(s.time + 1e-9, `shot at ${s.time.toFixed(3)} s not inside the telegraph window`).toBeGreaterThanOrEqual(last!.e.until);
    }
  });

  it('the cipher module is created in the commander corpse exactly once, and only while Q08 is active', () => {
    const { t, boss } = bossWorld('boss.cipher');
    t.ctx.sim.activeQuests = ['core.quest.q08_last_signal'];
    boss.alive = false;
    boss.hp = 0;
    processDeath(t.ctx, boss, 'test');
    processDeath(t.ctx, boss, 'test'); // same deathEventId: no second transfer
    const inCorpse = (w: TestWorld, id: string) => (w.ctx.sim.store.containers[`corpse:${id}`]?.items ?? []).filter((x) => w.ctx.sim.store.items[x]!.definitionId === CIPHER_MODULE);
    expect(inCorpse(t, boss.id)).toHaveLength(1);
    expect(Object.values(t.ctx.sim.store.items).filter((i) => i.definitionId === CIPHER_MODULE)).toHaveLength(1);
    // A second commander in the same raid does not create another module.
    const second = spawnEnemy(t.content, t.ctx.sim, 'core.enemy.boss', 34, 12, Rng.fromSeed('boss|second'));
    second.alive = false;
    processDeath(t.ctx, second, 'test');
    expect(inCorpse(t, second.id)).toHaveLength(0);
    // Free roam (Q08 done / not active): the commander drops only its own gear.
    const { t: t2, boss: b2 } = bossWorld('boss.cipher.none');
    b2.alive = false;
    processDeath(t2.ctx, b2, 'test');
    expect(inCorpse(t2, b2.id)).toHaveLength(0);
    expect(t2.ctx.sim.store.containers[`corpse:${b2.id}`]!.items.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------------ melee

function meleeWorld(id: string, weapon: 'core.melee.knife' | 'core.melee.crowbar', build?: Parameters<typeof arena>[3]): TestWorld {
  const t = world(arena(id, 20, 10, build), 5, 5);
  t.ctx.sim.debug.god = true;
  placeNew(t.ctx.sim.store, t.content, instantiate(t.content, t.ctx.sim.ids, weapon), { containerId: eqContainerId('player', 'melee') });
  return t;
}

const swing = aimCmd(9, 5, 1.0, { melee: true });
const hold = aimCmd(9, 5, 1.0);

describe('MELEE: knife / crowbar through the simulation', () => {
  it('a crowbar swing hits the enemy in front once, at 40 % of its 0.85 s cycle, for the formula damage, costing 14 stamina', () => {
    const t = meleeWorld('melee.hit', 'core.melee.crowbar');
    const e = target(t, 5.9, 5, { hp: 100 });
    tick(t, hold, 2); // face the target
    const st0 = t.player.stamina;
    tick(t, swing);
    expect(t.player.action?.type).toBe('melee');
    expect(t.player.stamina).toBeLessThanOrEqual(st0 - 14 + 1e-6);
    const expected = computeDamage({ baseDamage: 42, ammo: { fleshMult: 1, penetration: 25, armorDamage: 0.5, headMult: 1 }, part: 'body', range: 0, effectiveRange: 1, maxRange: 2, minRangeFactor: 1, penetrationCarry: 1, explicitBuff: 1, armor: null, targetHp: 100 }).actualHpLoss;
    expect(expected).toBe(42);
    tick(t, hold, Math.floor(0.85 * 0.4 * SEC) - 2);
    expect(e.hp, 'not yet at the strike point').toBe(100);
    tick(t, hold, 4);
    expect(e.hp).toBeCloseTo(100 - expected, 9);
    tick(t, hold, SEC);
    expect(e.hp, 'one strike per swing').toBeCloseTo(100 - expected, 9);
    expect(t.player.action).toBeNull();
    expect(t.ctx.sim.fx.filter((f) => f.t === 'melee')).toEqual([{ t: 'melee', actorId: 'player', hit: true, x: t.player.x, y: t.player.y, dirX: t.player.aim.dirX, dirY: t.player.aim.dirY, targetId: e.id }]);
    // Presentation feedback at the struck body: one flesh impact (blood burst + impact sound) per landed swing.
    const flesh = t.ctx.sim.fx.filter((f) => f.t === 'impact' && f.material === 'flesh');
    expect(flesh).toHaveLength(1);
    expect(Math.hypot((flesh[0] as { x: number }).x - e.x, (flesh[0] as { y: number }).y - e.y)).toBeLessThan(0.5);
  });

  it('holding the melee key does not multi-hit: a new swing starts only after the cycle has finished', () => {
    const t = meleeWorld('melee.hold', 'core.melee.crowbar');
    const e = target(t, 5.9, 5, { hp: 300 });
    tick(t, hold, 2);
    tick(t, swing, Math.round(0.85 * SEC) - 3); // key held for almost the whole cycle
    expect(300 - e.hp).toBeCloseTo(42, 9);
    tick(t, hold, 10);
    tick(t, swing);
    tick(t, hold, SEC);
    expect(300 - e.hp).toBeCloseTo(84, 9);
  });

  it('the hit area matches the drawn swing arc: bodies the arc sweeps are hit, up to the arc radius and the ±70° edge', () => {
    const knife = 0.8;
    expect(meleeArcRadius(knife)).toBeCloseTo(1.55, 9);
    expect(meleeHitRange(knife, 0.3, 0.3)).toBeCloseTo(1.7, 9);
    // In front at 1.6u (beyond the old 1.25u limit), and 60° off-axis at 1.3u: both inside the drawn arc.
    for (const [x, y, label] of [
      [5 + 1.6, 5, 'front 1.6u'],
      [5 + 1.3 * Math.cos(Math.PI / 3), 5 + 1.3 * Math.sin(Math.PI / 3), '60° at 1.3u'],
    ] as const) {
      const t = meleeWorld(`melee.arc.${label}`, 'core.melee.knife');
      const e = target(t, x, y, { hp: 100 });
      tick(t, hold, 2);
      tick(t, swing);
      tick(t, hold, SEC);
      expect(e.hp, label).toBeLessThan(100);
    }
  });

  it('the arc hits any visible part of the body it sweeps, not just the body centre (top-down depth); far depth still misses', () => {
    // [target ground offset, aim point, expect hit]. The arc is drawn around the attacker's chest; a target up-and-right
    // whose legs/lower body the arc sweeps over is hit although its centre is 1.77u away (beyond the 1.7u side reach).
    const cases: [number, number, number, number, boolean, string][] = [
      [1.3, -1.2, 9, 1, true, 'north-east, lower body under the arc'],
      [0, -2.0, 5, 1, true, 'north 2.0u, feet under the arc'],
      [0, -2.4, 5, 1, false, 'north 2.4u, beyond the depth slack'],
      [2.1, 0, 9, 5, false, 'east 2.1u, side-on beyond reach'],
    ];
    for (const [dx, dy, ax, ay, hit, label] of cases) {
      const t = meleeWorld(`melee.depth.${label}`, 'core.melee.knife');
      const e = target(t, 5 + dx, 5 + dy, { hp: 100 });
      const aimAt = aimCmd(ax, ay, 1.0);
      tick(t, aimAt, 3);
      tick(t, { ...aimAt, melee: true });
      tick(t, aimAt, SEC);
      if (hit) expect(e.hp, label).toBeLessThan(100);
      else expect(e.hp, label).toBe(100);
    }
  });

  it('no hit through a high wall, outside the 70° cone, beyond reach or on the own team; no swing without stamina', () => {
    const walled = meleeWorld('melee.wall', 'core.melee.knife', (b) => b.box('core.ob.wall_concrete', 5.45, 3, 5.55, 7, 3, { id: 'wall' }));
    const behind = target(walled, 5.95, 5, { hp: 100 });
    tick(walled, hold, 2);
    tick(walled, swing);
    tick(walled, hold, SEC);
    expect(behind.hp, 'wall blocks the swing').toBe(100);

    const side = meleeWorld('melee.cone', 'core.melee.knife');
    const beside = target(side, 5, 5.8, { hp: 100 });
    tick(side, hold, 2);
    tick(side, swing);
    tick(side, hold, SEC);
    expect(beside.hp, 'outside the 70° cone').toBe(100);

    const far = meleeWorld('melee.reach', 'core.melee.knife');
    const distant = target(far, 6.8, 5, { hp: 100 });
    tick(far, hold, 2);
    tick(far, swing);
    tick(far, hold, SEC);
    expect(distant.hp, 'beyond reach').toBe(100);

    const team = meleeWorld('melee.team', 'core.melee.knife');
    const ally = target(team, 5.7, 5, { hp: 100 });
    ally.team = 'player';
    tick(team, hold, 2);
    tick(team, swing);
    tick(team, hold, SEC);
    expect(ally.hp, 'own team').toBe(100);

    const tired = meleeWorld('melee.stamina', 'core.melee.crowbar');
    const foe = target(tired, 5.9, 5, { hp: 100 });
    tick(tired, hold, 2);
    tired.player.stamina = 10; // crowbar needs 14
    tick(tired, swing);
    expect(tired.player.action).toBeNull();
    tick(tired, hold, SEC);
    expect(foe.hp).toBe(100);
  });
});
