import type { EquipSlot } from '../content/types';
import { bagContainerId, instantiate, mergeStacks, moveItem, placeNew, splitStack, type Placement } from '../inventory/store';
import { startLoadMagazine } from '../combat/reload';
import type { RaidOp } from './command';
import { allCarriedItemIds, carriedContainerIds, equippedId, type SimContext } from './context';
import { dropItem, stowOrDrop } from './containers';
import { startMedical } from './medical';
import { carriedWeightKg, deepItemWeightKg, stackWeightKg, WEIGHT } from './movement';
import { eqContainerId, type ActorState } from './state';
import { startThrow } from './throwables';
import { setRangePreset, setRangeWeapon } from './range';

export interface OpResult {
  ok: boolean;
  error?: string;
}

const EQUIP: EquipSlot[] = ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'];

function playerContainers(ctx: SimContext, a: ActorState): string[] {
  return [...EQUIP.map((s) => eqContainerId(a.id, s)), ...carriedContainerIds(ctx.sim, a)];
}

/** Items that the player may currently touch: carried, or revealed items of the open loot container. */
export function accessible(ctx: SimContext, a: ActorState, itemId: string): boolean {
  const it = ctx.sim.store.items[itemId];
  if (!it || !it.ownerContainerId) return false;
  const owner = it.ownerContainerId;
  if (playerContainers(ctx, a).includes(owner)) return true;
  const loot = ctx.sim.loot?.containerId;
  if (loot && owner === loot) {
    const wc = ctx.sim.containers[loot];
    const c = ctx.sim.store.containers[loot];
    if (!wc || !c) return false;
    if (wc.locked) return false;
    const idx = c.items.indexOf(itemId);
    return idx >= 0 && idx < wc.searched;
  }
  return false;
}

function targetAllowed(ctx: SimContext, a: ActorState, cid: string): boolean {
  if (playerContainers(ctx, a).includes(cid)) return true;
  return ctx.sim.loot?.containerId === cid && !ctx.sim.containers[cid]?.locked;
}

function isCarriedTarget(ctx: SimContext, a: ActorState, cid: string): boolean {
  return playerContainers(ctx, a).includes(cid);
}

/** Is the item already part of what the actor carries (directly, in a bag, or inside a carried weapon/bag)? */
function isCarriedItem(ctx: SimContext, a: ActorState, itemId: string): boolean {
  return allCarriedItemIds(ctx.sim, a).includes(itemId);
}

/** Would taking `addKg` more push the actor over the 40 kg hard limit? */
function overLimit(ctx: SimContext, a: ActorState, addKg: number): boolean {
  return carriedWeightKg(ctx, a) + addKg > WEIGHT.heavy + 1e-9;
}

function wouldOverweight(ctx: SimContext, a: ActorState, itemId: string, targetCid: string): boolean {
  const it = ctx.sim.store.items[itemId];
  if (!it) return false;
  if (!isCarriedTarget(ctx, a, targetCid)) return false;
  if (isCarriedItem(ctx, a, itemId)) return false;
  // Count the whole item: a loaded weapon's magazine and rounds, a bag's contents.
  return overLimit(ctx, a, deepItemWeightKg(ctx, itemId));
}

export function applyOp(ctx: SimContext, a: ActorState, op: RaidOp): OpResult {
  const sim = ctx.sim;
  const store = sim.store;
  switch (op.op) {
    case 'move': {
      if (!accessible(ctx, a, op.itemId) || !targetAllowed(ctx, a, op.target.containerId)) return { ok: false, error: 'inv.err.no_access' };
      if (wouldOverweight(ctx, a, op.itemId, op.target.containerId)) return { ok: false, error: 'inv.err.overweight' };
      if (a.action && (a.action.itemId === op.itemId || a.action.newMagId === op.itemId)) return { ok: false, error: 'inv.err.in_use' };
      const r = moveItem(store, ctx.content, op.itemId, op.target);
      if (r.ok) noteRetrieved(ctx, op.itemId);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case 'equip': {
      if (!accessible(ctx, a, op.itemId)) return { ok: false, error: 'inv.err.no_access' };
      const slotCid = eqContainerId(a.id, op.slot);
      if (wouldOverweight(ctx, a, op.itemId, slotCid)) return { ok: false, error: 'inv.err.overweight' };
      if (a.action) return { ok: false, error: 'inv.err.busy' };
      const current = equippedId(sim, a.id, op.slot);
      if (current === op.itemId) return { ok: true };
      const it = store.items[op.itemId]!;
      const from: Placement = { containerId: it.ownerContainerId!, ...(it.gridPosition ? { x: it.gridPosition.x, y: it.gridPosition.y } : {}) };
      if (current) {
        if (op.slot === 'backpack') return { ok: false, error: 'inv.err.swap_bag' };
        store.containers[`swap:${a.id}`] = { id: `swap:${a.id}`, kind: 'list', w: 0, h: 0, items: [] };
        const tmp = moveItem(store, ctx.content, current, { containerId: `swap:${a.id}` });
        if (!tmp.ok) {
          delete store.containers[`swap:${a.id}`];
          return { ok: false, error: tmp.error };
        }
      }
      const r = moveItem(store, ctx.content, op.itemId, { containerId: slotCid });
      if (!r.ok) {
        if (current) moveItem(store, ctx.content, current, { containerId: slotCid });
        delete store.containers[`swap:${a.id}`];
        return { ok: false, error: r.error };
      }
      if (current) {
        const back = moveItem(store, ctx.content, current, { containerId: from.containerId });
        if (!back.ok) stowOrDrop(ctx, a, current);
        delete store.containers[`swap:${a.id}`];
      }
      noteRetrieved(ctx, op.itemId);
      return { ok: true };
    }
    case 'unequip': {
      const id = equippedId(sim, a.id, op.slot);
      if (!id) return { ok: false, error: 'inv.err.no_item' };
      if (op.slot === 'backpack') return { ok: false, error: 'inv.err.swap_bag' };
      if (a.action) return { ok: false, error: 'inv.err.busy' };
      stowOrDrop(ctx, a, id);
      return { ok: true };
    }
    case 'use': {
      if (!accessible(ctx, a, op.itemId)) return { ok: false, error: 'inv.err.no_access' };
      const it = store.items[op.itemId]!;
      const def = ctx.content.item(it.definitionId);
      if (!carriedContainerIds(sim, a).includes(it.ownerContainerId ?? '')) return { ok: false, error: 'inv.err.not_carried' };
      if (def.medical) {
        const r = startMedical(ctx, a, op.itemId);
        return r === 'started' ? { ok: true } : { ok: false, error: `med.${r}` };
      }
      if (def.throwable) return startThrow(ctx, a, op.itemId, { x: a.aim.targetX, y: a.aim.targetY }) ? { ok: true } : { ok: false, error: 'inv.err.busy' };
      return { ok: false, error: 'inv.err.not_usable' };
    }
    case 'drop': {
      if (!accessible(ctx, a, op.itemId)) return { ok: false, error: 'inv.err.no_access' };
      const it = store.items[op.itemId]!;
      if (!playerContainers(ctx, a).includes(it.ownerContainerId ?? '')) return { ok: false, error: 'inv.err.not_carried' };
      if (it.lockTags.includes('favorite')) return { ok: false, error: 'inv.err.locked' };
      if (ctx.content.item(it.definitionId).kind === 'backpack') {
        const bag = store.containers[bagContainerId(it.instanceId)];
        if (bag && bag.items.length > 0) return { ok: false, error: 'inv.err.bag_not_empty' };
      }
      return dropItem(ctx, a, op.itemId) ? { ok: true } : { ok: false, error: 'inv.err.no_space' };
    }
    case 'split': {
      if (!accessible(ctx, a, op.itemId) || !targetAllowed(ctx, a, op.target.containerId)) return { ok: false, error: 'inv.err.no_access' };
      const src = store.items[op.itemId];
      if (src && isCarriedTarget(ctx, a, op.target.containerId) && !isCarriedItem(ctx, a, op.itemId) && Number.isFinite(op.qty) && op.qty > 0 && overLimit(ctx, a, stackWeightKg(ctx, src.definitionId, op.qty))) return { ok: false, error: 'inv.err.overweight' };
      const r = splitStack(store, ctx.content, sim.ids, op.itemId, op.qty, op.target);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case 'merge': {
      if (!accessible(ctx, a, op.fromId) || !accessible(ctx, a, op.toId)) return { ok: false, error: 'inv.err.no_access' };
      const to = store.items[op.toId]!;
      if (wouldOverweight(ctx, a, op.fromId, to.ownerContainerId ?? '')) return { ok: false, error: 'inv.err.overweight' };
      const r = mergeStacks(store, ctx.content, op.fromId, op.toId);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case 'loadMag': {
      if (!accessible(ctx, a, op.magId)) return { ok: false, error: 'inv.err.no_access' };
      return startLoadMagazine(ctx, a, op.magId, op.ammoDefId) ? { ok: true } : { ok: false, error: 'inv.err.busy' };
    }
    case 'unloadMag': {
      if (!accessible(ctx, a, op.magId)) return { ok: false, error: 'inv.err.no_access' };
      const mag = store.items[op.magId];
      if (!mag?.mag || mag.mag.rounds.length === 0) return { ok: false, error: 'inv.err.empty' };
      if (a.action) return { ok: false, error: 'inv.err.busy' };
      // Rounds from a loot magazine are new weight for the carrier (they are stowed into the bag).
      if (!isCarriedItem(ctx, a, op.magId)) {
        const kg = mag.mag.rounds.reduce((s, r) => s + (ctx.content.item(r).unitWeightKg ?? 0.01), 0);
        if (overLimit(ctx, a, kg)) return { ok: false, error: 'inv.err.overweight' };
      }
      const counts = new Map<string, number>();
      for (const r of mag.mag.rounds) counts.set(r, (counts.get(r) ?? 0) + 1);
      mag.mag.rounds = [];
      for (const [defId, n] of counts) {
        let left = n;
        while (left > 0) {
          const q = Math.min(left, ctx.content.item(defId).stackMax);
          const st = instantiate(ctx.content, sim.ids, defId, { quantity: q });
          st.quantity = q;
          const tmpCid = `swap:${a.id}`;
          store.containers[tmpCid] = store.containers[tmpCid] ?? { id: tmpCid, kind: 'list', w: 0, h: 0, items: [] };
          placeNew(store, ctx.content, st, { containerId: tmpCid });
          stowOrDrop(ctx, a, st.instanceId);
          left -= q;
        }
      }
      delete store.containers[`swap:${a.id}`];
      return { ok: true };
    }
    case 'quickslot': {
      if (op.index < 0 || op.index > 3) return { ok: false, error: 'inv.err.bad_slot' };
      if (op.itemId) {
        const it = store.items[op.itemId];
        if (!it || !accessible(ctx, a, op.itemId)) return { ok: false, error: 'inv.err.no_access' };
        const d = ctx.content.item(it.definitionId);
        if (!d.medical && !d.throwable) return { ok: false, error: 'inv.err.not_usable' };
        for (let i = 0; i < 4; i++) if (a.quickslots[i] === op.itemId) a.quickslots[i] = null;
      }
      a.quickslots[op.index] = op.itemId;
      return { ok: true };
    }
    case 'takeAll': {
      const loot = sim.loot?.containerId;
      if (!loot) return { ok: false, error: 'inv.err.no_container' };
      const c = store.containers[loot];
      const wc = sim.containers[loot];
      if (!c || !wc || wc.locked) return { ok: false, error: 'inv.err.no_container' };
      const revealed = c.items.slice(0, wc.searched);
      let moved = 0;
      for (const id of revealed) {
        if (!store.items[id]) continue;
        const targets = carriedContainerIds(sim, a);
        let done = false;
        for (const t of targets) {
          if (wouldOverweight(ctx, a, id, t)) continue;
          if (moveItem(store, ctx.content, id, { containerId: t }).ok) {
            done = true;
            noteRetrieved(ctx, id);
            break;
          }
        }
        if (done) moved++;
      }
      return moved > 0 ? { ok: true } : { ok: false, error: 'inv.err.no_space' };
    }
    case 'closeLoot':
      sim.loot = null;
      return { ok: true };
    case 'readNote':
      if (!sim.progress.custom.includes(`read:${op.noteId}`)) sim.progress.custom.push(`read:${op.noteId}`);
      return { ok: true };
    case 'abandon':
      if (sim.mode === 'raid' && !sim.outcome) sim.outcome = { kind: 'abandoned', tick: sim.tick };
      return { ok: true };
    case 'rangePreset':
      if (sim.mode !== 'base') return { ok: false, error: 'inv.err.base_only' };
      setRangePreset(ctx, op.preset);
      return { ok: true };
    case 'rangeWeapon':
      if (sim.mode !== 'base' || !ctx.content.hasItem(op.defId) || ctx.content.item(op.defId).kind !== 'weapon') return { ok: false, error: 'inv.err.base_only' };
      setRangeWeapon(ctx, op.defId);
      return { ok: true };
  }
}

function noteRetrieved(ctx: SimContext, itemId: string): void {
  const it = ctx.sim.store.items[itemId];
  if (!it) return;
  if (!ctx.sim.progress.retrieved.includes(it.definitionId)) ctx.sim.progress.retrieved.push(it.definitionId);
}
