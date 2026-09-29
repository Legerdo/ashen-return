/**
 * A12 — "동일 거래/보상/탈출/제작/Perk ID 10회 재시도해도 한 번만 변경"
 *
 * Every profile mutation that the UI issues under a stable transaction id is retried 10 times with the same id.
 * Exactly one state change must happen (currency, per-definition item counts, flags, perks, buildings, ledger) and
 * every retry must report applied=false with reason 'duplicate'. A subset goes through the real persistence path
 * (ProfileService → SaveStore on fake-indexeddb), including concurrent Promise.all retries and retries after a
 * failed save.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { runTx, type TxOutcome } from '../src/core/tx';
import { placeBuilding, upgradeFacility } from '../src/economy/buildings';
import { completeCraft, startCraft, tickCrafting } from '../src/economy/crafting';
import { buyFromMarket, buyFromTrader, ensureMarket, sellItems, sellValue, unitBuyPrice } from '../src/economy/trade';
import { ProfileService } from '../src/game/profileService';
import { bagContainerId, destroyItem, instantiate, placeNew, validateStore } from '../src/inventory/store';
import { canClaimRelief, claimRelief, registerKey, restoreGenerator, unlockPerk } from '../src/progression/actions';
import { grantItems, newProfile, SHELF, STASH, type ProfileState } from '../src/progression/profile';
import { addExp, applyQuestEvent, deliverToNpc, turnInQuest } from '../src/progression/quests';
import { commitRaidEnd, EXTRACT_EXP, prepareDeploy } from '../src/progression/raidFlow';
import { SaveStore } from '../src/save/saveStore';
import { allCarriedItemIds } from '../src/world/context';
import { createRaidSim, type RaidLaunch } from '../src/world/spawn';
import { eqContainerId, type SimState } from '../src/world/state';

const content = createContent();
const SHELTER = content.map('core.map.shelter');
const RETRIES = 10;
const NOW = 1_700_000_000_000;
const DUP = { ok: true, applied: false, reason: 'duplicate' } as const;

const MECH = 'core.trader.mechanic';
const AMMO9 = 'core.ammo.9.fmj';
const Q01 = 'core.quest.q01_ready';
const Q02 = 'core.quest.q02_first_haul';
const RELIEF_PKG = 'core.quest.relief_package';
const DEST_MAIN = 'core.dest.quarantine_main';
const FEE_EXIT = 'exit.checkpoint_barrier';
const FEE = 300;

// --- helpers ------------------------------------------------------------------------------------------------

function fresh(seed = 'a12-seed', slot = 1): ProfileState {
  return newProfile(content, slot, 'A12', seed, NOW);
}

/** Total quantity per item definition over the whole profile store (stash, loadout, bags, reservations...). */
function counts(p: ProfileState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of Object.values(p.store.items)) out[it.definitionId] = (out[it.definitionId] ?? 0) + it.quantity;
  return out;
}

function withDelta(base: Record<string, number>, delta: Record<string, number>): Record<string, number> {
  const out = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    out[k] = (out[k] ?? 0) + v;
    if (out[k] === 0) delete out[k];
  }
  return out;
}

function applied<T>(o: TxOutcome<T> | undefined): T {
  if (!o || !o.ok || !o.applied) throw new Error(`expected an applied transaction, got ${JSON.stringify(o)}`);
  return o.value;
}

function mustApply<T>(p: ProfileState, txId: string, fn: (d: ProfileState) => T): { next: ProfileState; value: T } {
  const { outcome, next } = runTx(p, txId, fn);
  return { next, value: applied(outcome) };
}

interface Retried<T> {
  outcomes: TxOutcome<T>[];
  /** Deep copy of the state right after the first (applying) attempt. */
  first: ProfileState;
  final: ProfileState;
}

/** Run the same txId `n` times, each attempt on the state produced by the previous one. */
function retry<T>(p0: ProfileState, txId: string, mutate: (d: ProfileState) => T, n = RETRIES): Retried<T> {
  const outcomes: TxOutcome<T>[] = [];
  let cur = p0;
  let first: ProfileState | null = null;
  for (let i = 0; i < n; i++) {
    const { outcome, next } = runTx(cur, txId, mutate);
    outcomes.push(outcome);
    // A duplicate hands back the very same state object: nothing was cloned, mutated or re-marked.
    if (i > 0) expect(next).toBe(cur);
    cur = next;
    if (i === 0) first = structuredClone(next);
  }
  return { outcomes, first: first!, final: cur };
}

/** Exactly one applied attempt, 9 duplicates, no drift after the first attempt, exactly one new ledger entry. */
function expectExactlyOnce<T>(r: Retried<T>, p0: ProfileState, txId: string): void {
  expect(r.outcomes).toHaveLength(RETRIES);
  expect(r.outcomes[0]).toMatchObject({ ok: true, applied: true });
  for (const o of r.outcomes.slice(1)) expect(o).toEqual(DUP);
  expect(r.final).toEqual(r.first);
  expect(r.final.ledger.committed).toHaveLength(p0.ledger.committed.length + 1);
  expect(r.final.ledger.committed.filter((x) => x === txId)).toHaveLength(1);
  expect(validateStore(r.final.store, content)).toEqual([]);
}

function tally<T>(outs: TxOutcome<T>[]): { applied: number; duplicate: number; failed: number } {
  return {
    applied: outs.filter((o) => o.ok && o.applied).length,
    duplicate: outs.filter((o) => o.ok && !o.applied && o.reason === 'duplicate').length,
    failed: outs.filter((o) => !o.ok).length,
  };
}

/** Q01 turned in, Q02 relief package found → extracted → delivered: Q02 is 'ready' at the medic. */
function q02Ready(seed: string): ProfileState {
  let p = fresh(seed);
  applyQuestEvent(p, content, { type: 'Interact', target: 'npc.mechanic' });
  applyQuestEvent(p, content, { type: 'Custom', target: 'range_reload', amount: 1 });
  expect(p.quests[Q01]!.status).toBe('ready');
  p = mustApply(p, `quest:${Q01}:complete`, (d) => turnInQuest(d, content, Q01, `quest:${Q01}:complete`)).next;
  expect(p.quests[Q02]!.status).toBe('active');
  applyQuestEvent(p, content, { type: 'Retrieve', itemId: RELIEF_PKG });
  applyQuestEvent(p, content, { type: 'ExtractWith', itemId: RELIEF_PKG, qty: 1, mapId: 'core.map.quarantine_main' });
  grantItems(p, content, RELIEF_PKG, 1, 'test:extracted');
  p = mustApply(p, 'deliver:core.npc.medic:t1', (d) => deliverToNpc(d, content, 'core.npc.medic')).next;
  expect(p.quests[Q02]!.status).toBe('ready');
  return p;
}

function deploy(p: ProfileState): { p: ProfileState; sim: SimState; launch: RaidLaunch; txId: string } {
  const txId = `deploy:${p.slotId}:${p.raidCounter + 1}`;
  const { next, value } = mustApply(p, txId, (d) => prepareDeploy(d, content, DEST_MAIN, NOW));
  return { p: next, sim: createRaidSim(content, value).sim, launch: value, txId };
}

function playerBagContainer(sim: SimState): string {
  const bag = sim.store.containers[eqContainerId('player', 'backpack')]!.items[0]!;
  return bagContainerId(bag);
}

/** Put freshly looted items into the player's backpack inside the raid. */
function addLoot(sim: SimState, defId: string, qty = 1): string {
  const it = instantiate(content, sim.ids, defId, { quantity: qty });
  it.quantity = qty;
  const r = placeNew(sim.store, content, it, { containerId: playerBagContainer(sim) });
  if (!r.ok) throw new Error(`loot placement failed: ${r.error}`);
  return it.instanceId;
}

async function openService(p: ProfileState, dbName: string): Promise<{ store: SaveStore; svc: ProfileService }> {
  const store = new SaveStore(new IDBFactory(), dbName);
  await store.open();
  await store.commit(p.slotId, p, null, `newgame:${p.slotId}:${dbName}`);
  return { store, svc: new ProfileService(store, p) };
}

async function reload(store: SaveStore, slotId: number): Promise<{ profile: ProfileState; raid: SimState | null }> {
  const r = await store.load(slotId, content);
  if (!('profile' in r)) throw new Error(`load failed: ${JSON.stringify(r)}`);
  return { profile: r.profile, raid: r.raid };
}

async function deployVia(svc: ProfileService): Promise<SimState> {
  const holder: { sim: SimState | null } = { sim: null };
  const r = await svc.run(`deploy:${svc.slotId}:${svc.profile.raidCounter + 1}`, (d) => prepareDeploy(d, content, DEST_MAIN, NOW), {
    raid: (launch) => {
      holder.sim = createRaidSim(content, launch).sim;
      return holder.sim;
    },
    pinRaid: true,
  });
  applied(r);
  return holder.sim!;
}

/** Sorted definition ids of everything the raid player carries (equipment, magazines, bag contents). */
function carriedDefs(sim: SimState): string[] {
  const pl = sim.actors.find((a) => a.kind === 'player')!;
  return allCarriedItemIds(sim, pl)
    .map((id) => sim.store.items[id]!.definitionId)
    .sort();
}

/** Throw a QuotaExceededError from the first write phase only. */
function failFirstWrite(store: SaveStore): void {
  let pending = true;
  store.faultInjector = (phase) => {
    if (pending && phase === 'write') {
      pending = false;
      throw new DOMException('simulated quota', 'QuotaExceededError');
    }
  };
}

// --- runTx: each stable id retried 10× ------------------------------------------------------------------------

describe('A12 same transaction id retried 10× changes state exactly once (runTx)', () => {
  it('trade buy — buy:<trader>:<item>:<nonce>: paid once, 30 rounds once, trader stock reduced once', () => {
    const p0 = fresh();
    const untouched = structuredClone(p0);
    const txId = `buy:${MECH}:${AMMO9}:n1`;
    const r = retry(p0, txId, (d) => buyFromTrader(d, content, MECH, AMMO9, 30, txId));
    expectExactlyOnce(r, p0, txId);
    expect(p0).toEqual(untouched); // copy-on-write: the input state is never touched
    const paid = 30 * unitBuyPrice(content, AMMO9, 0);
    expect(applied(r.outcomes[0])).toEqual({ paid });
    expect(r.final.currency).toBe(p0.currency - paid);
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { [AMMO9]: 30 }));
    expect(r.final.traders[MECH]!.stock[AMMO9]).toBe(240 - 30);
    // A different nonce is a different purchase and is applied on its own.
    const second = runTx(r.final, `buy:${MECH}:${AMMO9}:n2`, (d) => buyFromTrader(d, content, MECH, AMMO9, 30, `buy:${MECH}:${AMMO9}:n2`));
    expect(second.outcome).toMatchObject({ ok: true, applied: true });
    expect(second.next.currency).toBe(p0.currency - 2 * paid);
  });

  it('black-market buy — bm:<offer>:<nonce>: paid once, item once, offer quantity reduced once', () => {
    const p0 = fresh('a12-market');
    p0.flags['black_market_unlocked'] = true;
    p0.currency = 100_000;
    ensureMarket(p0, content); // menu entry (outside the transaction, like enterBase)
    const offer = p0.market.offers.find((o) => {
      const d = content.item(o.itemId);
      return d.size.w * d.size.h <= 2;
    });
    expect(offer).toBeDefined();
    const txId = `bm:${offer!.offerId}:n1`;
    const r = retry(p0, txId, (d) => {
      ensureMarket(d, content);
      return buyFromMarket(d, content, offer!.offerId, 1, txId);
    });
    expectExactlyOnce(r, p0, txId);
    expect(r.final.currency).toBe(p0.currency - offer!.price);
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { [offer!.itemId]: 1 }));
    expect(r.final.market.offers.find((o) => o.offerId === offer!.offerId)!.qty).toBe(offer!.qty - 1);
  });

  it('sell — sell:<itemId>: credited once, item destroyed once', () => {
    const p0 = fresh();
    const carbine = p0.store.containers[STASH]!.items.find((id) => p0.store.items[id]!.definitionId === 'core.weapon.c556')!;
    expect(carbine).toBeDefined();
    const value = sellValue(p0, content, carbine, 0);
    expect(value).toBeGreaterThan(0);
    const txId = `sell:${carbine}`;
    const r = retry(p0, txId, (d) => sellItems(d, content, MECH, [carbine], txId));
    expectExactlyOnce(r, p0, txId);
    expect(applied(r.outcomes[0])).toEqual({ earned: value });
    expect(r.final.currency).toBe(p0.currency + value);
    expect(r.final.store.items[carbine]).toBeUndefined();
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { 'core.weapon.c556': -1 }));
    expect(r.final.itemLog.filter((e) => e.tx === txId && e.event === 'destroy')).toHaveLength(1);
  });

  it('quest reward turn-in — quest:<id>:complete: credits, EXP, level-up point, item, flag and trust once', () => {
    const p0 = q02Ready('a12-quest');
    const txId = `quest:${Q02}:complete`;
    const r = retry(p0, txId, (d) => turnInQuest(d, content, Q02, txId));
    expectExactlyOnce(r, p0, txId);
    expect(r.final.quests[Q02]!.status).toBe('completed');
    expect(r.final.currency).toBe(p0.currency + 600);
    expect(r.final.exp).toBe(p0.exp + 250);
    expect(r.final.level).toBe(2);
    expect(r.final.perkPoints).toBe(p0.perkPoints + 1);
    expect(r.final.flags['medical_stock']).toBe(true);
    expect(r.final.traders['core.trader.medic']!.trust).toBe(p0.traders['core.trader.medic']!.trust + 80);
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { 'core.med.firstaid': 1 }));
  });

  it('raid end (extract) — raidend:<raidId>: loadout + loot returned once, fee/EXP/generation/stats once', () => {
    const p0 = fresh('a12-raid');
    p0.flags['deploy_allowed'] = true;
    const before = counts(p0);
    const dep = deploy(p0);
    // The deployment itself is also retry-safe.
    for (let i = 1; i < RETRIES; i++) expect(runTx(dep.p, dep.txId, (d) => prepareDeploy(d, content, DEST_MAIN, NOW)).outcome).toEqual(DUP);
    expect(dep.p.stats.raids).toBe(1);
    addLoot(dep.sim, 'core.val.watch');
    dep.sim.outcome = { kind: 'extracted', exitId: FEE_EXIT, tick: dep.sim.tick };
    const txId = `raidend:${dep.sim.raidId}`;
    const r = retry(dep.p, txId, (d) => commitRaidEnd(d, content, dep.sim));
    expectExactlyOnce(r, dep.p, txId);
    const summary = applied(r.outcomes[0]);
    expect(summary.outcome).toBe('extracted');
    expect(summary.feePaid).toBe(FEE);
    expect(summary.itemsIn).toEqual([{ defId: 'core.val.watch', qty: 1 }]);
    expect(r.final.currency).toBe(p0.currency - FEE);
    expect(r.final.exp).toBe(p0.exp + EXTRACT_EXP);
    expect(r.final.generation).toBe(p0.generation + 1);
    expect(r.final.stats).toMatchObject({ raids: 1, extractions: 1, deaths: 0 });
    expect(r.final.activeRaid).toBeNull();
    expect(r.final.lastRaidSummary).toEqual(summary);
    expect(counts(r.final)).toEqual(withDelta(before, { 'core.val.watch': 1 }));
  });

  it('craft completion — craftdone:<jobId>: inputs consumed once, output granted once', () => {
    const p0 = fresh('a12-craft');
    const start = mustApply(p0, 'craft:core.recipe.bandage:n1', (d) => startCraft(d, content, 'core.recipe.bandage'));
    const p1 = start.next;
    const job = start.value;
    expect(p1.currency).toBe(p0.currency - 10);
    // The shelter frame loop advances timers outside transactions (like GameApp.baseTick).
    expect(tickCrafting(p1, 60)).toEqual([job.jobId]);
    const txId = `craftdone:${job.jobId}`;
    const r = retry(p1, txId, (d) => completeCraft(d, content, job.jobId, txId));
    expectExactlyOnce(r, p1, txId);
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { 'core.mat.cloth': -2, 'core.med.bandage': 1 }));
    expect(r.final.crafting.jobs).toEqual([]);
    expect(r.final.store.containers[`craft:${job.jobId}`]).toBeUndefined();
    expect(r.final.currency).toBe(p0.currency - 10);
  });

  it('perk unlock — perk:<perkId>: point spent once, perk owned once', () => {
    const p0 = fresh();
    addExp(p0, 300);
    expect(p0.perkPoints).toBe(1);
    const perk = 'core.perk.survival.stamina_1';
    const txId = `perk:${perk}`;
    const r = retry(p0, txId, (d) => unlockPerk(d, content, perk));
    expectExactlyOnce(r, p0, txId);
    expect(r.final.perks).toEqual([perk]);
    expect(r.final.perkPoints).toBe(0);
    // Even under another id the owned perk cannot be bought again.
    expect(runTx(r.final, `${txId}:again`, (d) => unlockPerk(d, content, perk)).outcome).toEqual({ ok: false, applied: false, reason: 'perk.err.owned' });
  });

  it('building placement — build:<buildingId>: cost charged once, one building, one shelf container', () => {
    const p0 = fresh();
    grantItems(p0, content, 'core.mat.scrap', 4, 'test:setup');
    const id = 'core.building.supply_shelf';
    const txId = `build:${id}`;
    const r = retry(p0, txId, (d) => placeBuilding(d, content, SHELTER, id, 12, 20, 0));
    expectExactlyOnce(r, p0, txId);
    expect(r.final.currency).toBe(p0.currency - 800);
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { 'core.mat.scrap': -4 }));
    expect(r.final.buildings.map((b) => b.buildingId)).toEqual([id]);
    expect(r.final.store.containers[SHELF]).toMatchObject({ kind: 'grid', w: 6, h: 4, items: [] });
    expect(r.final.flags[`building:${id}`]).toBe(true);
    expect(runTx(r.final, `${txId}:again`, (d) => placeBuilding(d, content, SHELTER, id, 14, 22, 0)).outcome).toEqual({ ok: false, applied: false, reason: 'build.err.duplicate' });
  });

  it('facility upgrade — facility:<id>: charged once, effect applied once', () => {
    const p0 = fresh();
    p0.flags['facilities_unlocked'] = true;
    p0.currency = 6000;
    const txId = 'facility:core.facility.stash';
    const r = retry(p0, txId, (d) => upgradeFacility(d, content, 'core.facility.stash'));
    expectExactlyOnce(r, p0, txId);
    expect(r.final.currency).toBe(6000 - 2500);
    expect(r.final.facilities).toEqual({ 'core.facility.stash': 1 });
    expect(r.final.store.containers[STASH]).toMatchObject({ w: 12, h: 14 });
    expect(runTx(r.final, `${txId}:again`, (d) => upgradeFacility(d, content, 'core.facility.stash')).outcome).toEqual({ ok: false, applied: false, reason: 'facility.err.done' });
  });

  it('key registration — key:<keyId>: key item consumed once, access right granted once', () => {
    const p0 = fresh();
    const [keyItem] = grantItems(p0, content, 'core.keyitem.farm_backroom', 1, 'test:loot');
    const txId = 'key:core.key.farm_backroom';
    const r = retry(p0, txId, (d) => registerKey(d, content, keyItem!, txId));
    expectExactlyOnce(r, p0, txId);
    expect(applied(r.outcomes[0])).toEqual({ keyId: 'core.key.farm_backroom', consumed: true });
    expect(r.final.keys.registered).toEqual(['core.key.farm_backroom']);
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { 'core.keyitem.farm_backroom': -1 }));
    expect(r.final.itemLog.filter((e) => e.reason === 'key-registered')).toHaveLength(1);
  });

  it('relief claim — relief:<generation>: one relief kit per generation', () => {
    const p0 = fresh();
    for (const it of Object.values(p0.store.items)) if (content.item(it.definitionId).kind === 'weapon') destroyItem(p0.store, it.instanceId);
    p0.currency = 200;
    expect(canClaimRelief(p0, content)).toBe(true);
    const txId = `relief:${p0.generation}`;
    const r = retry(p0, txId, (d) => claimRelief(d, content, txId));
    expectExactlyOnce(r, p0, txId);
    expect(r.final.reliefGeneration).toBe(p0.generation);
    expect(r.final.currency).toBe(200);
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { 'core.weapon.p9': 1, 'core.mag.p9': 1, 'core.ammo.9.relief': 30, 'core.med.bandage': 2 }));
    expect(runTx(r.final, `${txId}:again`, (d) => claimRelief(d, content, `${txId}:again`)).outcome).toEqual({ ok: false, applied: false, reason: 'relief.err.not_eligible' });
  });

  it('generator restore — generator:restore: relay module consumed once, flag set once', () => {
    let p0 = fresh();
    p0.flags['workbench_unlocked'] = true;
    grantItems(p0, content, 'core.mat.wire', 2, 'test:setup');
    grantItems(p0, content, 'core.mat.scrap', 4, 'test:setup');
    p0 = mustApply(p0, 'build:core.building.power_comms', (d) => placeBuilding(d, content, SHELTER, 'core.building.power_comms', 12, 24, 0)).next;
    grantItems(p0, content, 'core.quest.relay_module', 1, 'test:craft');
    const txId = 'generator:restore';
    const r = retry(p0, txId, (d) => restoreGenerator(d, content, txId));
    expectExactlyOnce(r, p0, txId);
    expect(r.final.flags['generator_restored']).toBe(true);
    expect(counts(r.final)).toEqual(withDelta(counts(p0), { 'core.quest.relay_module': -1 }));
    expect(runTx(r.final, `${txId}:again`, (d) => restoreGenerator(d, content, `${txId}:again`)).outcome).toEqual({ ok: false, applied: false, reason: 'gen.err.done' });
  });
});

// --- ProfileService on a real (fake-indexeddb) SaveStore ------------------------------------------------------

describe('A12 through ProfileService + SaveStore (fake-indexeddb)', () => {
  it('10 concurrent buy retries commit once; the persisted save agrees and the id stays spent after reload', async () => {
    const p0 = fresh('svc-buy');
    const { store, svc } = await openService(p0, 'a12-svc-buy');
    const start = structuredClone(svc.profile);
    const txId = `buy:${MECH}:${AMMO9}:svc1`;
    const buy = (d: ProfileState) => buyFromTrader(d, content, MECH, AMMO9, 30, txId);
    const outs = await Promise.all(Array.from({ length: RETRIES }, () => svc.run(txId, buy)));
    expect(tally(outs)).toEqual({ applied: 1, duplicate: RETRIES - 1, failed: 0 });
    const paid = 30 * unitBuyPrice(content, AMMO9, 0);
    expect(svc.profile.currency).toBe(start.currency - paid);
    expect(counts(svc.profile)).toEqual(withDelta(counts(start), { [AMMO9]: 30 }));
    const saved = await reload(store, p0.slotId);
    expect(saved.profile.currency).toBe(svc.profile.currency);
    expect(counts(saved.profile)).toEqual(counts(svc.profile));
    expect(saved.profile.ledger.committed.filter((x) => x === txId)).toHaveLength(1);
    const svc2 = new ProfileService(store, saved.profile);
    for (let i = 0; i < RETRIES; i++) expect(await svc2.run(txId, buy)).toEqual(DUP);
    expect(svc2.profile).toBe(saved.profile);
    store.close();
  });

  it('a buy whose first save fails (quota) is applied exactly once by the following retries', async () => {
    const p0 = fresh('svc-buy-fault');
    const { store, svc } = await openService(p0, 'a12-svc-buy-fault');
    const start = svc.profile;
    const snapshot = structuredClone(start);
    const txId = `buy:${MECH}:${AMMO9}:svc-fault`;
    const buy = (d: ProfileState) => buyFromTrader(d, content, MECH, AMMO9, 30, txId);
    failFirstWrite(store);
    expect(await svc.run(txId, buy)).toEqual({ ok: false, applied: false, reason: 'save.err.quota' });
    expect(svc.profile).toBe(start);
    expect(svc.profile).toEqual(snapshot);
    const outs = await Promise.all(Array.from({ length: RETRIES - 1 }, () => svc.run(txId, buy)));
    expect(tally(outs)).toEqual({ applied: 1, duplicate: RETRIES - 2, failed: 0 });
    const paid = 30 * unitBuyPrice(content, AMMO9, 0);
    expect(svc.profile.currency).toBe(snapshot.currency - paid);
    expect(counts(svc.profile)).toEqual(withDelta(counts(snapshot), { [AMMO9]: 30 }));
    const saved = await reload(store, p0.slotId);
    expect(saved.profile.currency).toBe(snapshot.currency - paid);
    expect(saved.profile.ledger.committed.filter((x) => x === txId)).toHaveLength(1);
    store.close();
  });

  it('10 concurrent quest turn-in retries pay the rewards once', async () => {
    const p0 = q02Ready('svc-quest');
    const { store, svc } = await openService(p0, 'a12-svc-quest');
    const txId = `quest:${Q02}:complete`;
    const outs = await Promise.all(Array.from({ length: RETRIES }, () => svc.run(txId, (d) => turnInQuest(d, content, Q02, txId))));
    expect(tally(outs)).toEqual({ applied: 1, duplicate: RETRIES - 1, failed: 0 });
    const saved = await reload(store, p0.slotId);
    for (const p of [svc.profile, saved.profile]) {
      expect(p.currency).toBe(p0.currency + 600);
      expect(p.exp).toBe(p0.exp + 250);
      expect(p.perkPoints).toBe(p0.perkPoints + 1);
      expect(p.traders['core.trader.medic']!.trust).toBe(80);
      expect(counts(p)).toEqual(withDelta(counts(p0), { 'core.med.firstaid': 1 }));
    }
    store.close();
  });

  it('10 concurrent perk unlock retries spend the point once', async () => {
    const p0 = fresh('svc-perk');
    addExp(p0, 300);
    const { store, svc } = await openService(p0, 'a12-svc-perk');
    const perk = 'core.perk.combat.steady';
    const outs = await Promise.all(Array.from({ length: RETRIES }, () => svc.run(`perk:${perk}`, (d) => unlockPerk(d, content, perk))));
    expect(tally(outs)).toEqual({ applied: 1, duplicate: RETRIES - 1, failed: 0 });
    const saved = await reload(store, p0.slotId);
    for (const p of [svc.profile, saved.profile]) {
      expect(p.perks).toEqual([perk]);
      expect(p.perkPoints).toBe(0);
    }
    store.close();
  });

  it('craftdone enqueued on every shelter frame (GameApp.baseTick pattern) completes the job once', async () => {
    const p0 = fresh('svc-craft');
    const { store, svc } = await openService(p0, 'a12-svc-craft');
    const start = await svc.run('craft:core.recipe.bandage:svc', (d) => startCraft(d, content, 'core.recipe.bandage'));
    const job = applied(start);
    const pending: Promise<TxOutcome<{ outputIds: string[] }>>[] = [];
    // 10 shelter frames run before the first commit resolves; the finished job is reported on every one of them.
    for (let frame = 0; frame < RETRIES; frame++) {
      for (const jobId of tickCrafting(svc.profile, job.total)) pending.push(svc.run(`craftdone:${jobId}`, (d) => completeCraft(d, content, jobId, `craftdone:${jobId}`)));
    }
    expect(pending).toHaveLength(RETRIES);
    const outs = await Promise.all(pending);
    expect(tally(outs)).toEqual({ applied: 1, duplicate: RETRIES - 1, failed: 0 });
    const saved = await reload(store, p0.slotId);
    for (const p of [svc.profile, saved.profile]) {
      expect(p.crafting.jobs).toEqual([]);
      expect(counts(p)).toEqual(withDelta(counts(p0), { 'core.mat.cloth': -2, 'core.med.bandage': 1 }));
      expect(p.currency).toBe(p0.currency - 10);
      expect(p.ledger.committed.filter((x) => x === `craftdone:${job.jobId}`)).toHaveLength(1);
    }
    store.close();
  });

  it('10 concurrent raid-end retries extract once; the save has no raid snapshot left', async () => {
    const p0 = fresh('svc-raid');
    p0.flags['deploy_allowed'] = true;
    const before = counts(p0);
    const { store, svc } = await openService(p0, 'a12-svc-raid');
    const sim = await deployVia(svc);
    expect((await reload(store, p0.slotId)).raid?.raidId).toBe(sim.raidId);
    addLoot(sim, 'core.val.watch');
    sim.outcome = { kind: 'extracted', exitId: FEE_EXIT, tick: sim.tick };
    const txId = `raidend:${sim.raidId}`;
    const outs = await Promise.all(Array.from({ length: RETRIES }, () => svc.run(txId, (d) => commitRaidEnd(d, content, sim), { raid: null })));
    expect(tally(outs)).toEqual({ applied: 1, duplicate: RETRIES - 1, failed: 0 });
    const saved = await reload(store, p0.slotId);
    expect(saved.raid).toBeNull();
    for (const p of [svc.profile, saved.profile]) {
      expect(p.activeRaid).toBeNull();
      expect(p.stats).toMatchObject({ raids: 1, extractions: 1 });
      expect(p.currency).toBe(p0.currency - FEE);
      expect(p.exp).toBe(EXTRACT_EXP);
      expect(counts(p)).toEqual(withDelta(before, { 'core.val.watch': 1 }));
      expect(p.ledger.committed.filter((x) => x === txId)).toHaveLength(1);
    }
    store.close();
  });

  it('a raid end whose first save fails is retried without losing the carried loadout or loot', async () => {
    const p0 = fresh('svc-raid-fault');
    p0.flags['deploy_allowed'] = true;
    const before = counts(p0);
    const { store, svc } = await openService(p0, 'a12-svc-raid-fault');
    const sim = await deployVia(svc);
    addLoot(sim, 'core.val.watch');
    sim.outcome = { kind: 'extracted', exitId: FEE_EXIT, tick: sim.tick };
    const carriedBefore = carriedDefs(sim);
    expect(carriedBefore).toContain('core.val.watch');
    const txId = `raidend:${sim.raidId}`;
    const end = (d: ProfileState) => commitRaidEnd(d, content, sim);
    failFirstWrite(store);
    const first = await svc.run(txId, end, { raid: null });
    expect(first).toEqual({ ok: false, applied: false, reason: 'save.err.quota' });
    expect(svc.profile.activeRaid?.raidId).toBe(sim.raidId);
    // Root cause probe: a transaction that was never committed must not have consumed the raid state it reads.
    expect.soft(carriedDefs(sim), 'items still carried by the raid player after the failed (uncommitted) raid-end attempt').toEqual(carriedBefore);
    // GameApp.frame() calls endRaid() again on the next frame with the same id.
    const outs: TxOutcome<unknown>[] = [];
    for (let i = 1; i < RETRIES; i++) outs.push(await svc.run(txId, end, { raid: null }));
    expect(tally(outs)).toEqual({ applied: 1, duplicate: RETRIES - 2, failed: 0 });
    expect(svc.profile.stats.extractions).toBe(1);
    expect(counts(svc.profile), 'profile items after the successful retry').toEqual(withDelta(before, { 'core.val.watch': 1 }));
    const saved = await reload(store, p0.slotId);
    expect(counts(saved.profile), 'persisted items after the successful retry').toEqual(withDelta(before, { 'core.val.watch': 1 }));
    store.close();
  });
});
