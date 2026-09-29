import { destroyItem } from '../inventory/store';
import { carriedContainerIds, type SimContext } from './context';
import type { ActionState, ActorState } from './state';

export const BLEED_RATE = 0.8;
export const PAINKILLER_DURATION = 60;

export type UseResult = 'started' | 'invalid' | 'busy' | 'not_needed';

function isCarried(ctx: SimContext, a: ActorState, itemId: string): boolean {
  const it = ctx.sim.store.items[itemId];
  if (!it) return false;
  return carriedContainerIds(ctx.sim, a).includes(it.ownerContainerId ?? '');
}

export function medicalUseTime(ctx: SimContext, a: ActorState, type: string, base: number): number {
  let t = base;
  if (a.kind === 'player') {
    t *= ctx.sim.perks.healTimeMult ?? 1;
    if (type === 'bandage') t *= ctx.sim.perks.bandageTimeMult ?? 1;
  }
  return t;
}

/** Start using a medical item. No effect and no consumption happen before the commit time. */
export function startMedical(ctx: SimContext, a: ActorState, itemId: string): UseResult {
  if (a.action) return 'busy';
  if (!isCarried(ctx, a, itemId)) return 'invalid';
  const it = ctx.sim.store.items[itemId]!;
  const def = ctx.content.item(it.definitionId);
  const med = def.medical;
  if (!med) return 'invalid';
  if (med.type === 'bandage' && !a.status.bleeding) return 'not_needed';
  if (med.type === 'firstaid' && a.hp >= a.maxHp - 0.01) return 'not_needed';
  a.sprinting = false;
  a.action = { type: 'heal', start: ctx.sim.time, duration: medicalUseTime(ctx, a, med.type, med.useTime), elapsed: 0, itemId, healed: 0, steps: [] };
  return 'started';
}

/** Returns true when finished (or invalid). First-aid heals continuously and only spends what it healed. */
export function tickHeal(ctx: SimContext, a: ActorState, act: ActionState, dt: number): boolean {
  const it = act.itemId ? ctx.sim.store.items[act.itemId] : undefined;
  if (!it || !isCarried(ctx, a, it.instanceId)) return true;
  const med = ctx.content.item(it.definitionId).medical;
  if (!med) return true;
  if (med.type === 'firstaid') {
    const rate = (med.pool ?? 40) / Math.max(0.1, act.duration);
    const pool = it.medPool ?? med.pool ?? 40;
    const missing = a.maxHp - a.hp;
    const heal = Math.min(rate * dt, missing, pool);
    if (heal > 0) {
      a.hp += heal;
      it.medPool = pool - heal;
      act.healed = (act.healed ?? 0) + heal;
      ctx.sim.stats.healed += heal;
    }
    if ((it.medPool ?? 0) <= 1e-6) {
      destroyItem(ctx.sim.store, it.instanceId);
      ctx.sim.fx.push({ t: 'heal', actorId: a.id, kind: 'firstaid_empty' });
      return true;
    }
    if (act.elapsed >= act.duration - 1e-9 || a.hp >= a.maxHp - 1e-9) {
      ctx.sim.fx.push({ t: 'heal', actorId: a.id, kind: 'firstaid' });
      return true;
    }
    return false;
  }
  if (act.elapsed + 1e-9 < act.duration) return false;
  // Commit: consume one unit and apply the effect.
  if (it.quantity > 1) it.quantity -= 1;
  else destroyItem(ctx.sim.store, it.instanceId);
  if (med.type === 'bandage') a.status.bleeding = false;
  if (med.type === 'painkiller') a.status.painkillerUntil = ctx.sim.time + (med.painkillerDuration ?? PAINKILLER_DURATION);
  ctx.sim.fx.push({ t: 'heal', actorId: a.id, kind: med.type });
  return true;
}

/** Bleeding damage; returns true if the actor died from it. */
export function tickStatus(ctx: SimContext, a: ActorState, dt: number): boolean {
  if (!a.alive) return false;
  if (a.status.bleeding) {
    const mult = a.kind === 'player' ? (ctx.sim.perks.bleedRateMult ?? 1) : 1;
    // Invulnerable actors (range dummies, NPCs, debug god mode) never bleed out either.
    if (!(a.invulnerable || (a.kind === 'player' && ctx.sim.debug.god))) a.hp = Math.max(0, a.hp - BLEED_RATE * mult * dt);
    if (a.hp <= 0) return true;
  }
  return false;
}
