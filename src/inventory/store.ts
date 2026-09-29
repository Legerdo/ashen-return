import type { AttachmentSlot, FireMode, ItemDef } from '../content/types';
import { allocId, type IdCounterState } from '../core/ids';

/**
 * Authoritative item ownership. Every ItemInstance has exactly one owner:
 *   - a container (grid / list / slot) listed in store.containers, or
 *   - a parent item ("item:<parentId>") that lists it in containedItems (magazine in weapon, attachments).
 * All mutations go through validate → reserve → commit helpers in this module.
 */

export interface WeaponRuntime {
  chamber: string | null;
  magazineId: string | null;
  tube: string[] | null;
  fireMode: FireMode;
}

export interface ItemInstance {
  instanceId: string;
  definitionId: string;
  quantity: number;
  durability: number | null;
  modifiers: string[];
  attachments: Partial<Record<AttachmentSlot, string>>;
  containedItems: string[];
  ownerContainerId: string | null;
  gridPosition: { x: number; y: number } | null;
  rotation: 0 | 1;
  questTags: string[];
  lockTags: string[];
  weapon?: WeaponRuntime;
  mag?: { rounds: string[] };
  medPool?: number;
}

export type ContainerKind = 'grid' | 'list' | 'slot';

export interface ContainerState {
  id: string;
  kind: ContainerKind;
  w: number;
  h: number;
  items: string[];
  /** Slot type for equipment slots / accepted item kinds. */
  accepts?: string;
}

export interface ItemStore {
  items: Record<string, ItemInstance>;
  containers: Record<string, ContainerState>;
}

export interface ItemLookup {
  item(defId: string): ItemDef;
  hasItem(defId: string): boolean;
}

export function emptyStore(): ItemStore {
  return { items: {}, containers: {} };
}

export const parentOwner = (parentId: string): string => `item:${parentId}`;
export const bagContainerId = (bagItemId: string): string => `bag:${bagItemId}`;

export function isItemOwner(owner: string | null): owner is string {
  return owner !== null && owner.startsWith('item:');
}

export function addContainer(store: ItemStore, c: Omit<ContainerState, 'items'> & { items?: string[] }): ContainerState {
  const existing = store.containers[c.id];
  if (existing) return existing;
  const cont: ContainerState = { ...c, items: c.items ?? [] };
  store.containers[c.id] = cont;
  return cont;
}

/** Footprint of an item given rotation. */
export function footprint(def: ItemDef, rotation: 0 | 1): { w: number; h: number } {
  return rotation === 1 ? { w: def.size.h, h: def.size.w } : { w: def.size.w, h: def.size.h };
}

export interface CreateItemOpts {
  quantity?: number;
  durability?: number | null;
  modifiers?: string[];
  questTags?: string[];
}

/** Create a new item instance (not yet owned). Callers must place it with placeNew*. */
export function instantiate(content: ItemLookup, ids: IdCounterState, defId: string, opts: CreateItemOpts = {}): ItemInstance {
  const def = content.item(defId);
  const inst: ItemInstance = {
    instanceId: allocId(ids, 'it'),
    definitionId: defId,
    quantity: Math.max(1, Math.min(def.stackMax, opts.quantity ?? 1)),
    durability: opts.durability !== undefined ? opts.durability : defaultDurability(def),
    modifiers: opts.modifiers ? [...opts.modifiers] : [],
    attachments: {},
    containedItems: [],
    ownerContainerId: null,
    gridPosition: null,
    rotation: 0,
    questTags: opts.questTags ? [...opts.questTags] : def.kind === 'quest' ? [...def.tags] : [],
    lockTags: [],
  };
  if (def.weapon) {
    inst.weapon = { chamber: null, magazineId: null, tube: def.weapon.magazineFamily === null ? [] : null, fireMode: def.weapon.modes[0]! };
  }
  if (def.magazine) inst.mag = { rounds: [] };
  if (def.medical?.type === 'firstaid') inst.medPool = def.medical.pool ?? 40;
  return inst;
}

export function defaultDurability(def: ItemDef): number | null {
  if (def.weapon) return 100;
  if (def.armor) return def.armor.maxDurability;
  return null;
}

// --- grid placement -----------------------------------------------------------------------------------------

export function occupancy(store: ItemStore, content: ItemLookup, cont: ContainerState, ignoreId?: string): Uint8Array {
  const occ = new Uint8Array(cont.w * cont.h);
  for (const id of cont.items) {
    if (id === ignoreId) continue;
    const it = store.items[id];
    if (!it || !it.gridPosition) continue;
    const fp = footprint(content.item(it.definitionId), it.rotation);
    for (let y = 0; y < fp.h; y++)
      for (let x = 0; x < fp.w; x++) {
        const gx = it.gridPosition.x + x;
        const gy = it.gridPosition.y + y;
        if (gx >= 0 && gy >= 0 && gx < cont.w && gy < cont.h) occ[gy * cont.w + gx] = 1;
      }
  }
  return occ;
}

export function fitsAt(occ: Uint8Array, cont: ContainerState, fp: { w: number; h: number }, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x + fp.w > cont.w || y + fp.h > cont.h) return false;
  for (let yy = 0; yy < fp.h; yy++) for (let xx = 0; xx < fp.w; xx++) if (occ[(y + yy) * cont.w + (x + xx)]) return false;
  return true;
}

export function findFreeSpot(store: ItemStore, content: ItemLookup, cont: ContainerState, def: ItemDef, ignoreId?: string): { x: number; y: number; rotation: 0 | 1 } | null {
  const occ = occupancy(store, content, cont, ignoreId);
  const rots: (0 | 1)[] = def.size.w === def.size.h ? [0] : [0, 1];
  for (const rotation of rots) {
    const fp = footprint(def, rotation);
    for (let y = 0; y + fp.h <= cont.h; y++) for (let x = 0; x + fp.w <= cont.w; x++) if (fitsAt(occ, cont, fp, x, y)) return { x, y, rotation };
  }
  return null;
}

// --- validation of target -----------------------------------------------------------------------------------

export type MoveError =
  | 'inv.err.no_item'
  | 'inv.err.no_container'
  | 'inv.err.no_space'
  | 'inv.err.slot_occupied'
  | 'inv.err.slot_mismatch'
  | 'inv.err.into_self'
  | 'inv.err.bag_not_empty'
  | 'inv.err.overweight'
  | 'inv.err.locked'
  | 'inv.err.not_stackable'
  | 'inv.err.bad_quantity';

export interface Placement {
  containerId: string;
  x?: number;
  y?: number;
  rotation?: 0 | 1;
}

/** Is `ancestorId` equal to or an ancestor (owner chain) of container/item `targetContainerId`? */
function containerIsInside(store: ItemStore, targetContainerId: string, itemId: string): boolean {
  // A bag cannot be moved into its own container (or any container nested inside it).
  let cid: string | null = targetContainerId;
  const seen = new Set<string>();
  while (cid && !seen.has(cid)) {
    seen.add(cid);
    if (cid === bagContainerId(itemId) || cid === parentOwner(itemId)) return true;
    let ownerItemId: string | null = null;
    if (cid.startsWith('bag:')) ownerItemId = cid.slice(4);
    else if (cid.startsWith('item:')) ownerItemId = cid.slice(5);
    if (!ownerItemId) return false;
    if (ownerItemId === itemId) return true;
    const owner: ItemInstance | undefined = store.items[ownerItemId];
    cid = owner?.ownerContainerId ?? null;
  }
  return false;
}

export function slotAccepts(def: ItemDef, accepts: string | undefined): boolean {
  if (!accepts) return true;
  switch (accepts) {
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

export interface ResolvedPlacement {
  containerId: string;
  gridPosition: { x: number; y: number } | null;
  rotation: 0 | 1;
}

export interface MoveOpts {
  /** System transfers (death bag, corpse) may carry a packed backpack into a list container. */
  allowNonEmptyBag?: boolean;
}

export function resolvePlacement(store: ItemStore, content: ItemLookup, itemId: string, target: Placement, opts: MoveOpts = {}): { ok: true; placement: ResolvedPlacement } | { ok: false; error: MoveError } {
  const it = store.items[itemId];
  if (!it) return { ok: false, error: 'inv.err.no_item' };
  const cont = store.containers[target.containerId];
  if (!cont) return { ok: false, error: 'inv.err.no_container' };
  const def = content.item(it.definitionId);
  if (containerIsInside(store, target.containerId, itemId)) return { ok: false, error: 'inv.err.into_self' };
  if (def.kind === 'backpack' && cont.kind !== 'slot' && !(opts.allowNonEmptyBag && cont.kind === 'list')) {
    const bag = store.containers[bagContainerId(itemId)];
    if (bag && bag.items.length > 0) return { ok: false, error: 'inv.err.bag_not_empty' };
  }
  if (cont.kind === 'slot') {
    if (!slotAccepts(def, cont.accepts)) return { ok: false, error: 'inv.err.slot_mismatch' };
    const occupied = cont.items.filter((i) => i !== itemId);
    if (occupied.length > 0) return { ok: false, error: 'inv.err.slot_occupied' };
    return { ok: true, placement: { containerId: cont.id, gridPosition: null, rotation: 0 } };
  }
  if (cont.kind === 'list') return { ok: true, placement: { containerId: cont.id, gridPosition: null, rotation: 0 } };
  // grid
  if (target.x !== undefined && target.y !== undefined) {
    // Cells are integers: fractional/NaN coordinates would index "free" phantom cells and overlap real items.
    if (!Number.isInteger(target.x) || !Number.isInteger(target.y)) return { ok: false, error: 'inv.err.no_space' };
    const rotation = target.rotation ?? it.rotation;
    const occ = occupancy(store, content, cont, itemId);
    if (!fitsAt(occ, cont, footprint(def, rotation), target.x, target.y)) return { ok: false, error: 'inv.err.no_space' };
    return { ok: true, placement: { containerId: cont.id, gridPosition: { x: target.x, y: target.y }, rotation } };
  }
  const spot = findFreeSpot(store, content, cont, def, itemId);
  if (!spot) return { ok: false, error: 'inv.err.no_space' };
  return { ok: true, placement: { containerId: cont.id, gridPosition: { x: spot.x, y: spot.y }, rotation: spot.rotation } };
}

// --- low level detach/attach (callers must have validated) --------------------------------------------------

function detach(store: ItemStore, it: ItemInstance): void {
  const owner = it.ownerContainerId;
  if (!owner) return;
  if (isItemOwner(owner)) {
    const parent = store.items[owner.slice(5)];
    if (parent) {
      parent.containedItems = parent.containedItems.filter((c) => c !== it.instanceId);
      if (parent.weapon && parent.weapon.magazineId === it.instanceId) parent.weapon.magazineId = null;
      for (const k of Object.keys(parent.attachments) as AttachmentSlot[]) if (parent.attachments[k] === it.instanceId) delete parent.attachments[k];
    }
  } else {
    const c = store.containers[owner];
    if (c) c.items = c.items.filter((i) => i !== it.instanceId);
  }
  it.ownerContainerId = null;
  it.gridPosition = null;
}

function attach(store: ItemStore, it: ItemInstance, p: ResolvedPlacement): void {
  const c = store.containers[p.containerId]!;
  it.ownerContainerId = c.id;
  it.gridPosition = p.gridPosition ? { ...p.gridPosition } : null;
  it.rotation = p.rotation;
  if (!c.items.includes(it.instanceId)) c.items.push(it.instanceId);
}

/** Move an existing item: validate → reserve (resolve placement) → commit. Never partially applies. */
export function moveItem(store: ItemStore, content: ItemLookup, itemId: string, target: Placement, opts: MoveOpts = {}): { ok: true } | { ok: false; error: MoveError } {
  const res = resolvePlacement(store, content, itemId, target, opts);
  if (!res.ok) return res;
  const it = store.items[itemId]!;
  detach(store, it);
  attach(store, it, res.placement);
  return { ok: true };
}

/** Put a freshly instantiated item into a container. */
export function placeNew(store: ItemStore, content: ItemLookup, inst: ItemInstance, target: Placement): { ok: true } | { ok: false; error: MoveError } {
  if (store.items[inst.instanceId]) throw new Error(`duplicate instance id ${inst.instanceId}`);
  store.items[inst.instanceId] = inst;
  const res = resolvePlacement(store, content, inst.instanceId, target);
  if (!res.ok) {
    delete store.items[inst.instanceId];
    return res;
  }
  attach(store, inst, res.placement);
  if (content.item(inst.definitionId).kind === 'backpack') ensureBagContainer(store, content, inst);
  return { ok: true };
}

export function ensureBagContainer(store: ItemStore, content: ItemLookup, bag: ItemInstance): ContainerState {
  const def = content.item(bag.definitionId);
  const bp = def.backpack ?? { w: 1, h: 1 };
  return addContainer(store, { id: bagContainerId(bag.instanceId), kind: 'grid', w: bp.w, h: bp.h });
}

/** Attach a child item (magazine, attachment) into a parent weapon. */
export function attachChild(store: ItemStore, parentId: string, childId: string, role: { magazine?: true; attachment?: AttachmentSlot }): void {
  const parent = store.items[parentId];
  const child = store.items[childId];
  if (!parent || !child) throw new Error('attachChild: missing item');
  detach(store, child);
  child.ownerContainerId = parentOwner(parentId);
  child.gridPosition = null;
  child.rotation = 0;
  if (!parent.containedItems.includes(childId)) parent.containedItems.push(childId);
  if (role.magazine && parent.weapon) parent.weapon.magazineId = childId;
  if (role.attachment) parent.attachments[role.attachment] = childId;
}

/** Destroy an item and all descendants (consumption, merge). Returns destroyed ids for the item log. */
export function destroyItem(store: ItemStore, itemId: string): string[] {
  const it = store.items[itemId];
  if (!it) return [];
  const out: string[] = [];
  for (const child of [...it.containedItems]) out.push(...destroyItem(store, child));
  const bag = store.containers[bagContainerId(itemId)];
  if (bag) {
    for (const c of [...bag.items]) out.push(...destroyItem(store, c));
    delete store.containers[bag.id];
  }
  detach(store, it);
  delete store.items[itemId];
  out.push(itemId);
  return out;
}

/** All descendants of an item (children and bag contents, recursively), excluding the item itself. */
export function descendants(store: ItemStore, itemId: string): string[] {
  const out: string[] = [];
  const stack = [itemId];
  while (stack.length) {
    const id = stack.pop()!;
    const it = store.items[id];
    if (!it) continue;
    for (const c of it.containedItems) {
      out.push(c);
      stack.push(c);
    }
    const bag = store.containers[bagContainerId(id)];
    if (bag)
      for (const c of bag.items) {
        out.push(c);
        stack.push(c);
      }
  }
  return out;
}

/** Display/sort order of item kinds (weapons first, quest items last). */
export const KIND_ORDER: readonly ItemDef['kind'][] = ['weapon', 'magazine', 'ammo', 'attachment', 'armor', 'backpack', 'accessory', 'melee', 'throwable', 'medical', 'tool', 'material', 'valuable', 'key', 'quest'];

/**
 * Re-pack a grid container in a stable order: kind (KIND_ORDER) → larger footprint first → definition id →
 * instance id. Items tagged `favorite` keep their cell (locked in place) and the rest is packed around them.
 * Only grid positions / rotation change — ownership, quantities and nested contents are untouched. All or
 * nothing: if the packed layout would not fit, nothing moves.
 */
export function sortGrid(store: ItemStore, content: ItemLookup, containerId: string): { ok: true; moved: number } | { ok: false; error: MoveError } {
  const cont = store.containers[containerId];
  if (!cont || cont.kind !== 'grid') return { ok: false, error: 'inv.err.no_container' };
  const ids = cont.items.filter((id) => store.items[id]);
  const pinned = ids.filter((id) => store.items[id]!.lockTags.includes('favorite') && store.items[id]!.gridPosition);
  const free = ids.filter((id) => !pinned.includes(id));
  const kindRank = (k: ItemDef['kind']) => {
    const i = KIND_ORDER.indexOf(k);
    return i < 0 ? KIND_ORDER.length : i;
  };
  free.sort((a, b) => {
    const ia = store.items[a]!;
    const ib = store.items[b]!;
    const da = content.item(ia.definitionId);
    const db = content.item(ib.definitionId);
    return kindRank(da.kind) - kindRank(db.kind) || db.size.w * db.size.h - da.size.w * da.size.h || (da.id < db.id ? -1 : da.id > db.id ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0);
  });
  const occ = new Uint8Array(cont.w * cont.h);
  const mark = (fp: { w: number; h: number }, x: number, y: number) => {
    for (let yy = 0; yy < fp.h; yy++) for (let xx = 0; xx < fp.w; xx++) occ[(y + yy) * cont.w + (x + xx)] = 1;
  };
  for (const id of pinned) {
    const it = store.items[id]!;
    mark(footprint(content.item(it.definitionId), it.rotation), it.gridPosition!.x, it.gridPosition!.y);
  }
  const plan: { id: string; x: number; y: number; rotation: 0 | 1 }[] = [];
  for (const id of free) {
    const def = content.item(store.items[id]!.definitionId);
    let spot: { x: number; y: number; rotation: 0 | 1 } | null = null;
    for (let y = 0; y < cont.h && !spot; y++)
      for (let x = 0; x < cont.w && !spot; x++)
        for (const rotation of (def.size.w === def.size.h ? [0] : [0, 1]) as (0 | 1)[]) {
          if (fitsAt(occ, cont, footprint(def, rotation), x, y)) {
            spot = { x, y, rotation };
            break;
          }
        }
    if (!spot) return { ok: false, error: 'inv.err.no_space' };
    mark(footprint(def, spot.rotation), spot.x, spot.y);
    plan.push({ id, ...spot });
  }
  let moved = 0;
  for (const s of plan) {
    const it = store.items[s.id]!;
    if (!it.gridPosition || it.gridPosition.x !== s.x || it.gridPosition.y !== s.y || it.rotation !== s.rotation) moved++;
    it.gridPosition = { x: s.x, y: s.y };
    it.rotation = s.rotation;
  }
  cont.items = [...pinned, ...plan.map((s) => s.id)];
  return { ok: true, moved };
}

/** Items directly or indirectly inside a container. */
export function itemsInContainerDeep(store: ItemStore, containerId: string): string[] {
  const c = store.containers[containerId];
  if (!c) return [];
  const out: string[] = [];
  for (const id of c.items) {
    out.push(id);
    out.push(...descendants(store, id));
  }
  return out;
}

// --- stacks -------------------------------------------------------------------------------------------------

export function canStack(content: ItemLookup, a: ItemInstance, b: ItemInstance): boolean {
  if (a.definitionId !== b.definitionId) return false;
  const def = content.item(a.definitionId);
  if (def.stackMax <= 1) return false;
  if (a.modifiers.join(',') !== b.modifiers.join(',')) return false;
  if (a.questTags.join(',') !== b.questTags.join(',')) return false;
  return true;
}

/** Merge `fromId` into `toId` (as much as fits). Quantity is conserved. */
export function mergeStacks(store: ItemStore, content: ItemLookup, fromId: string, toId: string): { ok: true; moved: number; destroyedFrom: boolean } | { ok: false; error: MoveError } {
  const a = store.items[fromId];
  const b = store.items[toId];
  if (!a || !b || fromId === toId) return { ok: false, error: 'inv.err.no_item' };
  if (!canStack(content, a, b)) return { ok: false, error: 'inv.err.not_stackable' };
  const max = content.item(b.definitionId).stackMax;
  const moved = Math.min(a.quantity, max - b.quantity);
  if (moved <= 0) return { ok: false, error: 'inv.err.no_space' };
  b.quantity += moved;
  a.quantity -= moved;
  let destroyedFrom = false;
  if (a.quantity <= 0) {
    destroyItem(store, fromId);
    destroyedFrom = true;
  }
  return { ok: true, moved, destroyedFrom };
}

/** Split `qty` off a stack into a new item placed at target. Quantity is conserved; fails atomically. */
export function splitStack(store: ItemStore, content: ItemLookup, ids: IdCounterState, itemId: string, qty: number, target: Placement): { ok: true; newId: string } | { ok: false; error: MoveError } {
  const it = store.items[itemId];
  if (!it) return { ok: false, error: 'inv.err.no_item' };
  if (!Number.isInteger(qty) || qty <= 0 || qty >= it.quantity) return { ok: false, error: 'inv.err.bad_quantity' };
  const probe = instantiate(content, ids, it.definitionId, { quantity: qty, modifiers: it.modifiers, questTags: it.questTags });
  probe.quantity = qty;
  const placed = placeNew(store, content, probe, target);
  if (!placed.ok) return placed;
  it.quantity -= qty;
  return { ok: true, newId: probe.instanceId };
}

// --- invariants ---------------------------------------------------------------------------------------------

export interface StoreViolation {
  itemId?: string;
  containerId?: string;
  problem: string;
}

/** Single-ownership invariant check. Used by tests and debug builds after transactions. */
export function validateStore(store: ItemStore, content?: ItemLookup): StoreViolation[] {
  const v: StoreViolation[] = [];
  const seen = new Map<string, string>();
  const claim = (itemId: string, by: string) => {
    const prev = seen.get(itemId);
    if (prev !== undefined) v.push({ itemId, problem: `listed by both ${prev} and ${by}` });
    else seen.set(itemId, by);
  };
  for (const c of Object.values(store.containers)) {
    for (const id of c.items) {
      claim(id, c.id);
      const it = store.items[id];
      if (!it) v.push({ containerId: c.id, itemId: id, problem: 'container lists missing item' });
      else if (it.ownerContainerId !== c.id) v.push({ itemId: id, problem: `owner mismatch ${it.ownerContainerId} vs ${c.id}` });
    }
    if (c.kind === 'slot' && c.items.length > 1) v.push({ containerId: c.id, problem: 'slot holds more than one item' });
    if (c.kind === 'grid' && content) {
      const occ = new Uint8Array(c.w * c.h);
      for (const id of c.items) {
        const it = store.items[id];
        if (!it || !content.hasItem(it.definitionId)) continue;
        if (!it.gridPosition) {
          v.push({ itemId: id, problem: 'grid item without position' });
          continue;
        }
        if (!Number.isInteger(it.gridPosition.x) || !Number.isInteger(it.gridPosition.y)) {
          v.push({ itemId: id, problem: `non-integer grid position ${it.gridPosition.x},${it.gridPosition.y}` });
          continue;
        }
        const fp = footprint(content.item(it.definitionId), it.rotation);
        for (let y = 0; y < fp.h; y++)
          for (let x = 0; x < fp.w; x++) {
            const gx = it.gridPosition.x + x;
            const gy = it.gridPosition.y + y;
            if (gx < 0 || gy < 0 || gx >= c.w || gy >= c.h) v.push({ itemId: id, problem: 'out of grid bounds' });
            else if (occ[gy * c.w + gx]) v.push({ itemId: id, problem: 'grid overlap' });
            else occ[gy * c.w + gx] = 1;
          }
      }
    }
  }
  for (const it of Object.values(store.items)) {
    for (const child of it.containedItems) {
      claim(child, `item:${it.instanceId}`);
      const ch = store.items[child];
      if (!ch) v.push({ itemId: child, problem: 'parent lists missing child' });
      else if (ch.ownerContainerId !== parentOwner(it.instanceId)) v.push({ itemId: child, problem: 'child owner mismatch' });
    }
    if (!it.ownerContainerId) v.push({ itemId: it.instanceId, problem: 'unowned item' });
    else if (!seen.has(it.instanceId) && !isItemOwner(it.ownerContainerId)) v.push({ itemId: it.instanceId, problem: 'owner does not list item' });
    if (!(it.quantity >= 1) || !Number.isInteger(it.quantity)) v.push({ itemId: it.instanceId, problem: `bad quantity ${it.quantity}` });
    if (it.weapon?.magazineId && !it.containedItems.includes(it.weapon.magazineId)) v.push({ itemId: it.instanceId, problem: 'magazine pointer not contained' });
  }
  for (const id of seen.keys()) if (!store.items[id]) v.push({ itemId: id, problem: 'dangling reference' });
  return v;
}

/** Total count of a definition (stack quantities) across the whole store. */
export function countDef(store: ItemStore, defId: string, containerIds?: string[]): number {
  let n = 0;
  const allowed = containerIds ? new Set(containerIds.flatMap((c) => itemsInContainerDeep(store, c))) : null;
  for (const it of Object.values(store.items)) {
    if (it.definitionId !== defId) continue;
    if (allowed && !allowed.has(it.instanceId)) continue;
    n += it.quantity;
  }
  return n;
}

/** Remove `qty` units of a definition from the given containers (deep). Returns false without mutation if insufficient. */
export function consumeDef(store: ItemStore, defId: string, qty: number, containerIds: string[]): boolean {
  const candidates = containerIds.flatMap((c) => itemsInContainerDeep(store, c)).map((id) => store.items[id]!).filter((it) => it && it.definitionId === defId && it.lockTags.length === 0);
  const total = candidates.reduce((s, it) => s + it.quantity, 0);
  if (total < qty) return false;
  let left = qty;
  // Consume smallest stacks first to keep inventories tidy.
  candidates.sort((a, b) => a.quantity - b.quantity || a.instanceId.localeCompare(b.instanceId));
  for (const it of candidates) {
    if (left <= 0) break;
    const take = Math.min(left, it.quantity);
    it.quantity -= take;
    left -= take;
    if (it.quantity <= 0) destroyItem(store, it.instanceId);
  }
  return true;
}

/** Transfer an item (and its descendants) between two stores, e.g. profile → raid at deployment. */
export function transferBetweenStores(from: ItemStore, to: ItemStore, itemId: string): string[] {
  const ids = [itemId, ...descendants(from, itemId)];
  const moved: string[] = [];
  for (const id of ids) {
    const it = from.items[id];
    if (!it) continue;
    if (to.items[id]) throw new Error(`transfer collision ${id}`);
    to.items[id] = it;
    delete from.items[id];
    moved.push(id);
  }
  // Move bag containers along with their bag items.
  for (const id of ids) {
    const cid = bagContainerId(id);
    const c = from.containers[cid];
    if (c) {
      to.containers[cid] = c;
      delete from.containers[cid];
    }
  }
  // Root item keeps no owner until the caller attaches it on the destination side.
  const root = to.items[itemId];
  if (root && root.ownerContainerId && !isItemOwner(root.ownerContainerId)) {
    const c = from.containers[root.ownerContainerId];
    if (c) c.items = c.items.filter((i) => i !== itemId);
    root.ownerContainerId = null;
    root.gridPosition = null;
  }
  return moved;
}

/** Attach an owner-less item (after transferBetweenStores) into a container of this store. */
export function adoptItem(store: ItemStore, content: ItemLookup, itemId: string, target: Placement, opts: MoveOpts = {}): { ok: true } | { ok: false; error: MoveError } {
  const it = store.items[itemId];
  if (!it) return { ok: false, error: 'inv.err.no_item' };
  const res = resolvePlacement(store, content, itemId, target, opts);
  if (!res.ok) return res;
  attach(store, it, res.placement);
  return { ok: true };
}
