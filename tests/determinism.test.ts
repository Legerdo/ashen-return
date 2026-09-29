/**
 * A14 — "계약/이벤트 생성 결정성, 불가능 조건 생성 0"
 * A16 — "시간/날씨/market seed 저장·로드 결정성"
 *
 * Contract offers, raid events, forecasts (time/weather), black-market offers and raid RNG are pure functions of
 * their seeds and survive save/load; nothing is re-rolled on menu re-entry or reload; no generated contract is
 * impossible for the player's current unlocks and gear.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { SIM_DT } from '../src/core/clock';
import { runTx, type TxOutcome } from '../src/core/tx';
import { buyFromMarket, buyFromTrader, ensureMarket, ensureTraderStock, generateMarketOffers, unitBuyPrice } from '../src/economy/trade';
import { bagContainerId, destroyItem, instantiate, placeNew } from '../src/inventory/store';
import { acceptContract, contractPossible, ensureContracts, MAX_ACTIVE_CONTRACTS, OFFERS_PER_GENERATION, ownedWeaponTags, turnInContract } from '../src/progression/contracts';
import { EXP_TABLE, grantItems, newProfile, type GeneratedContract, type ProfileState } from '../src/progression/profile';
import { addExp } from '../src/progression/quests';
import { commitRaidEnd, forecastFor, prepareDeploy } from '../src/progression/raidFlow';
import { deserializeSim, normalizeProfile, serializeSim } from '../src/save/schema';
import { SaveStore } from '../src/save/saveStore';
import { idleCommand } from '../src/world/command';
import { makeContext, type SimContext } from '../src/world/context';
import { stepSim } from '../src/world/sim';
import { createRaidSim, raidGeometry, type RaidLaunch } from '../src/world/spawn';
import { eqContainerId, type SimState } from '../src/world/state';

const content = createContent();
const NOW = 1_700_000_000_000;
const DEST_MAIN = 'core.dest.quarantine_main';
const DEST_OUTER = 'core.dest.outer_supply_route';
const MAIN_MAP = 'core.map.quarantine_main';
const OUTER_MAP = 'core.map.outer_supply_route';
const EV_PUMP = 'core.event.pump_restart';
const EV_SIGNAL = 'core.event.emergency_signal';
const EV_CONVOY = 'core.event.moving_supply';
const MECH = 'core.trader.mechanic';
const AMMO9 = 'core.ammo.9.fmj';
const EQ_SLOTS = ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'] as const;

// --- helpers ------------------------------------------------------------------------------------------------

function applied<T>(o: TxOutcome<T>): T {
  if (!o.ok || !o.applied) throw new Error(`expected an applied transaction, got ${JSON.stringify(o)}`);
  return o.value;
}

function mustApply<T>(p: ProfileState, txId: string, fn: (d: ProfileState) => T): { next: ProfileState; value: T } {
  const { outcome, next } = runTx(p, txId, fn);
  return { next, value: applied(outcome) };
}

function roundTrip(p: ProfileState): ProfileState {
  return normalizeProfile(JSON.parse(JSON.stringify(p)) as ProfileState);
}

/** Profile past Q01 (deploy allowed) at `level`, with extra world flags. */
function base(seed: string, level: number, flags: string[] = []): ProfileState {
  const p = newProfile(content, 1, 'A14', seed, NOW);
  for (const f of ['deploy_allowed', ...flags]) p.flags[f] = true;
  addExp(p, EXP_TABLE[level - 1]!);
  expect(p.level).toBe(level);
  return p;
}

function dropWeapons(p: ProfileState, keep: (defId: string) => boolean): void {
  for (const it of Object.values(p.store.items)) {
    if (!p.store.items[it.instanceId]) continue;
    if (content.item(it.definitionId).kind === 'weapon' && !keep(it.definitionId)) destroyItem(p.store, it.instanceId);
  }
}

function resetContracts(p: ProfileState, seed: string, generation: number): ProfileState {
  const q = structuredClone(p);
  q.seed = seed;
  q.generation = generation;
  q.contracts = { generation: -1, offers: [], completed: [] };
  ensureContracts(q, content);
  return q;
}

/** Everything that defines what a contract asks and pays (ids/generation excluded). */
function contractContent(c: GeneratedContract) {
  return { templateId: c.templateId, objective: c.objective, params: c.params, rewardCredits: c.rewardCredits, rewardExp: c.rewardExp, trust: c.trust };
}

// --- independent "is this contract possible?" oracle ------------------------------------------------------------

const HOME_ROOTS = new Set<string>(['stash', 'incoming', 'shelf', ...EQ_SLOTS.map((s) => `eq:player:${s}`)]);
const TEMPLATE_OBJECTIVE: Record<string, GeneratedContract['objective']['type']> = { supply: 'Deliver', recon: 'Visit', hunt: 'Kill', precision: 'HitPart', retrieve: 'ExtractWith', support: 'Event' };

/** Top-level container that ultimately holds an item (following weapon attachments and backpacks). */
function rootContainer(p: ProfileState, itemId: string): string | null {
  let cur = p.store.items[itemId];
  for (let guard = 0; cur && guard < 32; guard++) {
    const owner = cur.ownerContainerId;
    if (!owner) return null;
    if (owner.startsWith('item:')) cur = p.store.items[owner.slice(5)];
    else if (owner.startsWith('bag:')) cur = p.store.items[owner.slice(4)];
    else return owner;
  }
  return null;
}

/** Tags of weapons the player actually holds: stash, incoming, shelf or loadout (including inside held bags). */
function heldWeaponTags(p: ProfileState): Set<string> {
  const out = new Set<string>();
  for (const it of Object.values(p.store.items)) {
    const d = content.item(it.definitionId);
    if (d.kind !== 'weapon') continue;
    const root = rootContainer(p, it.instanceId);
    if (root && HOME_ROOTS.has(root)) for (const t of d.tags) out.add(t);
  }
  return out;
}

function unlockedMapIds(p: ProfileState): string[] {
  return [...content.destinations.values()].filter((d) => !d.unlockFlag || p.flags[d.unlockFlag]).map((d) => d.mapId);
}

function spawnableRoles(p: ProfileState, mapId: string): Set<string> {
  const out = new Set<string>();
  for (const g of content.map(mapId).enemyGroups) {
    if (g.boss || g.requiresQuest || g.requiresFlag || g.chance <= 0) continue;
    if (g.unlessFlag && p.flags[g.unlessFlag]) continue;
    for (const a of g.archetypes) if (a.weight > 0) out.add(content.enemy(a.id).role);
  }
  return out;
}

const lootCache = new Map<string, Set<string>>();
function lootableOn(mapId: string): Set<string> {
  const cached = lootCache.get(mapId);
  if (cached) return cached;
  const out = new Set<string>();
  const table = (id: string) => {
    const t = content.loot(id);
    for (const e of t.entries) out.add(e.itemId);
    for (const g of t.guaranteed ?? []) out.add(g.itemId);
  };
  const m = content.map(mapId);
  for (const c of m.containers) {
    table(c.lootTable);
    for (const g of c.guaranteed ?? []) out.add(g.itemId);
  }
  for (const g of m.enemyGroups) for (const a of g.archetypes) table(content.enemy(a.id).lootTable);
  lootCache.set(mapId, out);
  return out;
}

function soldByTrader(itemId: string): boolean {
  return [...content.traders.values()].some((t) => t.stock.some((s) => s.itemId === itemId));
}

function eventCanOccur(eventId: string, mapId: string): boolean {
  const ev = content.raidEvents.get(eventId);
  if (!ev || ev.chance <= 0 || !ev.mapIds.includes(mapId)) return false;
  const m = content.map(mapId);
  const crate = m.containers.some((c) => c.eventId === eventId);
  const spots = (k: string) => m.eventSpots[k]?.length ?? 0;
  if (eventId === EV_PUMP) return crate && spots('pump') > 0;
  if (eventId === EV_SIGNAL) return crate && spots('signal') > 0;
  if (eventId === EV_CONVOY) return crate && spots('convoy') >= 2;
  return false;
}

function whyImpossible(p: ProfileState, c: GeneratedContract): string | null {
  const tpl = content.contracts.get(c.templateId);
  if (!tpl) return 'unknown template';
  if (tpl.minLevel > p.level) return `template needs level ${tpl.minLevel}`;
  const o = c.objective;
  if (o.type !== TEMPLATE_OBJECTIVE[tpl.type]) return `objective ${o.type} does not fit template type ${tpl.type}`;
  if (!Number.isInteger(o.count) || o.count < 1) return `bad count ${o.count}`;
  if (c.rewardCredits < tpl.rewardCredits[0] || c.rewardCredits > tpl.rewardCredits[1]) return `credits ${c.rewardCredits} outside template range`;
  if (c.rewardExp < tpl.rewardExp[0] || c.rewardExp > tpl.rewardExp[1]) return `exp ${c.rewardExp} outside template range`;
  const maps = unlockedMapIds(p);
  if (o.mapId !== null && !maps.includes(o.mapId)) return `locked destination ${o.mapId}`;
  switch (o.type) {
    case 'Deliver':
      if (!content.hasItem(o.target)) return `unknown item ${o.target}`;
      if (content.item(o.target).kind === 'quest') return `quest item ${o.target}`;
      if (!o.npcId || !content.npcs.has(o.npcId)) return `unknown npc ${o.npcId}`;
      return soldByTrader(o.target) || maps.some((m) => lootableOn(m).has(o.target)) ? null : `item ${o.target} cannot be obtained`;
    case 'Visit':
      if (!o.mapId) return 'visit without map';
      return content.map(o.mapId).pois.some((poi) => poi.id === o.target) ? null : `unknown POI ${o.target} on ${o.mapId}`;
    case 'Kill':
      if (!o.mapId) return 'hunt without map';
      return spawnableRoles(p, o.mapId).has(o.target) ? null : `role ${o.target} never spawns on ${o.mapId}`;
    case 'HitPart':
      if (o.target !== 'head') return `unknown part ${o.target}`;
      if (!o.weaponTag) return 'precision contract without weapon tag';
      return heldWeaponTags(p).has(o.weaponTag) ? null : `needs a ${o.weaponTag} weapon the player does not own`;
    case 'ExtractWith':
      if (!o.mapId) return 'retrieve without map';
      if (!content.hasItem(o.target)) return `unknown item ${o.target}`;
      return lootableOn(o.mapId).has(o.target) ? null : `item ${o.target} is never found on ${o.mapId}`;
    case 'Event':
      if (!o.mapId) return 'event without map';
      return eventCanOccur(o.target, o.mapId) ? null : `event ${o.target} cannot occur on ${o.mapId}`;
  }
  return 'unhandled objective type';
}

interface Stage {
  id: string;
  build: () => ProfileState;
}

const STAGES: Stage[] = [
  { id: 'L1 main zone, starter P9+C556', build: () => base('stage', 1) },
  { id: 'L3 main zone, starter weapons', build: () => base('stage', 3) },
  { id: 'L5 both zones, starter weapons', build: () => base('stage', 5, ['outer_route_unlocked']) },
  {
    id: 'L4 both zones, pistol only',
    build: () => {
      const p = base('stage', 4, ['outer_route_unlocked']);
      dropWeapons(p, (d) => d === 'core.weapon.p9');
      return p;
    },
  },
  {
    id: 'L4 main zone, no weapons (bankrupt)',
    build: () => {
      const p = base('stage', 4);
      dropWeapons(p, () => false);
      return p;
    },
  },
  {
    id: 'L7 both zones, SG-P+DMR+SM9+LMG in stash',
    build: () => {
      const p = base('stage', 7, ['outer_route_unlocked']);
      for (const w of ['core.weapon.sgp', 'core.weapon.dmr', 'core.weapon.sm9', 'core.weapon.lmg']) grantItems(p, content, w, 1, 'test:setup');
      return p;
    },
  },
  {
    id: 'L2 main zone, only a shotgun packed in a stashed backpack',
    build: () => {
      const p = base('stage', 2);
      dropWeapons(p, () => false);
      const [bag] = grantItems(p, content, 'core.bag.hiker', 1, 'test:setup');
      expect(placeNew(p.store, content, instantiate(content, p.ids, 'core.weapon.sgp'), { containerId: bagContainerId(bag!) }).ok).toBe(true);
      return p;
    },
  },
];

// --- raid helpers ---------------------------------------------------------------------------------------------

function launchFor(destId: string, seed: string | null, flags: Record<string, boolean> = {}): { p: ProfileState; launch: RaidLaunch } {
  const p = newProfile(content, 1, 'A14', 'launch-profile', NOW);
  p.flags['deploy_allowed'] = true;
  p.flags['outer_route_unlocked'] = true;
  const { next, value } = mustApply(p, 'deploy:1:1', (d) => prepareDeploy(d, content, destId, NOW));
  if (seed !== null) value.seed = seed;
  value.flags = { ...value.flags, ...flags };
  return { p: next, launch: value };
}

function simFor(launch: RaidLaunch, seed: string, flags: Record<string, boolean> = {}): SimState {
  const l = structuredClone(launch);
  l.seed = seed;
  l.flags = { ...l.flags, ...flags };
  return createRaidSim(content, l).sim;
}

function persisted(sim: SimState): unknown {
  return JSON.parse(serializeSim(sim));
}

function run(ctx: SimContext, ticks: number): void {
  const cmd = idleCommand();
  for (let i = 0; i < ticks; i++) {
    stepSim(ctx, { cmd, ops: [] }, SIM_DT);
    ctx.sim.fx = []; // GameApp drains presentation events after every step
  }
}

// ============================================================================================================
// A14 contracts
// ============================================================================================================

describe('A14 contract generation', () => {
  it('≥300 seed×generation combinations over 7 progression stages generate 0 impossible contracts', () => {
    const problems: string[] = [];
    const types = new Map<string, number>();
    let combos = 0;
    let generated = 0;
    for (const stage of STAGES) {
      const stageProfile = stage.build();
      const held = heldWeaponTags(stageProfile);
      const maps = new Set<string>();
      let precision = 0;
      for (let s = 0; s < 50; s++) {
        for (let g = 0; g < 6; g++) {
          const p = resetContracts(stageProfile, `a14-${s}`, g);
          combos++;
          const offers = p.contracts.offers;
          const where = `${stage.id} / seed a14-${s} / gen ${g}`;
          if (offers.length < 1 || offers.length > OFFERS_PER_GENERATION) problems.push(`${where}: ${offers.length} offers`);
          if (p.contracts.generation !== g) problems.push(`${where}: contracts.generation ${p.contracts.generation}`);
          if (new Set(offers.map((c) => c.id)).size !== offers.length) problems.push(`${where}: duplicate contract ids`);
          if (new Set(offers.map((c) => c.templateId)).size !== offers.length) problems.push(`${where}: template offered twice`);
          for (const c of offers) {
            generated++;
            types.set(c.templateId, (types.get(c.templateId) ?? 0) + 1);
            if (c.objective.mapId) maps.add(c.objective.mapId);
            if (c.objective.type === 'HitPart') precision++;
            if (c.status !== 'offered' || c.progress !== 0 || c.generation !== g || !c.id.startsWith(`ct-${g}-`)) problems.push(`${where}: ${c.id} bad initial state`);
            const why = whyImpossible(p, c);
            if (why) problems.push(`${where}: ${c.templateId} ${JSON.stringify(c.objective)} → ${why}`);
            if (!contractPossible(p, content, c)) problems.push(`${where}: ${c.id} rejected by contractPossible`);
          }
        }
      }
      // Stage sanity: the sweep really exercised what the stage unlocks.
      if (stageProfile.flags['outer_route_unlocked']) expect(maps.has(OUTER_MAP), stage.id).toBe(true);
      else expect(maps.has(OUTER_MAP), stage.id).toBe(false);
      const precisionTags = [...held].filter((t) => ['pistol', 'smg', 'rifle', 'shotgun', 'precision', 'automatic'].includes(t));
      if (stageProfile.level < 2 || precisionTags.length === 0) expect(precision, stage.id).toBe(0);
      else expect(precision, stage.id).toBeGreaterThan(0);
    }
    expect(problems.slice(0, 20)).toEqual([]);
    expect(combos).toBeGreaterThanOrEqual(300);
    expect(generated).toBeGreaterThan(combos * 3 - 1);
    expect([...types.keys()].sort()).toEqual([...content.contracts.keys()].sort());
  });

  it('a weapon lost in the death bag is not owned: precision contracts never require it', () => {
    const p0 = base('a14-deathbag', 3);
    // The player's only shotgun travels packed in the equipped backpack…
    const bag = p0.store.containers[eqContainerId('player', 'backpack')]!.items[0]!;
    const sgp = instantiate(content, p0.ids, 'core.weapon.sgp');
    expect(placeNew(p0.store, content, sgp, { containerId: bagContainerId(bag) }).ok).toBe(true);
    expect(heldWeaponTags(p0).has('shotgun')).toBe(true);
    // …and the player dies: the whole loadout, backpack included, becomes the unrecovered death bag.
    const dep = mustApply(p0, 'deploy:1:1', (d) => prepareDeploy(d, content, DEST_MAIN, NOW));
    const { sim } = createRaidSim(content, dep.value);
    sim.actors.find((a) => a.kind === 'player')!.alive = false;
    sim.outcome = { kind: 'dead', tick: 0, cause: 'test' };
    const dead = mustApply(dep.next, `raidend:${sim.raidId}`, (d) => commitRaidEnd(d, content, sim)).next;
    expect(dead.lastDeathBag).not.toBeNull();
    expect(rootContainer(dead, sgp.instanceId)).toBe('deathbag');
    const held = heldWeaponTags(dead);
    expect(held.has('shotgun')).toBe(false);
    // Root cause probe: the generator's notion of "owned" weapon classes.
    expect.soft(ownedWeaponTags(dead, content), 'ownedWeaponTags() after the death').toEqual(['automatic', 'rifle']);
    const required = new Map<string, number>();
    for (let s = 0; s < 40; s++) {
      for (let g = 1; g <= 3; g++) {
        for (const c of resetContracts(dead, `a14-db-${s}`, g).contracts.offers) {
          if (c.objective.type === 'HitPart') required.set(c.objective.weaponTag!, (required.get(c.objective.weaponTag!) ?? 0) + 1);
        }
      }
    }
    expect(required.size).toBeGreaterThan(0);
    const unowned = [...required].filter(([tag]) => !held.has(tag));
    expect(unowned, 'precision contracts requiring a weapon class that is only in the death bag').toEqual([]);
  });

  it('offers for (seed, generation) are identical across calls, profiles and a JSON round trip, and never re-rolled', () => {
    const a = base('a14-det', 3, ['outer_route_unlocked']);
    const b = base('a14-det', 3, ['outer_route_unlocked']);
    ensureContracts(a, content);
    ensureContracts(b, content);
    expect(a.contracts.offers.length).toBe(OFFERS_PER_GENERATION);
    expect(a.contracts).toEqual(b.contracts);
    const first = a.contracts;
    const snapshot = structuredClone(first);
    for (let i = 0; i < 5; i++) ensureContracts(a, content); // menu re-entry
    expect(a.contracts).toBe(first);
    expect(a.contracts).toEqual(snapshot);
    const loaded = roundTrip(a);
    ensureContracts(loaded, content);
    expect(loaded.contracts).toEqual(snapshot);
    // Regenerating from the loaded state (offers wiped) reproduces the same offers: a pure function of the seed.
    const regen = roundTrip(a);
    regen.contracts = { generation: -1, offers: [], completed: [] };
    ensureContracts(regen, content);
    expect(regen.contracts.offers).toEqual(snapshot.offers);
  });

  it('advancing the generation produces a new, different set of offers (40 seeds)', () => {
    const unchanged: string[] = [];
    for (let s = 0; s < 40; s++) {
      const p = base(`a14-gen-${s}`, 3, ['outer_route_unlocked']);
      ensureContracts(p, content);
      const g0 = p.contracts.offers.map(contractContent);
      p.generation = 1;
      ensureContracts(p, content);
      expect(p.contracts.generation).toBe(1);
      expect(p.contracts.offers.every((c) => c.generation === 1 && c.id.startsWith('ct-1-') && c.status === 'offered')).toBe(true);
      if (JSON.stringify(p.contracts.offers.map(contractContent)) === JSON.stringify(g0)) unchanged.push(p.seed);
    }
    expect(unchanged).toEqual([]);
  });

  it('at most 3 contracts are active at once; active ones carry over to the next generation unchanged', () => {
    let p = base('a14-active', 3);
    ensureContracts(p, content);
    const ids = p.contracts.offers.map((c) => c.id);
    expect(ids).toHaveLength(OFFERS_PER_GENERATION);
    for (let i = 0; i < MAX_ACTIVE_CONTRACTS; i++) p = mustApply(p, `ctaccept:${ids[i]}`, (d) => acceptContract(d, ids[i]!)).next;
    const refusedFourth = runTx(p, `ctaccept:${ids[3]}`, (d) => acceptContract(d, ids[3]!));
    expect(refusedFourth.outcome).toEqual({ ok: false, applied: false, reason: 'contract.err.max' });
    expect(refusedFourth.next).toBe(p);
    const active = p.contracts.offers.filter((c) => c.status === 'active');
    expect(active).toHaveLength(MAX_ACTIVE_CONTRACTS);

    const next = roundTrip(p);
    next.generation = 1;
    ensureContracts(next, content);
    expect(next.contracts.generation).toBe(1);
    expect(next.contracts.offers.filter((c) => c.status === 'active')).toEqual(active);
    const offered = next.contracts.offers.filter((c) => c.status === 'offered');
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((c) => c.generation === 1)).toBe(true);
    expect(runTx(next, `ctaccept:${offered[0]!.id}`, (d) => acceptContract(d, offered[0]!.id)).outcome).toEqual({ ok: false, applied: false, reason: 'contract.err.max' });
    expect(next.contracts.offers.filter((c) => c.status === 'active' || c.status === 'ready').length).toBeLessThanOrEqual(MAX_ACTIVE_CONTRACTS);
  });

  it('a turned-in contract is never offered again in the same generation (shelter rebuild / reload re-entry)', () => {
    let p = base('a14-reoffer', 3);
    ensureContracts(p, content);
    const ids = p.contracts.offers.map((c) => c.id);
    expect(ids).toHaveLength(OFFERS_PER_GENERATION);
    // Hand in every offer of this generation (progress forced to ready; objectives are covered by other tests).
    for (const id of ids) {
      p = mustApply(p, `ctaccept:${id}`, (d) => acceptContract(d, id)).next;
      p = mustApply(p, `ctready:${id}`, (d) => {
        const c = d.contracts.offers.find((x) => x.id === id)!;
        c.progress = c.objective.count;
        c.status = 'ready';
      }).next;
      p = mustApply(p, `ctdone:${id}`, (d) => turnInContract(d, id)).next;
    }
    expect(p.contracts.offers).toEqual([]);
    expect([...p.contracts.completed].sort()).toEqual([...ids].sort());
    const credits = p.currency;
    // Same generation with an empty offer list: every shelter re-entry (construction rebuild, reload) calls
    // ensureContracts again. The deterministic ids must not come back, so the rewards cannot be farmed.
    for (let i = 0; i < 3; i++) {
      p = roundTrip(p);
      ensureContracts(p, content);
      expect(p.contracts.offers.filter((c) => ids.includes(c.id))).toEqual([]);
    }
    expect(p.currency).toBe(credits);
    // The next generation offers fresh contracts again.
    p.generation += 1;
    ensureContracts(p, content);
    expect(p.contracts.offers.length).toBeGreaterThan(0);
    expect(p.contracts.offers.every((c) => !ids.includes(c.id))).toBe(true);
  });
});

// ============================================================================================================
// A14 raid events
// ============================================================================================================

describe('A14 raid events', () => {
  it('the same raid seed produces the same events and the same complete raid state', () => {
    // Two identical profiles deploy with the same forecast seed → identical launches → identical raids.
    const l1 = launchFor(DEST_MAIN, null).launch;
    const l2 = launchFor(DEST_MAIN, null).launch;
    expect(l2).toEqual(l1);
    const a = createRaidSim(content, structuredClone(l1)).sim;
    const b = createRaidSim(content, structuredClone(l2)).sim;
    expect(b.events).toEqual(a.events);
    expect(persisted(b)).toEqual(persisted(a));
    for (const destId of [DEST_MAIN, DEST_OUTER]) {
      const { launch } = launchFor(destId, null);
      for (let i = 0; i < 5; i++) expect(persisted(simFor(launch, `ev-same-${i}`))).toEqual(persisted(simFor(launch, `ev-same-${i}`)));
    }
  });

  it('different seeds vary the events; events only appear on maps they belong to', () => {
    for (const [destId, mapId] of [[DEST_MAIN, MAIN_MAP], [DEST_OUTER, OUTER_MAP]] as const) {
      const { launch } = launchFor(destId, null);
      const signatures = new Set<string>();
      const present = new Map<string, number>();
      const N = 40;
      for (let i = 0; i < N; i++) {
        const sim = simFor(launch, `ev-vary-${i}`);
        for (const ev of sim.events) {
          expect(content.raidEvent(ev.defId).mapIds, `${ev.defId} on ${mapId}`).toContain(mapId);
          present.set(ev.defId, (present.get(ev.defId) ?? 0) + 1);
        }
        signatures.add(sim.events.map((e) => `${e.defId}:${e.variant}@${e.x},${e.y}`).join('|'));
      }
      expect(signatures.size, mapId).toBeGreaterThan(3);
      for (const def of content.raidEvents.values()) {
        const n = present.get(def.id) ?? 0;
        if (def.mapIds.includes(mapId)) {
          expect(n, `${def.id} on ${mapId}`).toBeGreaterThan(0);
          expect(n, `${def.id} on ${mapId}`).toBeLessThan(N);
        } else expect(n, `${def.id} on ${mapId}`).toBe(0);
      }
    }
  });

  it('debug_force_<eventId> forces an event on every seed of its maps (and never where it cannot occur)', () => {
    const forceAll = Object.fromEntries([...content.raidEvents.keys()].map((id) => [`debug_force_${id}`, true]));
    for (const [destId, mapId] of [[DEST_MAIN, MAIN_MAP], [DEST_OUTER, OUTER_MAP]] as const) {
      const { launch } = launchFor(destId, null);
      for (let i = 0; i < 20; i++) {
        const sim = simFor(launch, `ev-force-${i}`, forceAll);
        const expected = [...content.raidEvents.values()].filter((d) => d.mapIds.includes(mapId)).map((d) => d.id).sort();
        expect(sim.events.map((e) => e.defId).sort(), `${mapId} seed ${i}`).toEqual(expected);
      }
    }
    // Forcing an event that would have spawned anyway changes nothing but the flag itself (the roll is always consumed).
    const { launch } = launchFor(DEST_MAIN, null);
    let compared = 0;
    for (let i = 0; i < 20; i++) {
      const natural = simFor(launch, `ev-force-${i}`);
      if (!natural.events.some((e) => e.defId === EV_PUMP)) continue;
      const forced = simFor(launch, `ev-force-${i}`, { [`debug_force_${EV_PUMP}`]: true });
      const strip = (s: SimState) => ({ ...(persisted(s) as Record<string, unknown>), flags: null });
      expect(strip(forced)).toEqual(strip(natural));
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });
});

// ============================================================================================================
// A16 time/weather, market, raid RNG
// ============================================================================================================

describe('A16 forecast (time phase / weather / raid seed)', () => {
  it('forecastFor is fixed per (profile seed, destination, generation) and survives a JSON round trip', () => {
    const p = base('a16-forecast', 1, ['outer_route_unlocked']);
    for (const destId of [DEST_MAIN, DEST_OUTER]) {
      const f = forecastFor(p, content, destId);
      expect(f).toMatchObject({ destId, generation: 0 });
      expect(forecastFor(p, content, destId)).toBe(f); // menu re-entry: cached, not re-rolled
      expect(forecastFor(roundTrip(p), content, destId)).toEqual(f);
      // Recomputed from scratch on an identical profile (no cache) → identical.
      expect(forecastFor(base('a16-forecast', 1, ['outer_route_unlocked']), content, destId)).toEqual(f);
    }
    expect(roundTrip(p).forecasts).toEqual(p.forecasts);
  });

  it('the raid launches with exactly the shown forecast, and the forecast changes when the generation advances', () => {
    const p = base('a16-forecast-raid', 1);
    const f0 = forecastFor(p, content, DEST_MAIN);
    const loaded = roundTrip(p); // save/load between looking at the forecast and deploying
    const dep = mustApply(loaded, 'deploy:1:1', (d) => prepareDeploy(d, content, DEST_MAIN, NOW));
    expect({ seed: dep.value.seed, phase: dep.value.phase, weather: dep.value.weather }).toEqual({ seed: f0.seed, phase: f0.phase, weather: f0.weather });
    const { sim } = createRaidSim(content, dep.value);
    expect(sim.env).toEqual({ phase: f0.phase, weather: f0.weather });
    expect(sim.seed).toBe(f0.seed);
    sim.outcome = { kind: 'extracted', exitId: 'exit.west_drain', tick: 0 };
    const after = mustApply(dep.next, `raidend:${sim.raidId}`, (d) => commitRaidEnd(d, content, sim)).next;
    expect(after.generation).toBe(1);
    const f1 = forecastFor(after, content, DEST_MAIN);
    expect(f1.generation).toBe(1);
    expect(f1.seed).not.toBe(f0.seed);
    expect(forecastFor(roundTrip(after), content, DEST_MAIN)).toEqual(f1);

    const q = base('a16-forecast-gens', 1);
    const seeds = new Set<string>();
    const phases = new Set<string>();
    const weathers = new Set<string>();
    for (let g = 0; g < 40; g++) {
      q.generation = g;
      const f = forecastFor(q, content, DEST_MAIN);
      expect(f.generation).toBe(g);
      seeds.add(f.seed);
      phases.add(f.phase);
      weathers.add(f.weather);
    }
    expect(seeds.size).toBe(40);
    expect(phases.size).toBeGreaterThan(1);
    expect(weathers.size).toBeGreaterThan(1);
  });
});

describe('A16 black market and trader stock', () => {
  it('black-market offers are fixed per (seed, generation), identical after save/load and never re-rolled on re-entry', () => {
    const market = content.market('core.market.black');
    const p = base('a16-market', 1, ['black_market_unlocked']);
    p.currency = 1_000_000;
    ensureMarket(p, content);
    const m0 = structuredClone(p.market);
    expect(m0.generation).toBe(0);
    expect(m0.offers.map((o) => o.offerId)).toEqual(Array.from({ length: market.slots }, (_, i) => `bm-0-${i}`));
    expect(new Set(m0.offers.map((o) => o.itemId)).size).toBe(market.slots);
    for (const o of m0.offers) {
      const e = market.pool.find((x) => x.itemId === o.itemId)!;
      expect(e).toBeDefined();
      expect(o.qty).toBeGreaterThanOrEqual(e.qty[0]);
      expect(o.qty).toBeLessThanOrEqual(e.qty[1]);
      expect(o.price).toBe(unitBuyPrice(content, o.itemId, 0, e.priceMult));
    }
    expect(generateMarketOffers(base('a16-market', 1), content, 0)).toEqual(m0.offers);

    const ref = p.market;
    for (let i = 0; i < 5; i++) ensureMarket(p, content); // menu re-entry
    expect(p.market).toBe(ref);
    const loaded = roundTrip(p);
    ensureMarket(loaded, content);
    expect(loaded.market).toEqual(m0);

    // Buy an offer out: re-entry and reload neither restock nor re-roll it.
    const o = m0.offers.find((x) => content.item(x.itemId).size.w * content.item(x.itemId).size.h <= 2)!;
    expect(o).toBeDefined();
    const txId = `bm:${o.offerId}:n1`;
    const bought = mustApply(loaded, txId, (d) => {
      ensureMarket(d, content);
      return buyFromMarket(d, content, o.offerId, o.qty, txId);
    }).next;
    ensureMarket(bought, content);
    expect(bought.market.offers.find((x) => x.offerId === o.offerId)!.qty).toBe(0);
    const reloaded = roundTrip(bought);
    ensureMarket(reloaded, content);
    expect(reloaded.market).toEqual(bought.market);
    expect(reloaded.market.offers.filter((x) => x.offerId !== o.offerId)).toEqual(m0.offers.filter((x) => x.offerId !== o.offerId));

    // Next generation: a new deterministic set.
    reloaded.generation = 1;
    ensureMarket(reloaded, content);
    expect(reloaded.market.generation).toBe(1);
    expect(reloaded.market.offers).toEqual(generateMarketOffers(base('a16-market', 1), content, 1));
    expect(reloaded.market.offers.every((x) => x.offerId.startsWith('bm-1-'))).toBe(true);
    expect(reloaded.market.offers.map((x) => [x.itemId, x.qty])).not.toEqual(m0.offers.map((x) => [x.itemId, x.qty]));
  });

  it('trader stock is fixed per generation: re-entry and save/load never restock it', () => {
    const p = base('a16-stock', 1);
    ensureTraderStock(p, content, MECH);
    expect(p.traders[MECH]!.stock[AMMO9]).toBe(240);
    const txId = `buy:${MECH}:${AMMO9}:n1`;
    const bought = mustApply(p, txId, (d) => buyFromTrader(d, content, MECH, AMMO9, 60, txId)).next;
    for (let i = 0; i < 3; i++) ensureTraderStock(bought, content, MECH);
    expect(bought.traders[MECH]!.stock[AMMO9]).toBe(180);
    const loaded = roundTrip(bought);
    ensureTraderStock(loaded, content, MECH);
    expect(loaded.traders[MECH]).toEqual(bought.traders[MECH]);
    loaded.generation = 1;
    ensureTraderStock(loaded, content, MECH);
    expect(loaded.traders[MECH]!.stock[AMMO9]).toBe(240);
  });
});

describe('A16 raid env and RNG survive serialization', () => {
  it('serializeSim/deserializeSim keeps env and RNG streams; the resumed raid continues identically for 300 ticks', () => {
    const { launch } = launchFor(DEST_MAIN, 'a16-resume', { [`debug_force_${EV_CONVOY}`]: true });
    const live = createRaidSim(content, launch);
    run(live.ctx, 120);
    const json = serializeSim(live.sim);
    const restored = deserializeSim(json);
    expect(restored.env).toEqual(live.sim.env);
    expect(restored.rng).toEqual(live.ctx.rng.getState());
    expect([restored.seed, restored.tick, restored.time]).toEqual([live.sim.seed, live.sim.tick, live.sim.time]);
    const ctx2 = makeContext(restored, content, raidGeometry(content, restored));
    expect(ctx2.rng.getState()).toEqual(live.ctx.rng.getState());
    const convoyAt = (s: SimState) => {
      const ev = s.events.find((e) => e.defId === EV_CONVOY)!;
      return [ev.x, ev.y];
    };
    const convoyStart = convoyAt(restored);
    for (let chunk = 0; chunk < 5; chunk++) {
      run(live.ctx, 60);
      run(ctx2, 60);
      expect(persisted(restored), `after ${(chunk + 1) * 60} resumed ticks`).toEqual(persisted(live.sim));
    }
    expect(restored.tick).toBe(420);
    expect(restored.rng).toEqual(live.sim.rng);
    expect(convoyAt(restored)).not.toEqual(convoyStart); // the raid really evolved during the replay
  });

  it('a raid checkpoint written to IndexedDB restores env/RNG and continues identically', async () => {
    const { p, launch } = launchFor(DEST_MAIN, null, { [`debug_force_${EV_CONVOY}`]: true });
    const live = createRaidSim(content, launch);
    run(live.ctx, 90);
    const store = new SaveStore(new IDBFactory(), 'a16-resume-db');
    await store.open();
    // Same snapshot shape as GameApp.checkpointRaid.
    await store.commit(p.slotId, p, structuredClone({ ...live.sim, fx: [] }), 'checkpoint:a16');
    const lr = await store.load(p.slotId, content);
    if (!('profile' in lr) || !lr.raid) throw new Error('raid snapshot not restored');
    expect(lr.raid.raidId).toBe(p.activeRaid!.raidId);
    expect(lr.raid.env).toEqual(live.sim.env);
    expect(lr.raid.rng).toEqual(live.ctx.rng.getState());
    const ctx2 = makeContext(lr.raid, content, raidGeometry(content, lr.raid));
    for (let chunk = 0; chunk < 4; chunk++) {
      run(live.ctx, 60);
      run(ctx2, 60);
      expect(persisted(lr.raid), `after ${(chunk + 1) * 60} resumed ticks`).toEqual(persisted(live.sim));
    }
    store.close();
  });
});
