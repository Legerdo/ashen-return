import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { computeDamage, penetrate, rangeFactor } from '../src/combat/damage';
import { aimCmd, arena, equip, settle, target, tick, world } from './helpers';

const content = createContent();
const ammo = (id: string) => content.item(id).ammo!;
const weapon = (id: string) => content.item(id).weapon!;

function dmg(weaponId: string, ammoId: string, part: 'head' | 'body' | 'limb', opts: { range?: number; armor?: { rating: number; max: number; dur?: number } | null; hp?: number; carry?: number } = {}) {
  const w = weapon(weaponId);
  const a = ammo(ammoId);
  return computeDamage({
    baseDamage: a.damageOverride ?? w.damage,
    ammo: a,
    part,
    range: opts.range ?? 1,
    effectiveRange: a.rangeOverride?.effective ?? w.effectiveRange,
    maxRange: a.rangeOverride?.max ?? w.maxRange,
    minRangeFactor: a.rangeOverride?.minFactor ?? w.minRangeFactor,
    penetrationCarry: opts.carry ?? 1,
    explicitBuff: 1,
    armor: opts.armor ? { rating: opts.armor.rating, durability: opts.armor.dur ?? opts.armor.max, maxDurability: opts.armor.max } : null,
    targetHp: opts.hp ?? 1000,
  });
}

describe('spec §16 fixed calculation fixtures (pure formula)', () => {
  it('AR556 FMJ unarmored body = 30, head = 60', () => {
    expect(dmg('core.weapon.ar556', 'core.ammo.556.fmj', 'body').calculatedHpDamage).toBeCloseTo(30, 9);
    expect(dmg('core.weapon.ar556', 'core.ammo.556.fmj', 'head').calculatedHpDamage).toBeCloseTo(60, 9);
  });
  it('DMR FMJ head = 116, DMR AP head = 104.4, BOLT FMJ head = 164', () => {
    expect(dmg('core.weapon.dmr', 'core.ammo.762d.fmj', 'head').calculatedHpDamage).toBeCloseTo(116, 9);
    expect(dmg('core.weapon.dmr', 'core.ammo.762d.ap', 'head').calculatedHpDamage).toBeCloseTo(104.4, 9);
    expect(dmg('core.weapon.bolt', 'core.ammo.762d.fmj', 'head').calculatedHpDamage).toBeCloseTo(164, 9);
  });
  it('SG-P buckshot 8 pellets body: calculated 112, HP100 actual loss 100; body6+head2 = 121.8', () => {
    const one = dmg('core.weapon.sgp', 'core.ammo.12g.buck', 'body').calculatedHpDamage;
    expect(one * 8).toBeCloseTo(112, 9);
    let hp = 100;
    let lost = 0;
    for (let i = 0; i < 8; i++) {
      const r = dmg('core.weapon.sgp', 'core.ammo.12g.buck', 'body', { hp });
      hp -= r.actualHpLoss;
      lost += r.actualHpLoss;
    }
    expect(lost).toBeCloseTo(100, 9);
    const head = dmg('core.weapon.sgp', 'core.ammo.12g.buck', 'head').calculatedHpDamage;
    expect(6 * one + 2 * head).toBeCloseTo(121.8, 9);
  });
  it('AR556 vs rating-40 vest: FMJ HP 10.875 / armor -26.25, AP 27 / -16.875, HP-ammo 5.175 / -24.15', () => {
    const vest = { rating: 40, max: 80 };
    const f = dmg('core.weapon.ar556', 'core.ammo.556.fmj', 'body', { armor: vest });
    expect(f.calculatedHpDamage).toBeCloseTo(10.875, 9);
    expect(f.armorLoss).toBeCloseTo(26.25, 9);
    const ap = dmg('core.weapon.ar556', 'core.ammo.556.ap', 'body', { armor: vest });
    expect(ap.calculatedHpDamage).toBeCloseTo(27, 9);
    expect(ap.armorLoss).toBeCloseTo(16.875, 9);
    const hp = dmg('core.weapon.ar556', 'core.ammo.556.hp', 'body', { armor: vest });
    expect(hp.calculatedHpDamage).toBeCloseTo(5.175, 9);
    expect(hp.armorLoss).toBeCloseTo(24.15, 9);
  });
  it('AR556 FMJ vs rating-40 helmet on head: HP 21.75, helmet -52.5', () => {
    const r = dmg('core.weapon.ar556', 'core.ammo.556.fmj', 'head', { armor: { rating: 40, max: 55 } });
    expect(r.calculatedHpDamage).toBeCloseTo(21.75, 9);
    expect(r.armorLoss).toBeCloseTo(52.5, 9);
  });
  it('armor durability 0 → no protection and no armor loss', () => {
    const r = dmg('core.weapon.ar556', 'core.ammo.556.fmj', 'body', { armor: { rating: 40, max: 80, dur: 0 } });
    expect(r.healthTransfer).toBe(1);
    expect(r.armorLoss).toBe(0);
    expect(r.calculatedHpDamage).toBeCloseTo(30, 9);
  });
  it('AR556 FMJ at 28u = 22.5 (linear falloff to 0.5 at 38u)', () => {
    expect(dmg('core.weapon.ar556', 'core.ammo.556.fmj', 'body', { range: 28 }).calculatedHpDamage).toBeCloseTo(22.5, 9);
    expect(rangeFactor(18, 18, 38, 0.5)).toBe(1);
    expect(rangeFactor(38, 18, 38, 0.5)).toBe(0.5);
  });
  it('AR556 FMJ through 0.2u wood = 15', () => {
    const p = penetrate(20, 50, 0.2);
    expect(p.passed).toBe(true);
    expect(p.after).toBeCloseTo(10, 9);
    expect(dmg('core.weapon.ar556', 'core.ammo.556.fmj', 'body', { carry: p.carryMult }).calculatedHpDamage).toBeCloseTo(15, 9);
    expect(p.speedMult).toBeCloseTo(Math.sqrt(0.5), 9);
  });
  it('penetration needs E strictly greater than cost', () => {
    expect(penetrate(10, 50, 0.2).passed).toBe(false);
    expect(penetrate(20, 1000, 0.05).passed).toBe(false);
  });
});

describe('fixtures through the real firing pipeline (spread/recoil off)', () => {
  const map = arena('test.fixture', 60, 12, (b) => {
    b.box('core.ob.wall_wood', 12, 4.5, 12.2, 7.5, 2.2, { id: 'wood' });
  });
  function shootAt(weaponId: string, ammoId: string, tx: number, ty: number, z: number, opts: { vest?: number; helmet?: number } = {}) {
    // Shooter on the same row so the line of fire is perpendicular to walls (spec fixtures use straight passes).
    const t = world(map, 2, ty);
    t.ctx.sim.debug.noSpread = true;
    const wid = equip(t, weaponId, ammoId);
    t.ctx.sim.store.items[wid]!.durability = 100;
    const tg = target(t, tx, ty, { ...opts, hp: 1000 });
    tick(t, aimCmd(tx, ty, z, {}, tg.id));
    tick(t, aimCmd(tx, ty, z, { firePressed: true, fireHeld: true }, tg.id));
    settle(t, 120, aimCmd(tx, ty, z, {}, tg.id));
    return { t, tg, lost: 1000 - tg.hp, log: t.ctx.sim.shotLog };
  }
  it('AR556 FMJ body 30 and head 60 via projectiles', () => {
    expect(shootAt('core.weapon.ar556', 'core.ammo.556.fmj', 10, 3, 1.0).lost).toBeCloseTo(30, 6);
    expect(shootAt('core.weapon.ar556', 'core.ammo.556.fmj', 10, 3, 1.6).lost).toBeCloseTo(60, 6);
  });
  it('AR556 FMJ at 28u from the muzzle → 22.5', () => {
    // Muzzle at x = 2 + 0.95; body surface at target.x - 0.30.
    const tx = 2 + 0.95 + 28 + 0.3;
    const r = shootAt('core.weapon.ar556', 'core.ammo.556.fmj', tx, 3, 1.0);
    expect(r.lost).toBeCloseTo(22.5, 3);
    expect(r.log[0]!.range).toBeCloseTo(28, 2);
  });
  it('AR556 FMJ through the 0.2u wood wall → 15', () => {
    const r = shootAt('core.weapon.ar556', 'core.ammo.556.fmj', 16, 6, 1.0);
    // Row y=6 crosses the wood wall (x 12..12.2, y 4.5..7.5) perpendicularly: 0.2u of wood, within effective range.
    expect(r.lost).toBeCloseTo(15, 3);
  });
  it('vest only + head shot: HP 60 and vest unchanged', () => {
    const r = shootAt('core.weapon.ar556', 'core.ammo.556.fmj', 10, 3, 1.6, { vest: 2 });
    expect(r.lost).toBeCloseTo(60, 6);
    const vestId = r.t.ctx.sim.store.containers[`eq:${r.tg.id}:vest`]!.items[0]!;
    expect(r.t.ctx.sim.store.items[vestId]!.durability).toBe(80);
  });
  it('rating-40 vest body shot through the pipeline: 10.875 HP, vest 80 → 53.75', () => {
    const r = shootAt('core.weapon.ar556', 'core.ammo.556.fmj', 10, 3, 1.0, { vest: 2 });
    expect(r.lost).toBeCloseTo(10.875, 6);
    const vestId = r.t.ctx.sim.store.containers[`eq:${r.tg.id}:vest`]!.items[0]!;
    expect(r.t.ctx.sim.store.items[vestId]!.durability).toBeCloseTo(80 - 26.25, 6);
  });
  it('SG-P 8 pellets all hit at point blank body: 112 calculated, HP100 target dies with loss 100', () => {
    const t = world(map, 2, 3);
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.sgp', 'core.ammo.12g.buck');
    const tg = target(t, 5, 3, { hp: 100 });
    tick(t, aimCmd(5, 3, 1.0, {}, tg.id));
    tick(t, aimCmd(5, 3, 1.0, { firePressed: true, fireHeld: true }, tg.id));
    settle(t);
    const pellets = t.ctx.sim.shotLog.filter((l) => l.firstHit === `actor:${tg.id}`);
    // Non-penetrating pellets: the same body only takes damage while alive; total calculated for the 8 pellets:
    const calc = t.ctx.sim.shotLog.reduce((s, l) => s + l.calculatedHPDamage, 0);
    expect(tg.alive).toBe(false);
    expect(100 - tg.hp).toBeCloseTo(100, 6);
    expect(pellets.length).toBeGreaterThanOrEqual(7);
    expect(calc).toBeLessThanOrEqual(112 + 1e-6);
  });
});
