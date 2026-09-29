/**
 * A07 — "인벤토리 이동·분할·합치기·과적에서 단일 소유권 유지"
 * (inventory move / split / merge / overweight keep single ownership)
 *
 * Three layers are exercised: the store API (src/inventory/store.ts), raid ops applied through stepSim
 * (src/world/ops.ts) and shelter actions inside runTx (src/progression/actions.ts). After every operation the store
 * must pass validateStore AND an independent checker written from the spec, per-definition quantities are conserved,
 * and every rejected operation leaves the store deep-equal to its previous state.
 */
import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import type { EquipSlot, ItemDef } from '../src/content/types';
import { SIM_DT } from '../src/core/clock';
import { newCounter, type IdCounterState } from '../src/core/ids';
import { Rng } from '../src/core/rng';
import { runTx } from '../src/core/tx';
import {
  addContainer,
  adoptItem,
  attachChild,
  bagContainerId,
  descendants,
  destroyItem,
  emptyStore,
  instantiate,
  itemsInContainerDeep,
  mergeStacks,
  moveItem,
  placeNew,
  splitStack,
  transferBetweenStores,
  validateStore,
  type CreateItemOpts,
  type ItemStore,
  type Placement,
} from '../src/inventory/store';
import { equipProfileItem, mergeProfileStacks, moveProfileItem, shelterContainers, splitProfileStack, unequipProfileItem } from '../src/progression/actions';
import { grantItems, newProfile, SHELF, type ProfileState } from '../src/progression/profile';
import { prepareDeploy } from '../src/progression/raidFlow';
import type { RaidOp } from '../src/world/command';
import { carriedWeightKg, itemWeightKg, WEIGHT } from '../src/world/movement';
import { accessible, type OpResult } from '../src/world/ops';
import { stepSim } from '../src/world/sim';
import { createRaidSim, ensureEquipContainers, giveLoadedWeapon } from '../src/world/spawn';
import { eqContainerId, type WorldContainerState } from '../src/world/state';
import { arena, bagOf, world, type TestWorld } from './helpers';

const content = createContent();
const EQUIP: EquipSlot[] = ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'];

// --- independent invariant checker ------------------------------------------------------------------------------

/** Slot rules re-stated from the spec (independent of store.slotAccepts). */
function slotOk(def: ItemDef, accepts: string | undefined): boolean {
  switch (accepts) {
    case undefined:
      return true;
    case 'primary1':
    case 'primary2':
      return def.kind === 'weapon' && def.weapon!.class !== 'pistol';
    case 'secondary':
      return def.kind === 'weapon' && def.weapon!.class === 'pistol';
    case 'melee':
      return def.kind === 'melee';
    case 'helmet':
      return def.kind === 'armor' && def.armor!.slot === 'helmet';
    case 'vest':
      return def.kind === 'armor' && def.armor!.slot === 'vest';
    case 'backpack':
      return def.kind === 'backpack';
    case 'accessory':
      return def.kind === 'accessory';
    default:
      return true;
  }
}

/**
 * Single-ownership check written independently of validateStore:
 * every item is listed by exactly one owner (container list or parent containedItems) and that owner is its
 * ownerContainerId; no id is listed twice anywhere; owner chains are acyclic; slots hold ≤ 1 fitting item;
 * grid items sit on integer cells inside the grid without overlapping; quantities are integers in [1, stackMax].
 */
function ownershipProblems(store: ItemStore): string[] {
  const out: string[] = [];
  const listedBy = new Map<string, string[]>();
  const note = (id: string, by: string) => {
    const a = listedBy.get(id);
    if (a) a.push(by);
    else listedBy.set(id, [by]);
  };
  for (const [cid, c] of Object.entries(store.containers)) {
    if (c.id !== cid) out.push(`container key ${cid} holds id ${c.id}`);
    for (const id of c.items) note(id, cid);
  }
  for (const [iid, it] of Object.entries(store.items)) {
    if (it.instanceId !== iid) out.push(`item key ${iid} holds instanceId ${it.instanceId}`);
    for (const ch of it.containedItems) note(ch, `item:${iid}`);
  }
  for (const [id, by] of listedBy) {
    if (by.length !== 1) out.push(`${id} listed ${by.length}× (${by.join(', ')})`);
    if (!store.items[id]) out.push(`${id} listed by ${by.join(', ')} but does not exist`);
  }
  for (const [iid, it] of Object.entries(store.items)) {
    const by = listedBy.get(iid) ?? [];
    const owner = it.ownerContainerId;
    if (by.length === 0) out.push(`${iid} is listed by no owner`);
    if (owner === null) out.push(`${iid} has no ownerContainerId`);
    else if (by.length === 1 && by[0] !== owner) out.push(`${iid} ownerContainerId=${owner} but listed by ${by[0]}`);
    if (owner?.startsWith('item:')) {
      if (!store.items[owner.slice(5)]) out.push(`${iid} parent ${owner} missing`);
      if (it.gridPosition !== null) out.push(`${iid} parent-owned item has a grid position`);
    } else if (owner) {
      const c = store.containers[owner];
      if (!c) out.push(`${iid} owner container ${owner} missing`);
      else if (c.kind !== 'grid' && it.gridPosition !== null) out.push(`${iid} in ${c.kind} container ${owner} has a grid position`);
    }
    const def = content.item(it.definitionId);
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > def.stackMax) out.push(`${iid} quantity ${it.quantity} (stackMax ${def.stackMax})`);
    if (it.weapon?.magazineId && !it.containedItems.includes(it.weapon.magazineId)) out.push(`${iid} magazine pointer ${it.weapon.magazineId} not contained`);
    for (const [slot, aid] of Object.entries(it.attachments)) if (aid && !it.containedItems.includes(aid)) out.push(`${iid} attachment ${slot}=${aid} not contained`);
    // Acyclic owner chain (an item can never end up inside itself, directly or through bags / parents).
    const seen = new Set<string>([iid]);
    let cur = iid;
    for (let guard = 0; guard < 10_000; guard++) {
      const o = store.items[cur]?.ownerContainerId ?? null;
      const next = o?.startsWith('item:') ? o.slice(5) : o?.startsWith('bag:') ? o.slice(4) : null;
      if (next === null) break;
      if (seen.has(next)) {
        out.push(`${iid} ownership cycle through ${next}`);
        break;
      }
      seen.add(next);
      cur = next;
    }
  }
  for (const [cid, c] of Object.entries(store.containers)) {
    if (cid.startsWith('bag:')) {
      const bag = store.items[cid.slice(4)];
      if (!bag || content.item(bag.definitionId).kind !== 'backpack') out.push(`bag container ${cid} without its backpack item`);
    }
    if (new Set(c.items).size !== c.items.length) out.push(`${cid} lists an id twice`);
    if (c.kind === 'slot') {
      if (c.items.length > 1) out.push(`slot ${cid} holds ${c.items.length} items`);
      for (const id of c.items) {
        const it = store.items[id];
        if (it && !slotOk(content.item(it.definitionId), c.accepts)) out.push(`slot ${cid} (${c.accepts}) holds ${it.definitionId}`);
      }
    }
    if (c.kind === 'grid') {
      const cells = new Map<number, string>();
      for (const id of c.items) {
        const it = store.items[id];
        if (!it) continue;
        const pos = it.gridPosition;
        if (!pos || !Number.isInteger(pos.x) || !Number.isInteger(pos.y)) {
          out.push(`${id} in grid ${cid} has position ${JSON.stringify(pos)}`);
          continue;
        }
        const d = content.item(it.definitionId);
        const w = it.rotation === 1 ? d.size.h : d.size.w;
        const h = it.rotation === 1 ? d.size.w : d.size.h;
        if (pos.x < 0 || pos.y < 0 || pos.x + w > c.w || pos.y + h > c.h) out.push(`${id} (${w}×${h} at ${pos.x},${pos.y}) outside ${cid} ${c.w}×${c.h}`);
        for (let y = pos.y; y < pos.y + h; y++)
          for (let x = pos.x; x < pos.x + w; x++) {
            const k = y * 4096 + x;
            const other = cells.get(k);
            if (other) out.push(`${id} overlaps ${other} at ${x},${y} in ${cid}`);
            else cells.set(k, id);
          }
      }
    }
  }
  return out;
}

/** Total quantity per item definition over the whole store. */
function totals(store: ItemStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of Object.values(store.items)) out[it.definitionId] = (out[it.definitionId] ?? 0) + it.quantity;
  return out;
}

function expectHealthy(store: ItemStore, expectedTotals: Record<string, number>, label: string): void {
  expect(validateStore(store, content), `validateStore after ${label}`).toEqual([]);
  expect(ownershipProblems(store), `independent checker after ${label}`).toEqual([]);
  expect(totals(store), `per-definition quantity after ${label}`).toEqual(expectedTotals);
}

// --- store fixture ------------------------------------------------------------------------------------------------

interface Fixture {
  store: ItemStore;
  ids: IdCounterState;
}

const ACTOR = 'A';

function put(fx: Fixture, defId: string, target: Placement, opts: CreateItemOpts = {}): string {
  const it = instantiate(content, fx.ids, defId, opts);
  if (opts.quantity) it.quantity = opts.quantity;
  const r = placeNew(fx.store, content, it, target);
  if (!r.ok) throw new Error(`fixture: ${defId} → ${target.containerId}: ${r.error}`);
  return it.instanceId;
}

function child(fx: Fixture, parentId: string, defId: string, role: { magazine?: true; attachment?: 'muzzle' | 'grip' | 'stock' }): string {
  const it = instantiate(content, fx.ids, defId);
  fx.store.items[it.instanceId] = it;
  attachChild(fx.store, parentId, it.instanceId, role);
  return it.instanceId;
}

/**
 * Grid / list / slot containers, three levels of nested bags, weapons owning a magazine and an attachment,
 * stackables (incl. a relief-modified stack that must never merge with plain ammo) spread over all of them.
 */
function buildFixture(): Fixture {
  const fx: Fixture = { store: emptyStore(), ids: newCounter('fz') };
  const s = fx.store;
  ensureEquipContainers(s, ACTOR);
  addContainer(s, { id: 'stash', kind: 'grid', w: 12, h: 10 });
  addContainer(s, { id: 'crate', kind: 'grid', w: 5, h: 4 });
  addContainer(s, { id: 'tiny', kind: 'grid', w: 2, h: 2 });
  addContainer(s, { id: 'pile', kind: 'list', w: 0, h: 0 });
  addContainer(s, { id: 'pocket', kind: 'list', w: 0, h: 0 });
  addContainer(s, { id: 'hook', kind: 'slot', w: 1, h: 1 });
  const bagA = put(fx, 'core.bag.basic', { containerId: eqContainerId(ACTOR, 'backpack') });
  const bagB = put(fx, 'core.bag.hiker', { containerId: bagContainerId(bagA) });
  const bagC = put(fx, 'core.bag.basic', { containerId: bagContainerId(bagB) });
  put(fx, 'core.bag.military', { containerId: 'stash' });
  put(fx, 'core.bag.basic', { containerId: 'pile' });
  const p9 = put(fx, 'core.weapon.p9', { containerId: eqContainerId(ACTOR, 'secondary') });
  child(fx, p9, 'core.mag.p9', { magazine: true });
  const c556 = put(fx, 'core.weapon.c556', { containerId: 'stash' });
  child(fx, c556, 'core.mag.c556', { magazine: true });
  child(fx, c556, 'core.att.grip', { attachment: 'grip' });
  put(fx, 'core.weapon.ar556', { containerId: eqContainerId(ACTOR, 'primary1') });
  put(fx, 'core.weapon.dmr', { containerId: bagContainerId(bagB) });
  put(fx, 'core.weapon.sm9', { containerId: 'pile' });
  put(fx, 'core.mag.p9', { containerId: bagContainerId(bagA) });
  put(fx, 'core.mag.c556', { containerId: 'crate' });
  put(fx, 'core.mag.ar556', { containerId: bagContainerId(bagC) });
  put(fx, 'core.att.suppressor', { containerId: 'pocket' });
  put(fx, 'core.armor.vest1', { containerId: 'stash' });
  put(fx, 'core.armor.helmet2', { containerId: eqContainerId(ACTOR, 'helmet') });
  put(fx, 'core.melee.knife', { containerId: eqContainerId(ACTOR, 'melee') });
  put(fx, 'core.melee.crowbar', { containerId: 'stash' });
  put(fx, 'core.acc.nvg', { containerId: 'crate' });
  put(fx, 'core.med.firstaid', { containerId: bagContainerId(bagA) });
  put(fx, 'core.mat.fuel', { containerId: 'stash' });
  const stacks: [string, number, string][] = [
    ['core.ammo.9.fmj', 60, 'stash'],
    ['core.ammo.9.fmj', 25, bagContainerId(bagA)],
    ['core.ammo.9.fmj', 7, bagContainerId(bagC)],
    ['core.ammo.9.fmj', 13, 'pile'],
    ['core.ammo.556.fmj', 42, 'crate'],
    ['core.ammo.556.fmj', 30, bagContainerId(bagB)],
    ['core.ammo.12g.buck', 18, 'tiny'],
    ['core.ammo.12g.buck', 29, 'pocket'],
    ['core.mat.scrap', 9, 'stash'],
    ['core.mat.scrap', 4, bagContainerId(bagC)],
    ['core.mat.cloth', 6, 'crate'],
    ['core.med.bandage', 3, bagContainerId(bagA)],
    ['core.med.bandage', 4, 'pile'],
    ['core.throw.frag', 2, 'tiny'],
    ['core.val.ring', 5, bagContainerId(bagB)],
    ['core.val.ring', 1, 'stash'],
  ];
  for (const [defId, q, cid] of stacks) put(fx, defId, { containerId: cid }, { quantity: q });
  put(fx, 'core.ammo.9.fmj', { containerId: 'stash' }, { quantity: 30, modifiers: ['relief'] });
  return fx;
}

// --- fuzz ---------------------------------------------------------------------------------------------------------

const STORE_SEEDS = ['a07-store-1', 'a07-store-2', 'a07-store-3', 'a07-store-4', 'a07-store-5', 'a07-store-6'];
const STORE_OPS = 400;

type StoreOp =
  | { kind: 'move'; itemId: string; target: Placement }
  | { kind: 'equip'; itemId: string; slot: EquipSlot }
  | { kind: 'split'; itemId: string; qty: number; target: Placement }
  | { kind: 'merge'; fromId: string; toId: string }
  | { kind: 'load'; weaponId: string; magId: string };

/** Random target: mostly grids / lists (incl. every bag), sometimes slots, rarely a container that does not exist. */
function randomPlacement(rng: Rng, store: ItemStore): Placement {
  const all = Object.keys(store.containers).sort();
  const roll = rng.next();
  let cid: string;
  if (roll < 0.05) cid = rng.pick(['bag:missing', 'nowhere']);
  else if (roll < 0.25) cid = rng.pick(all.filter((c) => store.containers[c]!.kind === 'slot'));
  else cid = rng.pick(all.filter((c) => store.containers[c]!.kind !== 'slot'));
  const c = store.containers[cid];
  if (!c || c.kind !== 'grid' || rng.chance(0.4)) return { containerId: cid };
  return { containerId: cid, x: rng.int(-1, c.w), y: rng.int(-1, c.h), rotation: rng.chance(0.5) ? 1 : 0 };
}

/** Mostly valid split sizes plus zero, negative, whole-stack, over-stack and fractional requests. */
function randomQty(rng: Rng, q: number): number {
  const r = rng.next();
  if (r < 0.05) return 0;
  if (r < 0.08) return -1;
  if (r < 0.12) return q;
  if (r < 0.15) return q + 1;
  if (r < 0.18) return 1.5;
  return rng.int(1, Math.max(1, q - 1));
}

const EQUIPPABLE = new Set(['weapon', 'melee', 'armor', 'backpack', 'accessory']);

/** Equipment slots an item definition belongs in (null when it has none). */
function slotFor(def: ItemDef): EquipSlot[] | null {
  if (def.kind === 'weapon') return def.weapon!.class === 'pistol' ? ['secondary'] : ['primary1', 'primary2'];
  if (def.kind === 'melee') return ['melee'];
  if (def.kind === 'armor') return [def.armor!.slot];
  if (def.kind === 'backpack') return ['backpack'];
  if (def.kind === 'accessory') return ['accessory'];
  return null;
}

function randomStoreOp(rng: Rng, fx: Fixture): StoreOp {
  const s = fx.store;
  const ids = Object.keys(s.items).sort();
  const def = (id: string) => content.item(s.items[id]!.definitionId);
  const stackables = ids.filter((id) => def(id).stackMax > 1);
  const bags = ids.filter((id) => def(id).kind === 'backpack');
  const roll = rng.next();
  if (roll < 0.08 && bags.length) {
    // A bag aimed at its own container or at a bag nested (at any depth) inside it.
    const bag = rng.pick(bags);
    const inner = [bag, ...bags.filter((b) => b !== bag && isInside(s, b, bag))];
    return { kind: 'move', itemId: bag, target: { containerId: bagContainerId(rng.pick(inner)) } };
  }
  if (roll < 0.36) return { kind: 'move', itemId: rng.chance(0.03) ? 'ghost' : rng.pick(ids), target: randomPlacement(rng, s) };
  if (roll < 0.5) {
    const pool = rng.chance(0.8) ? ids.filter((id) => EQUIPPABLE.has(def(id).kind)) : ids;
    const id = rng.pick(pool);
    const own = slotFor(def(id));
    return { kind: 'equip', itemId: id, slot: own && rng.chance(0.6) ? rng.pick(own) : rng.pick(EQUIP) };
  }
  if (roll < 0.72 && stackables.length) {
    const id = rng.pick(stackables);
    return { kind: 'split', itemId: id, qty: randomQty(rng, s.items[id]!.quantity), target: randomPlacement(rng, s) };
  }
  if (roll < 0.92 && stackables.length) {
    const from = rng.pick(stackables);
    const sameDef = stackables.filter((x) => x !== from && s.items[x]!.definitionId === s.items[from]!.definitionId);
    const to = sameDef.length && rng.chance(0.8) ? rng.pick(sameDef) : rng.pick(ids);
    return { kind: 'merge', fromId: from, toId: to };
  }
  const weapons = ids.filter((id) => s.items[id]!.weapon && def(id).weapon!.magazineFamily);
  const mags = ids.filter((id) => def(id).magazine && !s.items[id]!.ownerContainerId?.startsWith('item:'));
  if (weapons.length && mags.length) {
    const w = rng.pick(weapons);
    const fitting = mags.filter((m) => def(m).magazine!.family === def(w).weapon!.magazineFamily);
    return { kind: 'load', weaponId: w, magId: fitting.length && rng.chance(0.8) ? rng.pick(fitting) : rng.pick(mags) };
  }
  return { kind: 'move', itemId: rng.pick(ids), target: randomPlacement(rng, s) };
}

/** Is item `id` (transitively) inside bag / parent item `ancestor`? */
function isInside(store: ItemStore, id: string, ancestor: string): boolean {
  let cur: string | null = id;
  for (let guard = 0; cur && guard < 1000; guard++) {
    const o: string | null = store.items[cur]?.ownerContainerId ?? null;
    const next: string | null = o?.startsWith('bag:') ? o.slice(4) : o?.startsWith('item:') ? o.slice(5) : null;
    if (next === ancestor) return true;
    cur = next;
  }
  return false;
}

/** Apply one store operation; parent attachment is validated like progression/actions.loadWeapon. */
function applyStoreOp(fx: Fixture, op: StoreOp): { ok: boolean; error?: string } {
  const s = fx.store;
  switch (op.kind) {
    case 'move':
      return moveItem(s, content, op.itemId, op.target);
    case 'equip':
      return moveItem(s, content, op.itemId, { containerId: eqContainerId(ACTOR, op.slot) });
    case 'split':
      return splitStack(s, content, fx.ids, op.itemId, op.qty, op.target);
    case 'merge':
      return mergeStacks(s, content, op.fromId, op.toId);
    case 'load': {
      const w = s.items[op.weaponId]!;
      const m = s.items[op.magId]!;
      if (w.weapon!.magazineId || content.item(w.definitionId).weapon!.magazineFamily !== content.item(m.definitionId).magazine!.family) return { ok: false, error: 'incompatible' };
      attachChild(s, op.weaponId, op.magId, { magazine: true });
      return { ok: true };
    }
  }
}

/** Post-conditions of a successful op beyond the global invariants. */
function expectEffect(before: ItemStore, after: ItemStore, op: StoreOp, label: string): void {
  switch (op.kind) {
    case 'move':
    case 'equip': {
      const cid = op.kind === 'move' ? op.target.containerId : eqContainerId(ACTOR, op.slot);
      const it = after.items[op.itemId]!;
      expect(it.ownerContainerId, label).toBe(cid);
      if (op.kind === 'move' && op.target.x !== undefined) {
        expect(it.gridPosition, label).toEqual({ x: op.target.x, y: op.target.y });
        expect(it.rotation, label).toBe(op.target.rotation ?? before.items[op.itemId]!.rotation);
      }
      // Descendants travel with the moved item: their direct owners are unchanged.
      for (const [id, x] of Object.entries(before.items)) if (id !== op.itemId && x.ownerContainerId?.startsWith('item:')) expect(after.items[id]?.ownerContainerId, label).toBe(x.ownerContainerId);
      break;
    }
    case 'split': {
      const src = after.items[op.itemId]!;
      expect(src.quantity, label).toBe(before.items[op.itemId]!.quantity - op.qty);
      const created = Object.keys(after.items).filter((id) => !before.items[id]);
      expect(created, label).toHaveLength(1);
      const n = after.items[created[0]!]!;
      expect({ def: n.definitionId, qty: n.quantity, owner: n.ownerContainerId, mods: n.modifiers }, label).toEqual({ def: src.definitionId, qty: op.qty, owner: op.target.containerId, mods: src.modifiers });
      break;
    }
    case 'merge': {
      const a0 = before.items[op.fromId]!;
      const b0 = before.items[op.toId]!;
      const max = content.item(b0.definitionId).stackMax;
      const moved = Math.min(a0.quantity, max - b0.quantity);
      expect(after.items[op.toId]!.quantity, label).toBe(b0.quantity + moved);
      if (moved === a0.quantity) expect(after.items[op.fromId], label).toBeUndefined();
      else expect(after.items[op.fromId]!.quantity, label).toBe(a0.quantity - moved);
      break;
    }
    case 'load':
      expect(after.items[op.magId]!.ownerContainerId, label).toBe(`item:${op.weaponId}`);
      expect(after.items[op.weaponId]!.weapon!.magazineId, label).toBe(op.magId);
      break;
  }
}

describe('A07 (a) seeded fuzz over the store API (grid / list / slot / nested bags / parent items)', () => {
  it.each(STORE_SEEDS)('seed %s: every op keeps single ownership, conserves quantity, rejected ops change nothing', (seed) => {
    const fx = buildFixture();
    const expected = totals(fx.store);
    expectHealthy(fx.store, expected, 'fixture');
    const rng = Rng.fromSeed(seed);
    const tally: Record<string, { ok: number; rejected: number }> = {};
    for (let i = 0; i < STORE_OPS; i++) {
      const op = randomStoreOp(rng, fx);
      const before = structuredClone(fx.store);
      const r = applyStoreOp(fx, op);
      const label = `#${i} ${JSON.stringify(op)} → ${JSON.stringify(r)}`;
      const t = (tally[op.kind] ??= { ok: 0, rejected: 0 });
      if (r.ok) {
        t.ok++;
        expectEffect(before, fx.store, op, label);
      } else {
        t.rejected++;
        expect(fx.store, `rejected op left the store untouched: ${label}`).toEqual(before);
      }
      expectHealthy(fx.store, expected, label);
    }
    // The run really exercised both outcomes of every operation kind.
    for (const kind of ['move', 'equip', 'split', 'merge']) {
      expect(tally[kind]?.ok, `${kind} successes`).toBeGreaterThan(0);
      expect(tally[kind]?.rejected, `${kind} rejections`).toBeGreaterThan(0);
    }
  });
});

// --- raid ops fuzz (applyOp through stepSim) ----------------------------------------------------------------------

const RAID_SEEDS = ['a07-raid-1', 'a07-raid-2', 'a07-raid-3', 'a07-raid-4'];
const RAID_OPS = 300;
const RAID_MAP = arena('a07-inventory', 24, 12);

/** Register an already-searched lootable world container next to the player. */
function lootSpot(t: TestWorld, cid: string, kind: 'grid' | 'list', w: number, h: number, x: number, wkind: WorldContainerState['kind']): string {
  const sim = t.ctx.sim;
  addContainer(sim.store, { id: cid, kind, w, h });
  sim.containers[cid] = { id: cid, kind: wkind, typeId: 'a07', x, y: t.player.y, floor: 0, searched: 9999, searchProgress: 0, keyId: null, locked: false, actorId: null, nameKey: 'world.drop', createdTick: 0, opened: true };
  return cid;
}

function give(t: TestWorld, defId: string, cid: string, opts: CreateItemOpts = {}): string {
  const sim = t.ctx.sim;
  const it = instantiate(t.content, sim.ids, defId, opts);
  if (opts.quantity) it.quantity = opts.quantity;
  const r = placeNew(sim.store, t.content, it, { containerId: cid });
  if (!r.ok) throw new Error(`raid fixture: ${defId} → ${cid}: ${r.error}`);
  return it.instanceId;
}

interface RaidFixture {
  t: TestWorld;
  crate: string;
  corpse: string;
}

/** Player with a basic bag, a loaded pistol and rifle; a searched grid crate and a list corpse with a packed bag. */
function raidFixture(): RaidFixture {
  const t = world(RAID_MAP, 6, 6);
  const sim = t.ctx.sim;
  const c = t.content;
  const bag = bagOf(t);
  giveLoadedWeapon(c, sim, eqContainerId('player', 'secondary'), 'core.weapon.p9', 'core.ammo.9.fmj', 1, 20, bag);
  giveLoadedWeapon(c, sim, eqContainerId('player', 'primary1'), 'core.weapon.ar556', 'core.ammo.556.fmj', 1, 45, bag);
  t.player.activeSlot = 'primary1';
  give(t, 'core.med.bandage', bag, { quantity: 3 });
  give(t, 'core.mat.scrap', bag, { quantity: 4 });
  const crate = lootSpot(t, 'ct:a07_crate', 'grid', 6, 5, 6.5, 'world');
  giveLoadedWeapon(c, sim, crate, 'core.weapon.c556', 'core.ammo.556.fmj', 0, 0, null);
  give(t, 'core.ammo.556.fmj', crate, { quantity: 37 });
  give(t, 'core.ammo.9.fmj', crate, { quantity: 52 });
  give(t, 'core.mat.scrap', crate, { quantity: 7 });
  give(t, 'core.armor.helmet1', crate);
  give(t, 'core.bag.basic', crate);
  give(t, 'core.med.bandage', crate, { quantity: 4 });
  const corpse = lootSpot(t, 'corpse:a07', 'list', 0, 0, 5.5, 'corpse');
  const packed = give(t, 'core.bag.military', corpse);
  give(t, 'core.ammo.9.fmj', bagContainerId(packed), { quantity: 60 });
  give(t, 'core.mat.cloth', bagContainerId(packed), { quantity: 5 });
  give(t, 'core.armor.vest2', corpse);
  give(t, 'core.melee.crowbar', corpse);
  give(t, 'core.ammo.556.fmj', corpse, { quantity: 11 });
  give(t, 'core.throw.frag', corpse, { quantity: 2 });
  sim.loot = { containerId: crate };
  return { t, crate, corpse };
}

type FuzzRaidOp = RaidOp | { op: 'openLoot'; containerId: string };

function randomRaidOp(rng: Rng, f: RaidFixture): FuzzRaidOp {
  const ctx = f.t.ctx;
  const s = ctx.sim.store;
  const ids = Object.keys(s.items).sort();
  const def = (id: string) => ctx.content.item(s.items[id]!.definitionId);
  const reach = ids.filter((id) => accessible(ctx, f.t.player, id));
  const pick = (pool: string[]) => (pool.length && rng.chance(0.85) ? rng.pick(pool) : rng.pick(ids));
  const target = (): Placement => {
    const cids: string[] = EQUIP.map((sl) => eqContainerId('player', sl));
    const bag = s.containers[eqContainerId('player', 'backpack')]?.items[0];
    if (bag && s.containers[bagContainerId(bag)]) cids.push(bagContainerId(bag), bagContainerId(bag), bagContainerId(bag));
    if (ctx.sim.loot) cids.push(ctx.sim.loot.containerId, ctx.sim.loot.containerId);
    cids.push(...Object.keys(ctx.sim.containers).sort(), 'nowhere');
    const cid = rng.pick(cids);
    const c = s.containers[cid];
    if (!c || c.kind !== 'grid' || rng.chance(0.5)) return { containerId: cid };
    return { containerId: cid, x: rng.int(-1, c.w), y: rng.int(-1, c.h), rotation: rng.chance(0.5) ? 1 : 0 };
  };
  const stack = reach.filter((id) => def(id).stackMax > 1);
  const roll = rng.next();
  if (roll < 0.28) return { op: 'move', itemId: pick(reach), target: target() };
  if (roll < 0.4) {
    const id = pick(reach.filter((x) => EQUIPPABLE.has(def(x).kind)));
    const own = slotFor(def(id));
    return { op: 'equip', itemId: id, slot: own && rng.chance(0.6) ? rng.pick(own) : rng.pick(EQUIP) };
  }
  if (roll < 0.45) return { op: 'unequip', slot: rng.pick(EQUIP) };
  if (roll < 0.52) return { op: 'drop', itemId: pick(reach) };
  if (roll < 0.67) {
    const id = pick(stack);
    return { op: 'split', itemId: id, qty: randomQty(rng, s.items[id]!.quantity), target: target() };
  }
  if (roll < 0.82) {
    const from = pick(stack);
    const same = stack.filter((x) => x !== from && s.items[x]!.definitionId === s.items[from]!.definitionId);
    return { op: 'merge', fromId: from, toId: same.length && rng.chance(0.8) ? rng.pick(same) : pick(stack) };
  }
  if (roll < 0.87) return { op: 'takeAll' };
  if (roll < 0.89) return { op: 'closeLoot' };
  const piles = Object.keys(ctx.sim.containers).sort();
  return { op: 'openLoot', containerId: rng.pick(piles) };
}

function raidStep(f: RaidFixture, op: FuzzRaidOp): OpResult {
  if (op.op === 'openLoot') {
    f.t.ctx.sim.loot = { containerId: op.containerId };
    return { ok: true };
  }
  return stepSim(f.t.ctx, { cmd: null, ops: [op] }, SIM_DT).opResults[0]!;
}

describe('A07 (a) seeded fuzz over raid ops (move / split / merge / equip / unequip / drop / takeAll)', () => {
  it.each(RAID_SEEDS)('seed %s: after every applied raid op the raid store keeps single ownership and quantities', (seed) => {
    const f = raidFixture();
    const store = () => f.t.ctx.sim.store;
    const expected = totals(store());
    expectHealthy(store(), expected, 'raid fixture');
    const rng = Rng.fromSeed(seed);
    const tally: Record<string, { ok: number; rejected: number }> = {};
    for (let i = 0; i < RAID_OPS; i++) {
      const op = randomRaidOp(rng, f);
      const before = structuredClone(store());
      const r = raidStep(f, op);
      const label = `#${i} ${JSON.stringify(op)} → ${JSON.stringify(r)}`;
      const t = (tally[op.op] ??= { ok: 0, rejected: 0 });
      if (r.ok) {
        t.ok++;
        const s = store();
        if (op.op === 'move') expect(s.items[op.itemId]!.ownerContainerId, label).toBe(op.target.containerId);
        if (op.op === 'equip') expect(s.containers[eqContainerId('player', op.slot)]!.items, label).toEqual([op.itemId]);
        if (op.op === 'drop') expect(s.items[op.itemId]!.ownerContainerId, label).toMatch(/^drop:/);
        if (op.op === 'unequip') expect(s.containers[eqContainerId('player', op.slot)]!.items, label).toEqual([]);
      } else {
        t.rejected++;
        expect(store(), `rejected raid op left the store untouched: ${label}`).toEqual(before);
      }
      expectHealthy(store(), expected, label);
    }
    for (const kind of ['move', 'equip', 'split', 'merge', 'drop']) {
      expect(tally[kind]?.ok, `${kind} successes`).toBeGreaterThan(0);
      expect(tally[kind]?.rejected, `${kind} rejections`).toBeGreaterThan(0);
    }
  });
});

// --- shelter actions fuzz (progression/actions inside runTx) --------------------------------------------------

const SHELTER_SEEDS = ['a07-shelter-1', 'a07-shelter-2', 'a07-shelter-3'];
const SHELTER_OPS = 200;

/** Starter profile plus a shelf, a spare (empty) bag, armor and assorted stacks. */
function shelterProfile(seed: string): ProfileState {
  const p = newProfile(content, 1, 'A07', seed, 0);
  addContainer(p.store, { id: SHELF, kind: 'grid', w: 6, h: 4 });
  const tx = 'a07:setup';
  grantItems(p, content, 'core.bag.hiker', 1, tx);
  grantItems(p, content, 'core.armor.vest1', 1, tx);
  grantItems(p, content, 'core.armor.helmet1', 1, tx);
  grantItems(p, content, 'core.weapon.sm9', 1, tx);
  grantItems(p, content, 'core.melee.crowbar', 1, tx);
  grantItems(p, content, 'core.mat.scrap', 13, tx);
  grantItems(p, content, 'core.ammo.9.fmj', 50, tx);
  grantItems(p, content, 'core.med.bandage', 6, tx);
  grantItems(p, content, 'core.ammo.12g.buck', 40, tx);
  return p;
}

type ShelterOp =
  | { kind: 'move'; itemId: string; target: Placement }
  | { kind: 'equip'; itemId: string; slot: EquipSlot }
  | { kind: 'unequip'; slot: EquipSlot }
  | { kind: 'split'; itemId: string; qty: number; target: Placement }
  | { kind: 'merge'; fromId: string; toId: string };

function randomShelterOp(rng: Rng, p: ProfileState): ShelterOp {
  const s = p.store;
  const ids = Object.keys(s.items).sort();
  const def = (id: string) => content.item(s.items[id]!.definitionId);
  const cids = [...shelterContainers(p), 'deathbag', 'nowhere'];
  const target = (): Placement => {
    const cid = rng.pick(cids);
    const c = s.containers[cid];
    if (!c || c.kind !== 'grid' || rng.chance(0.5)) return { containerId: cid };
    return { containerId: cid, x: rng.int(-1, c.w), y: rng.int(-1, c.h), rotation: rng.chance(0.5) ? 1 : 0 };
  };
  const stack = ids.filter((id) => def(id).stackMax > 1);
  const roll = rng.next();
  if (roll < 0.3) return { kind: 'move', itemId: rng.pick(ids), target: target() };
  if (roll < 0.5) {
    const id = rng.pick(ids.filter((x) => EQUIPPABLE.has(def(x).kind)));
    const own = slotFor(def(id));
    return { kind: 'equip', itemId: id, slot: own && rng.chance(0.7) ? rng.pick(own) : rng.pick(EQUIP) };
  }
  if (roll < 0.58) return { kind: 'unequip', slot: rng.pick(EQUIP) };
  if (roll < 0.8) {
    const id = rng.pick(stack);
    return { kind: 'split', itemId: id, qty: randomQty(rng, s.items[id]!.quantity), target: target() };
  }
  const from = rng.pick(stack);
  const same = stack.filter((x) => x !== from && s.items[x]!.definitionId === s.items[from]!.definitionId);
  return { kind: 'merge', fromId: from, toId: same.length && rng.chance(0.8) ? rng.pick(same) : rng.pick(stack) };
}

function shelterMutation(op: ShelterOp): (d: ProfileState) => unknown {
  switch (op.kind) {
    case 'move':
      return (d) => moveProfileItem(d, content, op.itemId, op.target);
    case 'equip':
      return (d) => equipProfileItem(d, content, op.itemId, op.slot);
    case 'unequip':
      return (d) => unequipProfileItem(d, content, op.slot);
    case 'split':
      return (d) => splitProfileStack(d, content, op.itemId, op.qty, op.target);
    case 'merge':
      return (d) => mergeProfileStacks(d, content, op.fromId, op.toId);
  }
}

describe('A07 (a) seeded fuzz over shelter inventory actions (runTx)', () => {
  it.each(SHELTER_SEEDS)('seed %s: applied actions keep the profile store valid, failed ones return the untouched state', (seed) => {
    let p = shelterProfile(seed);
    const expected = totals(p.store);
    expectHealthy(p.store, expected, 'profile fixture');
    const rng = Rng.fromSeed(seed);
    const tally: Record<string, { ok: number; rejected: number }> = {};
    for (let i = 0; i < SHELTER_OPS; i++) {
      const op = randomShelterOp(rng, p);
      const snapshot = structuredClone(p);
      const { outcome, next } = runTx(p, `a07:${seed}:${i}`, shelterMutation(op));
      const label = `#${i} ${JSON.stringify(op)} → ${JSON.stringify(outcome)}`;
      const t = (tally[op.kind] ??= { ok: 0, rejected: 0 });
      expect(p, `input state never mutated: ${label}`).toEqual(snapshot);
      if (outcome.ok) {
        t.ok++;
        p = next;
        if (op.kind === 'move') expect(p.store.items[op.itemId]!.ownerContainerId, label).toBe(op.target.containerId);
        if (op.kind === 'equip') expect(p.store.containers[eqContainerId('player', op.slot)]!.items, label).toEqual([op.itemId]);
        if (op.kind === 'unequip') expect(p.store.containers[eqContainerId('player', op.slot)]!.items, label).toEqual([]);
      } else {
        t.rejected++;
        expect(next, label).toBe(p);
      }
      expectHealthy(p.store, expected, label);
    }
    for (const kind of ['move', 'equip', 'split', 'merge']) {
      expect(tally[kind]?.ok, `${kind} successes`).toBeGreaterThan(0);
      expect(tally[kind]?.rejected, `${kind} rejections`).toBeGreaterThan(0);
    }
  });
});

// --- (b) rejected operations never partially apply ----------------------------------------------------------------

/**
 * stash 6×4: P9 (2×2, own magazine) at 0,0 · C556 (4×2) at 2,0 · 9mm×50 at 0,2 · relief 9mm×10 at 1,2 · 5.56×20 at 2,2.
 * "full" 2×1 holds scrap×10 (stackMax) and scrap×3. Backpack slot: bag A ⊃ bag B ⊃ bag C (9mm×40 inside C).
 */
function namedFixture() {
  const fx: Fixture = { store: emptyStore(), ids: newCounter('nf') };
  const s = fx.store;
  ensureEquipContainers(s, ACTOR);
  addContainer(s, { id: 'stash', kind: 'grid', w: 6, h: 4 });
  addContainer(s, { id: 'full', kind: 'grid', w: 2, h: 1 });
  addContainer(s, { id: 'pile', kind: 'list', w: 0, h: 0 });
  const bagA = put(fx, 'core.bag.basic', { containerId: eqContainerId(ACTOR, 'backpack') });
  const bagB = put(fx, 'core.bag.hiker', { containerId: bagContainerId(bagA) });
  const bagC = put(fx, 'core.bag.basic', { containerId: bagContainerId(bagB) });
  const spareBag = put(fx, 'core.bag.basic', { containerId: 'pile' });
  const pistol = put(fx, 'core.weapon.p9', { containerId: 'stash', x: 0, y: 0 });
  const pistolMag = child(fx, pistol, 'core.mag.p9', { magazine: true });
  const rifle = put(fx, 'core.weapon.ar556', { containerId: eqContainerId(ACTOR, 'primary1') });
  const carbine = put(fx, 'core.weapon.c556', { containerId: 'stash', x: 2, y: 0 });
  const ammo = put(fx, 'core.ammo.9.fmj', { containerId: 'stash', x: 0, y: 2 }, { quantity: 50 });
  const relief = put(fx, 'core.ammo.9.fmj', { containerId: 'stash', x: 1, y: 2 }, { quantity: 10, modifiers: ['relief'] });
  const rifleAmmo = put(fx, 'core.ammo.556.fmj', { containerId: 'stash', x: 2, y: 2 }, { quantity: 20 });
  const deepAmmo = put(fx, 'core.ammo.9.fmj', { containerId: bagContainerId(bagC) }, { quantity: 40 });
  const fullScrap = put(fx, 'core.mat.scrap', { containerId: 'full', x: 0, y: 0 }, { quantity: 10 });
  const scrap = put(fx, 'core.mat.scrap', { containerId: 'full', x: 1, y: 0 }, { quantity: 3 });
  const vest = put(fx, 'core.armor.vest1', { containerId: bagContainerId(bagA) });
  return { fx, bagA, bagB, bagC, spareBag, pistol, pistolMag, rifle, carbine, ammo, relief, rifleAmmo, deepAmmo, fullScrap, scrap, vest };
}

function expectRejected(store: ItemStore, attempt: () => { ok: boolean; error?: string }, error: string, label: string): void {
  const before = structuredClone(store);
  const expected = totals(store);
  const r = attempt();
  expect(r, label).toEqual({ ok: false, error });
  expect(store, `${label}: store unchanged`).toEqual(before);
  expectHealthy(store, expected, label);
}

describe('A07 (b) rejected operations never partially apply (deep-equal store before/after)', () => {
  it('no space: full grid, occupied cell, out of bounds, too-large item; placeNew / split into no space leave nothing behind', () => {
    const n = namedFixture();
    const s = n.fx.store;
    expectRejected(s, () => moveItem(s, content, n.rifle, { containerId: 'stash' }), 'inv.err.no_space', 'AR556 4×2 into a stash without a 4×2 gap');
    expectRejected(s, () => moveItem(s, content, n.deepAmmo, { containerId: 'stash', x: 1, y: 1 }), 'inv.err.no_space', 'onto the P9 footprint');
    expectRejected(s, () => moveItem(s, content, n.deepAmmo, { containerId: 'stash', x: 6, y: 0 }), 'inv.err.no_space', 'x past the right edge');
    expectRejected(s, () => moveItem(s, content, n.deepAmmo, { containerId: 'stash', x: -1, y: 3 }), 'inv.err.no_space', 'negative x');
    expectRejected(s, () => moveItem(s, content, n.carbine, { containerId: 'stash', x: 2, y: 2, rotation: 1 }), 'inv.err.no_space', 'rotated carbine 2×4 would leave the grid');
    expectRejected(s, () => moveItem(s, content, n.deepAmmo, { containerId: 'full' }), 'inv.err.no_space', 'into a full grid');
    expectRejected(s, () => splitStack(s, content, n.fx.ids, n.ammo, 5, { containerId: 'full' }), 'inv.err.no_space', 'split into a full grid');
    expectRejected(s, () => splitStack(s, content, n.fx.ids, n.ammo, 5, { containerId: 'stash', x: 0, y: 0 }), 'inv.err.no_space', 'split onto an occupied cell');
    const probe = instantiate(content, n.fx.ids, 'core.mat.cloth', { quantity: 2 });
    expectRejected(s, () => placeNew(s, content, probe, { containerId: 'full' }), 'inv.err.no_space', 'placeNew into a full grid');
    expect(s.items[probe.instanceId]).toBeUndefined();
    expectRejected(s, () => moveItem(s, content, n.ammo, { containerId: 'nowhere' }), 'inv.err.no_container', 'unknown container');
    expectRejected(s, () => moveItem(s, content, 'ghost', { containerId: 'stash' }), 'inv.err.no_item', 'unknown item');
  });

  it('slot mismatch / occupied slot', () => {
    const n = namedFixture();
    const s = n.fx.store;
    const slot = (sl: EquipSlot) => ({ containerId: eqContainerId(ACTOR, sl) });
    expectRejected(s, () => moveItem(s, content, n.pistol, slot('primary2')), 'inv.err.slot_mismatch', 'pistol → primary2');
    expectRejected(s, () => moveItem(s, content, n.carbine, slot('secondary')), 'inv.err.slot_mismatch', 'carbine → secondary');
    expectRejected(s, () => moveItem(s, content, n.ammo, slot('helmet')), 'inv.err.slot_mismatch', 'ammo → helmet');
    expectRejected(s, () => moveItem(s, content, n.vest, slot('helmet')), 'inv.err.slot_mismatch', 'vest → helmet');
    expectRejected(s, () => moveItem(s, content, n.spareBag, slot('vest')), 'inv.err.slot_mismatch', 'backpack → vest');
    expectRejected(s, () => moveItem(s, content, n.pistolMag, slot('accessory')), 'inv.err.slot_mismatch', 'attached magazine → accessory');
    expectRejected(s, () => splitStack(s, content, n.fx.ids, n.ammo, 5, slot('melee')), 'inv.err.slot_mismatch', 'split ammo → melee');
    expectRejected(s, () => moveItem(s, content, n.carbine, slot('primary1')), 'inv.err.slot_occupied', 'carbine → occupied primary1');
    expectRejected(s, () => moveItem(s, content, n.spareBag, slot('backpack')), 'inv.err.slot_occupied', 'second bag → occupied backpack slot');
  });

  it('a bag can never go into itself or into any bag nested inside it', () => {
    const n = namedFixture();
    const s = n.fx.store;
    const into = (bag: string, host: string, label: string) => expectRejected(s, () => moveItem(s, content, bag, { containerId: bagContainerId(host) }), 'inv.err.into_self', label);
    into(n.bagA, n.bagA, 'A → A');
    into(n.bagA, n.bagB, 'A → B (B inside A)');
    into(n.bagA, n.bagC, 'A → C (C inside B inside A)');
    into(n.bagB, n.bagB, 'B → B');
    into(n.bagB, n.bagC, 'B → C (C inside B)');
    into(n.bagC, n.bagC, 'C → C');
    into(n.spareBag, n.spareBag, 'empty bag → itself');
    // Explicit coordinates do not bypass the check.
    expectRejected(s, () => moveItem(s, content, n.spareBag, { containerId: bagContainerId(n.spareBag), x: 0, y: 0 }), 'inv.err.into_self', 'empty bag → itself at 0,0');
    // The reverse direction is fine for an empty bag: moving the empty spare bag into C nests it one level deeper.
    expect(moveItem(s, content, n.spareBag, { containerId: bagContainerId(n.bagC) })).toEqual({ ok: true });
    into(n.spareBag, n.spareBag, 'nested empty bag → itself');
    expectRejected(s, () => moveItem(s, content, n.bagA, { containerId: bagContainerId(n.spareBag) }), 'inv.err.into_self', 'A → spare (now inside C inside B inside A)');
  });

  it('bad split quantities: 0, negative, whole stack, more than the stack, fractional, NaN, Infinity; bad targets', () => {
    const n = namedFixture();
    const s = n.fx.store;
    for (const q of [0, -1, -50, 50, 51, 1.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expectRejected(s, () => splitStack(s, content, n.fx.ids, n.ammo, q, { containerId: 'pile' }), 'inv.err.bad_quantity', `split ${q} of 50`);
    expectRejected(s, () => splitStack(s, content, n.fx.ids, n.pistol, 1, { containerId: 'pile' }), 'inv.err.bad_quantity', 'split a single weapon');
    expectRejected(s, () => splitStack(s, content, n.fx.ids, n.ammo, 10, { containerId: 'nowhere' }), 'inv.err.no_container', 'split into an unknown container');
    expectRejected(s, () => splitStack(s, content, n.fx.ids, 'ghost', 1, { containerId: 'pile' }), 'inv.err.no_item', 'split an unknown item');
  });

  it('merges of different definitions / modifiers / non-stackables / full stacks are refused; over-stackMax merges keep the remainder in the source', () => {
    const n = namedFixture();
    const s = n.fx.store;
    expectRejected(s, () => mergeStacks(s, content, n.ammo, n.rifleAmmo), 'inv.err.not_stackable', '9mm → 5.56');
    expectRejected(s, () => mergeStacks(s, content, n.ammo, n.relief), 'inv.err.not_stackable', 'plain 9mm → relief 9mm');
    expectRejected(s, () => mergeStacks(s, content, n.relief, n.ammo), 'inv.err.not_stackable', 'relief 9mm → plain 9mm');
    expectRejected(s, () => mergeStacks(s, content, n.carbine, n.rifle), 'inv.err.not_stackable', 'weapon → weapon');
    expectRejected(s, () => mergeStacks(s, content, n.scrap, n.fullScrap), 'inv.err.no_space', 'into a stack already at stackMax');
    expectRejected(s, () => mergeStacks(s, content, n.ammo, n.ammo), 'inv.err.no_item', 'onto itself');
    expectRejected(s, () => mergeStacks(s, content, 'ghost', n.ammo), 'inv.err.no_item', 'unknown source');
    // 50 + 40 with stackMax 60: target fills to 60, the other 30 stay exactly where the source was.
    const src0 = structuredClone(s.items[n.ammo]!);
    const total = totals(s);
    expect(mergeStacks(s, content, n.ammo, n.deepAmmo)).toEqual({ ok: true, moved: 20, destroyedFrom: false });
    expect(s.items[n.deepAmmo]!.quantity).toBe(60);
    expect(s.items[n.ammo]).toEqual({ ...src0, quantity: 30 });
    expect(s.containers['stash']!.items).toContain(n.ammo);
    expectHealthy(s, total, 'over-stackMax merge');
    // Now the target is full: the next merge is refused and nothing moves.
    expectRejected(s, () => mergeStacks(s, content, n.ammo, n.deepAmmo), 'inv.err.no_space', 'into the now-full target');
  });

  it('a non-empty bag cannot be put into a grid or list (system transfers into a list are the only exception)', () => {
    const n = namedFixture();
    const s = n.fx.store;
    expectRejected(s, () => moveItem(s, content, n.bagA, { containerId: 'stash' }), 'inv.err.bag_not_empty', 'packed A → grid');
    expectRejected(s, () => moveItem(s, content, n.bagA, { containerId: 'pile' }), 'inv.err.bag_not_empty', 'packed A → list');
    expectRejected(s, () => moveItem(s, content, n.bagB, { containerId: 'stash', x: 0, y: 3 }), 'inv.err.bag_not_empty', 'packed nested B → grid cell');
    expectRejected(s, () => moveItem(s, content, n.bagC, { containerId: bagContainerId(n.spareBag) }), 'inv.err.bag_not_empty', 'packed C → another bag');
    expectRejected(s, () => moveItem(s, content, n.bagB, { containerId: 'stash' }, { allowNonEmptyBag: true }), 'inv.err.bag_not_empty', 'allowNonEmptyBag does not open grids');
  });

  it('explicit placements on fractional or NaN cells are refused (they would straddle occupied cells)', () => {
    const n = namedFixture();
    const s = n.fx.store;
    // Stash row 2 holds 9mm at x=0 and relief 9mm at x=1: x=0.5 straddles both, NaN is no cell at all.
    for (const [x, y] of [
      [0.5, 2],
      [1.5, 2.5],
      [Number.NaN, 2],
      [0, Number.NaN],
    ] as const) {
      const before = structuredClone(s);
      const r = moveItem(s, content, n.deepAmmo, { containerId: 'stash', x, y });
      expect(r.ok, `move 9mm to (${x}, ${y}) → ${JSON.stringify(r)}; validateStore: ${JSON.stringify(validateStore(s, content))}; independent checker: ${JSON.stringify(ownershipProblems(s))}`).toBe(false);
      expect(s).toEqual(before);
    }
  });
});

describe('A07 (b) the same rejections through raid ops and shelter actions', () => {
  it('raid ops: slot mismatch, packed bag into loot / itself, bad split, cross-definition merge, occupied cell → store untouched', () => {
    const f = raidFixture();
    const sim = f.t.ctx.sim;
    const s = sim.store;
    const eq = (sl: EquipSlot) => s.containers[eqContainerId('player', sl)]!.items[0]!;
    const bag = bagOf(f.t);
    const bagItem = eq('backpack');
    const inBag = (defId: string) => s.containers[bag]!.items.find((id) => s.items[id]!.definitionId === defId)!;
    const crateItem = (defId: string) => s.containers[f.crate]!.items.find((id) => s.items[id]!.definitionId === defId)!;
    const cases: [RaidOp, string][] = [
      [{ op: 'move', itemId: eq('secondary'), target: { containerId: eqContainerId('player', 'primary2') } }, 'inv.err.slot_mismatch'],
      [{ op: 'equip', itemId: eq('secondary'), slot: 'vest' }, 'inv.err.slot_mismatch'],
      [{ op: 'move', itemId: bagItem, target: { containerId: f.crate } }, 'inv.err.bag_not_empty'],
      [{ op: 'drop', itemId: bagItem }, 'inv.err.bag_not_empty'],
      [{ op: 'move', itemId: bagItem, target: { containerId: bag } }, 'inv.err.into_self'],
      [{ op: 'equip', itemId: crateItem('core.bag.basic'), slot: 'backpack' }, 'inv.err.swap_bag'],
      [{ op: 'unequip', slot: 'backpack' }, 'inv.err.swap_bag'],
      [{ op: 'split', itemId: inBag('core.mat.scrap'), qty: 0, target: { containerId: bag } }, 'inv.err.bad_quantity'],
      [{ op: 'split', itemId: inBag('core.mat.scrap'), qty: 4, target: { containerId: bag } }, 'inv.err.bad_quantity'],
      [{ op: 'merge', fromId: crateItem('core.ammo.9.fmj'), toId: crateItem('core.ammo.556.fmj') }, 'inv.err.not_stackable'],
      [{ op: 'move', itemId: inBag('core.mat.scrap'), target: { containerId: f.crate, x: s.items[crateItem('core.mat.scrap')]!.gridPosition!.x, y: s.items[crateItem('core.mat.scrap')]!.gridPosition!.y } }, 'inv.err.no_space'],
      [{ op: 'move', itemId: inBag('core.mat.scrap'), target: { containerId: 'nowhere' } }, 'inv.err.no_access'],
    ];
    for (const [op, error] of cases) expectRejected(s, () => stepSim(f.t.ctx, { cmd: null, ops: [op] }, SIM_DT).opResults[0]!, error, JSON.stringify(op));
  });

  it('shelter actions: failures return the untouched profile (runTx) with the store error as reason', () => {
    const p = shelterProfile('a07-shelter-reject');
    const snapshot = structuredClone(p);
    const bag = p.store.containers[eqContainerId('player', 'backpack')]!.items[0]!;
    const stashOf = (defId: string) => p.store.containers['stash']!.items.find((id) => p.store.items[id]!.definitionId === defId)!;
    const cases: [(d: ProfileState) => unknown, string][] = [
      [(d) => moveProfileItem(d, content, bag, { containerId: bagContainerId(bag) }), 'inv.err.into_self'],
      [(d) => moveProfileItem(d, content, bag, { containerId: 'stash' }), 'inv.err.bag_not_empty'],
      [(d) => unequipProfileItem(d, content, 'backpack'), 'inv.err.bag_not_empty'],
      [(d) => equipProfileItem(d, content, stashOf('core.bag.hiker'), 'backpack'), 'inv.err.bag_not_empty'],
      [(d) => equipProfileItem(d, content, stashOf('core.weapon.c556'), 'secondary'), 'inv.err.slot_mismatch'],
      [(d) => splitProfileStack(d, content, stashOf('core.mat.scrap'), 10, { containerId: 'incoming' }), 'inv.err.bad_quantity'],
      [(d) => mergeProfileStacks(d, content, stashOf('core.ammo.9.fmj'), stashOf('core.ammo.556.fmj')), 'inv.err.not_stackable'],
      [(d) => moveProfileItem(d, content, stashOf('core.mat.scrap'), { containerId: 'deathbag' }), 'inv.err.no_access'],
    ];
    for (const [fn, reason] of cases) {
      const { outcome, next } = runTx(p, `a07:reject:${reason}`, fn);
      expect(outcome).toEqual({ ok: false, applied: false, reason });
      expect(next).toBe(p);
      expect(p).toEqual(snapshot);
    }
  });
});

// --- (c) split then merge restores the original quantity ---------------------------------------------------------

describe('A07 (c) split then merge restores the original quantity', () => {
  it('fixed cases: grid / explicit cell / list / nested bag / slot-free generic target; merging back restores the exact store', () => {
    const n = namedFixture();
    const s = n.fx.store;
    const cases: [string, number, Placement][] = [
      [n.ammo, 1, { containerId: 'pile' }],
      [n.ammo, 17, { containerId: bagContainerId(n.bagC) }],
      [n.ammo, 49, { containerId: 'stash', x: 5, y: 3 }],
      [n.deepAmmo, 39, { containerId: 'stash', rotation: 1 }],
      [n.relief, 4, { containerId: bagContainerId(n.bagA) }],
      [n.scrap, 2, { containerId: 'pile' }],
      [n.rifleAmmo, 10, { containerId: bagContainerId(n.spareBag) }],
    ];
    for (const [id, qty, target] of cases) {
      const label = `split ${qty} of ${id} → ${JSON.stringify(target)}`;
      const before = structuredClone(s);
      const total = totals(s);
      const q0 = s.items[id]!.quantity;
      const r = splitStack(s, content, n.fx.ids, id, qty, target);
      expect(r.ok, label).toBe(true);
      const newId = (r as { ok: true; newId: string }).newId;
      expect(s.items[id]!.quantity + s.items[newId]!.quantity, label).toBe(q0);
      expectHealthy(s, total, label);
      expect(mergeStacks(s, content, newId, id), label).toEqual({ ok: true, moved: qty, destroyedFrom: true });
      expect(s.items[id]!.quantity, label).toBe(q0);
      expect(s, `${label}: merge back restores the store exactly`).toEqual(before);
    }
  });

  it('seeded random split/merge pairs over the fuzz fixture restore quantity in both merge directions', () => {
    const fx = buildFixture();
    const s = fx.store;
    const expected = totals(s);
    const rng = Rng.fromSeed('a07-split-merge');
    let pairs = 0;
    for (let i = 0; i < 300; i++) {
      const stacks = Object.keys(s.items)
        .sort()
        .filter((id) => s.items[id]!.quantity > 1);
      const id = rng.pick(stacks);
      const q0 = s.items[id]!.quantity;
      const qty = rng.int(1, q0 - 1);
      const before = structuredClone(s);
      const r = splitStack(s, content, fx.ids, id, qty, randomPlacement(rng, s));
      if (!r.ok) {
        expect(s).toEqual(before);
        continue;
      }
      pairs++;
      const newId = r.newId;
      expectHealthy(s, expected, `split #${i}`);
      if (rng.chance(0.5)) {
        expect(mergeStacks(s, content, newId, id)).toEqual({ ok: true, moved: qty, destroyedFrom: true });
        expect(s).toEqual(before);
      } else {
        // Reverse direction: the split-off stack absorbs the remainder (stackMax is never exceeded since q0 ≤ stackMax).
        expect(mergeStacks(s, content, id, newId)).toEqual({ ok: true, moved: q0 - qty, destroyedFrom: true });
        expect(s.items[id]).toBeUndefined();
        expect(s.items[newId]!.quantity).toBe(q0);
      }
      expectHealthy(s, expected, `merge #${i}`);
    }
    expect(pairs).toBeGreaterThan(100);
  });

  it('through raid ops and shelter actions as well', () => {
    const f = raidFixture();
    const sim = f.t.ctx.sim;
    const bag = bagOf(f.t);
    const ammo = sim.store.containers[f.crate]!.items.find((id) => sim.store.items[id]!.definitionId === 'core.ammo.9.fmj')!;
    const before = structuredClone(sim.store);
    expect(raidStep(f, { op: 'split', itemId: ammo, qty: 20, target: { containerId: bag } })).toEqual({ ok: true });
    const newId = Object.keys(sim.store.items).find((id) => !before.items[id])!;
    expect(sim.store.items[newId]).toMatchObject({ definitionId: 'core.ammo.9.fmj', quantity: 20, ownerContainerId: bag });
    expect(sim.store.items[ammo]!.quantity).toBe(32);
    expect(raidStep(f, { op: 'merge', fromId: newId, toId: ammo })).toEqual({ ok: true });
    expect(sim.store).toEqual(before);

    let p = shelterProfile('a07-shelter-split');
    const stack = p.store.containers['stash']!.items.find((id) => p.store.items[id]!.definitionId === 'core.ammo.12g.buck' && p.store.items[id]!.quantity === 30)!;
    const p0 = structuredClone(p.store);
    const split = runTx(p, 'a07:split', (d) => splitProfileStack(d, content, stack, 11, { containerId: 'incoming' }));
    expect(split.outcome.ok).toBe(true);
    p = split.next;
    const sid = (split.outcome as { ok: true; applied: true; value: string }).value;
    expect(p.store.items[stack]!.quantity + p.store.items[sid]!.quantity).toBe(30);
    const merged = runTx(p, 'a07:merge', (d) => mergeProfileStacks(d, content, sid, stack));
    expect(merged.outcome.ok).toBe(true);
    expect(merged.next.store).toEqual(p0);
  });
});

// --- (d) overweight ------------------------------------------------------------------------------------------------

function raidOp(t: TestWorld, op: RaidOp): OpResult {
  return stepSim(t.ctx, { cmd: null, ops: [op] }, SIM_DT).opResults[0]!;
}

const kg = (t: TestWorld) => carriedWeightKg(t.ctx, t.player);

/** Player carrying exactly 35.5 kg (military bag 2.0 + vest4 9.5 + eight 3.0 kg fuel cans), a searched crate beside them. */
function heavyWorld(): { t: TestWorld; bag: string; crate: string } {
  const t = world(RAID_MAP, 6, 6);
  const sim = t.ctx.sim;
  destroyItem(sim.store, sim.store.containers[eqContainerId('player', 'backpack')]!.items[0]!);
  give(t, 'core.bag.military', eqContainerId('player', 'backpack'));
  give(t, 'core.armor.vest4', eqContainerId('player', 'vest'));
  const bag = bagOf(t);
  for (let i = 0; i < 8; i++) give(t, 'core.mat.fuel', bag);
  const crate = lootSpot(t, 'ct:a07_heavy', 'grid', 10, 6, 6.5, 'world');
  sim.loot = { containerId: crate };
  expect(kg(t)).toBe(35.5);
  return { t, bag, crate };
}

/** The op is refused with inv.err.overweight, the item is still in its source and nothing at all changed. */
function expectOverweight(t: TestWorld, op: RaidOp, itemId: string, source: string): void {
  const before = structuredClone(t.ctx.sim.store);
  const w0 = kg(t);
  expect(raidOp(t, op), `${JSON.stringify(op)} at ${w0} kg`).toEqual({ ok: false, error: 'inv.err.overweight' });
  expect(t.ctx.sim.store.items[itemId]!.ownerContainerId).toBe(source);
  expect(t.ctx.sim.store).toEqual(before);
  expect(kg(t)).toBe(w0);
}

describe('A07 (d) overweight: a new pickup that would take carried weight above 40 kg is refused', () => {
  it('move pickups are allowed up to exactly 40 kg and refused above it; the refused item stays in the loot', () => {
    const { t, bag, crate } = heavyWorld();
    const s = t.ctx.sim.store;
    expect(WEIGHT.heavy).toBe(40);
    const scrap5 = give(t, 'core.mat.scrap', crate, { quantity: 5 });
    const fuel = give(t, 'core.mat.fuel', crate);
    const power = give(t, 'core.mat.power_unit', crate);
    const scrap4 = give(t, 'core.mat.scrap', crate, { quantity: 4 });
    const scrap1 = give(t, 'core.mat.scrap', crate, { quantity: 1 });
    const round = give(t, 'core.ammo.9.fmj', crate, { quantity: 1 });
    expect(raidOp(t, { op: 'move', itemId: scrap5, target: { containerId: bag } })).toEqual({ ok: true });
    expect(kg(t)).toBe(38);
    expectOverweight(t, { op: 'move', itemId: fuel, target: { containerId: bag } }, fuel, crate); // 41.0
    expectOverweight(t, { op: 'move', itemId: power, target: { containerId: bag } }, power, crate); // 40.5
    expect(raidOp(t, { op: 'move', itemId: scrap4, target: { containerId: bag } })).toEqual({ ok: true });
    expect(kg(t)).toBe(40); // exactly at the limit is still allowed
    expectOverweight(t, { op: 'move', itemId: scrap1, target: { containerId: bag } }, scrap1, crate);
    expectOverweight(t, { op: 'move', itemId: round, target: { containerId: bag } }, round, crate);
    // Rearranging what is already carried is not an acquisition.
    expect(raidOp(t, { op: 'move', itemId: scrap4, target: { containerId: bag } })).toEqual({ ok: true });
    // Dropping frees capacity: the 2.5 kg power unit then fits (37.0 → 39.5).
    const carriedFuel = s.containers[bag]!.items.find((id) => s.items[id]!.definitionId === 'core.mat.fuel')!;
    expect(raidOp(t, { op: 'drop', itemId: carriedFuel })).toEqual({ ok: true });
    expect(kg(t)).toBe(37);
    expect(raidOp(t, { op: 'move', itemId: power, target: { containerId: bag } })).toEqual({ ok: true });
    expect(kg(t)).toBe(39.5);
    expect(s.items[fuel]!.ownerContainerId).toBe(crate);
    expectHealthy(s, totals(s), 'after pickups');
  });

  it('equip from the loot into an empty slot follows the same limit', () => {
    const { t, crate } = heavyWorld();
    const helmet4 = give(t, 'core.armor.helmet4', crate); // 2.3 kg
    const helmet3 = give(t, 'core.armor.helmet3', crate); // 1.6 kg
    const shotgun = give(t, 'core.weapon.sgp', crate); // 3.4 kg, empty tube
    const scrap5 = give(t, 'core.mat.scrap', crate, { quantity: 5 });
    expect(raidOp(t, { op: 'move', itemId: scrap5, target: { containerId: bagOf(t) } })).toEqual({ ok: true }); // 38.0
    expectOverweight(t, { op: 'equip', itemId: helmet4, slot: 'helmet' }, helmet4, crate); // 40.3
    expect(raidOp(t, { op: 'equip', itemId: helmet3, slot: 'helmet' })).toEqual({ ok: true }); // 39.6
    expect(kg(t)).toBeCloseTo(39.6, 9);
    expectOverweight(t, { op: 'equip', itemId: shotgun, slot: 'primary1' }, shotgun, crate); // 43.0
  });

  it('takeAll takes what fits under 40 kg and leaves the rest in the container', () => {
    const { t, bag, crate } = heavyWorld();
    const s = t.ctx.sim.store;
    const scrap5 = give(t, 'core.mat.scrap', crate, { quantity: 5 });
    expect(raidOp(t, { op: 'move', itemId: scrap5, target: { containerId: bag } })).toEqual({ ok: true }); // 38.0
    const scrap2 = give(t, 'core.mat.scrap', crate, { quantity: 2 }); // 1.0
    const fuel = give(t, 'core.mat.fuel', crate); // 3.0
    const scrap1 = give(t, 'core.mat.scrap', crate, { quantity: 1 }); // 0.5
    expect(raidOp(t, { op: 'takeAll' })).toEqual({ ok: true });
    expect(s.items[scrap2]!.ownerContainerId).toBe(bag);
    expect(s.items[scrap1]!.ownerContainerId).toBe(bag);
    expect(s.items[fuel]!.ownerContainerId).toBe(crate);
    expect(kg(t)).toBe(39.5);
    // Nothing left that fits: refused as a whole, nothing changes.
    const before = structuredClone(s);
    expect(raidOp(t, { op: 'takeAll' }).ok).toBe(false);
    expect(s).toEqual(before);
    expect(s.items[fuel]!.ownerContainerId).toBe(crate);
  });

  it('merging a loot stack into a carried stack counts the moved units', () => {
    const { t, bag, crate } = heavyWorld();
    const carried = give(t, 'core.mat.scrap', crate, { quantity: 5 });
    expect(raidOp(t, { op: 'move', itemId: carried, target: { containerId: bag } })).toEqual({ ok: true }); // 38.0
    const five = give(t, 'core.mat.scrap', crate, { quantity: 5 });
    const four = give(t, 'core.mat.scrap', crate, { quantity: 4 });
    expectOverweight(t, { op: 'merge', fromId: five, toId: carried }, five, crate); // +2.5 → 40.5
    expect(raidOp(t, { op: 'merge', fromId: four, toId: carried })).toEqual({ ok: true }); // +2.0 → 40.0
    expect(kg(t)).toBe(40);
    expect(t.ctx.sim.store.items[carried]!.quantity).toBe(9);
  });

  it('splitting part of a loot stack into the bag is a pickup too', () => {
    const { t, bag, crate } = heavyWorld();
    const s = t.ctx.sim.store;
    const carried = give(t, 'core.mat.scrap', crate, { quantity: 5 });
    expect(raidOp(t, { op: 'move', itemId: carried, target: { containerId: bag } })).toEqual({ ok: true }); // 38.0
    const pile = give(t, 'core.mat.scrap', crate, { quantity: 10 }); // 5.0 kg in the crate
    const before = structuredClone(s);
    const r = raidOp(t, { op: 'split', itemId: pile, qty: 6, target: { containerId: bag } }); // +3.0 → 41.0
    expect({ result: r, carriedKg: kg(t) }, 'split of 6 scrap (3 kg) from the crate into the bag at 38 kg').toEqual({ result: { ok: false, error: 'inv.err.overweight' }, carriedKg: 38 });
    expect(s).toEqual(before);
    expect(raidOp(t, { op: 'split', itemId: pile, qty: 4, target: { containerId: bag } })).toEqual({ ok: true }); // +2.0 → 40.0
    expect(kg(t)).toBe(40);
  });

  it('unloading a magazine that lies in the loot into the bag cannot push carried weight above 40 kg', () => {
    const { t, bag, crate } = heavyWorld();
    const s = t.ctx.sim.store;
    const scrap9 = give(t, 'core.mat.scrap', crate, { quantity: 9 });
    expect(raidOp(t, { op: 'move', itemId: scrap9, target: { containerId: bag } })).toEqual({ ok: true }); // 40.0
    const mag = give(t, 'core.mag.lmg', crate);
    s.items[mag]!.mag!.rounds = Array.from({ length: 75 }, () => 'core.ammo.556.fmj'); // 75 × 0.012 = 0.9 kg
    const before = structuredClone(s);
    const r = raidOp(t, { op: 'unloadMag', magId: mag });
    const inBag = s.containers[bag]!.items.filter((id) => s.items[id]!.definitionId === 'core.ammo.556.fmj').reduce((n, id) => n + s.items[id]!.quantity, 0);
    expect({ carriedAtMost40: kg(t) <= WEIGHT.heavy + 1e-9, roundsTakenIntoBag: inBag }, `unloadMag → ${JSON.stringify(r)}, carried ${kg(t).toFixed(3)} kg`).toEqual({ carriedAtMost40: true, roundsTakenIntoBag: 0 });
    if (!r.ok) expect(s).toEqual(before);
  });

  it('picking up a loaded weapon counts its magazine and rounds (move / equip / takeAll)', () => {
    const { t, bag, crate } = heavyWorld();
    const scrap4 = give(t, 'core.mat.scrap', crate, { quantity: 4 });
    expect(raidOp(t, { op: 'move', itemId: scrap4, target: { containerId: bag } })).toEqual({ ok: true }); // 37.5
    const rifle = giveLoadedWeapon(t.content, t.ctx.sim, crate, 'core.weapon.c556', 'core.ammo.556.fmj', 0, 0, null);
    const tree = [rifle, ...descendants(t.ctx.sim.store, rifle)];
    const rifleKg = tree.reduce((w, id) => w + itemWeightKg(t.ctx, id), 0);
    expect(rifleKg).toBeCloseTo(2.4 + 0.2 + 19 * 0.012, 9); // carbine + magazine + 19 rounds (20th is chambered)
    expect(37.5 + rifleKg).toBeGreaterThan(WEIGHT.heavy);
    const pristine = structuredClone(t.ctx.sim.store);
    const attempts: RaidOp[] = [{ op: 'move', itemId: rifle, target: { containerId: bag } }, { op: 'equip', itemId: rifle, slot: 'primary1' }, { op: 'takeAll' }];
    const outcomes = attempts.map((op) => {
      t.ctx.sim.store = structuredClone(pristine); // every attempt starts from 37.5 kg with the rifle in the crate
      const r = raidOp(t, op);
      return { op: op.op, ok: r.ok, overweightError: op.op === 'takeAll' ? null : r.error === 'inv.err.overweight', rifleOwner: t.ctx.sim.store.items[rifle]!.ownerContainerId, carriedKg: Math.round(kg(t) * 1000) / 1000 };
    });
    expect(outcomes, `rifle with contents weighs ${rifleKg.toFixed(3)} kg; carried before: 37.5 kg`).toEqual([
      { op: 'move', ok: false, overweightError: true, rifleOwner: crate, carriedKg: 37.5 },
      { op: 'equip', ok: false, overweightError: true, rifleOwner: crate, carriedKg: 37.5 },
      { op: 'takeAll', ok: false, overweightError: null, rifleOwner: crate, carriedKg: 37.5 },
    ]);
  });

  it('equipping a packed backpack from a corpse counts everything inside it', () => {
    const t = world(RAID_MAP, 6, 6);
    const sim = t.ctx.sim;
    destroyItem(sim.store, sim.store.containers[eqContainerId('player', 'backpack')]!.items[0]!);
    give(t, 'core.armor.vest4', eqContainerId('player', 'vest')); // 9.5
    give(t, 'core.weapon.lmg', eqContainerId('player', 'primary1')); // 6.5
    expect(kg(t)).toBe(16);
    const corpse = lootSpot(t, 'corpse:a07_packed', 'list', 0, 0, 6.5, 'corpse');
    const packed = give(t, 'core.bag.military', corpse); // 2.0
    for (let i = 0; i < 8; i++) give(t, 'core.mat.fuel', bagContainerId(packed)); // 24.0
    sim.loot = { containerId: corpse };
    const before = structuredClone(sim.store);
    const r = raidOp(t, { op: 'equip', itemId: packed, slot: 'backpack' });
    // 16 + 2 + 24 = 42 kg > 40 kg.
    expect({ result: r, carriedKg: kg(t), bagOwner: sim.store.items[packed]!.ownerContainerId }).toEqual({ result: { ok: false, error: 'inv.err.overweight' }, carriedKg: 16, bagOwner: corpse });
    expect(sim.store).toEqual(before);
  });
});

// --- (e) bags carry their descendants; non-empty bags are refused where not allowed ------------------------------

describe('A07 (e) a bag moves together with everything inside it', () => {
  it('store: packed bag A (B ⊃ C, weapon with magazine + grip) moves slot → other actor → generic slot → list (system) → back', () => {
    const n = namedFixture();
    const s = n.fx.store;
    const smg = put(n.fx, 'core.weapon.sm9', { containerId: bagContainerId(n.bagB) });
    const smgMag = child(n.fx, smg, 'core.mag.sm9', { magazine: true });
    const grip = child(n.fx, smg, 'core.att.grip', { attachment: 'grip' });
    ensureEquipContainers(s, 'B');
    addContainer(s, { id: 'hook', kind: 'slot', w: 1, h: 1 });
    const tree = descendants(s, n.bagA).sort();
    expect(tree).toEqual([n.bagB, n.bagC, n.deepAmmo, n.vest, smg, smgMag, grip].sort());
    const owners = Object.fromEntries(tree.map((id) => [id, s.items[id]!.ownerContainerId]));
    const total = totals(s);
    const route: [string, { allowNonEmptyBag?: boolean }][] = [
      [eqContainerId('B', 'backpack'), {}],
      ['hook', {}],
      ['pile', { allowNonEmptyBag: true }],
      [eqContainerId(ACTOR, 'backpack'), {}],
    ];
    for (const [target, opts] of route) {
      const from = s.items[n.bagA]!.ownerContainerId!;
      expect(moveItem(s, content, n.bagA, { containerId: target }, opts), `A → ${target}`).toEqual({ ok: true });
      expect(s.items[n.bagA]!.ownerContainerId).toBe(target);
      expect(descendants(s, n.bagA).sort()).toEqual(tree);
      for (const id of tree) expect(s.items[id]!.ownerContainerId, id).toBe(owners[id]);
      expect(itemsInContainerDeep(s, target)).toEqual(expect.arrayContaining([n.bagA, ...tree]));
      for (const id of [n.bagA, ...tree]) expect(itemsInContainerDeep(s, from)).not.toContain(id);
      expectHealthy(s, total, `A → ${target}`);
    }
  });

  it('store → store: transferBetweenStores moves the packed bag, all descendants and every nested bag container exactly once', () => {
    const n = namedFixture();
    const src = n.fx.store;
    const dst = emptyStore();
    ensureEquipContainers(dst, 'X');
    const tree = [n.bagA, ...descendants(src, n.bagA)].sort();
    const srcTotal = totals(src);
    const moved = transferBetweenStores(src, dst, n.bagA).sort();
    expect(moved).toEqual(tree);
    for (const id of tree) {
      expect(src.items[id], `${id} left the source`).toBeUndefined();
      expect(dst.items[id], `${id} arrived`).toBeDefined();
    }
    for (const b of [n.bagA, n.bagB, n.bagC]) {
      expect(src.containers[bagContainerId(b)]).toBeUndefined();
      expect(dst.containers[bagContainerId(b)]).toBeDefined();
    }
    expect(src.containers[eqContainerId(ACTOR, 'backpack')]!.items).toEqual([]);
    expect(adoptItem(dst, content, n.bagA, { containerId: eqContainerId('X', 'backpack') })).toEqual({ ok: true });
    const movedTotal = totals(dst);
    const rest: Record<string, number> = { ...srcTotal };
    for (const [d, q] of Object.entries(movedTotal)) {
      rest[d] = (rest[d] ?? 0) - q;
      if (rest[d] === 0) delete rest[d];
    }
    expectHealthy(src, rest, 'source after transfer');
    expectHealthy(dst, movedTotal, 'destination after adopt');
  });

  it('deployment moves the packed starter bag with its magazines and bandages from the profile into the raid (single owner)', () => {
    const p = newProfile(content, 1, 'A07', 'a07-deploy', 0);
    p.flags['deploy_allowed'] = true;
    const bag = p.store.containers[eqContainerId('player', 'backpack')]!.items[0]!;
    const tree = [bag, ...descendants(p.store, bag)].sort();
    expect(tree.length).toBeGreaterThan(3);
    const { outcome, next } = runTx(p, 'deploy:a07', (d) => prepareDeploy(d, content, 'core.dest.quarantine_main', 0));
    expect(outcome.ok).toBe(true);
    const launch = (outcome as { ok: true; applied: true; value: ReturnType<typeof prepareDeploy> }).value;
    for (const id of tree) {
      expect(next.store.items[id], `${id} left the profile`).toBeUndefined();
      expect(launch.loadout.items[id], `${id} in the loadout`).toBeDefined();
    }
    expect(validateStore(next.store, content)).toEqual([]);
    expect(ownershipProblems(next.store)).toEqual([]);
    const { sim } = createRaidSim(content, launch);
    expect(sim.store.items[bag]!.ownerContainerId).toBe(eqContainerId('player', 'backpack'));
    expect([bag, ...descendants(sim.store, bag)].sort()).toEqual(tree);
    expect(validateStore(sim.store, content)).toEqual([]);
    expect(ownershipProblems(sim.store)).toEqual([]);
  });
});

describe('A07 (e) a non-empty bag is refused where it is not allowed; once emptied the same move succeeds', () => {
  it('raid: move to loot / drop refused while packed; the emptied bag moves and its (empty) container goes with it', () => {
    const f = raidFixture();
    const sim = f.t.ctx.sim;
    const s = sim.store;
    const bagItem = s.containers[eqContainerId('player', 'backpack')]!.items[0]!;
    const bag = bagContainerId(bagItem);
    sim.loot = { containerId: f.corpse };
    expectRejected(s, () => raidStep(f, { op: 'move', itemId: bagItem, target: { containerId: f.corpse } }), 'inv.err.bag_not_empty', 'packed bag → corpse list');
    sim.loot = { containerId: f.crate };
    expectRejected(s, () => raidStep(f, { op: 'move', itemId: bagItem, target: { containerId: f.crate } }), 'inv.err.bag_not_empty', 'packed bag → crate grid');
    expectRejected(s, () => raidStep(f, { op: 'drop', itemId: bagItem }), 'inv.err.bag_not_empty', 'drop packed bag');
    const total = totals(s);
    sim.loot = { containerId: f.corpse };
    for (const id of [...s.containers[bag]!.items]) expect(raidStep(f, { op: 'move', itemId: id, target: { containerId: f.corpse } })).toEqual({ ok: true });
    expect(s.containers[bag]!.items).toEqual([]);
    expect(raidStep(f, { op: 'move', itemId: bagItem, target: { containerId: f.corpse } })).toEqual({ ok: true });
    expect(s.items[bagItem]!.ownerContainerId).toBe(f.corpse);
    expect(s.containers[bag]).toEqual(expect.objectContaining({ items: [] }));
    expectHealthy(s, total, 'emptied bag moved to the corpse');
  });

  it('shelter: unequip / swap / move of a packed bag refused; after emptying it unequips into the stash', () => {
    let p = shelterProfile('a07-shelter-bag');
    const bagItem = p.store.containers[eqContainerId('player', 'backpack')]!.items[0]!;
    const bag = bagContainerId(bagItem);
    const hiker = p.store.containers['stash']!.items.find((id) => p.store.items[id]!.definitionId === 'core.bag.hiker')!;
    for (const [fn, reason] of [
      [(d: ProfileState) => unequipProfileItem(d, content, 'backpack'), 'inv.err.bag_not_empty'],
      [(d: ProfileState) => equipProfileItem(d, content, hiker, 'backpack'), 'inv.err.bag_not_empty'],
      [(d: ProfileState) => moveProfileItem(d, content, bagItem, { containerId: 'incoming' }), 'inv.err.bag_not_empty'],
    ] as const) {
      const r = runTx(p, `a07:bag:${reason}`, fn);
      expect(r.outcome).toEqual({ ok: false, applied: false, reason });
      expect(r.next).toBe(p);
    }
    const total = totals(p.store);
    for (const id of [...p.store.containers[bag]!.items]) {
      const r = runTx(p, `a07:empty:${id}`, (d) => moveProfileItem(d, content, id, { containerId: 'incoming' }));
      expect(r.outcome.ok).toBe(true);
      p = r.next;
    }
    const swapped = runTx(p, 'a07:swap-bag', (d) => equipProfileItem(d, content, hiker, 'backpack'));
    expect(swapped.outcome.ok).toBe(true);
    p = swapped.next;
    expect(p.store.containers[eqContainerId('player', 'backpack')]!.items).toEqual([hiker]);
    expect(p.store.items[bagItem]!.ownerContainerId).toBe('stash');
    expect(p.store.containers[bag]).toEqual(expect.objectContaining({ items: [] }));
    expectHealthy(p.store, total, 'emptied starter bag swapped for the hiker bag');
  });
});
