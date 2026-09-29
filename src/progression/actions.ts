import type { ContentRegistry } from '../content/registry';
import type { AttachmentSlot, EquipSlot } from '../content/types';
import { fail } from '../core/tx';
import {
  attachChild,
  bagContainerId,
  destroyItem,
  findFreeSpot,
  instantiate,
  itemsInContainerDeep,
  mergeStacks,
  moveItem,
  placeNew,
  sortGrid,
  splitStack,
  type Placement,
} from '../inventory/store';
import { RELIEF_MODIFIER } from '../economy/trade';
import { applyQuestEvent, setFlag } from './quests';
import { grantItems, homeContainers, loadoutContainers, logItem, PLAYER, pushLog, SECURE_POCKET, STASH, type ProfileState } from './profile';

const eq = (s: EquipSlot) => `eq:${PLAYER}:${s}`;

/** Containers the player can freely rearrange in the shelter. */
export function shelterContainers(p: ProfileState): string[] {
  const out = [...homeContainers(p), ...loadoutContainers()];
  if (p.store.containers[SECURE_POCKET]) out.push(SECURE_POCKET);
  const bag = p.store.containers[eq('backpack')]?.items[0];
  if (bag && p.store.containers[bagContainerId(bag)]) out.push(bagContainerId(bag));
  return out;
}

function assertShelterItem(p: ProfileState, itemId: string): void {
  const it = p.store.items[itemId];
  if (!it) fail('inv.err.no_item');
  if (!shelterContainers(p).includes(it!.ownerContainerId ?? '')) fail('inv.err.no_access');
}

export function moveProfileItem(p: ProfileState, content: ContentRegistry, itemId: string, target: Placement): void {
  assertShelterItem(p, itemId);
  if (!shelterContainers(p).includes(target.containerId)) fail('inv.err.no_access');
  const r = moveItem(p.store, content, itemId, target);
  if (!r.ok) fail(r.error);
  pruneQuickslots(p);
}

export function equipProfileItem(p: ProfileState, content: ContentRegistry, itemId: string, slot: EquipSlot): void {
  assertShelterItem(p, itemId);
  const cur = p.store.containers[eq(slot)]?.items[0];
  if (cur === itemId) return;
  const it = p.store.items[itemId]!;
  const from = { containerId: it.ownerContainerId!, ...(it.gridPosition ? { x: it.gridPosition.x, y: it.gridPosition.y, rotation: it.rotation } : {}) };
  if (cur) {
    if (slot === 'backpack') {
      const bag = p.store.containers[bagContainerId(cur)];
      if (bag && bag.items.length > 0) fail('inv.err.bag_not_empty');
    }
    // Swap: current item goes to where the new one came from (or first free stash spot).
    const tmp = moveItem(p.store, content, cur, { containerId: 'incoming' });
    if (!tmp.ok) fail(tmp.error);
    const r = moveItem(p.store, content, itemId, { containerId: eq(slot) });
    if (!r.ok) {
      moveItem(p.store, content, cur, { containerId: eq(slot) });
      fail(r.error);
    }
    const back = moveItem(p.store, content, cur, from.containerId.startsWith('eq:') ? { containerId: STASH } : from);
    if (!back.ok) {
      const spot = findFreeSpot(p.store, content, p.store.containers[STASH]!, content.item(p.store.items[cur]!.definitionId), cur);
      if (spot) moveItem(p.store, content, cur, { containerId: STASH, x: spot.x, y: spot.y, rotation: spot.rotation });
    }
  } else {
    const r = moveItem(p.store, content, itemId, { containerId: eq(slot) });
    if (!r.ok) fail(r.error);
  }
  pruneQuickslots(p);
}

export function unequipProfileItem(p: ProfileState, content: ContentRegistry, slot: EquipSlot): void {
  const cur = p.store.containers[eq(slot)]?.items[0];
  if (!cur) fail('inv.err.no_item');
  const it = p.store.items[cur]!;
  const spot = findFreeSpot(p.store, content, p.store.containers[STASH]!, content.item(it.definitionId), cur);
  if (!spot) fail('inv.err.no_space');
  const r = moveItem(p.store, content, cur, { containerId: STASH, x: spot!.x, y: spot!.y, rotation: spot!.rotation });
  if (!r.ok) fail(r.error);
  pruneQuickslots(p);
}

export function splitProfileStack(p: ProfileState, content: ContentRegistry, itemId: string, qty: number, target: Placement): string {
  assertShelterItem(p, itemId);
  const r = splitStack(p.store, content, p.ids, itemId, qty, target);
  if (!r.ok) fail(r.error);
  return (r as { ok: true; newId: string }).newId;
}

export function mergeProfileStacks(p: ProfileState, content: ContentRegistry, fromId: string, toId: string): void {
  assertShelterItem(p, fromId);
  assertShelterItem(p, toId);
  const r = mergeStacks(p.store, content, fromId, toId);
  if (!r.ok) fail(r.error);
  pruneQuickslots(p);
}

/** Sort a home grid (stash / shelf / incoming is a list) — see sortGrid; favorite-locked items stay in place. */
export function sortHomeContainer(p: ProfileState, content: ContentRegistry, containerId: string): number {
  if (!homeContainers(p).includes(containerId)) fail('inv.err.no_access');
  const r = sortGrid(p.store, content, containerId);
  if (!r.ok) fail(r.error);
  return r.moved;
}

export function toggleFavorite(p: ProfileState, itemId: string): void {
  const it = p.store.items[itemId];
  if (!it) fail('inv.err.no_item');
  it!.lockTags = it!.lockTags.includes('favorite') ? it!.lockTags.filter((t) => t !== 'favorite') : [...it!.lockTags, 'favorite'];
}

export function discardItem(p: ProfileState, content: ContentRegistry, itemId: string, tx: string): void {
  assertShelterItem(p, itemId);
  const it = p.store.items[itemId]!;
  if (it.lockTags.includes('favorite')) fail('inv.err.locked');
  if (content.item(it.definitionId).kind === 'quest') fail('trade.err.quest_item');
  logItem(p, { tx, event: 'destroy', defId: it.definitionId, qty: it.quantity, itemId, reason: 'discard' });
  destroyItem(p.store, itemId);
  pruneQuickslots(p);
}

export function setQuickslot(p: ProfileState, content: ContentRegistry, index: number, itemId: string | null): void {
  if (index < 0 || index > 3) fail('inv.err.bad_slot');
  if (itemId) {
    const it = p.store.items[itemId];
    if (!it) fail('inv.err.no_item');
    const bag = p.store.containers[eq('backpack')]?.items[0];
    if (!bag || it!.ownerContainerId !== bagContainerId(bag)) fail('inv.err.quickslot_bag');
    const d = content.item(it!.definitionId);
    if (!d.medical && !d.throwable) fail('inv.err.not_usable');
    for (let i = 0; i < 4; i++) if (p.quickslots[i] === itemId) p.quickslots[i] = null;
  }
  p.quickslots[index] = itemId;
}

export function pruneQuickslots(p: ProfileState): void {
  const bag = p.store.containers[eq('backpack')]?.items[0];
  const bc = bag ? bagContainerId(bag) : null;
  for (let i = 0; i < 4; i++) {
    const q = p.quickslots[i];
    if (q && (!p.store.items[q] || p.store.items[q]!.ownerContainerId !== bc)) p.quickslots[i] = null;
  }
}

/** Instant magazine fill in the shelter from loose rounds (home storage + bag). */
export function fillMagazine(p: ProfileState, content: ContentRegistry, magId: string, ammoDefId: string | null): number {
  assertShelterItemOrAttached(p, magId);
  const mag = p.store.items[magId]!;
  const md = content.item(mag.definitionId).magazine;
  if (!md || !mag.mag) fail('inv.err.not_usable');
  const room = md!.capacity - mag.mag!.rounds.length;
  if (room <= 0) fail('reload.full');
  const pool = shelterContainers(p).flatMap((c) => itemsInContainerDeep(p.store, c)).map((id) => p.store.items[id]!).filter((it) => it && content.item(it.definitionId).ammo?.caliber === md!.caliber && (!ammoDefId || it.definitionId === ammoDefId) && it.lockTags.length === 0);
  pool.sort((a, b) => a.quantity - b.quantity);
  let loaded = 0;
  for (const st of pool) {
    while (st.quantity > 0 && loaded < room) {
      mag.mag!.rounds.push(st.definitionId);
      st.quantity--;
      loaded++;
    }
    if (st.quantity <= 0) destroyItem(p.store, st.instanceId);
    if (loaded >= room) break;
  }
  if (loaded === 0) fail('reload.no_ammo');
  return loaded;
}

function assertShelterItemOrAttached(p: ProfileState, itemId: string): void {
  const it = p.store.items[itemId];
  if (!it) fail('inv.err.no_item');
  const owner = it!.ownerContainerId ?? '';
  if (owner.startsWith('item:')) {
    assertShelterItem(p, owner.slice(5));
    return;
  }
  assertShelterItem(p, itemId);
}

export function unloadMagazine(p: ProfileState, content: ContentRegistry, magId: string, tx: string): number {
  assertShelterItemOrAttached(p, magId);
  const mag = p.store.items[magId]!;
  if (!mag.mag || mag.mag.rounds.length === 0) fail('inv.err.empty');
  const counts = new Map<string, number>();
  for (const r of mag.mag!.rounds) counts.set(r, (counts.get(r) ?? 0) + 1);
  const n = mag.mag!.rounds.length;
  mag.mag!.rounds = [];
  for (const [defId, q] of counts) grantItems(p, content, defId, q, tx);
  return n;
}

/** Insert a magazine into a weapon (and chamber a round) in the shelter. */
export function loadWeapon(p: ProfileState, content: ContentRegistry, weaponId: string, magId: string): void {
  assertShelterItem(p, weaponId);
  assertShelterItem(p, magId);
  const w = p.store.items[weaponId]!;
  const wd = content.item(w.definitionId).weapon;
  const mag = p.store.items[magId]!;
  const md = content.item(mag.definitionId).magazine;
  if (!wd || !md || wd.magazineFamily !== md.family) fail('inv.err.incompatible');
  if (w.weapon!.magazineId) fail('inv.err.slot_occupied');
  attachChild(p.store, weaponId, magId, { magazine: true });
  if (!w.weapon!.chamber && mag.mag!.rounds.length > 0) w.weapon!.chamber = mag.mag!.rounds.pop()!;
}

export function unloadWeapon(p: ProfileState, content: ContentRegistry, weaponId: string, tx: string): void {
  assertShelterItem(p, weaponId);
  const w = p.store.items[weaponId]!;
  if (!w.weapon) fail('inv.err.not_usable');
  if (w.weapon!.magazineId) {
    const mid = w.weapon!.magazineId;
    const spot = findFreeSpot(p.store, content, p.store.containers[STASH]!, content.item(p.store.items[mid]!.definitionId), mid);
    if (!spot) fail('inv.err.no_space');
    const r = moveItem(p.store, content, mid, { containerId: STASH, x: spot!.x, y: spot!.y, rotation: spot!.rotation });
    if (!r.ok) fail(r.error);
  }
  const loose: string[] = [];
  if (w.weapon!.chamber) loose.push(w.weapon!.chamber);
  w.weapon!.chamber = null;
  if (w.weapon!.tube) {
    loose.push(...w.weapon!.tube);
    w.weapon!.tube = [];
  }
  const counts = new Map<string, number>();
  for (const r of loose) counts.set(r, (counts.get(r) ?? 0) + 1);
  for (const [defId, q] of counts) grantItems(p, content, defId, q, tx);
}

/** Fill a tube-fed weapon (SG-P) from loose shells, chamber included. */
export function fillTube(p: ProfileState, content: ContentRegistry, weaponId: string): number {
  assertShelterItem(p, weaponId);
  const w = p.store.items[weaponId]!;
  const wd = content.item(w.definitionId).weapon!;
  if (!w.weapon?.tube) fail('inv.err.not_usable');
  const pool = shelterContainers(p).flatMap((c) => itemsInContainerDeep(p.store, c)).map((id) => p.store.items[id]!).filter((it) => it && content.item(it.definitionId).ammo?.caliber === wd.caliber && it.lockTags.length === 0);
  let n = 0;
  for (const st of pool) {
    while (st.quantity > 0 && (w.weapon!.tube!.length < wd.capacity || !w.weapon!.chamber)) {
      if (!w.weapon!.chamber) w.weapon!.chamber = st.definitionId;
      else w.weapon!.tube!.push(st.definitionId);
      st.quantity--;
      n++;
    }
    if (st.quantity <= 0) destroyItem(p.store, st.instanceId);
  }
  if (n === 0) fail('reload.no_ammo');
  return n;
}

export function attachToWeapon(p: ProfileState, content: ContentRegistry, weaponId: string, attId: string): void {
  assertShelterItem(p, weaponId);
  assertShelterItem(p, attId);
  const w = p.store.items[weaponId]!;
  const wd = content.item(w.definitionId).weapon;
  const ad = content.item(p.store.items[attId]!.definitionId).attachment;
  if (!wd || !ad) fail('inv.err.incompatible');
  if (!wd!.attachmentSlots.includes(ad!.slot)) fail('att.err.slot');
  if (w.attachments[ad!.slot]) fail('att.err.occupied');
  attachChild(p.store, weaponId, attId, { attachment: ad!.slot });
}

export function detachFromWeapon(p: ProfileState, content: ContentRegistry, weaponId: string, slot: AttachmentSlot): void {
  assertShelterItem(p, weaponId);
  const w = p.store.items[weaponId]!;
  const aid = w.attachments[slot];
  if (!aid) fail('inv.err.no_item');
  const spot = findFreeSpot(p.store, content, p.store.containers[STASH]!, content.item(p.store.items[aid!]!.definitionId), aid!);
  if (!spot) fail('inv.err.no_space');
  const r = moveItem(p.store, content, aid!, { containerId: STASH, x: spot!.x, y: spot!.y, rotation: spot!.rotation });
  if (!r.ok) fail(r.error);
}

// --- Perks ------------------------------------------------------------------------------------------------------

export function perkBlocker(p: ProfileState, content: ContentRegistry, perkId: string): string | null {
  const perk = content.perk(perkId);
  if (p.perks.includes(perkId)) return 'perk.err.owned';
  if (p.level < perk.level) return 'perk.err.level';
  if (!perk.requires.every((r) => p.perks.includes(r))) return 'perk.err.requires';
  if (p.perkPoints < perk.cost) return 'perk.err.points';
  return null;
}

export function unlockPerk(p: ProfileState, content: ContentRegistry, perkId: string): void {
  const b = perkBlocker(p, content, perkId);
  if (b) fail(b);
  p.perkPoints -= content.perk(perkId).cost;
  p.perks.push(perkId);
  pushLog(p, 'log.perk', { name: content.perk(perkId).nameKey });
}

// --- Keys & notes -----------------------------------------------------------------------------------------------

/** Register a found key: item is consumed once and becomes a permanent access right. Duplicates change nothing. */
export function registerKey(p: ProfileState, content: ContentRegistry, itemId: string, tx: string): { keyId: string; consumed: boolean } {
  const it = p.store.items[itemId];
  if (!it || !homeContainers(p).includes(it.ownerContainerId ?? '')) fail('inv.err.no_item');
  const keyId = content.item(it!.definitionId).keyId;
  if (!keyId) fail('key.err.not_key');
  if (p.keys.registered.includes(keyId!)) return { keyId: keyId!, consumed: false };
  logItem(p, { tx, event: 'destroy', defId: it!.definitionId, qty: 1, itemId, reason: 'key-registered' });
  destroyItem(p.store, itemId);
  p.keys.registered.push(keyId!);
  return { keyId: keyId!, consumed: true };
}

export function markNoteRead(p: ProfileState, noteId: string): void {
  const n = p.notes[noteId];
  if (!n || !n.found) fail('note.err.unknown');
  n!.read = true;
}

// --- Medical / relief / generator ------------------------------------------------------------------------------

export const HEAL_COST_PER_HP = 3;

export function healCost(p: ProfileState): number {
  if ((p.facilities['core.facility.medical'] ?? 0) > 0) return 0;
  return Math.ceil((100 - p.playerHp) * HEAL_COST_PER_HP) + (p.playerBleeding ? 30 : 0);
}

export function healAtShelter(p: ProfileState): number {
  if (p.playerHp >= 100 && !p.playerBleeding) fail('med.not_needed');
  const cost = healCost(p);
  if (p.currency < cost) fail('trade.err.money');
  p.currency -= cost;
  p.playerHp = 100;
  p.playerBleeding = false;
  return cost;
}

export function hasAnyWeapon(p: ProfileState, content: ContentRegistry): boolean {
  return Object.values(p.store.items).some((i) => content.item(i.definitionId).kind === 'weapon' && i.ownerContainerId !== 'deathbag');
}

export function canClaimRelief(p: ProfileState, content: ContentRegistry): boolean {
  return !hasAnyWeapon(p, content) && p.currency < 1000 && p.reliefGeneration !== p.generation && !p.activeRaid;
}

/** Relief rounds: combat-identical to 9mm FMJ, never sellable (even after being loaded into another magazine). */
export const RELIEF_AMMO = 'core.ammo.9.relief';

/** Bankruptcy relief kit (sale/dismantle value 0) so the player can always deploy again. */
export function claimRelief(p: ProfileState, content: ContentRegistry, tx: string): void {
  if (!canClaimRelief(p, content)) fail('relief.err.not_eligible');
  p.reliefGeneration = p.generation;
  const mods = [RELIEF_MODIFIER];
  if (!p.store.containers[eq('secondary')]?.items.length) {
    const w = instantiate(content, p.ids, 'core.weapon.p9', { modifiers: mods, durability: 80 });
    placeNew(p.store, content, w, { containerId: eq('secondary') });
    const mag = instantiate(content, p.ids, 'core.mag.p9', { modifiers: mods });
    mag.mag!.rounds = Array.from({ length: 15 }, () => RELIEF_AMMO);
    p.store.items[mag.instanceId] = mag;
    attachChild(p.store, w.instanceId, mag.instanceId, { magazine: true });
    w.weapon!.chamber = mag.mag!.rounds.pop()!;
    logItem(p, { tx, event: 'create', defId: 'core.weapon.p9', qty: 1, itemId: w.instanceId, reason: 'relief' });
  } else grantItems(p, content, 'core.weapon.p9', 1, tx, { modifiers: mods, durability: 80 });
  if (!p.store.containers[eq('melee')]?.items.length) placeNew(p.store, content, instantiate(content, p.ids, 'core.melee.knife', { modifiers: mods }), { containerId: eq('melee') });
  if (!p.store.containers[eq('backpack')]?.items.length) placeNew(p.store, content, instantiate(content, p.ids, 'core.bag.basic', { modifiers: mods }), { containerId: eq('backpack') });
  grantItems(p, content, RELIEF_AMMO, 30, tx, { modifiers: mods });
  grantItems(p, content, 'core.med.bandage', 2, tx, { modifiers: mods });
  pushLog(p, 'log.relief');
}

/** Q07 final step: connect the crafted relay module to the generator (requires the power & comms module). */
export function restoreGenerator(p: ProfileState, content: ContentRegistry, tx: string): void {
  if (p.flags['generator_restored']) fail('gen.err.done');
  if (!p.buildings.some((b) => b.buildingId === 'core.building.power_comms')) fail('gen.err.no_module');
  const relay = homeContainers(p).flatMap((c) => itemsInContainerDeep(p.store, c)).find((id) => p.store.items[id]?.definitionId === 'core.quest.relay_module');
  if (!relay) fail('gen.err.no_relay');
  logItem(p, { tx, event: 'destroy', defId: 'core.quest.relay_module', qty: 1, itemId: relay!, reason: 'generator' });
  destroyItem(p.store, relay!);
  setFlag(p, 'generator_restored');
  applyQuestEvent(p, content, { type: 'Custom', target: 'generator_restored', amount: 1 });
  pushLog(p, 'log.generator');
}
