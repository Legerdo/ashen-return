import { EPS, circleRectPush, clamp } from '../core/math';
import { descendants } from '../inventory/store';
import { allCarriedItemIds, activeWeaponItem, type SimContext } from './context';
import type { ActorState } from './state';

/** Movement TUNABLE values (spec §5). */
export const MOVE = {
  walk: 3,
  sprint: 4.8,
  crouch: 1.65,
  staminaMax: 100,
  sprintDrain: 18,
  regenDelay: 1,
  regenRate: 14,
  sprintRestart: 5,
  medicalMult: 0.5,
  painMult: 0.85,
  painHp: 30,
} as const;

export const WEIGHT = {
  normal: 25,
  heavy: 40,
  sprintMax: 35,
  heavyMult: 0.65,
} as const;

export const FOOTSTEP = {
  stride: 1.4,
  walk: 4,
  sprint: 9,
  crouch: 2,
  door: 6,
} as const;

export function itemWeightKg(ctx: SimContext, itemId: string): number {
  const it = ctx.sim.store.items[itemId];
  if (!it) return 0;
  const d = ctx.content.item(it.definitionId);
  let w = d.weightKg * (d.stackMax > 1 && !d.unitWeightKg ? it.quantity : 1);
  if (d.unitWeightKg) w += d.unitWeightKg * it.quantity;
  if (it.mag) {
    for (const r of it.mag.rounds) w += ctx.content.item(r).unitWeightKg ?? 0.01;
  }
  if (it.weapon?.tube) for (const r of it.weapon.tube) w += ctx.content.item(r).unitWeightKg ?? 0.01;
  return w;
}

/** Weight of an item together with everything it holds (magazine, attachments, bag contents), as carriedWeightKg counts it. */
export function deepItemWeightKg(ctx: SimContext, itemId: string): number {
  let w = itemWeightKg(ctx, itemId);
  for (const id of descendants(ctx.sim.store, itemId)) w += itemWeightKg(ctx, id);
  return w;
}

/** Weight a new stack of `qty` units of a definition would have (split / unloaded rounds). */
export function stackWeightKg(ctx: SimContext, defId: string, qty: number): number {
  const d = ctx.content.item(defId);
  return d.weightKg * (d.stackMax > 1 && !d.unitWeightKg ? qty : 1) + (d.unitWeightKg ?? 0) * qty;
}

export function carriedWeightKg(ctx: SimContext, a: ActorState): number {
  let w = 0;
  for (const id of allCarriedItemIds(ctx.sim, a)) w += itemWeightKg(ctx, id);
  return w;
}

export function normalLimitKg(ctx: SimContext, a: ActorState): number {
  return WEIGHT.normal + (a.kind === 'player' ? (ctx.sim.perks.carryKg ?? 0) : 0);
}

/** 1.0 at/below normal limit, linear to 0.65 at 40kg. */
export function weightMoveMult(kg: number, normal: number): number {
  if (kg <= normal) return 1;
  if (kg >= WEIGHT.heavy) return WEIGHT.heavyMult;
  return 1 - ((kg - normal) / (WEIGHT.heavy - normal)) * (1 - WEIGHT.heavyMult);
}

export function isMedicalAction(a: ActorState): boolean {
  return a.action?.type === 'heal';
}

export interface MoveIntent {
  x: number;
  y: number;
  sprint: boolean;
  ads: boolean;
}

/** Resolve speed and sprint eligibility for this tick. */
export function resolveSpeed(ctx: SimContext, a: ActorState, intent: MoveIntent, kg: number): { speed: number; sprinting: boolean } {
  const moving = Math.abs(intent.x) + Math.abs(intent.y) > EPS;
  const medical = isMedicalAction(a);
  const canSprint = moving && intent.sprint && a.stance === 'stand' && !medical && !intent.ads && kg <= WEIGHT.sprintMax && (a.sprinting ? a.stamina > 0 : a.stamina > MOVE.sprintRestart);
  let speed: number = a.stance === 'crouch' ? MOVE.crouch : canSprint ? MOVE.sprint : MOVE.walk;
  if (intent.ads && a.handling.adsT > 0.2) {
    const aw = activeWeaponItem(ctx, a);
    if (aw) speed *= aw.def.weapon!.adsMove;
  }
  speed *= weightMoveMult(kg, normalLimitKg(ctx, a));
  if (a.hp < MOVE.painHp && a.status.painkillerUntil <= ctx.sim.time) speed *= MOVE.painMult;
  if (medical) speed *= MOVE.medicalMult;
  const g = ctx.geo.groundAt(a.x, a.y);
  speed *= g.moveMult * ctx.geo.foliageMoveMult(a.x, a.y, ctx.sim);
  return { speed, sprinting: canSprint };
}

/** free: training sims (shelter / range / tutorial) — sprinting never drains stamina. */
export function updateStamina(a: ActorState, sprinting: boolean, dt: number, free = false): void {
  if (free) {
    a.stamina = a.staminaMax;
    a.staminaIdle = MOVE.regenDelay;
    return;
  }
  if (sprinting) {
    a.stamina = Math.max(0, a.stamina - MOVE.sprintDrain * dt);
    a.staminaIdle = 0;
  } else {
    a.staminaIdle += dt;
    if (a.staminaIdle >= MOVE.regenDelay) a.stamina = Math.min(a.staminaMax, a.stamina + MOVE.regenRate * dt);
  }
}

/** Axis-separated circle movement with corner sliding and no tunnelling. */
export function moveActor(ctx: SimContext, a: ActorState, vx: number, vy: number, dt: number): void {
  const r = a.radius;
  const steps = Math.max(1, Math.ceil((Math.hypot(vx, vy) * dt) / 0.1));
  const sdt = dt / steps;
  for (let s = 0; s < steps; s++) {
    a.x += vx * sdt;
    resolve(ctx, a, r);
    a.y += vy * sdt;
    resolve(ctx, a, r);
  }
  a.x = clamp(a.x, r, ctx.geo.map.width - r);
  a.y = clamp(a.y, r, ctx.geo.map.height - r);
}

function resolve(ctx: SimContext, a: ActorState, r: number): void {
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const o of ctx.geo.movementBlockers(a.x, a.y, r, a.floor, ctx.sim)) {
      const push = circleRectPush(a.x, a.y, r, o.box.x0, o.box.y0, o.box.x1, o.box.y1);
      if (push) {
        a.x += push.x;
        a.y += push.y;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** Soft separation between living actors so bodies do not overlap. */
export function separateActors(ctx: SimContext): void {
  const list = ctx.sim.actors.filter((a) => a.alive && a.kind !== 'turret');
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.floor !== b.floor) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = a.radius + b.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) / 2;
      const nx = dx / d;
      const ny = dy / d;
      const aStatic = a.kind === 'dummy' || a.kind === 'npc';
      const bStatic = b.kind === 'dummy' || b.kind === 'npc';
      if (!aStatic) {
        a.x -= nx * push * (bStatic ? 2 : 1);
        a.y -= ny * push * (bStatic ? 2 : 1);
        resolve(ctx, a, a.radius);
      }
      if (!bStatic) {
        b.x += nx * push * (aStatic ? 2 : 1);
        b.y += ny * push * (aStatic ? 2 : 1);
        resolve(ctx, b, b.radius);
      }
    }
}
