import { describe, expect, it } from 'vitest';
import { requestReload, totalRounds, LOOSE_ROUND_TIME } from '../src/combat/reload';
import { instantiate, placeNew, validateStore } from '../src/inventory/store';
import { allCarriedItemIds } from '../src/world/context';
import { eqContainerId } from '../src/world/state';
import { stepSim } from '../src/world/sim';
import { aimCmd, arena, bagOf, tick, world, type TestWorld } from './helpers';

const map = arena('test.a06', 30, 10);

function p9(t: TestWorld, chamber: boolean, inMag: number): string {
  const w = instantiate(t.content, t.ctx.sim.ids, 'core.weapon.p9');
  placeNew(t.ctx.sim.store, t.content, w, { containerId: eqContainerId('player', 'secondary') });
  t.player.activeSlot = 'secondary';
  if (inMag >= 0) {
    const m = instantiate(t.content, t.ctx.sim.ids, 'core.mag.p9');
    m.mag!.rounds = Array.from({ length: inMag }, () => 'core.ammo.9.fmj');
    t.ctx.sim.store.items[m.instanceId] = m;
    m.ownerContainerId = `item:${w.instanceId}`;
    w.containedItems.push(m.instanceId);
    w.weapon!.magazineId = m.instanceId;
  }
  w.weapon!.chamber = chamber ? 'core.ammo.9.fmj' : null;
  return w.instanceId;
}

function spareMag(t: TestWorld, rounds: number): string {
  const m = instantiate(t.content, t.ctx.sim.ids, 'core.mag.p9');
  m.mag!.rounds = Array.from({ length: rounds }, () => 'core.ammo.9.fmj');
  placeNew(t.ctx.sim.store, t.content, m, { containerId: bagOf(t) });
  return m.instanceId;
}

function rounds(t: TestWorld): number {
  const ids = [...allCarriedItemIds(t.ctx.sim, t.player), ...Object.values(t.ctx.sim.containers).filter((c) => c.kind === 'drop').flatMap((c) => t.ctx.sim.store.containers[c.id]!.items)];
  return totalRounds(t.ctx, [...new Set(ids)], '9');
}

const idle = aimCmd(20, 5, 1.0);

describe('A06 chamber/magazine conservation', () => {
  it('empty P9 + 15-round magazine → chamber 1 + magazine 14 = 15', () => {
    const t = world(map);
    const w = p9(t, false, -1);
    const m = spareMag(t, 15);
    expect(requestReload(t.ctx, t.player, false)).toBe('started');
    tick(t, idle, 60 * 2);
    const wi = t.ctx.sim.store.items[w]!;
    expect(wi.weapon!.magazineId).toBe(m);
    expect(wi.weapon!.chamber).toBe('core.ammo.9.fmj');
    expect(t.ctx.sim.store.items[m]!.mag!.rounds.length).toBe(14);
    expect(rounds(t)).toBe(15);
  });
  it('tactical reload: chamber 1 / old 5 / new 15 → 21 conserved and N+1 in the gun', () => {
    const t = world(map);
    const w = p9(t, true, 5);
    const m = spareMag(t, 15);
    expect(rounds(t)).toBe(21);
    requestReload(t.ctx, t.player, false);
    tick(t, idle, 60 * 2);
    const wi = t.ctx.sim.store.items[w]!;
    expect(wi.weapon!.chamber).not.toBeNull();
    expect(t.ctx.sim.store.items[m]!.mag!.rounds.length).toBe(15);
    expect(rounds(t)).toBe(21);
    expect(validateStore(t.ctx.sim.store, t.content)).toEqual([]);
  });
  it('quick reload (double R within 0.25s) drops the old magazine exactly once and is 20% faster', () => {
    const t = world(map);
    p9(t, true, 5);
    spareMag(t, 15);
    stepSim(t.ctx, { cmd: { ...idle, reload: true }, ops: [] });
    tick(t, idle, 5);
    stepSim(t.ctx, { cmd: { ...idle, reload: true }, ops: [] });
    expect(t.player.action?.quick).toBe(true);
    expect(t.player.action?.duration).toBeCloseTo(1.4 * 0.8, 6);
    tick(t, idle, 90);
    const drops = Object.values(t.ctx.sim.containers).filter((c) => c.kind === 'drop');
    const dropped = drops.flatMap((c) => t.ctx.sim.store.containers[c.id]!.items);
    expect(dropped.length).toBe(1);
    expect(rounds(t)).toBe(21);
  });
  it('cancel mid-reload keeps committed steps (magazine removed, not yet inserted)', () => {
    const t = world(map);
    const w = p9(t, true, 5);
    spareMag(t, 15);
    requestReload(t.ctx, t.player, false);
    // 0.35×1.4 = 0.49s remove commit; cancel at ~0.6s (before 0.98s insert).
    tick(t, idle, 36);
    t.player.action = null;
    const wi = t.ctx.sim.store.items[w]!;
    expect(wi.weapon!.magazineId).toBeNull();
    expect(wi.weapon!.chamber).not.toBeNull();
    expect(rounds(t)).toBe(21);
    expect(validateStore(t.ctx.sim.store, t.content)).toEqual([]);
  });
  it('firing cancels a reload and the rounds fired are the only change', () => {
    const t = world(map);
    p9(t, true, 5);
    spareMag(t, 15);
    requestReload(t.ctx, t.player, false);
    tick(t, idle, 10);
    stepSim(t.ctx, { cmd: { ...idle, firePressed: true, fireHeld: true }, ops: [] });
    expect(t.player.action).toBeNull();
    tick(t, idle, 60);
    expect(rounds(t)).toBe(20);
  });
  it('SG-P tube: open 0.40 + 0.55/shell + close; interrupted loads keep loaded shells', () => {
    const t = world(map);
    const w = instantiate(t.content, t.ctx.sim.ids, 'core.weapon.sgp');
    placeNew(t.ctx.sim.store, t.content, w, { containerId: eqContainerId('player', 'primary1') });
    t.player.activeSlot = 'primary1';
    w.weapon!.tube = [];
    w.weapon!.chamber = null;
    const shells = instantiate(t.content, t.ctx.sim.ids, 'core.ammo.12g.buck', { quantity: 10 });
    shells.quantity = 10;
    placeNew(t.ctx.sim.store, t.content, shells, { containerId: bagOf(t) });
    const total = () => totalRounds(t.ctx, allCarriedItemIds(t.ctx.sim, t.player), '12g');
    expect(total()).toBe(10);
    expect(requestReload(t.ctx, t.player, false)).toBe('started');
    // Empty chamber: open 0.40 → chamber +0.40 (0.80s) → first tube shell at 1.35s.
    tick(t, idle, Math.round(1.5 * 60) + 1);
    expect(w.weapon!.chamber).not.toBeNull();
    expect(w.weapon!.tube!.length).toBe(1);
    t.player.action = null;
    expect(total()).toBe(10);
    requestReload(t.ctx, t.player, false);
    tick(t, idle, 60 * 6);
    // Tube full (6) + chamber (1) → 7 in gun, 3 loose.
    expect(w.weapon!.tube!.length + (w.weapon!.chamber ? 1 : 0)).toBe(7);
    expect(total()).toBe(10);
  });
  it('loose rounds load into a magazine at 0.20s per round', () => {
    const t = world(map);
    p9(t, true, 15);
    const m = spareMag(t, 0);
    const loose = instantiate(t.content, t.ctx.sim.ids, 'core.ammo.9.fmj', { quantity: 30 });
    loose.quantity = 30;
    placeNew(t.ctx.sim.store, t.content, loose, { containerId: bagOf(t) });
    stepSim(t.ctx, { cmd: idle, ops: [{ op: 'loadMag', magId: m, ammoDefId: 'core.ammo.9.fmj' }] });
    tick(t, idle, Math.round((LOOSE_ROUND_TIME * 5 * 60) / 1));
    const n = t.ctx.sim.store.items[m]!.mag!.rounds.length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(5);
    tick(t, idle, 60 * 4);
    expect(t.ctx.sim.store.items[m]!.mag!.rounds.length).toBe(15);
    expect(rounds(t)).toBe(1 + 15 + 15 + 15);
  });
});
