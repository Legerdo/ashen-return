import type { ContentRegistry } from '../content/registry';
import type { ContractTemplateDef } from '../content/types';
import { Rng } from '../core/rng';
import { fail } from '../core/tx';
import { consumeDef, countDef } from '../inventory/store';
import { addExp } from './quests';
import { homeContainers, loadoutContainers, pushLog, type ContractObjective, type GeneratedContract, type ProfileState } from './profile';

export const MAX_ACTIVE_CONTRACTS = 3;
export const OFFERS_PER_GENERATION = 4;

const SUPPLY_POOL: [string, number][] = [
  ['core.mat.cloth', 4],
  ['core.mat.scrap', 3],
  ['core.med.bandage', 2],
  ['core.mat.antiseptic', 1],
  ['core.mat.battery', 2],
  ['core.mat.wire', 2],
  ['core.mat.powder', 3],
  ['core.mat.metal', 3],
];
const RECON_POIS: Record<string, string[]> = {
  'core.map.quarantine_main': ['poi.water_tower', 'poi.red_pump', 'poi.watchtower', 'poi.industrial_yard', 'poi.farmhouse', 'poi.checkpoint', 'poi.factory'],
  'core.map.outer_supply_route': ['poi.freight_station', 'poi.depot', 'poi.forest_cache'],
};
const HUNT_ROLES: Record<string, string[]> = {
  'core.map.quarantine_main': ['sentry', 'flanker', 'rusher', 'marksman'],
  'core.map.outer_supply_route': ['sentry', 'flanker', 'rusher', 'marksman'],
};
const RETRIEVE_ITEMS: Record<string, string[]> = {
  'core.map.quarantine_main': ['core.val.watch', 'core.val.spoon', 'core.val.lens', 'core.mat.battery', 'core.val.radio'],
  'core.map.outer_supply_route': ['core.val.chip', 'core.val.market_note', 'core.mat.fuel', 'core.val.lens'],
};
const PRECISION_TAGS = ['pistol', 'smg', 'rifle', 'shotgun', 'precision', 'automatic'];

export function unlockedMaps(p: ProfileState, content: ContentRegistry): string[] {
  const out: string[] = [];
  for (const d of content.destinations.values()) if (!d.unlockFlag || p.flags[d.unlockFlag]) out.push(d.mapId);
  return out;
}

/** Weapon tags the player actually owns (stash, incoming, shelf, loadout) — contracts never require unowned weapons. */
export function ownedWeaponTags(p: ProfileState, content: ContentRegistry): string[] {
  const tags = new Set<string>();
  const owners = new Set([...homeContainers(p), ...loadoutContainers()]);
  /** Top-level container of an item, following parent items and backpacks (a bag in the death bag is not owned). */
  const rootOf = (itemId: string): string | null => {
    let cur = p.store.items[itemId];
    for (let guard = 0; cur && guard < 32; guard++) {
      const owner = cur.ownerContainerId;
      if (!owner) return null;
      if (owner.startsWith('item:')) cur = p.store.items[owner.slice(5)];
      else if (owner.startsWith('bag:')) cur = p.store.items[owner.slice(4)];
      else return owner;
    }
    return null;
  };
  for (const it of Object.values(p.store.items)) {
    const d = content.item(it.definitionId);
    if (!d.weapon) continue;
    const root = rootOf(it.instanceId);
    if (!root || !owners.has(root)) continue;
    for (const t of d.tags) if (PRECISION_TAGS.includes(t)) tags.add(t);
  }
  return [...tags].sort();
}

export function eventMapsFor(content: ContentRegistry, eventId: string, maps: string[]): string[] {
  return maps.filter((m) => content.raidEvent(eventId).mapIds.includes(m));
}

function build(p: ProfileState, content: ContentRegistry, t: ContractTemplateDef, rng: Rng, idx: number, maps: string[], tags: string[]): GeneratedContract | null {
  const gen = p.generation;
  const credits = rng.int(t.rewardCredits[0], t.rewardCredits[1]);
  const exp = rng.int(t.rewardExp[0], t.rewardExp[1]);
  const base = { id: `ct-${gen}-${idx}`, templateId: t.id, generation: gen, giver: t.giver, rewardCredits: Math.round(credits / 10) * 10, rewardExp: exp, trust: t.trust, status: 'offered' as const, progress: 0, needsExtract: false, visitedPending: false };
  const mk = (objective: ContractObjective, params: Record<string, string | number>, needsExtract = false): GeneratedContract => ({ ...base, objective, params, needsExtract });
  // Extension destinations may have no curated pools: skip the template instead of throwing on an empty pick.
  const pickOr = <T>(list: readonly T[]): T | undefined => (list.length > 0 ? rng.pick(list as T[]) : undefined);
  if (maps.length === 0) return null;
  switch (t.type) {
    case 'supply': {
      const [item, count] = rng.pick(SUPPLY_POOL);
      return mk({ type: 'Deliver', target: item, count, mapId: null, weaponTag: null, npcId: t.giver }, { item: content.item(item).nameKey, count, npc: content.npc(t.giver).nameKey });
    }
    case 'recon': {
      const map = rng.pick(maps);
      const poi = pickOr(RECON_POIS[map] ?? []);
      if (!poi) return null;
      return mk({ type: 'Visit', target: poi, count: 1, mapId: map, weaponTag: null, npcId: null }, { map: content.map(map).nameKey, poi }, true);
    }
    case 'hunt': {
      const map = rng.pick(maps);
      const role = rng.pick(HUNT_ROLES[map] ?? ['sentry']);
      const count = rng.int(2, 4);
      return mk({ type: 'Kill', target: role, count, mapId: map, weaponTag: null, npcId: null }, { map: content.map(map).nameKey, role: `enemy.${role}`, count });
    }
    case 'precision': {
      if (tags.length === 0) return null;
      const tag = rng.pick(tags);
      const count = rng.int(2, 3);
      return mk({ type: 'HitPart', target: 'head', count, mapId: null, weaponTag: tag, npcId: null }, { tag: `tag.${tag}`, count });
    }
    case 'retrieve': {
      const map = rng.pick(maps);
      const item = pickOr(RETRIEVE_ITEMS[map] ?? []);
      if (!item) return null;
      return mk({ type: 'ExtractWith', target: item, count: 1, mapId: map, weaponTag: null, npcId: null }, { map: content.map(map).nameKey, item: content.item(item).nameKey });
    }
    case 'support': {
      const events = [...content.raidEvents.values()].filter((e) => eventMapsFor(content, e.id, maps).length > 0);
      if (events.length === 0) return null;
      const ev = rng.pick(events);
      const map = rng.pick(eventMapsFor(content, ev.id, maps));
      return mk({ type: 'Event', target: ev.id, count: 1, mapId: map, weaponTag: null, npcId: null }, { map: content.map(map).nameKey, event: ev.nameKey }, true);
    }
  }
}

/** Is a contract satisfiable with the player's current unlocks and gear? (A14: 0 impossible contracts.) */
export function contractPossible(p: ProfileState, content: ContentRegistry, c: GeneratedContract): boolean {
  const maps = unlockedMaps(p, content);
  const o = c.objective;
  if (o.mapId && !maps.includes(o.mapId)) return false;
  if (o.weaponTag && !ownedWeaponTags(p, content).includes(o.weaponTag)) return false;
  if (o.type === 'Event' && o.mapId && !content.raidEvent(o.target).mapIds.includes(o.mapId)) return false;
  if (o.type === 'Visit' && o.mapId && !content.map(o.mapId).pois.some((poi) => poi.id === o.target)) return false;
  if (!content.contracts.has(c.templateId)) return false;
  return true;
}

/** Deterministic offers per (profile seed, generation). Active contracts are kept; saved offers are never re-rolled. */
export function ensureContracts(p: ProfileState, content: ContentRegistry): void {
  if (!p.flags['deploy_allowed']) return;
  if (p.contracts.generation === p.generation && p.contracts.offers.length > 0) return;
  const keep = p.contracts.offers.filter((c) => c.status === 'active' || c.status === 'ready');
  const rng = Rng.fromSeed(`${p.seed}|contracts|${p.generation}`);
  const maps = unlockedMaps(p, content);
  const tags = ownedWeaponTags(p, content);
  const templates = [...content.contracts.values()].filter((t) => t.minLevel <= p.level);
  rng.shuffle(templates);
  const offers: GeneratedContract[] = [];
  let idx = 0;
  for (const t of templates) {
    if (offers.length >= OFFERS_PER_GENERATION) break;
    const c = build(p, content, t, rng, idx++, maps, tags);
    if (c && contractPossible(p, content, c)) offers.push(c);
  }
  // Ids are deterministic per (seed, generation): a same-generation regeneration (every offer turned in, then a
  // shelter rebuild or reload) must never hand out an already completed or still-tracked contract again.
  const taken = new Set([...p.contracts.completed, ...keep.map((k) => k.id)]);
  p.contracts = { generation: p.generation, offers: [...keep, ...offers.filter((o) => !taken.has(o.id))], completed: p.contracts.completed };
}

export function acceptContract(p: ProfileState, id: string): void {
  const c = p.contracts.offers.find((x) => x.id === id);
  if (!c || c.status !== 'offered') fail('contract.err.not_offered');
  const active = p.contracts.offers.filter((x) => x.status === 'active' || x.status === 'ready').length;
  if (active >= MAX_ACTIVE_CONTRACTS) fail('contract.err.max');
  c!.status = 'active';
}

export function abandonContract(p: ProfileState, id: string): void {
  const c = p.contracts.offers.find((x) => x.id === id);
  if (!c || (c.status !== 'active' && c.status !== 'ready')) fail('contract.err.not_active');
  c!.status = 'offered';
  c!.progress = 0;
  c!.visitedPending = false;
}

function bump(c: GeneratedContract, n: number): void {
  if (c.status !== 'active') return;
  c.progress = Math.min(c.objective.count, c.progress + n);
  if (c.progress >= c.objective.count) c.status = 'ready';
}

export interface RaidContractInput {
  mapId: string;
  extracted: boolean;
  visited: string[];
  kills: { role: string; weaponTags: string[] }[];
  headshots: { weaponTags: string[] }[];
  extractedItems: { defId: string; qty: number }[];
  eventsCompleted: string[];
}

export function applyRaidToContracts(p: ProfileState, r: RaidContractInput): string[] {
  const changed: string[] = [];
  for (const c of p.contracts.offers) {
    if (c.status !== 'active') continue;
    const o = c.objective;
    if (o.mapId && o.mapId !== r.mapId) continue;
    const before = c.progress;
    switch (o.type) {
      case 'Visit':
        if (r.visited.includes(o.target) && r.extracted) bump(c, 1);
        break;
      case 'Kill':
        bump(c, r.kills.filter((k) => k.role === o.target).length);
        break;
      case 'HitPart':
        bump(c, r.headshots.filter((h) => !o.weaponTag || h.weaponTags.includes(o.weaponTag)).length);
        break;
      case 'ExtractWith':
        if (r.extracted) bump(c, r.extractedItems.filter((i) => i.defId === o.target).reduce((s, i) => s + i.qty, 0));
        break;
      case 'Event':
        if (r.extracted && r.eventsCompleted.includes(o.target)) bump(c, 1);
        break;
      case 'Deliver':
        break;
    }
    if (c.progress !== before) changed.push(c.id);
  }
  return changed;
}

/** Deliver supply-contract items (consumed from home storage). */
export function deliverContract(p: ProfileState, id: string): number {
  const c = p.contracts.offers.find((x) => x.id === id);
  if (!c || c.status !== 'active' || c.objective.type !== 'Deliver') fail('contract.err.not_active');
  const need = c!.objective.count - c!.progress;
  const have = countDef(p.store, c!.objective.target, homeContainers(p));
  const give = Math.min(need, have);
  if (give <= 0) fail('contract.err.no_items');
  if (!consumeDef(p.store, c!.objective.target, give, homeContainers(p))) fail('contract.err.no_items');
  bump(c!, give);
  return give;
}

export function turnInContract(p: ProfileState, id: string): { credits: number; exp: number } {
  const c = p.contracts.offers.find((x) => x.id === id);
  if (!c || c.status !== 'ready') fail('contract.err.not_ready');
  c!.status = 'completed';
  p.currency += c!.rewardCredits;
  addExp(p, c!.rewardExp);
  const st = p.traders[`core.trader.${c!.giver.split('.').pop()}`];
  if (st) st.trust = Math.min(1000, st.trust + c!.trust);
  p.contracts.completed.push(c!.id);
  p.contracts.offers = p.contracts.offers.filter((x) => x.id !== id);
  pushLog(p, 'log.contract.done', { name: c!.templateId });
  return { credits: c!.rewardCredits, exp: c!.rewardExp };
}
