import { tickLoadMag, tickMagReload, tickRefillMag, tickTubeReload } from '../combat/reload';
import { equippedItem, type SimContext } from './context';
import { tickHeal } from './medical';
import { tickMelee } from './melee';
import type { ActorState, WeaponSlot } from './state';
import { tickThrowAction } from './throwables';

/** Advance the actor's single timed action. Committed steps persist even if the action is later cancelled. */
export function tickAction(ctx: SimContext, a: ActorState, dt: number): void {
  const act = a.action;
  if (!act) return;
  act.elapsed += dt;
  let done = false;
  switch (act.type) {
    case 'reload':
      done = tickMagReload(ctx, a, act);
      break;
    case 'tubeReload':
      done = tickTubeReload(ctx, a, act);
      break;
    case 'refillMag':
      done = tickRefillMag(ctx, a, act);
      break;
    case 'loadMag':
      done = tickLoadMag(ctx, a, act);
      break;
    case 'heal':
      done = tickHeal(ctx, a, act, dt);
      break;
    case 'melee':
      done = tickMelee(ctx, a);
      break;
    case 'throw':
      done = tickThrowAction(ctx, a);
      break;
    case 'switch':
      if (act.elapsed + 1e-9 >= act.duration) {
        if (act.toSlot) a.activeSlot = act.toSlot;
        done = true;
      }
      break;
    case 'sprintStop':
    case 'unloadMag':
    case 'dodge': // movement and invulnerability live in world/dodge.ts; the action only times the roll
      done = act.elapsed + 1e-9 >= act.duration;
      break;
  }
  if (done && a.action === act) a.action = null;
}

export function cancelAction(a: ActorState): void {
  a.action = null;
}

export function requestSwitch(ctx: SimContext, a: ActorState, slot: WeaponSlot): boolean {
  if (slot === a.activeSlot && !(a.action?.type === 'switch')) return false;
  const it = equippedItem(ctx.sim, a.id, slot);
  if (!it) return false;
  if (a.action && a.action.type !== 'reload' && a.action.type !== 'tubeReload' && a.action.type !== 'refillMag' && a.action.type !== 'switch' && a.action.type !== 'sprintStop') return false;
  const def = ctx.content.item(it.definitionId);
  const base = def.weapon?.equipTime ?? 0.3;
  const mult = a.kind === 'player' ? (ctx.sim.perks.swapTimeMult ?? 1) : 1;
  a.action = { type: 'switch', start: ctx.sim.time, duration: base * mult, elapsed: 0, toSlot: slot, steps: [] };
  a.handling.adsT = 0;
  return true;
}
