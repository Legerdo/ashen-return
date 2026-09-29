import type { ContentRegistry } from '../content/registry';
import { allocId } from '../core/ids';
import { fail } from '../core/tx';
import { addContainer, countDef, destroyItem, itemsInContainerDeep, moveItem, splitStack } from '../inventory/store';
import { applyQuestEvent } from '../progression/quests';
import { grantItems, homeContainers, loadoutContainers, logItem, type CraftJob, type ProfileState } from '../progression/profile';
import { RELIEF_MODIFIER } from './trade';

/**
 * Crafting reserves inputs (moved into craft:<jobId>) and the fee at start; completion consumes/creates exactly once;
 * cancellation returns reservations. Job time only advances while the shelter simulation runs (not paused/hidden).
 */

export function hasBuilding(p: ProfileState, buildingId: string): boolean {
  return p.buildings.some((b) => b.buildingId === buildingId);
}

export function craftSpeed(p: ProfileState): number {
  return (p.facilities['core.facility.workbench'] ?? 0) > 0 ? 1.25 : 1;
}

export function recipeTime(p: ProfileState, content: ContentRegistry, recipeId: string): number {
  const r = content.recipe(recipeId);
  let t = r.time;
  if (r.id === 'core.recipe.firstaid' && (p.facilities['core.facility.medical'] ?? 0) > 0) t = 3;
  if (r.station === 'workbench') t /= craftSpeed(p);
  return t;
}

export function recipeBlocker(p: ProfileState, content: ContentRegistry, recipeId: string): string | null {
  const r = content.recipe(recipeId);
  if (r.requiresFlag && !p.flags[r.requiresFlag]) return 'craft.err.flag';
  if (r.requiresBuilding && !hasBuilding(p, r.requiresBuilding)) return 'craft.err.building';
  if (p.crafting.jobs.some((j) => j.station === r.station)) return 'craft.err.busy';
  for (const i of r.inputs) if (countDef(p.store, i.itemId, homeContainers(p)) < i.qty) return 'craft.err.materials';
  if (p.currency < r.fee) return 'trade.err.money';
  return null;
}

/** Move exactly `qty` units of a definition from home storage into a reservation container. */
function reserve(p: ProfileState, content: ContentRegistry, defId: string, qty: number, cid: string): void {
  let left = qty;
  const ids = homeContainers(p).flatMap((c) => itemsInContainerDeep(p.store, c)).filter((id) => p.store.items[id]?.definitionId === defId && p.store.items[id]!.lockTags.length === 0);
  for (const id of ids) {
    if (left <= 0) break;
    const it = p.store.items[id];
    if (!it) continue;
    if (it.quantity <= left) {
      left -= it.quantity;
      const r = moveItem(p.store, content, id, { containerId: cid });
      if (!r.ok) fail(r.error);
    } else {
      const r = splitStack(p.store, content, p.ids, id, left, { containerId: cid });
      if (!r.ok) fail(r.error);
      left = 0;
    }
  }
  if (left > 0) fail('craft.err.materials');
}

export function startCraft(p: ProfileState, content: ContentRegistry, recipeId: string): CraftJob {
  const blocker = recipeBlocker(p, content, recipeId);
  if (blocker) fail(blocker);
  const r = content.recipe(recipeId);
  const jobId = allocId(p.ids, 'job');
  const cid = `craft:${jobId}`;
  addContainer(p.store, { id: cid, kind: 'list', w: 0, h: 0 });
  for (const i of r.inputs) reserve(p, content, i.itemId, i.qty, cid);
  p.currency -= r.fee;
  const t = recipeTime(p, content, recipeId);
  const job: CraftJob = { jobId, recipeId, station: r.station, remaining: t, total: t, fee: r.fee };
  p.crafting.jobs.push(job);
  return job;
}

/** Advance crafting time; returns ids of jobs that reached zero (completion must be committed separately). */
export function tickCrafting(p: ProfileState, dt: number): string[] {
  const done: string[] = [];
  for (const j of p.crafting.jobs) {
    if (j.remaining <= 0) {
      done.push(j.jobId);
      continue;
    }
    // Same 1e-9 tolerance as the other simulation timers so float residue never costs an extra step.
    j.remaining = j.remaining - dt <= 1e-9 ? 0 : j.remaining - dt;
    if (j.remaining <= 0) done.push(j.jobId);
  }
  return done;
}

export function completeCraft(p: ProfileState, content: ContentRegistry, jobId: string, tx: string): { outputIds: string[] } {
  const job = p.crafting.jobs.find((j) => j.jobId === jobId);
  if (!job) fail('craft.err.no_job');
  if (job!.remaining > 1e-9) fail('craft.err.not_done');
  const r = content.recipe(job!.recipeId);
  const cid = `craft:${jobId}`;
  const c = p.store.containers[cid];
  for (const id of [...(c?.items ?? [])]) {
    const it = p.store.items[id];
    if (it) logItem(p, { tx, event: 'destroy', defId: it.definitionId, qty: it.quantity, itemId: id, reason: `craft:${r.id}` });
    destroyItem(p.store, id);
  }
  delete p.store.containers[cid];
  p.crafting.jobs = p.crafting.jobs.filter((j) => j.jobId !== jobId);
  const outputIds = grantItems(p, content, r.output.itemId, r.output.qty, tx);
  applyQuestEvent(p, content, { type: 'Craft', recipeId: r.id });
  return { outputIds };
}

export function cancelCraft(p: ProfileState, content: ContentRegistry, jobId: string): void {
  const job = p.crafting.jobs.find((j) => j.jobId === jobId);
  if (!job) fail('craft.err.no_job');
  const cid = `craft:${jobId}`;
  const c = p.store.containers[cid];
  for (const id of [...(c?.items ?? [])]) {
    const r = moveItem(p.store, content, id, { containerId: 'stash' });
    if (!r.ok) moveItem(p.store, content, id, { containerId: 'incoming' });
  }
  delete p.store.containers[cid];
  p.currency += job!.fee;
  p.crafting.jobs = p.crafting.jobs.filter((j) => j.jobId !== jobId);
}

// --- Repair / dismantle ----------------------------------------------------------------------------------------

export function repairAmount(p: ProfileState): number {
  const base = (p.facilities['core.facility.workbench'] ?? 0) > 0 ? 50 : 40;
  return base;
}

function ownedAtHome(p: ProfileState, itemId: string): boolean {
  const it = p.store.items[itemId];
  if (!it) return false;
  let owner = it.ownerContainerId;
  // Items attached inside a weapon count as owned by the weapon's location.
  for (let i = 0; i < 4 && owner?.startsWith('item:'); i++) owner = p.store.items[owner.slice(5)]?.ownerContainerId ?? null;
  return [...homeContainers(p), ...loadoutContainers()].includes(owner ?? '') || (owner?.startsWith('bag:') ?? false);
}

export function repairItem(p: ProfileState, content: ContentRegistry, itemId: string, perkRepairMult: number, tx: string): { restored: number } {
  const it = p.store.items[itemId];
  if (!it || !ownedAtHome(p, itemId)) fail('inv.err.no_item');
  const d = content.item(it!.definitionId);
  const max = d.weapon ? 100 : d.armor ? d.armor.maxDurability : 0;
  if (!max || it!.durability === null) fail('repair.err.not_repairable');
  if (it!.durability! >= max - 1e-6) fail('repair.err.full');
  if (!(countDef(p.store, 'core.tool.repair_kit', homeContainers(p)) >= 1)) fail('repair.err.no_kit');
  // Consume one kit (from home storage only).
  const kitIds = homeContainers(p).flatMap((c) => itemsInContainerDeep(p.store, c)).filter((id) => p.store.items[id]?.definitionId === 'core.tool.repair_kit');
  const kit = kitIds[0]!;
  logItem(p, { tx, event: 'destroy', defId: 'core.tool.repair_kit', qty: 1, itemId: kit, reason: `repair:${itemId}` });
  destroyItem(p.store, kit);
  const amount = repairAmount(p) * perkRepairMult;
  const before = it!.durability!;
  it!.durability = Math.min(max, before + amount);
  applyQuestEvent(p, content, { type: 'Repair' });
  return { restored: it!.durability - before };
}

export function dismantleItem(p: ProfileState, content: ContentRegistry, itemId: string, tx: string): { outputs: { itemId: string; qty: number }[] } {
  const it = p.store.items[itemId];
  if (!it || !homeContainers(p).includes(it.ownerContainerId ?? '')) fail('inv.err.no_item');
  const d = content.item(it!.definitionId);
  // Relief gear can always be discarded this way (it yields nothing); other no-value items (quest items) cannot.
  if (d.kind === 'quest' || (d.noValue && !it!.modifiers.includes(RELIEF_MODIFIER))) fail('dismantle.err.not_allowed');
  if (it!.lockTags.includes('favorite')) fail('inv.err.locked');
  const outputs = it!.modifiers.includes(RELIEF_MODIFIER) ? [] : (d.dismantle ?? []);
  if (outputs.length === 0 && !it!.modifiers.includes(RELIEF_MODIFIER)) fail('dismantle.err.nothing');
  if (it!.containedItems.length > 0) fail('dismantle.err.strip_first');
  logItem(p, { tx, event: 'destroy', defId: d.id, qty: it!.quantity, itemId, reason: 'dismantle' });
  const qty = it!.quantity;
  destroyItem(p.store, itemId);
  const out = outputs.map((o) => ({ itemId: o.itemId, qty: o.qty * (d.stackMax > 1 ? qty : 1) }));
  for (const o of out) grantItems(p, content, o.itemId, o.qty, tx);
  return { outputs: out };
}
