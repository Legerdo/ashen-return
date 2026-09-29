import { describe, expect, it } from 'vitest';
import { requestReload, standardAmmoFor, totalRounds } from '../src/combat/reload';
import { createContent } from '../src/content/core';
import { SIM_DT } from '../src/core/clock';
import { destroyItem, instantiate, placeNew, validateStore } from '../src/inventory/store';
import { activeWeaponItem, allCarriedItemIds, carriedContainerIds, type SimContext } from '../src/world/context';
import { startMelee } from '../src/world/melee';
import { createBaseSim, profileTrainingLoadout, setRangeWeapon } from '../src/world/range';
import { newProfile } from '../src/progression/profile';
import { equipProfileItem } from '../src/progression/actions';
import { stepSim } from '../src/world/sim';
import { spawnEnemy } from '../src/world/spawn';
import { eqContainerId } from '../src/world/state';
import { Rng } from '../src/core/rng';
import { aimCmd, arena, bagOf, tick, world, type TestWorld } from './helpers';

const map = arena('test.reload.training', 30, 10);
const idle = aimCmd(20, 5, 1.0);

/** P9 with `inMag` rounds in its magazine (+ optional chamber round). */
function p9(t: TestWorld, chamber: boolean, inMag: number): string {
  const w = instantiate(t.content, t.ctx.sim.ids, 'core.weapon.p9');
  placeNew(t.ctx.sim.store, t.content, w, { containerId: eqContainerId('player', 'secondary') });
  t.player.activeSlot = 'secondary';
  const m = instantiate(t.content, t.ctx.sim.ids, 'core.mag.p9');
  m.mag!.rounds = Array.from({ length: inMag }, () => 'core.ammo.9.fmj');
  t.ctx.sim.store.items[m.instanceId] = m;
  m.ownerContainerId = `item:${w.instanceId}`;
  w.containedItems.push(m.instanceId);
  w.weapon!.magazineId = m.instanceId;
  w.weapon!.chamber = chamber ? 'core.ammo.9.fmj' : null;
  return w.instanceId;
}

function spareMag(t: TestWorld, rounds: number): string {
  const m = instantiate(t.content, t.ctx.sim.ids, 'core.mag.p9');
  m.mag!.rounds = Array.from({ length: rounds }, () => 'core.ammo.9.fmj');
  placeNew(t.ctx.sim.store, t.content, m, { containerId: bagOf(t) });
  return m.instanceId;
}

function loose(t: TestWorld, qty: number): string {
  const s = instantiate(t.content, t.ctx.sim.ids, 'core.ammo.9.fmj', { quantity: qty });
  s.quantity = qty;
  placeNew(t.ctx.sim.store, t.content, s, { containerId: bagOf(t) });
  return s.instanceId;
}

const inGun = (t: TestWorld, wid: string): number => {
  const w = t.ctx.sim.store.items[wid]!;
  const m = w.weapon!.magazineId ? t.ctx.sim.store.items[w.weapon!.magazineId] : undefined;
  return (m?.mag?.rounds.length ?? 0) + (w.weapon!.chamber ? 1 : 0);
};

const inGunCtx = (ctx: SimContext, wid: string): number => {
  const w = ctx.sim.store.items[wid]!;
  const m = w.weapon!.magazineId ? ctx.sim.store.items[w.weapon!.magazineId] : undefined;
  return (m?.mag?.rounds.length ?? 0) + (w.weapon!.chamber ? 1 : 0);
};

const messages = (t: TestWorld): string[] => t.ctx.sim.fx.flatMap((f) => (f.t === 'message' ? [f.key] : []));

describe('player reload: R is a one-shot magazine swap (no silent round-by-round refill)', () => {
  it('a fuller spare magazine is swapped in whole, even a partly filled one', () => {
    const t = world(map);
    const w = p9(t, true, 3);
    const spare = spareMag(t, 9);
    loose(t, 30);
    expect(requestReload(t.ctx, t.player, true)).toBe('started');
    expect(t.player.action?.type).toBe('reload');
    tick(t, idle, 60 * 2);
    expect(t.ctx.sim.store.items[w]!.weapon!.magazineId).toBe(spare);
    expect(inGun(t, w)).toBe(10);
  });

  it('with only loose rounds a tap does not start a round-by-round refill; it explains how to top up instead', () => {
    const t = world(map);
    const w = p9(t, true, 5);
    loose(t, 30);
    stepSim(t.ctx, { cmd: { ...idle, reload: true }, ops: [] });
    expect(t.player.action).toBeNull();
    expect(messages(t)).toContain('reload.no_mag');
    expect(t.content.t('reload.no_mag')).toContain('길게');
    expect(inGun(t, w)).toBe(6);
  });

  it('holding R (reloadHold) tops the inserted magazine up from loose rounds with every round conserved', () => {
    const t = world(map);
    const w = p9(t, true, 5);
    loose(t, 30);
    const total = () => totalRounds(t.ctx, allCarriedItemIds(t.ctx.sim, t.player), '9');
    expect(total()).toBe(36);
    stepSim(t.ctx, { cmd: { ...idle, reloadHold: true }, ops: [] });
    expect(t.player.action?.type).toBe('refillMag');
    tick(t, idle, 60 * 4);
    expect(t.player.action).toBeNull();
    expect(inGun(t, w)).toBe(16);
    expect(total()).toBe(36);
    expect(validateStore(t.ctx.sim.store, t.content)).toEqual([]);
  });

  it('only emptier magazines and no loose rounds → "no fuller magazine", nothing swapped', () => {
    const t = world(map);
    const w = p9(t, true, 10);
    spareMag(t, 4);
    expect(requestReload(t.ctx, t.player, true)).toBe('no_better');
    expect(t.player.action).toBeNull();
    expect(inGun(t, w)).toBe(11);
    expect(t.content.has('reload.no_better')).toBe(true);
  });

  it('AI keeps the automatic loose-round refill (finite loadout, A08)', () => {
    const t = world(map);
    const e = spawnEnemy(t.content, t.ctx.sim, 'core.enemy.sentry', 20, 5, Rng.fromSeed('reload-ai'));
    const ew = activeWeaponItem(t.ctx, e)!.item;
    const pocket = carriedContainerIds(t.ctx.sim, e);
    // Leave the enemy with its inserted magazine nearly empty, no spare magazines, and loose rounds.
    for (const cid of pocket)
      for (const id of [...t.ctx.sim.store.containers[cid]!.items]) {
        const d = t.content.item(t.ctx.sim.store.items[id]!.definitionId);
        if (d.magazine || d.ammo) destroyItem(t.ctx.sim.store, id);
      }
    const cal = t.content.item(ew.definitionId).weapon!.caliber;
    const st = instantiate(t.content, t.ctx.sim.ids, standardAmmoFor(t.content, cal), { quantity: 20 });
    st.quantity = 20;
    placeNew(t.ctx.sim.store, t.content, st, { containerId: pocket[0]! });
    t.ctx.sim.store.items[ew.weapon!.magazineId!]!.mag!.rounds.splice(2);
    expect(requestReload(t.ctx, e, false)).toBe('started');
    expect(e.action?.type).toBe('refillMag');
  });
});

describe('training sims (shelter / range / tutorial): unlimited training reserve, no stamina drain', () => {
  const content = createContent();
  const base = (weaponDefId: string): SimContext => createBaseSim(content, { seed: 'train', flags: {}, perks: {}, weaponDefId, extraObstacles: [] });
  const stepN = (ctx: SimContext, cmd: ReturnType<typeof aimCmd>, n: number) => {
    for (let i = 0; i < n; i++) stepSim(ctx, { cmd, ops: [] }, SIM_DT);
  };
  const pl = (ctx: SimContext) => ctx.sim.actors.find((a) => a.kind === 'player')!;
  const bagItems = (ctx: SimContext) => carriedContainerIds(ctx.sim, pl(ctx)).flatMap((cid) => ctx.sim.store.containers[cid]!.items);

  it('the shelter mirrors the equipped loadout (rifle stays primary, no weapon means no gun); a rental only fills its class slot', () => {
    const slotDef = (ctx: SimContext, s: string) => {
      const id = ctx.sim.store.containers[`eq:player:${s}`]?.items[0];
      return id ? ctx.sim.store.items[id]!.definitionId : null;
    };
    const p = newProfile(content, 1, 'Loadout', 'loadout-seed', 0);
    // Starter kit: P9 (secondary) + knife.
    let ctx = createBaseSim(content, { seed: 's', flags: {}, perks: {}, extraObstacles: [], loadout: profileTrainingLoadout(p.store, content) });
    expect([slotDef(ctx, 'primary1'), slotDef(ctx, 'secondary'), slotDef(ctx, 'melee')]).toEqual([null, 'core.weapon.p9', 'core.melee.knife']);
    expect(pl(ctx).activeSlot).toBe('secondary');
    // Equip the stash carbine as primary 1: the shelter hands the carbine out first, the pistol stays secondary.
    const carbine = Object.values(p.store.items).find((i) => i.definitionId === 'core.weapon.c556')!;
    equipProfileItem(p, content, carbine.instanceId, 'primary1');
    ctx = createBaseSim(content, { seed: 's', flags: {}, perks: {}, extraObstacles: [], loadout: profileTrainingLoadout(p.store, content) });
    expect([slotDef(ctx, 'primary1'), slotDef(ctx, 'secondary')]).toEqual(['core.weapon.c556', 'core.weapon.p9']);
    expect(pl(ctx).activeSlot).toBe('primary1');
    const cw = activeWeaponItem(ctx, pl(ctx))!.item;
    expect(cw.weapon!.chamber).not.toBeNull(); // loaded training copy
    expect(Object.keys(p.store.items)).toContain(carbine.instanceId); // the profile item itself never enters the sim
    expect(ctx.sim.store.items[carbine.instanceId]).toBeUndefined();
    // Renting a pistol replaces only the secondary slot.
    setRangeWeapon(ctx, 'core.weapon.h45');
    expect([slotDef(ctx, 'primary1'), slotDef(ctx, 'secondary')]).toEqual(['core.weapon.c556', 'core.weapon.h45']);
    // Nothing equipped: no gun at all.
    const empty = createBaseSim(content, { seed: 's', flags: {}, perks: {}, extraObstacles: [], loadout: [] });
    expect(['primary1', 'primary2', 'secondary', 'melee'].map((s) => slotDef(empty, s))).toEqual([null, null, null, null]);
    expect(activeWeaponItem(empty, pl(empty))).toBeNull();
    expect(validateStore(ctx.sim.store, content)).toEqual([]);
  });

  it('the rental rack issues just the loaded weapon: no spare magazines or loose rounds to manage', () => {
    const ctx = base('core.weapon.p9');
    expect(bagItems(ctx)).toEqual([]);
  });

  it('R in the shelter swaps in a fresh full magazine every time; the spent one is discarded (nothing piles up)', () => {
    const ctx = base('core.weapon.p9');
    const p = pl(ctx);
    const w = activeWeaponItem(ctx, p)!.item;
    const items0 = Object.keys(ctx.sim.store.items).length;
    const cmd = aimCmd(p.x + 5, p.y, 1.0);
    for (let round = 0; round < 3; round++) {
      const mag = ctx.sim.store.items[w.weapon!.magazineId!]!;
      mag.mag!.rounds.splice(round === 2 ? 0 : 4); // shots fired (round 3: fully empty, chamber too)
      if (round === 2) w.weapon!.chamber = null;
      stepSim(ctx, { cmd: { ...cmd, reload: true }, ops: [] }, SIM_DT);
      expect(p.action?.type).toBe('reload');
      expect(p.action?.training).toBe(true);
      stepN(ctx, cmd, 60 * 3);
      expect(p.action).toBeNull();
      const now = ctx.sim.store.items[w.weapon!.magazineId!]!;
      expect(now.instanceId).not.toBe(mag.instanceId);
      expect(ctx.sim.store.items[mag.instanceId], 'old training magazine discarded').toBeUndefined();
      expect(now.mag!.rounds.length + (w.weapon!.chamber ? 1 : 0)).toBe(round === 2 ? 15 : 16);
      expect(bagItems(ctx)).toEqual([]);
      expect(Object.keys(ctx.sim.store.items).length).toBe(items0);
      expect(validateStore(ctx.sim.store, content)).toEqual([]);
    }
    expect(ctx.sim.range!.reloads).toBe(3); // Q01 range_reload still counts
    // After the empty reload the chamber took one round (14 + 1): a tactical top-up gives 15 + 1, then it is full.
    expect(requestReload(ctx, p, true)).toBe('started');
    stepN(ctx, cmd, 60 * 3);
    expect(inGunCtx(ctx, w.instanceId)).toBe(16);
    expect(requestReload(ctx, p, true)).toBe('full');
  });

  it('a tube shotgun in training loads free shells (still shell by shell) up to capacity', () => {
    const ctx = base('core.weapon.sgp');
    const p = pl(ctx);
    const w = activeWeaponItem(ctx, p)!.item;
    const cap = content.item(w.definitionId).weapon!.capacity;
    w.weapon!.tube!.splice(1);
    expect(requestReload(ctx, p, true)).toBe('started');
    expect(p.action?.type).toBe('tubeReload');
    stepN(ctx, aimCmd(p.x + 5, p.y, 1.0), 60 * 6);
    expect(w.weapon!.tube!.length).toBe(cap);
    expect(w.weapon!.chamber).not.toBeNull();
    expect(bagItems(ctx)).toEqual([]);
  });

  it('sprinting and melee cost no stamina in the shelter, but do in a raid', () => {
    const ctx = base('core.weapon.p9');
    const p = pl(ctx);
    stepN(ctx, aimCmd(p.x + 5, p.y, 1.0, { moveX: 1, sprint: true }), 120);
    expect(p.stamina).toBe(p.staminaMax);
    expect(startMelee(ctx, p)).toBe(true);
    expect(p.stamina).toBe(p.staminaMax);

    const t = world(arena('test.reload.stamina', 60, 10));
    placeNew(t.ctx.sim.store, t.content, instantiate(t.content, t.ctx.sim.ids, 'core.melee.knife'), { containerId: eqContainerId('player', 'melee') });
    tick(t, aimCmd(50, 5, 1.0, { moveX: 1, sprint: true }), 120);
    expect(t.player.stamina).toBeLessThan(t.player.staminaMax - 20);
    const st = t.player.stamina;
    tick(t, aimCmd(50, 5, 1.0), 1);
    expect(startMelee(t.ctx, t.player)).toBe(true);
    expect(t.player.stamina).toBeLessThan(st);
  });

  it('a raid-rule sim flagged as training (tutorial) uses the same reserve and free stamina', () => {
    const t = world(map);
    t.ctx.sim.training = true;
    const w = p9(t, true, 2);
    expect(requestReload(t.ctx, t.player, true)).toBe('started');
    tick(t, idle, 60 * 2);
    expect(inGun(t, w)).toBe(16);
    tick(t, aimCmd(29, 5, 1.0, { moveX: 1, sprint: true }), 90);
    expect(t.player.stamina).toBe(t.player.staminaMax);
  });
});
