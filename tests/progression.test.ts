/**
 * A15 — "EXP/Perk/건설/시설 저장·비용·효과의 중복 적용 0"
 * A18 — "노트/열쇠/퀘스트/WorldFlag 상태와 보상 중복 0"
 *
 * Costs are charged once, effects are applied once, and neither retries (same transaction id), repeated requests
 * (new ids) nor a JSON save/load round trip re-apply or re-charge anything.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { runTx, type TxOutcome } from '../src/core/tx';
import { buildingCost, placeBuilding, upgradeFacility } from '../src/economy/buildings';
import { craftSpeed, recipeTime, repairAmount } from '../src/economy/crafting';
import { ensureMarket, ensureTraderStock } from '../src/economy/trade';
import { countDef, validateStore } from '../src/inventory/store';
import { healCost, markNoteRead, perkBlocker, registerKey, restoreGenerator, unlockPerk } from '../src/progression/actions';
import { ensureContracts } from '../src/progression/contracts';
import { aggregatePerks, EXP_TABLE, grantItems, levelForExp, MAX_LEVEL, newProfile, SHELF, STASH, stashHeight, type ProfileState, type RaidSummary } from '../src/progression/profile';
import { addExp, applyQuestEvent, deliverToNpc, refreshQuests, setFlag, turnInQuest } from '../src/progression/quests';
import { commitRaidEnd, EXTRACT_EXP, prepareDeploy } from '../src/progression/raidFlow';
import { checksum } from '../src/save/checksum';
import { normalizeProfile } from '../src/save/schema';
import { SaveStore } from '../src/save/saveStore';
import { hasKey } from '../src/world/interact';
import { createRaidSim } from '../src/world/spawn';
import type { SimState } from '../src/world/state';

const content = createContent();
const SHELTER = content.map('core.map.shelter');
const RETRIES = 10;
const NOW = 1_700_000_000_000;
const DUP = { ok: true, applied: false, reason: 'duplicate' } as const;
const refused = (reason: string) => ({ ok: false, applied: false, reason });

const DEST_MAIN = 'core.dest.quarantine_main';
const MAIN_MAP = 'core.map.quarantine_main';
const FREE_EXIT = 'exit.west_drain';

const S1 = 'core.perk.survival.stamina_1';
const S2 = 'core.perk.survival.stamina_2';
const S3 = 'core.perk.survival.stamina_3';
const FIELD_MEDIC = 'core.perk.survival.field_medic';
const PACK1 = 'core.perk.carry.pack_1';
const PACK2 = 'core.perk.carry.pack_2';
const PACK3 = 'core.perk.carry.pack_3';
const STEADY = 'core.perk.combat.steady';

const SHELF_B = 'core.building.supply_shelf';
const WB_B = 'core.building.workbench_module';
const MED_B = 'core.building.medical_module';
const POWER_B = 'core.building.power_comms';
const STASH_F = 'core.facility.stash';
const WB_F = 'core.facility.workbench';
const MED_F = 'core.facility.medical';

const Q01 = 'core.quest.q01_ready';
const Q02 = 'core.quest.q02_first_haul';
const Q07 = 'core.quest.q07_restore_power';
const RELIEF_PKG = 'core.quest.relief_package';
const MEDIC_NPC = 'core.npc.medic';

// --- helpers ------------------------------------------------------------------------------------------------

function fresh(seed = 'prog-seed'): ProfileState {
  return newProfile(content, 1, 'A15', seed, NOW);
}

function atLevel(level: number, seed = 'prog-level'): ProfileState {
  const p = fresh(seed);
  addExp(p, EXP_TABLE[level - 1]!);
  expect(p.level).toBe(level);
  return p;
}

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

function applied<T>(o: TxOutcome<T>): T {
  if (!o.ok || !o.applied) throw new Error(`expected an applied transaction, got ${JSON.stringify(o)}`);
  return o.value;
}

function mustApply<T>(p: ProfileState, txId: string, fn: (d: ProfileState) => T): { next: ProfileState; value: T } {
  const { outcome, next } = runTx(p, txId, fn);
  return { next, value: applied(outcome) };
}

/** Same id `RETRIES` times: first applies, the rest are duplicates returning the identical state object. */
function retryOnce<T>(p0: ProfileState, txId: string, fn: (d: ProfileState) => T): { final: ProfileState; value: T } {
  const first = runTx(p0, txId, fn);
  const value = applied(first.outcome);
  const snapshot = structuredClone(first.next);
  for (let i = 1; i < RETRIES; i++) {
    const again = runTx(first.next, txId, fn);
    expect(again.outcome).toEqual(DUP);
    expect(again.next).toBe(first.next);
  }
  expect(first.next).toEqual(snapshot);
  expect(first.next.ledger.committed).toHaveLength(p0.ledger.committed.length + 1);
  return { final: first.next, value };
}

/** A refused request must leave the very same state object behind (nothing partially applied). */
function expectRefused<T>(p: ProfileState, txId: string, fn: (d: ProfileState) => T, reason: string): void {
  const r = runTx(p, txId, fn);
  expect(r.outcome).toEqual(refused(reason));
  expect(r.next).toBe(p);
}

function roundTrip(p: ProfileState): ProfileState {
  return normalizeProfile(JSON.parse(JSON.stringify(p)) as ProfileState);
}

/** Deploy to the main zone, let `prepare` script what happened in the raid, then commit the raid end. */
function raid(p: ProfileState, prepare: (sim: SimState) => void, died = false): { p: ProfileState; summary: RaidSummary; txId: string; sim: SimState } {
  const dep = mustApply(p, `deploy:${p.slotId}:${p.raidCounter + 1}`, (d) => prepareDeploy(d, content, DEST_MAIN, NOW));
  const { sim } = createRaidSim(content, dep.value);
  prepare(sim);
  const pl = sim.actors.find((a) => a.kind === 'player')!;
  if (died) {
    pl.alive = false;
    pl.hp = 0;
    sim.outcome = { kind: 'dead', tick: sim.tick, cause: 'test' };
  } else sim.outcome = { kind: 'extracted', exitId: FREE_EXIT, tick: sim.tick };
  const txId = `raidend:${sim.raidId}`;
  const end = mustApply(dep.next, txId, (d) => commitRaidEnd(d, content, sim));
  return { p: end.next, summary: end.value, txId, sim };
}

/** Q01 turned in; Q02 relief package already found and extracted (delivery pending). */
function q02AwaitingDelivery(seed: string): ProfileState {
  let p = fresh(seed);
  applyQuestEvent(p, content, { type: 'Interact', target: 'npc.mechanic' });
  applyQuestEvent(p, content, { type: 'Custom', target: 'range_reload', amount: 1 });
  p = mustApply(p, `quest:${Q01}:complete`, (d) => turnInQuest(d, content, Q01, `quest:${Q01}:complete`)).next;
  applyQuestEvent(p, content, { type: 'Retrieve', itemId: RELIEF_PKG });
  applyQuestEvent(p, content, { type: 'ExtractWith', itemId: RELIEF_PKG, qty: 1, mapId: MAIN_MAP });
  expect(p.quests[Q02]).toEqual({ status: 'active', progress: { find: 1, extract: 1 } });
  return p;
}

/** Everything the player paid for / unlocked and every effect derived from it. */
function paidState(p: ProfileState) {
  return {
    currency: p.currency,
    exp: p.exp,
    level: p.level,
    perkPoints: p.perkPoints,
    perks: [...p.perks],
    perkEffects: aggregatePerks(content, p.perks),
    buildings: structuredClone(p.buildings),
    facilities: { ...p.facilities },
    flags: { ...p.flags },
    stash: { w: p.store.containers[STASH]!.w, h: p.store.containers[STASH]!.h },
    stashHeight: stashHeight(p),
    shelf: p.store.containers[SHELF] ? { w: p.store.containers[SHELF]!.w, h: p.store.containers[SHELF]!.h, kind: p.store.containers[SHELF]!.kind } : null,
    craftSpeed: craftSpeed(p),
    repairAmount: repairAmount(p),
    recipeTimes: Object.fromEntries([...content.recipes.keys()].map((id) => [id, recipeTime(p, content, id)])),
    healCost: healCost({ ...p, playerHp: 40, playerBleeding: true }),
    items: counts(p),
    ledger: [...p.ledger.committed],
  };
}

// --- A15: EXP / level ------------------------------------------------------------------------------------------

describe('A15 EXP and levels', () => {
  it('EXP_TABLE thresholds map exactly onto levels 1–10 and cap at MAX_LEVEL', () => {
    expect(EXP_TABLE).toEqual([0, 300, 800, 1500, 2400, 3500, 4800, 6300, 8000, 10000]);
    expect(MAX_LEVEL).toBe(10);
    EXP_TABLE.forEach((xp, i) => {
      expect(levelForExp(xp)).toBe(i + 1);
      if (i > 0) expect(levelForExp(xp - 1)).toBe(i);
    });
    expect(levelForExp(10_000_000)).toBe(MAX_LEVEL);
  });

  it('perk points are granted exactly once per level gained and never beyond level 10', () => {
    const inc = fresh();
    for (let i = 0; i < 400; i++) {
      addExp(inc, 37);
      expect(inc.level).toBe(levelForExp(inc.exp));
      expect(inc.perkPoints).toBe(inc.level - 1);
    }
    expect(inc.exp).toBe(400 * 37);
    expect([inc.level, inc.perkPoints]).toEqual([10, 9]);
    expect(inc.log.filter((l) => l.key === 'log.levelup')).toHaveLength(9);

    const jump = fresh();
    expect(addExp(jump, 25_000)).toBe(9);
    expect(addExp(jump, 50_000)).toBe(0);
    expect([jump.level, jump.perkPoints]).toEqual([10, 9]);

    const edge = fresh();
    addExp(edge, 299);
    addExp(edge, -1000);
    addExp(edge, 0);
    expect([edge.exp, edge.level, edge.perkPoints]).toEqual([299, 1, 0]);
    expect(addExp(edge, 1)).toBe(1);
    expect([edge.exp, edge.level, edge.perkPoints]).toEqual([300, 2, 1]);
  });

  it('raid-end EXP that crosses a threshold levels up once even when the raid end is retried 10×', () => {
    const p0 = fresh('a15-raid-exp');
    p0.flags['deploy_allowed'] = true;
    addExp(p0, 250);
    const dep = mustApply(p0, 'deploy:1:1', (d) => prepareDeploy(d, content, DEST_MAIN, NOW));
    const { sim } = createRaidSim(content, dep.value);
    sim.outcome = { kind: 'extracted', exitId: FREE_EXIT, tick: 0 };
    const r = retryOnce(dep.next, `raidend:${sim.raidId}`, (d) => commitRaidEnd(d, content, sim));
    expect(r.value.expGained).toBe(EXTRACT_EXP);
    expect(r.value.levelUps).toBe(1);
    expect([r.final.exp, r.final.level, r.final.perkPoints]).toEqual([350, 2, 1]);
  });
});

// --- A15: perks ------------------------------------------------------------------------------------------------

describe('A15 perks', () => {
  it('every perk enforces its level, prerequisites and cost; the cost is charged once and ownership is final', () => {
    expect(content.perks.size).toBe(12);
    for (const perk of content.perks.values()) {
      const txId = `perk:${perk.id}`;
      const unlock = (d: ProfileState) => unlockPerk(d, content, perk.id);
      if (perk.level > 1) {
        const low = atLevel(perk.level - 1);
        low.perks = [...perk.requires];
        low.perkPoints = 5;
        expect(perkBlocker(low, content, perk.id)).toBe('perk.err.level');
        expectRefused(low, txId, unlock, 'perk.err.level');
      }
      if (perk.requires.length > 0) {
        const noReq = atLevel(perk.level);
        noReq.perkPoints = 5;
        expect(perkBlocker(noReq, content, perk.id)).toBe('perk.err.requires');
        expectRefused(noReq, txId, unlock, 'perk.err.requires');
      }
      const broke = atLevel(perk.level);
      broke.perks = [...perk.requires];
      broke.perkPoints = perk.cost - 1;
      expect(perkBlocker(broke, content, perk.id)).toBe('perk.err.points');
      expectRefused(broke, txId, unlock, 'perk.err.points');

      const ok = atLevel(perk.level);
      ok.perks = [...perk.requires];
      ok.perkPoints = 5;
      expect(perkBlocker(ok, content, perk.id)).toBeNull();
      const r = retryOnce(ok, txId, unlock);
      expect(r.final.perkPoints).toBe(5 - perk.cost);
      expect(r.final.perks).toEqual([...perk.requires, perk.id]);
      expect(perkBlocker(r.final, content, perk.id)).toBe('perk.err.owned');
      expectRefused(r.final, `${txId}:again`, unlock, 'perk.err.owned');
    }
  });

  it('a staged unlock path spends exactly one point per perk from level-up points', () => {
    let p = atLevel(4);
    expect(p.perkPoints).toBe(3);
    expectRefused(p, `perk:${S2}`, (d) => unlockPerk(d, content, S2), 'perk.err.requires');
    expectRefused(p, `perk:${S3}`, (d) => unlockPerk(d, content, S3), 'perk.err.level');
    for (const id of [S1, S2, FIELD_MEDIC]) p = mustApply(p, `perk:${id}`, (d) => unlockPerk(d, content, id)).next;
    expect(p.perks).toEqual([S1, S2, FIELD_MEDIC]);
    expect(p.perkPoints).toBe(0);
    expectRefused(p, `perk:${STEADY}`, (d) => unlockPerk(d, content, STEADY), 'perk.err.points');
    const spent = p.perks.reduce((s, id) => s + content.perk(id).cost, 0);
    expect(p.perkPoints).toBe(p.level - 1 - spent);
  });

  it('aggregatePerks counts staged perks as cumulative totals and every owned perk exactly once', () => {
    const all = [...content.perks.keys()];
    const expected = {
      staminaMax: 15,
      carryKg: 3,
      healTimeMult: 0.9,
      bandageTimeMult: 0.75,
      bleedRateMult: 0.75,
      searchSpeedMult: 1.15,
      mapInfo: true,
      stabilizeMult: 0.85,
      repairMult: 1.2,
      reloadMult: 0.92,
      recoilRecoveryMult: 1.15,
      swapTimeMult: 0.85,
    };
    const input = [...all];
    expect(aggregatePerks(content, input)).toEqual(expected);
    expect(input).toEqual(all); // not mutated
    expect(aggregatePerks(content, [...all].reverse())).toEqual(expected);
    expect(aggregatePerks(content, input)).toEqual(aggregatePerks(content, input));
    expect(aggregatePerks(content, [S1]).staminaMax).toBe(5);
    expect(aggregatePerks(content, [S1, S2]).staminaMax).toBe(10);
    expect(aggregatePerks(content, [S1, S2, S3]).staminaMax).toBe(15);
    expect(aggregatePerks(content, [PACK1, PACK2, PACK3]).carryKg).toBe(3);
  });

  it('a perk id listed twice in an accepted save import is still counted once by aggregatePerks', () => {
    const all = [...content.perks.keys()];
    const once = aggregatePerks(content, all);
    const payload = JSON.stringify({ ...fresh('a15-dup-perk'), perks: [...all, FIELD_MEDIC, STEADY] });
    const pkg = { format: 'ashen-return-save', version: 1, exportedAt: NOW, gameVersion: '1.0.0', slotId: 1, profile: payload, raid: null, checksum: checksum(`${payload}|`) };
    const v = SaveStore.validateImport(pkg, content);
    if ('errors' in v) throw new Error(`import rejected: ${v.errors.join(', ')}`);
    expect(v.profile.perks).toHaveLength(all.length); // normalization drops the duplicated ids on load/import
    expect(aggregatePerks(content, v.profile.perks)).toEqual(once);
    // Even a list that still contains duplicates is aggregated once per perk.
    expect(aggregatePerks(content, [...all, FIELD_MEDIC, STEADY])).toEqual(once);
  });

  it('perk effects reach the raid once: stamina I–III gives +15 max stamina, not +30', () => {
    const p = atLevel(6, 'a15-perk-raid');
    p.flags['deploy_allowed'] = true;
    p.perks = [S1, S2, S3, PACK1];
    const dep = mustApply(p, 'deploy:1:1', (d) => prepareDeploy(d, content, DEST_MAIN, NOW));
    expect(dep.value.perks).toEqual({ staminaMax: 15, carryKg: 1 });
    const { sim } = createRaidSim(content, dep.value);
    const pl = sim.actors.find((a) => a.kind === 'player')!;
    expect(pl.staminaMax).toBe(115);
    expect(pl.stamina).toBe(115);
  });
});

// --- A15: buildings & facilities -------------------------------------------------------------------------------

describe('A15 buildings and facilities', () => {
  it('building placement charges its cost once; duplicate and invalid placements are refused at no cost', () => {
    const p0 = fresh();
    p0.currency = 10_000;
    grantItems(p0, content, 'core.mat.scrap', 10, 'test:setup');
    const r = retryOnce(p0, `build:${SHELF_B}`, (d) => placeBuilding(d, content, SHELTER, SHELF_B, 12, 20, 0));
    const p = r.final;
    expect(p.currency).toBe(10_000 - 800);
    expect(counts(p)).toEqual(withDelta(counts(p0), { 'core.mat.scrap': -4 }));
    expect(p.buildings).toEqual([{ guid: r.value.guid, buildingId: SHELF_B, x: 12, y: 20, rot: 0 }]);
    expect(p.store.containers[SHELF]).toMatchObject({ kind: 'grid', w: 6, h: 4, items: [] });
    expect(validateStore(p.store, content)).toEqual([]);

    const place = (id: string, x: number, y: number) => (d: ProfileState) => placeBuilding(d, content, SHELTER, id, x, y, 0);
    expectRefused(p, `build:${SHELF_B}:again`, place(SHELF_B, 14, 22), 'build.err.duplicate');
    expectRefused(p, `build:${MED_B}`, place(MED_B, 6, 28), 'build.err.locked');
    const unlocked = structuredClone(p);
    unlocked.flags['workbench_unlocked'] = true;
    expectRefused(unlocked, `build:${WB_B}`, place(WB_B, 11, 19), 'build.err.overlap');
    expectRefused(unlocked, `build:${WB_B}`, place(WB_B, 18, 20), 'build.err.bounds');
    expectRefused(unlocked, `build:${WB_B}`, place(WB_B, 5, 15), 'build.err.reserved');
    expectRefused(unlocked, `build:${WB_B}`, place(WB_B, 12.5, 24), 'build.err.grid');
  });

  it('the one-time free workbench module (Q06 reward) is granted once', () => {
    const p0 = fresh();
    p0.flags['workbench_unlocked'] = true;
    expect(buildingCost(p0, WB_B, content)).toEqual({ credits: 0, items: [] });
    const r = retryOnce(p0, `build:${WB_B}`, (d) => placeBuilding(d, content, SHELTER, WB_B, 12, 24, 0));
    expect(r.final.currency).toBe(p0.currency);
    expect(counts(r.final)).toEqual(counts(p0));
    expect(r.final.flags['free_workbench_used']).toBe(true);
    expect(buildingCost(r.final, WB_B, content)).toEqual(content.building(WB_B).cost);
    expectRefused(r.final, `build:${WB_B}:again`, (d) => placeBuilding(d, content, SHELTER, WB_B, 12, 27, 0), 'build.err.duplicate');
  });

  it('each facility upgrade is charged once and its effect is applied once', () => {
    let p = fresh();
    p.currency = 20_000;
    p.flags['facilities_unlocked'] = true;
    p.flags['workbench_unlocked'] = true;
    p.flags['medical_stock'] = true;
    const upgrade = (id: string) => (d: ProfileState) => upgradeFacility(d, content, id);

    // Stash expansion 12×10 → 12×14, 2,500cr.
    expect(p.store.containers[STASH]).toMatchObject({ w: 12, h: 10 });
    p = retryOnce(p, `facility:${STASH_F}`, upgrade(STASH_F)).final;
    expect(p.currency).toBe(20_000 - 2500);
    expect(p.store.containers[STASH]).toMatchObject({ w: 12, h: 14 });
    expect(stashHeight(p)).toBe(14);
    expectRefused(p, `facility:${STASH_F}:again`, upgrade(STASH_F), 'facility.err.done');

    // Workbench upgrade needs the module; ×1.25 craft speed, repair 40 → 50, 2,000cr.
    expectRefused(p, `facility:${WB_F}`, upgrade(WB_F), 'facility.err.building');
    p = mustApply(p, `build:${WB_B}`, (d) => placeBuilding(d, content, SHELTER, WB_B, 12, 24, 0)).next;
    expect([craftSpeed(p), recipeTime(p, content, 'core.recipe.repair_kit'), repairAmount(p)]).toEqual([1, 4, 40]);
    const beforeWb = p.currency;
    p = retryOnce(p, `facility:${WB_F}`, upgrade(WB_F)).final;
    expect(p.currency).toBe(beforeWb - 2000);
    expect([craftSpeed(p), recipeTime(p, content, 'core.recipe.repair_kit'), repairAmount(p)]).toEqual([1.25, 3.2, 50]);
    expectRefused(p, `facility:${WB_F}:again`, upgrade(WB_F), 'facility.err.done');

    // Medical upgrade needs the medical module; free basic heal, first aid 4s → 3s, 1,500cr.
    expectRefused(p, `facility:${MED_F}`, upgrade(MED_F), 'facility.err.building');
    grantItems(p, content, 'core.mat.cloth', 2, 'test:setup');
    grantItems(p, content, 'core.mat.antiseptic', 2, 'test:setup');
    p = mustApply(p, `build:${MED_B}`, (d) => placeBuilding(d, content, SHELTER, MED_B, 6, 28, 0)).next;
    const hurt = { ...p, playerHp: 40, playerBleeding: true };
    expect(healCost(hurt)).toBe(Math.ceil(60 * 3) + 30);
    expect(recipeTime(p, content, 'core.recipe.firstaid')).toBe(4);
    const beforeMed = p.currency;
    p = retryOnce(p, `facility:${MED_F}`, upgrade(MED_F)).final;
    expect(p.currency).toBe(beforeMed - 1500);
    expect(healCost({ ...p, playerHp: 40, playerBleeding: true })).toBe(0);
    expect(recipeTime(p, content, 'core.recipe.firstaid')).toBe(3);
    expectRefused(p, `facility:${MED_F}:again`, upgrade(MED_F), 'facility.err.done');

    expect(p.facilities).toEqual({ [STASH_F]: 1, [WB_F]: 1, [MED_F]: 1 });
    expect(p.store.containers[STASH]!.h).toBe(14);
  });

  it('after a JSON save/load round trip nothing is re-applied or re-charged and every effect is identical', async () => {
    let p = atLevel(5, 'a15-roundtrip');
    p.currency = 20_000;
    p.flags['facilities_unlocked'] = true;
    p.flags['workbench_unlocked'] = true;
    grantItems(p, content, 'core.mat.scrap', 4, 'test:setup');
    const ops: [string, (d: ProfileState) => unknown][] = [
      [`perk:${S1}`, (d) => unlockPerk(d, content, S1)],
      [`perk:${S2}`, (d) => unlockPerk(d, content, S2)],
      [`perk:${STEADY}`, (d) => unlockPerk(d, content, STEADY)],
      [`build:${SHELF_B}`, (d) => placeBuilding(d, content, SHELTER, SHELF_B, 12, 20, 0)],
      [`build:${WB_B}`, (d) => placeBuilding(d, content, SHELTER, WB_B, 12, 24, 0)],
      [`facility:${STASH_F}`, (d) => upgradeFacility(d, content, STASH_F)],
      [`facility:${WB_F}`, (d) => upgradeFacility(d, content, WB_F)],
    ];
    for (const [id, fn] of ops) p = mustApply(p, id, fn).next;
    const before = paidState(p);
    expect(before).toMatchObject({ currency: 20_000 - 800 - 2500 - 2000, perkPoints: 1, craftSpeed: 1.25, repairAmount: 50, stash: { w: 12, h: 14 }, shelf: { w: 6, h: 4 } });
    expect(before.perkEffects).toEqual({ staminaMax: 10, stabilizeMult: 0.85 });

    const loaded = roundTrip(p);
    expect(paidState(loaded)).toEqual(before);
    // Same ids after loading: all duplicates (the ledger is part of the save).
    for (const [id, fn] of ops) {
      const r = runTx(loaded, id, fn);
      expect(r.outcome).toEqual(DUP);
      expect(r.next).toBe(loaded);
    }
    // Fresh ids after loading: refused by the state itself, nothing charged.
    expect(ops.map(([id, fn]) => runTx(loaded, `${id}:after-load`, fn).outcome)).toEqual([
      refused('perk.err.owned'),
      refused('perk.err.owned'),
      refused('perk.err.owned'),
      refused('build.err.duplicate'),
      refused('build.err.duplicate'),
      refused('facility.err.done'),
      refused('facility.err.done'),
    ]);
    // Entering the shelter after a load runs these hooks; none of them may re-apply a paid effect.
    ensureContracts(loaded, content);
    ensureMarket(loaded, content);
    for (const t of content.traders.keys()) ensureTraderStock(loaded, content, t);
    refreshQuests(loaded, content);
    expect(addExp(loaded, 0)).toBe(0);
    expect(paidState(loaded)).toEqual(before);
    expect(paidState(roundTrip(roundTrip(loaded)))).toEqual(before);

    // The same holds for the real IndexedDB save path (normalize + quarantine on load).
    const store = new SaveStore(new IDBFactory(), 'a15-roundtrip');
    await store.open();
    await store.commit(p.slotId, structuredClone(p), null, 'a15:checkpoint');
    const lr = await store.load(p.slotId, content);
    if (!('profile' in lr)) throw new Error('load failed');
    expect(lr.quarantined).toBe(0);
    expect(paidState(lr.profile)).toEqual(before);
    store.close();
  });
});

// --- A18: notes, keys, quests, world flags ---------------------------------------------------------------------

describe('A18 notes', () => {
  it('found and read are independent per-note states; reading twice or finding again changes nothing', () => {
    const FARM = 'core.note.farm_diary';
    const PATROL = 'core.note.patrol_orders';
    const CHECK = 'core.note.checkpoint_log';
    let p = fresh('a18-notes');
    p.flags['deploy_allowed'] = true;
    expect(Object.keys(p.notes).sort()).toEqual([...content.notes.keys()].sort());
    expect(Object.keys(p.notes)).toHaveLength(8);
    for (const n of Object.values(p.notes)) expect(n).toEqual({ found: false, read: false });
    expectRefused(p, `noteread:${FARM}`, (d) => markNoteRead(d, FARM), 'note.err.unknown');

    // Raid 1: two notes picked up, one of them read on the spot.
    const r1 = raid(p, (sim) => {
      sim.progress.notesFound.push(FARM, PATROL);
      sim.progress.custom.push(`read:${FARM}`);
    });
    expect(r1.summary.notesFound).toEqual([FARM, PATROL]);
    p = r1.p;
    expect(p.notes[FARM]).toEqual({ found: true, read: true });
    expect(p.notes[PATROL]).toEqual({ found: true, read: false });
    for (const [id, n] of Object.entries(p.notes)) if (id !== FARM && id !== PATROL) expect(n).toEqual({ found: false, read: false });

    // Reading in the archive (UI id noteread:<noteId>) ×10.
    p = retryOnce(p, `noteread:${PATROL}`, (d) => markNoteRead(d, PATROL)).final;
    expect(p.notes[PATROL]).toEqual({ found: true, read: true });
    const readState = structuredClone(p.notes);
    expect(mustApply(p, `noteread:${PATROL}:again`, (d) => markNoteRead(d, PATROL)).next.notes).toEqual(readState);

    // Raid 2: an already found note is found again, a new one is found but not read.
    const r2 = raid(p, (sim) => sim.progress.notesFound.push(FARM, CHECK));
    expect(r2.summary.notesFound).toEqual([CHECK]);
    p = r2.p;
    expect(p.notes[FARM]).toEqual({ found: true, read: true });
    expect(p.notes[PATROL]).toEqual({ found: true, read: true });
    expect(p.notes[CHECK]).toEqual({ found: true, read: false });
    expect(roundTrip(p).notes).toEqual(p.notes);
    const next = mustApply(p, `deploy:1:${p.raidCounter + 1}`, (d) => prepareDeploy(d, content, DEST_MAIN, NOW)).value;
    expect([...next.notesKnown].sort()).toEqual([CHECK, FARM, PATROL].sort());
  });
});

describe('A18 keys', () => {
  it('registering the same key twice consumes the key item once and grants the access right once', () => {
    const KEY = 'core.key.farm_backroom';
    const KEY_ITEM = 'core.keyitem.farm_backroom';
    const p0 = fresh('a18-keys');
    p0.flags['deploy_allowed'] = true;

    // Control: without the access right the raid places the key item in its container.
    const control = mustApply(structuredClone(p0), 'deploy:1:1', (d) => prepareDeploy(d, content, DEST_MAIN, NOW)).value;
    expect(Object.values(createRaidSim(content, control).sim.store.items).filter((i) => i.definitionId === KEY_ITEM)).toHaveLength(1);

    const [copy1] = grantItems(p0, content, KEY_ITEM, 1, 'test:loot');
    const r = retryOnce(p0, `key:${KEY}`, (d) => registerKey(d, content, copy1!, `key:${KEY}`));
    expect(r.value).toEqual({ keyId: KEY, consumed: true });
    expect(r.final.keys.registered).toEqual([KEY]);
    expect(r.final.store.items[copy1!]).toBeUndefined();
    expect(countDef(r.final.store, KEY_ITEM)).toBe(0);

    // Access in the next raid: one right, the door opens without carrying the key, no new key item is placed.
    const launch = mustApply(r.final, 'deploy:1:1', (d) => prepareDeploy(d, content, DEST_MAIN, NOW)).value;
    expect(launch.registeredKeys).toEqual([KEY]);
    expect(launch.keyItemsHeld).toEqual([]);
    const { sim, ctx } = createRaidSim(content, launch);
    expect(sim.registeredKeys).toEqual([KEY]);
    expect(hasKey(ctx, sim.actors.find((a) => a.kind === 'player')!, KEY)).toBe(true);
    expect(Object.values(sim.store.items).filter((i) => i.definitionId === KEY_ITEM)).toHaveLength(0);

    // A second physical copy found later: under the UI id it is a duplicate; under any other id it is not
    // consumed and no second access right appears.
    const later = structuredClone(r.final);
    const [copy2] = grantItems(later, content, KEY_ITEM, 1, 'test:loot');
    expect(runTx(later, `key:${KEY}`, (d) => registerKey(d, content, copy2!, `key:${KEY}`)).outcome).toEqual(DUP);
    const second = mustApply(later, `key:${KEY}:copy2`, (d) => registerKey(d, content, copy2!, `key:${KEY}:copy2`));
    expect(second.value).toEqual({ keyId: KEY, consumed: false });
    expect(second.next.keys.registered).toEqual([KEY]);
    expect(second.next.store.items[copy2!]).toBeDefined();
    expect(countDef(second.next.store, KEY_ITEM)).toBe(1);
    expect(second.next.itemLog.filter((e) => e.reason === 'key-registered')).toHaveLength(1);

    const loaded = roundTrip(second.next);
    expect(loaded.keys.registered).toEqual([KEY]);
    expect(runTx(loaded, `key:${KEY}`, (d) => registerKey(d, content, copy2!, `key:${KEY}`)).outcome).toEqual(DUP);
  });
});

describe('A18 quests', () => {
  it('delivering and turning in the same quest twice pays every reward once', () => {
    let p = q02AwaitingDelivery('a18-quest');
    grantItems(p, content, RELIEF_PKG, 2, 'test:extracted'); // one to submit, one spare
    const d1 = mustApply(p, `deliver:${MEDIC_NPC}:n1`, (d) => deliverToNpc(d, content, MEDIC_NPC));
    expect(d1.value).toEqual([{ questId: Q02, itemId: RELIEF_PKG, qty: 1 }]);
    expect(d1.next.quests[Q02]!.status).toBe('ready');
    expect(countDef(d1.next.store, RELIEF_PKG)).toBe(1);
    // A second delivery (the UI uses a new nonce) submits and consumes nothing.
    const d2 = mustApply(d1.next, `deliver:${MEDIC_NPC}:n2`, (d) => deliverToNpc(d, content, MEDIC_NPC));
    expect(d2.value).toEqual([]);
    expect(d2.next.quests).toEqual(d1.next.quests);
    expect(counts(d2.next)).toEqual(counts(d1.next));
    p = d2.next;

    const txId = `quest:${Q02}:complete`;
    const turnIn = (d: ProfileState) => turnInQuest(d, content, Q02, txId);
    const r = retryOnce(p, txId, turnIn);
    const done = r.final;
    expect(done.quests[Q02]!.status).toBe('completed');
    expect(done.currency).toBe(p.currency + 600);
    expect(done.exp).toBe(p.exp + 250);
    expect(done.flags['medical_stock']).toBe(true);
    expect(done.traders['core.trader.medic']!.trust).toBe(p.traders['core.trader.medic']!.trust + 80);
    expect(counts(done)).toEqual(withDelta(counts(p), { 'core.med.firstaid': 1 }));
    expectRefused(done, `${txId}:again`, turnIn, 'quest.err.not_ready');

    // Objective events, deliveries and refreshes after completion change nothing at all.
    const snapshot = structuredClone(done);
    const q = structuredClone(done);
    const changed = [
      ...applyQuestEvent(q, content, { type: 'Retrieve', itemId: RELIEF_PKG }),
      ...applyQuestEvent(q, content, { type: 'ExtractWith', itemId: RELIEF_PKG, qty: 1, mapId: MAIN_MAP }),
      ...deliverToNpc(q, content, MEDIC_NPC).map((x) => x.questId),
      ...refreshQuests(q, content),
      ...refreshQuests(q, content),
    ];
    expect(changed).toEqual([]);
    expect(q).toEqual(snapshot);

    const loaded = roundTrip(done);
    expect(runTx(loaded, txId, turnIn).outcome).toEqual(DUP);
    expectRefused(loaded, `${txId}:after-load`, turnIn, 'quest.err.not_ready');
  });

  it('Q01 no longer asks for a walk to the shelter hall; old saves carrying that progress key still work', () => {
    const q01 = content.quest(Q01);
    expect(q01.objectives.map((o) => o.id)).toEqual(['talk', 'reload']);
    expect(SHELTER.pois.some((poi) => poi.id === 'poi.shelter_hall')).toBe(false);
    // A save from before the change: hall visited or not, talk + reload done → ready after load.
    for (const move of [0, 1]) {
      const p = fresh(`q01-compat-${move}`);
      p.quests[Q01] = { status: 'active', progress: { move, talk: 1, reload: 1 } };
      const loaded = roundTrip(p);
      refreshQuests(loaded, content);
      expect(loaded.quests[Q01]!.status, `move=${move}`).toBe('ready');
    }
    // …and the removed objective alone never makes it ready.
    const p = fresh('q01-compat-partial');
    p.quests[Q01] = { status: 'active', progress: { move: 1, talk: 1 } };
    refreshQuests(p, content);
    expect(p.quests[Q01]!.status).toBe('active');
  });
});

describe('A18 world flags', () => {
  it('setting a flag twice is idempotent (including chapter completion)', () => {
    const p = fresh();
    setFlag(p, 'some_flag');
    const once = structuredClone(p);
    setFlag(p, 'some_flag');
    expect(p).toEqual(once);
    setFlag(p, 'chapter1_complete');
    expect(p.chapter.completed).toBe(true);
    const done = structuredClone(p);
    setFlag(p, 'chapter1_complete');
    expect(p).toEqual(done);
  });

  it('WorldFlag objectives resolve once and the Q07 completion rewards are paid once', () => {
    let q = fresh('a18-q07');
    for (const id of [Q01, Q02, 'core.quest.q03_remember_road', 'core.quest.q06_scrap']) q.quests[id] = { status: 'completed', progress: {} };
    q.flags['deploy_allowed'] = true;
    q.flags['workbench_unlocked'] = true;
    refreshQuests(q, content);
    expect(q.quests[Q07]!.status).toBe('active');

    // Build the power & comms module → WorldFlag building:core.building.power_comms.
    grantItems(q, content, 'core.mat.wire', 2, 'test:setup');
    grantItems(q, content, 'core.mat.scrap', 4, 'test:setup');
    q = retryOnce(q, `build:${POWER_B}`, (d) => placeBuilding(d, content, SHELTER, POWER_B, 15, 28, 0)).final;
    expect(q.flags[`building:${POWER_B}`]).toBe(true);
    refreshQuests(q, content);
    expect(q.quests[Q07]!.progress['build']).toBe(1);
    const quests = structuredClone(q.quests);
    for (let i = 0; i < 5; i++) {
      setFlag(q, `building:${POWER_B}`);
      refreshQuests(q, content);
    }
    expect(q.quests).toEqual(quests);

    // Restore the generator ×10 → flag once, relay module consumed once, objective set once.
    grantItems(q, content, 'core.quest.relay_module', 1, 'test:craft');
    const beforeRestore = counts(q);
    q = retryOnce(q, 'generator:restore', (d) => restoreGenerator(d, content, 'generator:restore')).final;
    expect(q.flags['generator_restored']).toBe(true);
    expect(q.quests[Q07]!.progress['restore']).toBe(1);
    expect(counts(q)).toEqual(withDelta(beforeRestore, { 'core.quest.relay_module': -1 }));
    expectRefused(q, 'generator:restore:again', (d) => restoreGenerator(d, content, 'generator:restore:again'), 'gen.err.done');

    applyQuestEvent(q, content, { type: 'ExtractWith', itemId: 'core.mat.power_unit', qty: 1, mapId: MAIN_MAP });
    applyQuestEvent(q, content, { type: 'Craft', recipeId: 'core.recipe.relay_module' });
    expect(q.quests[Q07]!.status).toBe('ready');

    const txId = `quest:${Q07}:complete`;
    const t = retryOnce(q, txId, (d) => turnInQuest(d, content, Q07, txId));
    const done = t.final;
    expect(done.currency).toBe(q.currency + 800);
    expect(done.exp).toBe(q.exp + 700);
    expect(t.value.levelUps).toBe(1);
    expect(done.perkPoints).toBe(q.perkPoints + 1 + 1); // reward point + level-up point
    for (const f of ['power_restored', 'facilities_unlocked', 'ap_stock', 'black_market_unlocked']) expect(done.flags[f]).toBe(true);
    expect(done.traders['core.trader.comms']!.trust).toBe(q.traders['core.trader.comms']!.trust + 150);
    expect(done.traders['core.trader.mechanic']!.trust).toBe(q.traders['core.trader.mechanic']!.trust + 60);

    // Raising the same flags / events again after completion changes nothing.
    const again = structuredClone(done);
    for (const f of ['generator_restored', 'power_restored', `building:${POWER_B}`, 'black_market_unlocked']) setFlag(again, f);
    applyQuestEvent(again, content, { type: 'Custom', target: 'generator_restored', amount: 1 });
    refreshQuests(again, content);
    expect(again).toEqual(done);
    expect(roundTrip(done).quests).toEqual(done.quests);
  });
});
