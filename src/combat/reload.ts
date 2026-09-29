import type { ContentRegistry } from '../content/registry';
import { attachChild, destroyItem, instantiate, type ItemInstance } from '../inventory/store';
import { activeWeaponItem, carriedContainerIds, type SimContext } from '../world/context';
import { dropItem, stowOrDrop } from '../world/containers';
import { standardMagazineFor } from '../world/spawn';
import { isTraining, type ActionState, type ActorState } from '../world/state';
import { magazineOf } from './weapons';

/**
 * Reload state machines with explicit commit points. Cancelling keeps every change that was already committed.
 *   Magazine reload: remove @35% → insert @70% → chamber @100% (empty reload only).
 *   Quick reload (double R within 0.25s): old magazine dropped once, total time ×0.8.
 *   Tube (SG-P): open 0.40 → 0.55/round → [+0.40 chamber if empty] → close 0.35.
 *   Loose rounds into a magazine: 0.20s per round.
 *
 * Player R (tap) is always a one-shot magazine swap to the fullest carried magazine. Topping up the inserted
 * magazine from loose rounds is an explicit choice (hold R → allowRefill); AI keeps the automatic refill.
 * Training sims (shelter / range / tutorial): the player's reloads draw from an unlimited training reserve — a fresh
 * full magazine of the inserted type (the old one is discarded) or free shells for tube weapons.
 */

export const QUICK_RELOAD_WINDOW = 0.25;
export const QUICK_RELOAD_MULT = 0.8;
export const LOOSE_ROUND_TIME = 0.2;
export const UNLOAD_ROUND_TIME = 0.1;
export const CHAMBER_ONLY_TIME = 0.45;
/** Holding R this long tops up the inserted magazine from loose rounds (when no fuller magazine is carried). */
export const RELOAD_HOLD_TIME = 0.45;

/**
 * no_mag: no fuller magazine is carried, but loose rounds are (hold R to top up).
 * no_better: only emptier magazines are carried and there are no loose rounds.
 */
export type ReloadRequest = 'started' | 'converted' | 'full' | 'no_ammo' | 'no_mag' | 'no_better' | 'busy' | 'no_weapon';

export interface ReloadOpts {
  /** Refill the inserted magazine round by round when no fuller magazine exists. Default: AI yes, player no. */
  allowRefill?: boolean;
}

/** Standard training round of a caliber (FMJ / buckshot), found by data for extension calibers. */
export function standardAmmoFor(content: ContentRegistry, caliber: string): string {
  const canonical = caliber === '12g' ? 'core.ammo.12g.buck' : `core.ammo.${caliber}.fmj`;
  if (content.hasItem(canonical)) return canonical;
  const list = [...content.items.values()].filter((d) => d.ammo?.caliber === caliber).sort((a, b) => a.id.localeCompare(b.id));
  if (!list[0]) throw new Error(`no ammo definition for caliber ${caliber}`);
  return list[0].id;
}

/** Does this actor reload from the unlimited training reserve? */
export function usesTrainingReserve(ctx: SimContext, a: ActorState): boolean {
  return a.kind === 'player' && isTraining(ctx.sim);
}

function carriedItems(ctx: SimContext, a: ActorState): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const cid of carriedContainerIds(ctx.sim, a)) {
    const c = ctx.sim.store.containers[cid];
    if (!c) continue;
    for (const id of c.items) {
      const it = ctx.sim.store.items[id];
      if (it) out.push(it);
    }
  }
  return out;
}

export function compatibleMagazines(ctx: SimContext, a: ActorState, w: ItemInstance): ItemInstance[] {
  const fam = ctx.content.item(w.definitionId).weapon!.magazineFamily;
  if (!fam) return [];
  return carriedItems(ctx, a).filter((it) => {
    const d = ctx.content.item(it.definitionId);
    return d.magazine?.family === fam && it.instanceId !== w.weapon?.magazineId;
  });
}

export function bestMagazine(ctx: SimContext, a: ActorState, w: ItemInstance): ItemInstance | null {
  const mags = compatibleMagazines(ctx, a, w).filter((m) => (m.mag?.rounds.length ?? 0) > 0);
  mags.sort((x, y) => (y.mag!.rounds.length - x.mag!.rounds.length) || x.instanceId.localeCompare(y.instanceId));
  return mags[0] ?? null;
}

export function looseAmmo(ctx: SimContext, a: ActorState, caliber: string, prefer: string | null): ItemInstance[] {
  const stacks = carriedItems(ctx, a).filter((it) => ctx.content.item(it.definitionId).ammo?.caliber === caliber && it.lockTags.length === 0);
  stacks.sort((x, y) => {
    const px = x.definitionId === prefer ? 1 : 0;
    const py = y.definitionId === prefer ? 1 : 0;
    return py - px || y.quantity - x.quantity || x.instanceId.localeCompare(y.instanceId);
  });
  return stacks;
}

function takeRound(ctx: SimContext, stack: ItemInstance): string {
  const id = stack.definitionId;
  stack.quantity -= 1;
  if (stack.quantity <= 0) destroyItem(ctx.sim.store, stack.instanceId);
  return id;
}

export function requestReload(ctx: SimContext, a: ActorState, quickPress: boolean, opts: ReloadOpts = {}): ReloadRequest {
  const sim = ctx.sim;
  const aw = activeWeaponItem(ctx, a);
  if (!aw) return 'no_weapon';
  const w = aw.item;
  const spec = aw.def.weapon!;
  const perkMult = a.kind === 'player' ? (sim.perks.reloadMult ?? 1) : 1;
  const allowRefill = opts.allowRefill ?? a.kind !== 'player';
  const training = usesTrainingReserve(ctx, a);
  // Second R within the window converts an in-progress magazine reload into a quick reload.
  if (a.action && a.action.type === 'reload' && a.action.weaponId === w.instanceId) {
    if (quickPress && !a.action.quick && sim.time - a.action.start <= QUICK_RELOAD_WINDOW && !a.action.steps.includes('remove') && a.action.oldMagId) {
      a.action.quick = true;
      a.action.duration *= QUICK_RELOAD_MULT;
      return 'converted';
    }
    return 'busy';
  }
  if (a.action) return 'busy';
  const wr = w.weapon!;
  if (wr.tube) {
    const cap = spec.capacity;
    if (wr.tube.length >= cap && wr.chamber) return 'full';
    const prefer = wr.chamber ?? wr.tube[wr.tube.length - 1] ?? null;
    const stacks = looseAmmo(ctx, a, spec.caliber, prefer);
    if (stacks.length === 0 && !training) {
      if (!wr.chamber && wr.tube.length > 0) {
        a.action = { type: 'tubeReload', start: sim.time, duration: 0.4, elapsed: 0, weaponId: w.instanceId, steps: [], phase: 'chamberOnly', nextCommitAt: 0.4, roundsDone: 0 };
        return 'started';
      }
      return 'no_ammo';
    }
    // Training: free shells of the loaded type (tube weapons still load shell by shell — that is how they work).
    const ammoDefId = training ? (prefer ?? standardAmmoFor(ctx.content, spec.caliber)) : stacks[0]!.definitionId;
    a.action = { type: 'tubeReload', start: sim.time, duration: 99, elapsed: 0, weaponId: w.instanceId, steps: [], phase: 'open', nextCommitAt: spec.tube!.open * perkMult, roundsDone: 0, ammoDefId, ...(training ? { training: true } : {}) };
    return 'started';
  }
  const mag = magazineOf(ctx, w);
  const curRounds = mag?.mag?.rounds.length ?? 0;
  if (training) {
    const magDefId = mag ? mag.definitionId : standardMagazineFor(ctx.content, spec.magazineFamily!, spec.caliber);
    const magDef = ctx.content.item(magDefId).magazine!;
    if (mag && curRounds >= magDef.capacity) {
      if (wr.chamber) return 'full';
      a.action = { type: 'reload', start: sim.time, duration: CHAMBER_ONLY_TIME * perkMult, elapsed: 0, weaponId: w.instanceId, newMagId: null, oldMagId: null, quick: false, steps: ['remove', 'insert'] };
      return 'started';
    }
    const empty = !wr.chamber;
    const T = (empty ? spec.reloadEmpty : spec.reloadTactical) * magDef.reloadMult * perkMult;
    const ammoDefId = mag?.mag?.rounds[mag.mag.rounds.length - 1] ?? wr.chamber ?? standardAmmoFor(ctx.content, spec.caliber);
    a.action = { type: 'reload', start: sim.time, duration: T, elapsed: 0, weaponId: w.instanceId, newMagId: null, oldMagId: mag?.instanceId ?? null, quick: false, steps: empty ? [] : ['noChamber'], training: true, magDefId, ammoDefId };
    if (!mag) a.action.steps.push('remove');
    return 'started';
  }
  const best = bestMagazine(ctx, a, w);
  if (best && (!mag || best.mag!.rounds.length > curRounds)) {
    const empty = !wr.chamber;
    const magDef = ctx.content.item(best.definitionId).magazine!;
    const T = (empty ? spec.reloadEmpty : spec.reloadTactical) * magDef.reloadMult * perkMult;
    a.action = { type: 'reload', start: sim.time, duration: T, elapsed: 0, weaponId: w.instanceId, newMagId: best.instanceId, oldMagId: mag?.instanceId ?? null, quick: false, steps: empty ? [] : ['noChamber'] };
    if (!mag) a.action.steps.push('remove');
    return 'started';
  }
  if (!wr.chamber && curRounds > 0) {
    a.action = { type: 'reload', start: sim.time, duration: CHAMBER_ONLY_TIME * perkMult, elapsed: 0, weaponId: w.instanceId, newMagId: null, oldMagId: null, quick: false, steps: ['remove', 'insert'] };
    return 'started';
  }
  // No fuller magazine: top up the inserted magazine from loose rounds (AI automatically, the player on hold R).
  if (mag?.mag) {
    const cap = ctx.content.item(mag.definitionId).magazine!.capacity;
    if (mag.mag.rounds.length < cap) {
      const stacks = looseAmmo(ctx, a, spec.caliber, mag.mag.rounds[mag.mag.rounds.length - 1] ?? wr.chamber);
      if (stacks.length > 0) {
        if (!allowRefill) return 'no_mag';
        a.action = { type: 'refillMag', start: sim.time, duration: 99, elapsed: 0, weaponId: w.instanceId, steps: [], phase: 'remove', nextCommitAt: 0.3 * perkMult, roundsDone: 0, ammoDefId: stacks[0]!.definitionId };
        return 'started';
      }
      if (compatibleMagazines(ctx, a, w).some((m) => (m.mag?.rounds.length ?? 0) > 0)) return 'no_better';
    } else if (wr.chamber) return 'full';
  }
  return 'no_ammo';
}

/** Magazine reload tick. Returns true when the action finished (or was aborted). */
export function tickMagReload(ctx: SimContext, a: ActorState, act: ActionState): boolean {
  const w = act.weaponId ? ctx.sim.store.items[act.weaponId] : undefined;
  if (!w?.weapon) return true;
  const T = act.duration;
  if (!act.steps.includes('remove') && act.elapsed + 1e-9 >= 0.35 * T) {
    const old = act.oldMagId ? ctx.sim.store.items[act.oldMagId] : undefined;
    if (old && w.weapon.magazineId === old.instanceId) {
      // Training reserve: the spent magazine goes back to the range, nothing piles up in the bag.
      if (act.training) destroyItem(ctx.sim.store, old.instanceId);
      else if (act.quick) dropItem(ctx, a, old.instanceId);
      else stowOrDrop(ctx, a, old.instanceId);
      ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: act.quick ? 'magDrop' : 'magOut' });
    }
    act.steps.push('remove');
  }
  if (act.steps.includes('remove') && !act.steps.includes('insert') && act.elapsed + 1e-9 >= 0.7 * T) {
    if (act.training && act.magDefId && act.ammoDefId) {
      if (w.weapon.magazineId) return true;
      // Fresh full training magazine, created at the insert commit so it is never an unowned item.
      const nm = instantiate(ctx.content, ctx.sim.ids, act.magDefId);
      const cap = ctx.content.item(act.magDefId).magazine!.capacity;
      nm.mag!.rounds = Array.from({ length: cap }, () => act.ammoDefId!);
      ctx.sim.store.items[nm.instanceId] = nm;
      attachChild(ctx.sim.store, w.instanceId, nm.instanceId, { magazine: true });
      act.newMagId = nm.instanceId;
    } else {
      const nm = act.newMagId ? ctx.sim.store.items[act.newMagId] : undefined;
      const carried = nm && carriedContainerIds(ctx.sim, a).includes(nm.ownerContainerId ?? '');
      if (!nm || !carried || w.weapon.magazineId) {
        return true; // magazine vanished (dropped/looted) — abort, keep commits
      }
      attachChild(ctx.sim.store, w.instanceId, nm.instanceId, { magazine: true });
    }
    act.steps.push('insert');
    ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'magIn' });
    if (ctx.sim.range && a.kind === 'player') ctx.sim.range.reloads++;
  }
  if (act.elapsed + 1e-9 >= T) {
    if (!act.steps.includes('noChamber') && !w.weapon.chamber) {
      const mag = magazineOf(ctx, w);
      if (mag?.mag && mag.mag.rounds.length > 0) {
        w.weapon.chamber = mag.mag.rounds.pop()!;
        ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'chamber' });
      }
    }
    act.steps.push('done');
    return true;
  }
  return false;
}

export function tickTubeReload(ctx: SimContext, a: ActorState, act: ActionState): boolean {
  const w = act.weaponId ? ctx.sim.store.items[act.weaponId] : undefined;
  if (!w?.weapon?.tube) return true;
  const spec = ctx.content.item(w.definitionId).weapon!;
  const tube = spec.tube!;
  const perkMult = a.kind === 'player' ? (ctx.sim.perks.reloadMult ?? 1) : 1;
  // Training reserve hands out free shells of the loaded type; otherwise shells come from carried loose stacks.
  const free = !!act.training && !!act.ammoDefId;
  const hasShell = () => free || looseAmmo(ctx, a, spec.caliber, act.ammoDefId ?? null).length > 0;
  const nextShell = () => (free ? act.ammoDefId! : takeRound(ctx, looseAmmo(ctx, a, spec.caliber, act.ammoDefId ?? null)[0]!));
  let guard = 0;
  while (act.nextCommitAt !== undefined && act.elapsed >= act.nextCommitAt && guard++ < 16) {
    switch (act.phase) {
      case 'chamberOnly':
        if (!w.weapon.chamber && w.weapon.tube.length > 0) w.weapon.chamber = w.weapon.tube.pop()!;
        ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'pump' });
        return true;
      case 'open':
        ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'open' });
        if (!w.weapon.chamber) {
          // Empty chamber: +0.40s to load one shell straight into the chamber first.
          act.phase = 'chamber';
          act.nextCommitAt += tube.chamber * perkMult;
        } else {
          act.phase = 'load';
          act.nextCommitAt += tube.perRound * perkMult;
        }
        break;
      case 'load': {
        if (w.weapon.tube.length < spec.capacity && hasShell()) {
          w.weapon.tube.push(nextShell());
          act.roundsDone = (act.roundsDone ?? 0) + 1;
          ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'shell' });
          if (ctx.sim.range && a.kind === 'player' && act.roundsDone === 1) ctx.sim.range.reloads++;
        }
        const more = w.weapon.tube.length < spec.capacity && hasShell();
        if (more) act.nextCommitAt += tube.perRound * perkMult;
        else {
          act.phase = 'close';
          act.nextCommitAt += tube.close * perkMult;
        }
        break;
      }
      case 'chamber': {
        if (!w.weapon.chamber) {
          if (hasShell()) w.weapon.chamber = nextShell();
          else if (w.weapon.tube.length > 0) w.weapon.chamber = w.weapon.tube.pop()!;
          if (ctx.sim.range && a.kind === 'player' && (act.roundsDone ?? 0) === 0) ctx.sim.range.reloads++;
          act.roundsDone = (act.roundsDone ?? 0) + 1;
        }
        ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'pump' });
        const more = w.weapon.tube.length < spec.capacity && hasShell();
        if (more) {
          act.phase = 'load';
          act.nextCommitAt += tube.perRound * perkMult;
        } else {
          act.phase = 'close';
          act.nextCommitAt += tube.close * perkMult;
        }
        break;
      }
      case 'close':
        ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'close' });
        return true;
      default:
        return true;
    }
  }
  return false;
}

export function tickRefillMag(ctx: SimContext, a: ActorState, act: ActionState): boolean {
  const w = act.weaponId ? ctx.sim.store.items[act.weaponId] : undefined;
  if (!w?.weapon) return true;
  const mag = magazineOf(ctx, w);
  if (!mag?.mag) return true;
  const spec = ctx.content.item(w.definitionId).weapon!;
  const cap = ctx.content.item(mag.definitionId).magazine!.capacity;
  let guard = 0;
  while (act.nextCommitAt !== undefined && act.elapsed >= act.nextCommitAt && guard++ < 64) {
    if (act.phase === 'remove') {
      act.phase = 'load';
      act.nextCommitAt += LOOSE_ROUND_TIME;
      ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'magOut' });
    } else if (act.phase === 'load') {
      const stacks = looseAmmo(ctx, a, spec.caliber, act.ammoDefId ?? null);
      if (mag.mag.rounds.length < cap && stacks.length > 0) {
        mag.mag.rounds.push(takeRound(ctx, stacks[0]!));
        act.roundsDone = (act.roundsDone ?? 0) + 1;
      }
      if (mag.mag.rounds.length < cap && looseAmmo(ctx, a, spec.caliber, act.ammoDefId ?? null).length > 0) act.nextCommitAt += LOOSE_ROUND_TIME;
      else {
        act.phase = 'insert';
        act.nextCommitAt += 0.4;
      }
    } else if (act.phase === 'insert') {
      ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'magIn' });
      if (!w.weapon.chamber) {
        act.phase = 'chamber';
        act.nextCommitAt += 0.3;
      } else return true;
    } else if (act.phase === 'chamber') {
      if (!w.weapon.chamber && mag.mag.rounds.length > 0) w.weapon.chamber = mag.mag.rounds.pop()!;
      ctx.sim.fx.push({ t: 'reload', actorId: a.id, step: 'chamber' });
      return true;
    } else return true;
  }
  return false;
}

/** Start loading loose rounds into a carried magazine (inventory action, 0.2s per round). */
export function startLoadMagazine(ctx: SimContext, a: ActorState, magId: string, ammoDefId: string): boolean {
  if (a.action) return false;
  const mag = ctx.sim.store.items[magId];
  if (!mag?.mag) return false;
  a.action = { type: 'loadMag', start: ctx.sim.time, duration: 999, elapsed: 0, itemId: magId, ammoDefId, steps: [], nextCommitAt: LOOSE_ROUND_TIME, roundsDone: 0 };
  return true;
}

export function tickLoadMag(ctx: SimContext, a: ActorState, act: ActionState): boolean {
  const mag = act.itemId ? ctx.sim.store.items[act.itemId] : undefined;
  if (!mag?.mag || !act.ammoDefId) return true;
  const md = ctx.content.item(mag.definitionId).magazine!;
  const ammoCal = ctx.content.item(act.ammoDefId).ammo?.caliber;
  if (ammoCal !== md.caliber) return true;
  let guard = 0;
  while (act.nextCommitAt !== undefined && act.elapsed >= act.nextCommitAt && guard++ < 128) {
    const stacks = looseAmmo(ctx, a, md.caliber, act.ammoDefId).filter((s) => s.definitionId === act.ammoDefId);
    if (mag.mag.rounds.length >= md.capacity || stacks.length === 0) return true;
    mag.mag.rounds.push(takeRound(ctx, stacks[0]!));
    act.roundsDone = (act.roundsDone ?? 0) + 1;
    act.nextCommitAt += LOOSE_ROUND_TIME;
  }
  return mag.mag.rounds.length >= md.capacity;
}

/** Total rounds an actor holds for a caliber: chambers + magazines + tubes + loose stacks (conservation checks). */
export function totalRounds(ctx: SimContext, itemIds: string[], caliber: string): number {
  let n = 0;
  for (const id of itemIds) {
    const it = ctx.sim.store.items[id];
    if (!it) continue;
    const d = ctx.content.item(it.definitionId);
    if (d.ammo?.caliber === caliber) n += it.quantity;
    if (d.magazine?.caliber === caliber) n += it.mag?.rounds.length ?? 0;
    if (d.weapon?.caliber === caliber) {
      if (it.weapon?.chamber) n++;
      if (it.weapon?.tube) n += it.weapon.tube.length;
    }
  }
  return n;
}
