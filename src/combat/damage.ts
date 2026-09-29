import type { AmmoSpec, HitPart } from '../content/types';
import { clamp01 } from '../core/math';

/** LOCKED formula (spec §6):
 *   Dpre = Dbase × ammoFlesh × hitPart × rangeFactor × penetrationCarry × explicitBuff
 *   Aeff = armorRating × (0.5 + 0.5 × durabilityRatio)
 *   q = clamp01((ammoPenetration − Aeff + 20) / 40)
 *   healthTransfer = 0.15 + 0.85 q
 *   HPDamage = Dpre × healthTransfer
 *   ArmorLoss = Dpre × ammoArmorDamage × (1 − 0.5 q)
 * No armor / durability 0 → healthTransfer 1, ArmorLoss 0.
 */

export interface ArmorView {
  rating: number;
  durability: number;
  maxDurability: number;
}

export interface DamageInput {
  baseDamage: number;
  ammo: Pick<AmmoSpec, 'fleshMult' | 'penetration' | 'armorDamage' | 'headMult'>;
  part: HitPart;
  range: number;
  effectiveRange: number;
  maxRange: number;
  minRangeFactor: number;
  penetrationCarry: number;
  explicitBuff: number;
  armor: ArmorView | null;
  targetHp: number;
}

export interface DamageResult {
  rawDamage: number;
  part: HitPart;
  range: number;
  rangeFactor: number;
  q: number;
  healthTransfer: number;
  armorBefore: number | null;
  armorAfter: number | null;
  armorLoss: number;
  calculatedHpDamage: number;
  actualHpLoss: number;
  killed: boolean;
}

export const LIMB_MULT = 0.75;

export function hitPartMultiplier(part: HitPart, ammo: Pick<AmmoSpec, 'headMult'>): number {
  if (part === 'head') return ammo.headMult;
  if (part === 'limb') return LIMB_MULT;
  return 1;
}

/** 1.0 up to effective range, then linear to minFactor at max range (and clamped beyond). */
export function rangeFactor(range: number, effective: number, max: number, minFactor: number): number {
  if (range <= effective) return 1;
  if (range >= max || max <= effective) return minFactor;
  const t = (range - effective) / (max - effective);
  return 1 - t * (1 - minFactor);
}

export function effectiveArmor(a: ArmorView): number {
  const ratio = a.maxDurability > 0 ? clamp01(a.durability / a.maxDurability) : 0;
  return a.rating * (0.5 + 0.5 * ratio);
}

export function computeDamage(inp: DamageInput): DamageResult {
  const rf = rangeFactor(inp.range, inp.effectiveRange, inp.maxRange, inp.minRangeFactor);
  const raw = inp.baseDamage * inp.ammo.fleshMult * hitPartMultiplier(inp.part, inp.ammo) * rf * inp.penetrationCarry * inp.explicitBuff;
  let transfer = 1;
  let armorLoss = 0;
  let q = 1;
  let armorBefore: number | null = null;
  let armorAfter: number | null = null;
  if (inp.armor) {
    armorBefore = inp.armor.durability;
    armorAfter = inp.armor.durability;
    if (inp.armor.durability > 0) {
      const aeff = effectiveArmor(inp.armor);
      q = clamp01((inp.ammo.penetration - aeff + 20) / 40);
      transfer = 0.15 + 0.85 * q;
      armorLoss = raw * inp.ammo.armorDamage * (1 - 0.5 * q);
      armorAfter = Math.max(0, inp.armor.durability - armorLoss);
    }
  }
  const hpDamage = raw * transfer;
  const hp = Math.max(0, inp.targetHp);
  const actual = Math.min(hp, hpDamage);
  return {
    rawDamage: raw,
    part: inp.part,
    range: inp.range,
    rangeFactor: rf,
    q,
    healthTransfer: transfer,
    armorBefore,
    armorAfter,
    armorLoss,
    calculatedHpDamage: hpDamage,
    actualHpLoss: actual,
    killed: hp - hpDamage <= 1e-9,
  };
}

/** Environment penetration: cost = resistance × thickness; passes only if E > cost. */
export function penetrate(energy: number, resistance: number, thickness: number): { passed: boolean; after: number; carryMult: number; speedMult: number } {
  const cost = resistance * Math.max(0, thickness);
  if (!Number.isFinite(cost) || energy <= cost || energy <= 0) return { passed: false, after: 0, carryMult: 0, speedMult: 0 };
  const after = energy - cost;
  const ratio = after / energy;
  return { passed: true, after, carryMult: ratio, speedMult: Math.sqrt(ratio) };
}
