/**
 * Stage 4 — Expansion Hardening.
 *   (1) A data-only extension pack (weapon ×2 incl. its own magazine family, ammo, bag, perk, building, contract template,
 *       region via mapPatches) registers through createContent([pack]) with no core change and is usable through the
 *       normal pipelines.
 *   (2) Old save migration (legacy v0 record, older v1 record missing later fields).
 *   (3) Missing-content quarantine when the pack disappears, and restoration when it comes back.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { requestReload } from '../src/combat/reload';
import { createContent } from '../src/content/core';
import type { MapDef } from '../src/content/mapTypes';
import type { ContentPack, ContentRegistry } from '../src/content/registry';
import type { BuildingDef, ContractTemplateDef, ItemDef, PerkDef, RegionDef } from '../src/content/types';
import { runTx } from '../src/core/tx';
import type { IdCounterState } from '../src/core/ids';
import { buildingObstacles, placeBuilding, validatePlacement } from '../src/economy/buildings';
import { ProfileService } from '../src/game/profileService';
import { attachChild, bagContainerId, countDef, instantiate, moveItem, placeNew, validateStore, type ItemInstance, type ItemStore } from '../src/inventory/store';
import { equipProfileItem, fillMagazine, loadWeapon, perkBlocker, unlockPerk } from '../src/progression/actions';
import { acceptContract, contractPossible, deliverContract, ensureContracts, turnInContract } from '../src/progression/contracts';
import { aggregatePerks, grantItems, homeContainers, INCOMING, newProfile, STASH, type ProfileState } from '../src/progression/profile';
import { prepareDeploy } from '../src/progression/raidFlow';
import { checksum } from '../src/save/checksum';
import { DB_VERSION, SaveStore, type LoadFailure, type LoadResult, type PointerRow, type RecordRow } from '../src/save/saveStore';
import { checkProfileShape, migrateProfile, normalizeProfile, raidContentErrors, referenceErrors, restoreQuarantined } from '../src/save/schema';
import { makeContext, type SimContext } from '../src/world/context';
import { WorldGeometry } from '../src/world/geometry';
import { createBaseSim } from '../src/world/range';
import { createRaidSim, emptySim, ensureEquipContainers, newActor } from '../src/world/spawn';
import { eqContainerId, type SimState } from '../src/world/state';
import { aimCmd, arena, bagOf, equip, settle, target, tick, type TestWorld } from './helpers';

const T0 = 1_700_000_000_000;
const QM = 'core.map.quarantine_main';
const DEST = 'core.dest.quarantine_main';

// --- the extension pack (pure data) -------------------------------------------------------------------------------

const STR: Record<string, string> = {};
const S = (key: string, text: string): string => {
  STR[key] = text;
  return key;
};

/** New rifle: new id, existing 5.56 caliber, reuses the core AR556 magazine family. */
const EXT_RIFLE: ItemDef = {
  id: 'ext.weapon.tr556',
  kind: 'weapon',
  nameKey: S('ext.weapon.tr556.name', 'TR556 시험형 소총'),
  descKey: S('ext.weapon.tr556.desc', '확장 팩 시험용 5.56 소총. AR556 탄창을 그대로 쓴다.'),
  size: { w: 4, h: 2 },
  stackMax: 1,
  weightKg: 3.1,
  basePrice: 4200,
  tags: ['rifle', 'assault', 'automatic', 'class:ar', 'cal:556'],
  icon: 'weapon:ar556',
  weapon: {
    class: 'ar',
    caliber: '556',
    damage: 33,
    pellets: 1,
    rpm: 600,
    magazineFamily: 'ar556',
    capacity: 30,
    reloadTactical: 2.2,
    reloadEmpty: 2.7,
    effectiveRange: 20,
    maxRange: 40,
    minRangeFactor: 0.5,
    modes: ['auto', 'semi'],
    precisionSpreadDeg: 0.4,
    recoilDeg: 1.0,
    stabilizeSec: 0.22,
    adsMove: 0.83,
    muzzleVelocity: 180,
    bloomPerShot: 0.16,
    gunshotRadius: 60,
    attachmentSlots: ['muzzle', 'grip', 'stock'],
    muzzleLength: 0.95,
    equipTime: 0.6,
    soundProfile: 'ar556',
  },
  dismantle: [
    { itemId: 'core.mat.scrap', qty: 2 },
    { itemId: 'core.mat.part', qty: 1 },
  ],
};

/** New pistol that ships its own magazine family and magazine definition. */
const EXT_PISTOL: ItemDef = {
  id: 'ext.weapon.tp9',
  kind: 'weapon',
  nameKey: S('ext.weapon.tp9.name', 'TP9 시험형 권총'),
  descKey: S('ext.weapon.tp9.desc', '전용 12발 탄창을 쓰는 9mm 시험 권총.'),
  size: { w: 2, h: 2 },
  stackMax: 1,
  weightKg: 0.9,
  basePrice: 1200,
  tags: ['pistol', 'sidearm', 'class:pistol', 'cal:9'],
  icon: 'weapon:p9',
  weapon: {
    class: 'pistol',
    caliber: '9',
    damage: 27,
    pellets: 1,
    rpm: 400,
    magazineFamily: 'ext_tp9',
    capacity: 12,
    reloadTactical: 1.5,
    reloadEmpty: 1.9,
    effectiveRange: 10,
    maxRange: 22,
    minRangeFactor: 0.4,
    modes: ['semi'],
    precisionSpreadDeg: 0.7,
    recoilDeg: 1.1,
    stabilizeSec: 0.13,
    adsMove: 0.95,
    muzzleVelocity: 100,
    bloomPerShot: 0.12,
    gunshotRadius: 30,
    attachmentSlots: ['muzzle'],
    muzzleLength: 0.55,
    equipTime: 0.35,
    soundProfile: 'p9',
  },
};

const EXT_MAG: ItemDef = {
  id: 'ext.mag.tp9',
  kind: 'magazine',
  nameKey: S('ext.mag.tp9.name', 'TP9 탄창 (12발)'),
  descKey: S('ext.mag.tp9.desc', 'TP9 전용 9mm 탄창.'),
  size: { w: 1, h: 2 },
  stackMax: 1,
  weightKg: 0.12,
  basePrice: 70,
  tags: ['cal:9', 'family:ext_tp9'],
  icon: 'mag:p9',
  magazine: { family: 'ext_tp9', caliber: '9', capacity: 12, reloadMult: 1 },
};

const EXT_AMMO: ItemDef = {
  id: 'ext.ammo.556.match',
  kind: 'ammo',
  nameKey: S('ext.ammo.556.match.name', '5.56 시합탄'),
  descKey: S('ext.ammo.556.match.desc', '정밀하게 만든 5.56 탄. 살상력이 10% 높다.'),
  size: { w: 1, h: 1 },
  stackMax: 60,
  weightKg: 0,
  unitWeightKg: 0.012,
  basePrice: 12,
  tags: ['cal:556', 'ammo:fmj'],
  icon: 'ammo:fmj',
  ammo: { caliber: '556', variant: 'fmj', fleshMult: 1.1, penetration: 32, armorDamage: 1.0, envEnergy: 22, headMult: 2.0, bleedChance: 0, tracer: 0xffe08a },
};

const EXT_BAG: ItemDef = {
  id: 'ext.bag.crate',
  kind: 'backpack',
  nameKey: S('ext.bag.crate.name', '시험용 보급 가방'),
  descKey: S('ext.bag.crate.desc', '5×4 칸의 확장 팩 가방.'),
  size: { w: 3, h: 3 },
  stackMax: 1,
  weightKg: 1.0,
  basePrice: 800,
  tags: ['backpack'],
  icon: 'backpack:crate',
  backpack: { w: 5, h: 4 },
};

const EXT_PERK: PerkDef = {
  id: 'ext.perk.marksman',
  line: 'combat',
  nameKey: S('ext.perk.marksman', '시험 사수'),
  descKey: S('ext.perk.marksman.d', '장전 시간 -10%, 정상 중량 +4kg'),
  level: 2,
  cost: 1,
  requires: ['core.perk.combat.steady'],
  effects: { reloadMult: 0.9, carryKg: 4 },
};

const EXT_BUILDING: BuildingDef = {
  id: 'ext.building.locker',
  nameKey: S('ext.building.locker', '시험 보관함'),
  descKey: S('ext.building.locker.d', '확장 팩 시험용 2×2 건물.'),
  footprint: { w: 2, h: 2 },
  cost: { credits: 500, items: [{ itemId: 'core.mat.scrap', qty: 2 }] },
  unlockFlag: 'ext.bunker_cleared',
  effects: ['ext:locker'],
  sprite: 'ext_locker',
  solid: true,
};

const EXT_CONTRACT: ContractTemplateDef = {
  id: 'ext.contract.courier',
  nameKey: S('ext.contract.courier', '시험 배달'),
  descKey: S('ext.contract.courier.d', '{npc}에게 {item} {count}개를 전달한다.'),
  type: 'supply',
  giver: 'core.npc.medic',
  minLevel: 1,
  rewardCredits: [500, 520],
  rewardExp: [100, 110],
  trust: 20,
};

const EXT_REGION: RegionDef = {
  id: 'ext.region.bunker',
  nameKey: S('ext.region.bunker', '시험 벙커'),
  rects: [{ x: 26, y: 34, w: 8, h: 6 }],
  ambience: 'industrial',
  lootTier: 2,
};
const POI_KEY = S('ext.poi.bunker', '시험 벙커 입구');
const CACHE_ID = 'ext.bunker_cache';

const EXT_PACK: ContentPack = {
  id: 'test.ext',
  version: '0.1.0',
  items: [EXT_RIFLE, EXT_PISTOL, EXT_MAG, EXT_AMMO, EXT_BAG],
  perks: [EXT_PERK],
  buildings: [EXT_BUILDING],
  contracts: [EXT_CONTRACT],
  strings: STR,
  mapPatches: [
    {
      mapId: QM,
      apply: (m: MapDef) => {
        // WorldGeometry.regionAt is first-match and the core regions tile the whole map, so a sub-region goes first.
        m.regions.unshift(EXT_REGION);
        m.pois.push({ id: 'ext.poi.bunker', nameKey: POI_KEY, x: 30, y: 37, radius: 3, kind: 'landmark' });
        m.containers.push({ id: CACHE_ID, type: 'core.ct.supply', x: 30, y: 37, lootTable: 'core.loot.military', keyId: null, guaranteed: [{ itemId: EXT_AMMO.id, qty: 30 }] });
        m.obstacles.push({ id: `prop:${CACHE_ID}`, profile: 'core.ob.crate_metal', x0: 29.3, y0: 36.5, x1: 30.7, y1: 37.5, z0: 0, z1: 1.0, floor: 0 });
      },
    },
  ],
};

const core = createContent();
const ext = createContent([EXT_PACK]);

// --- helpers ------------------------------------------------------------------------------------------------------

function put(p: ProfileState, c: ContentRegistry, defId: string, containerId: string, qty = 1): ItemInstance {
  const it = instantiate(c, p.ids, defId, { quantity: qty });
  it.quantity = qty;
  const r = placeNew(p.store, c, it, { containerId });
  if (!r.ok) throw new Error(`put ${defId} → ${containerId}: ${r.error}`);
  return it;
}

/** Attach a filled magazine to a weapon and chamber one round (like a shelter load). */
function loadInto(store: ItemStore, c: ContentRegistry, ids: IdCounterState, weapon: ItemInstance, magDefId: string, ammoId: string, rounds: number): ItemInstance {
  const mag = instantiate(c, ids, magDefId);
  mag.mag!.rounds = Array.from({ length: rounds }, () => ammoId);
  store.items[mag.instanceId] = mag;
  attachChild(store, weapon.instanceId, mag.instanceId, { magazine: true });
  weapon.weapon!.chamber = mag.mag!.rounds.pop()!;
  return mag;
}

const ARENA = arena('test.ext.arena', 40, 12);

/** Same as helpers.world() but with the extension pack registered next to the arena map. */
function extWorld(px = 2, py = 3): TestWorld {
  const content = createContent([EXT_PACK, { id: 'test.ext.arena', version: '0', maps: [ARENA] }]);
  const sim = emptySim('raid', 'ext-raid', ARENA.id, 'seed-ext', 'Day', 'Clear');
  const geo = new WorldGeometry(ARENA, content);
  const ctx = makeContext(sim, content, geo);
  const pl = newActor('player', 'player', px, py, 100, 'player');
  sim.actors.push(pl);
  ensureEquipContainers(sim.store, 'player');
  const bag = instantiate(content, sim.ids, 'core.bag.basic');
  placeNew(sim.store, content, bag, { containerId: eqContainerId('player', 'backpack') });
  return { content, ctx, player: pl };
}

function shootOnce(t: TestWorld, x: number, y: number, z: number, targetId: string): void {
  tick(t, aimCmd(x, y, z, {}, targetId));
  tick(t, aimCmd(x, y, z, { firePressed: true, fireHeld: true }, targetId));
  settle(t, 120, aimCmd(x, y, z, {}, targetId));
}

// fake-indexeddb environment (one isolated database per test)
interface Env {
  factory: IDBFactory;
  name: string;
  store: SaveStore;
}
let dbSeq = 0;
async function freshEnv(): Promise<Env> {
  const factory = new IDBFactory();
  const name = `stage4-${++dbSeq}`;
  const store = new SaveStore(factory, name);
  await store.open();
  return { factory, name, store };
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

async function dumpDb(env: Env): Promise<unknown[]> {
  const db = await reqP(env.factory.open(env.name, DB_VERSION));
  try {
    const t = db.transaction(['records', 'pointers', 'journal', 'meta'], 'readonly');
    return await Promise.all(['records', 'pointers', 'journal', 'meta'].map((s) => reqP(t.objectStore(s).getAll())));
  } finally {
    db.close();
  }
}

/** Store an arbitrary (e.g. legacy) profile payload as the current record of a slot, bypassing SaveStore.commit. */
async function writeRawSlot(env: Env, slotId: number, payloadObject: unknown): Promise<void> {
  const payload = JSON.stringify(payloadObject);
  const db = await reqP(env.factory.open(env.name, DB_VERSION));
  try {
    const t = db.transaction(['records', 'pointers'], 'readwrite');
    const record: RecordRow = { recordId: `${slotId}:p:1`, slotId, kind: 'profile', seq: 1, createdAt: T0, checksum: checksum(payload), payload };
    const pointer: PointerRow = { slotId, seq: 1, profile: record.recordId, raid: null, backups: [], raidBackups: [], updatedAt: T0, summary: null };
    t.objectStore('records').put(record);
    t.objectStore('pointers').put(pointer);
    await txDone(t);
  } finally {
    db.close();
  }
}

function expectLoaded(r: LoadResult | LoadFailure): LoadResult {
  expect('kind' in r ? r : 'loaded').toBe('loaded');
  return r as LoadResult;
}

function persisted(p: ProfileState): ProfileState {
  return JSON.parse(JSON.stringify(p)) as ProfileState;
}

// --- (1) data-only extension pack --------------------------------------------------------------------------------

describe('Stage 4 (1) — data-only extension pack registered through createContent([pack])', () => {
  it('registers with no duplicates; every lookup, cross reference and string resolves; the cached core registry is untouched', () => {
    expect(ext.duplicates).toEqual([]);
    expect(ext.packs).toEqual([...core.packs, 'test.ext@0.1.0']);
    for (const d of EXT_PACK.items!) {
      expect(ext.item(d.id)).toBe(d);
      expect(core.hasItem(d.id)).toBe(false);
      expect(ext.t(d.nameKey)).toBe(STR[d.nameKey]);
      expect(ext.has(d.descKey), d.descKey).toBe(true);
    }
    expect(ext.perk(EXT_PERK.id)).toBe(EXT_PERK);
    expect(ext.building(EXT_BUILDING.id)).toBe(EXT_BUILDING);
    expect(ext.contract(EXT_CONTRACT.id)).toBe(EXT_CONTRACT);
    for (const k of [EXT_PERK.nameKey, EXT_PERK.descKey, EXT_BUILDING.nameKey, EXT_BUILDING.descKey, EXT_CONTRACT.nameKey, EXT_CONTRACT.descKey, EXT_REGION.nameKey, POI_KEY]) expect(ext.has(k), k).toBe(true);

    // Cross references resolve in the merged registry (magazine families by data, prerequisites, giver, costs).
    const mags = (w: ItemDef) => [...ext.items.values()].filter((d) => d.magazine?.family === w.weapon!.magazineFamily && d.magazine.caliber === w.weapon!.caliber);
    expect(mags(EXT_RIFLE).map((d) => d.id)).toContain('core.mag.ar556');
    expect(mags(EXT_PISTOL).map((d) => d.id)).toEqual([EXT_MAG.id]);
    expect(EXT_PERK.requires.every((r) => ext.perks.has(r))).toBe(true);
    expect(ext.npcs.has(EXT_CONTRACT.giver)).toBe(true);
    expect(EXT_BUILDING.cost.items.every((c) => ext.hasItem(c.itemId))).toBe(true);

    // Core + pack, nothing lost or replaced.
    expect(ext.items.size).toBe(core.items.size + EXT_PACK.items!.length);
    expect(ext.perks.size).toBe(core.perks.size + 1);
    expect(ext.buildings.size).toBe(core.buildings.size + 1);
    expect(ext.contracts.size).toBe(core.contracts.size + 1);
    expect(ext.maps.size).toBe(core.maps.size);

    // The map patch is applied once, to this registry's own map instance.
    const qm = ext.map(QM);
    expect(qm).not.toBe(core.map(QM));
    expect(qm.regions.filter((r) => r.id === EXT_REGION.id)).toHaveLength(1);
    expect(qm.containers.filter((c) => c.id === CACHE_ID)).toHaveLength(1);
    expect(core.map(QM).regions.some((r) => r.id === EXT_REGION.id)).toBe(false);
    expect(core.map(QM).containers.some((c) => c.id === CACHE_ID)).toBe(false);
    expect(createContent([EXT_PACK]).map(QM).regions.filter((r) => r.id === EXT_REGION.id)).toHaveLength(1);
    expect(createContent()).toBe(core);
  });

  it('the registry reports id collisions and patches for unknown maps instead of failing silently', () => {
    const bad = createContent([{ id: 'test.bad', version: '0', items: [{ ...EXT_RIFLE, id: 'core.weapon.ar556' }], mapPatches: [{ mapId: 'ext.map.nowhere', apply: () => undefined }] }]);
    expect(bad.duplicates).toEqual(['item:core.weapon.ar556', 'mapPatch:missing:ext.map.nowhere']);
  });

  it('the pack rifle fires and damages a target through the normal firing pipeline (core FMJ and pack ammo)', () => {
    const cases = [
      ['core.ammo.556.fmj', 'body', 1.0, 33],
      ['core.ammo.556.fmj', 'head', 1.6, 66],
      [EXT_AMMO.id, 'body', 1.0, 33 * 1.1],
    ] as const;
    for (const [ammo, part, z, expected] of cases) {
      const t = extWorld(2, 3);
      t.ctx.sim.debug.noSpread = true;
      const wid = equip(t, EXT_RIFLE.id, ammo);
      expect(t.ctx.sim.store.items[wid]!.definitionId).toBe(EXT_RIFLE.id);
      const tg = target(t, 10, 3, { hp: 1000 });
      shootOnce(t, 10, 3, z, tg.id);
      expect(1000 - tg.hp).toBeCloseTo(expected, 6);
      expect(t.ctx.sim.shotLog).toHaveLength(1);
      expect(t.ctx.sim.shotLog[0]).toMatchObject({ weaponId: EXT_RIFLE.id, ammoId: ammo, firstHit: `actor:${tg.id}`, part });
      expect(validateStore(t.ctx.sim.store, t.content)).toEqual([]);
    }
  });

  it('a pack weapon with its own magazine family fires and reloads in a raid world, with the pack perk applied to the reload', () => {
    const t = extWorld(2, 3);
    const sim = t.ctx.sim;
    sim.debug.noSpread = true;
    const w = instantiate(t.content, sim.ids, EXT_PISTOL.id);
    expect(placeNew(sim.store, t.content, w, { containerId: eqContainerId('player', 'secondary') })).toEqual({ ok: true });
    t.player.activeSlot = 'secondary';
    loadInto(sim.store, t.content, sim.ids, w, EXT_MAG.id, 'core.ammo.9.fmj', 6); // 5 in the magazine + 1 chambered
    const spare = instantiate(t.content, sim.ids, EXT_MAG.id);
    spare.mag!.rounds = Array.from({ length: 12 }, () => 'core.ammo.9.fmj');
    expect(placeNew(sim.store, t.content, spare, { containerId: bagOf(t) })).toEqual({ ok: true });

    const tg = target(t, 8, 3, { hp: 1000 });
    shootOnce(t, 8, 3, 1.0, tg.id);
    expect(1000 - tg.hp).toBeCloseTo(27, 6);
    expect(sim.shotLog[0]).toMatchObject({ weaponId: EXT_PISTOL.id, part: 'body' });

    sim.perks = aggregatePerks(t.content, ['core.perk.combat.steady', EXT_PERK.id]);
    expect(requestReload(t.ctx, t.player, false)).toBe('started');
    expect(t.player.action?.duration).toBeCloseTo(EXT_PISTOL.weapon!.reloadTactical * 0.9, 6);
    tick(t, aimCmd(8, 3, 1.0), 60 * 2);
    const wi = sim.store.items[w.instanceId]!;
    expect(wi.weapon!.magazineId).toBe(spare.instanceId);
    expect(wi.weapon!.chamber).toBe('core.ammo.9.fmj');
    expect(validateStore(sim.store, t.content)).toEqual([]);
  });

  it('shelter actions fill and load the pack magazine into the pack pistol by family, and refuse other families', () => {
    const p = newProfile(ext, 1, 'Loader', 'loader-seed', T0);
    const pistol = put(p, ext, EXT_PISTOL.id, STASH);
    const mag = put(p, ext, EXT_MAG.id, STASH);
    expect(fillMagazine(p, ext, mag.instanceId, 'core.ammo.9.fmj')).toBe(12);
    loadWeapon(p, ext, pistol.instanceId, mag.instanceId);
    expect(p.store.items[pistol.instanceId]!.weapon).toMatchObject({ magazineId: mag.instanceId, chamber: 'core.ammo.9.fmj' });
    expect(p.store.items[mag.instanceId]!.mag!.rounds).toHaveLength(11);
    const coreMag = put(p, ext, 'core.mag.p9', STASH);
    expect(runTx(p, 'load:wrong-family', (d) => loadWeapon(d, ext, pistol.instanceId, coreMag.instanceId)).outcome).toEqual({ ok: false, applied: false, reason: 'inv.err.incompatible' });
    expect(validateStore(p.store, ext)).toEqual([]);
  });

  function rent(defId: string): { ctx: SimContext | null; error: string | null } {
    try {
      return { ctx: createBaseSim(ext, { seed: 'range', flags: {}, perks: {}, weaponDefId: defId, extraObstacles: [] }), error: null };
    } catch (e) {
      return { ctx: null, error: String(e) };
    }
  }

  it('the shooting-range rental rack issues the pack rifle loaded with a shared-family magazine', () => {
    const r = rent(EXT_RIFLE.id);
    expect(r.error).toBeNull();
    const sim = r.ctx!.sim;
    const w = sim.store.items[sim.store.containers[eqContainerId('player', 'primary1')]!.items[0]!]!;
    expect(w.definitionId).toBe(EXT_RIFLE.id);
    expect(ext.item(sim.store.items[w.weapon!.magazineId!]!.definitionId).magazine!.family).toBe('ar556');
    expect(w.weapon!.chamber).toBe('core.ammo.556.fmj');
    expect(validateStore(sim.store, ext)).toEqual([]);
  });

  it('the shooting-range rental rack issues a pack weapon that ships its own magazine family', () => {
    // The rack lists every registered weapon (ui/panels.ts) and App.enterBase re-issues profile.rangeWeapon on every
    // shelter entry, so this must work for pack weapons with pack magazines.
    const r = rent(EXT_PISTOL.id);
    expect(r.error).toBeNull();
    const sim = r.ctx!.sim;
    const w = sim.store.items[sim.store.containers[eqContainerId('player', 'secondary')]!.items[0]!]!;
    expect(w.definitionId).toBe(EXT_PISTOL.id);
    expect(sim.store.items[w.weapon!.magazineId!]!.definitionId).toBe(EXT_MAG.id);
    expect(w.weapon!.chamber).toBe('core.ammo.9.fmj');
  });

  it('the pack perk unlocks through unlockPerk once its requirements are met; aggregatePerks and the raid launch carry its effect', () => {
    let p = newProfile(ext, 1, 'Perk', 'perk-seed', T0);
    const attempt = (s: ProfileState, id: string) => runTx(s, `perk:${id}:${s.perks.length}:${s.perkPoints}:${s.level}`, (d) => unlockPerk(d, ext, id));
    expect(attempt(p, EXT_PERK.id).outcome).toEqual({ ok: false, applied: false, reason: 'perk.err.level' });
    p.level = 3;
    expect(attempt(p, EXT_PERK.id).outcome).toEqual({ ok: false, applied: false, reason: 'perk.err.requires' });
    p.perkPoints = 1;
    const a = attempt(p, 'core.perk.combat.steady');
    expect(a.outcome).toMatchObject({ ok: true, applied: true });
    p = a.next;
    expect(attempt(p, EXT_PERK.id).outcome).toEqual({ ok: false, applied: false, reason: 'perk.err.points' });
    p.perkPoints = 1;
    expect(perkBlocker(p, ext, EXT_PERK.id)).toBeNull();
    const b = attempt(p, EXT_PERK.id);
    expect(b.outcome).toMatchObject({ ok: true, applied: true });
    p = b.next;
    expect(p.perks).toEqual(['core.perk.combat.steady', EXT_PERK.id]);
    expect(p.perkPoints).toBe(0);
    expect(perkBlocker(p, ext, EXT_PERK.id)).toBe('perk.err.owned');
    expect(aggregatePerks(ext, p.perks)).toEqual({ stabilizeMult: 0.85, reloadMult: 0.9, carryKg: 4 });

    p.flags['deploy_allowed'] = true;
    const launch = prepareDeploy(p, ext, DEST, T0);
    expect(launch.perks).toEqual({ stabilizeMult: 0.85, reloadMult: 0.9, carryKg: 4 });
    expect(createRaidSim(ext, launch).sim.perks).toEqual(launch.perks);
  });

  it('the pack building passes validatePlacement/placeBuilding in the shelter build zone', () => {
    const shelter = ext.map('core.map.shelter');
    const p = newProfile(ext, 1, 'Builder', 'builder-seed', T0);
    expect(validatePlacement(p, ext, shelter, EXT_BUILDING.id, 12, 20, 0, null)).toBeNull();
    expect(validatePlacement(p, ext, shelter, EXT_BUILDING.id, 19, 31, 0, null)).toBe('build.err.bounds');
    expect(validatePlacement(p, ext, shelter, EXT_BUILDING.id, 5, 15, 0, null)).toBe('build.err.reserved');
    expect(validatePlacement(p, ext, shelter, EXT_BUILDING.id, 12.5, 20, 0, null)).toBe('build.err.grid');
    const place = (s: ProfileState, tx: string) => runTx(s, tx, (d) => placeBuilding(d, ext, shelter, EXT_BUILDING.id, 12, 20, 0));
    expect(place(p, 'bld:1').outcome).toEqual({ ok: false, applied: false, reason: 'build.err.locked' }); // data-defined unlock flag
    p.flags['ext.bunker_cleared'] = true;
    expect(place(p, 'bld:2').outcome).toEqual({ ok: false, applied: false, reason: 'build.err.materials' });
    grantItems(p, ext, 'core.mat.scrap', 2, 'grant:scrap');
    const scrapBefore = countDef(p.store, 'core.mat.scrap', homeContainers(p));
    const { outcome, next } = place(p, 'bld:3');
    expect(outcome).toMatchObject({ ok: true, applied: true });
    expect(next.buildings).toEqual([{ guid: expect.any(String), buildingId: EXT_BUILDING.id, x: 12, y: 20, rot: 0 }]);
    expect(next.currency).toBe(p.currency - EXT_BUILDING.cost.credits);
    expect(countDef(next.store, 'core.mat.scrap', homeContainers(next))).toBe(scrapBefore - 2);
    expect(next.flags[`building:${EXT_BUILDING.id}`]).toBe(true);
    expect(place(next, 'bld:4').outcome).toEqual({ ok: false, applied: false, reason: 'build.err.duplicate' });
    expect(validatePlacement(next, ext, shelter, 'core.building.supply_shelf', 13, 21, 0, null)).toBe('build.err.overlap');
    // The shelter geometry rebuilds with the new building as a solid obstacle.
    const geo = new WorldGeometry(shelter, ext, buildingObstacles(next, ext));
    expect(geo.byId.get(`bld:${next.buildings[0]!.guid}`)?.def.tags).toEqual(['building', EXT_BUILDING.id]);
  });

  it('the pack contract template is generated by ensureContracts and can be accepted, delivered and turned in', () => {
    const p = newProfile(ext, 1, 'Courier', 'courier-seed', T0);
    p.flags['deploy_allowed'] = true;
    ensureContracts(p, ext);
    const offer = p.contracts.offers.find((o) => o.templateId === EXT_CONTRACT.id);
    expect(offer).toBeDefined();
    expect(offer!.objective).toMatchObject({ type: 'Deliver', npcId: EXT_CONTRACT.giver, mapId: null, weaponTag: null });
    expect(offer!.giver).toBe(EXT_CONTRACT.giver);
    expect(offer!.rewardCredits).toBeGreaterThanOrEqual(500);
    expect(offer!.rewardCredits).toBeLessThanOrEqual(520);
    expect(contractPossible(p, ext, offer!)).toBe(true);
    expect(ext.t(EXT_CONTRACT.descKey, offer!.params)).not.toMatch(/[{⟦]/);

    acceptContract(p, offer!.id);
    grantItems(p, ext, offer!.objective.target, offer!.objective.count, 'grant:contract');
    expect(deliverContract(p, offer!.id)).toBe(offer!.objective.count);
    expect(p.contracts.offers.find((o) => o.id === offer!.id)!.status).toBe('ready');
    const before = p.currency;
    const res = turnInContract(p, offer!.id);
    expect(res.credits).toBe(offer!.rewardCredits);
    expect(p.currency).toBe(before + offer!.rewardCredits);
    expect(p.contracts.completed).toContain(offer!.id);

    // Without the pack the generator never offers it.
    const q = newProfile(core, 1, 'Courier', 'courier-seed', T0);
    q.flags['deploy_allowed'] = true;
    ensureContracts(q, core);
    expect(q.contracts.offers.some((o) => o.templateId === EXT_CONTRACT.id)).toBe(false);
  });

  it('geo.regionAt finds the new region, and the patched map spawns the region cache in a raid', () => {
    const geo = new WorldGeometry(ext.map(QM), ext);
    expect(geo.regionAt(30, 37)?.id).toBe(EXT_REGION.id);
    expect(geo.regionAt(26.5, 34.5)?.id).toBe(EXT_REGION.id);
    expect(ext.t(geo.regionAt(30, 37)!.nameKey)).toBe('시험 벙커');
    expect(geo.regionAt(10, 60)?.id).toBe('core.region.farm'); // the rest of the map is unchanged
    expect(geo.regionAt(35, 37)?.id).toBe('core.region.farm');
    expect(new WorldGeometry(core.map(QM), core).regionAt(30, 37)?.id).toBe('core.region.farm');

    const p = newProfile(ext, 1, 'Scout', 'scout-seed', T0);
    p.flags['deploy_allowed'] = true;
    const { sim, ctx } = createRaidSim(ext, prepareDeploy(p, ext, DEST, T0));
    expect(ctx.geo.regionAt(30, 37)?.id).toBe(EXT_REGION.id);
    expect(ctx.geo.byId.has(`prop:${CACHE_ID}`)).toBe(true);
    expect(sim.containers[`ct:${CACHE_ID}`]).toMatchObject({ kind: 'world', typeId: 'core.ct.supply', x: 30, y: 37 });
    expect(countDef(sim.store, EXT_AMMO.id, [`ct:${CACHE_ID}`])).toBe(30);
    expect(validateStore(sim.store, ext)).toEqual([]);
  });
});

// --- (2) old save migration --------------------------------------------------------------------------------------

function legacyItems(): ItemInstance[] {
  const base = () => ({ durability: null, modifiers: [], attachments: {}, containedItems: [], ownerContainerId: null, gridPosition: null, rotation: 0 as const, questTags: [], lockTags: [] });
  return [
    { ...base(), instanceId: 'v0-it-1', definitionId: 'core.weapon.p9', quantity: 1, durability: 64, weapon: { chamber: null, magazineId: null, tube: null, fireMode: 'semi' } },
    { ...base(), instanceId: 'v0-it-2', definitionId: 'core.ammo.9.fmj', quantity: 45 },
    { ...base(), instanceId: 'v0-it-3', definitionId: 'core.med.bandage', quantity: 3 },
    { ...base(), instanceId: 'v0-it-4', definitionId: 'core.mag.p9', quantity: 1, mag: { rounds: ['core.ammo.9.fmj', 'core.ammo.9.fmj'] } },
  ];
}

const legacyRecord = () => ({ version: 0, legacy: { money: 4321, slot: 2, seed: 'legacy-seed', name: '옛 생존자', items: legacyItems() } });

/** A migrated legacy save is "usable": data preserved, invariants hold, and transactions work on it. */
function expectUsableLegacy(p: ProfileState, c: ContentRegistry): ProfileState {
  expect(p).toMatchObject({ schemaVersion: 1, slotId: 2, seed: 'legacy-seed', name: '옛 생존자', currency: 4321 });
  for (const li of legacyItems()) expect(p.store.items[li.instanceId], li.instanceId).toMatchObject({ definitionId: li.definitionId, quantity: li.quantity, durability: li.durability });
  expect(countDef(p.store, 'core.ammo.9.fmj', homeContainers(p))).toBe(45);
  expect(validateStore(p.store, c)).toEqual([]);
  expect(referenceErrors(p, c)).toEqual([]);
  const { outcome, next } = runTx(p, 'legacy:grant', (d) => grantItems(d, c, 'core.mat.cloth', 2, 'legacy:grant'));
  expect(outcome).toMatchObject({ ok: true, applied: true });
  expect(countDef(next.store, 'core.mat.cloth', homeContainers(next))).toBe(2);
  return next;
}

describe('Stage 4 (2) — old save migration', () => {
  it('migrateProfile maps a legacy v0 record into the v1 layout (money → currency, items → stash)', () => {
    const m = migrateProfile(legacyRecord());
    expect(m).toMatchObject({ schemaVersion: 1, slotId: 2, seed: 'legacy-seed', name: '옛 생존자', currency: 4321, __migratedFrom: 0 });
    const store = m['store'] as ItemStore;
    const ids = legacyItems().map((i) => i.instanceId);
    expect(Object.keys(store.items).sort()).toEqual([...ids].sort());
    expect(store.containers['stash']!.items).toEqual(ids);
    for (const li of legacyItems()) expect(store.items[li.instanceId]).toMatchObject({ definitionId: li.definitionId, quantity: li.quantity, ownerContainerId: 'stash' });
  });

  it('a migrated legacy v0 profile passes checkProfileShape and normalizes into a usable profile', () => {
    const m = migrateProfile(legacyRecord());
    expect(checkProfileShape(m).errors).toEqual([]);
    expectUsableLegacy(normalizeProfile(m as unknown as ProfileState), core);
  });

  it('a legacy v0 record stored in the SaveStore loads (not reported corrupt) into a usable profile with currency/items preserved', async () => {
    const env = await freshEnv();
    await writeRawSlot(env, 2, legacyRecord());
    const lr = expectLoaded(await env.store.load(2, core));
    const next = expectUsableLegacy(lr.profile, core);
    await env.store.commit(2, next, undefined, 'legacy:resave');
    expect(expectLoaded(await env.store.load(2, core)).profile.currency).toBe(4321);
  });

  it('an older v1 save missing later-added fields loads with defaults and stays usable', async () => {
    const env = await freshEnv();
    const p = newProfile(core, 1, '구버전', 'v1-old', T0);
    const raw = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    const later = ['perks', 'perkPoints', 'exp', 'level', 'buildings', 'facilities', 'crafting', 'market', 'contracts', 'chapter', 'quickslots', 'stats', 'playerHp', 'playerBleeding', 'rangeWeapon', 'reliefGeneration', 'generation', 'raidCounter', 'missingContent', 'itemLog', 'log', 'forecasts', 'lastDeathBag', 'activeRaid', 'lastRaidSummary', 'tutorial'];
    for (const k of later) delete raw[k];
    raw['settings'] = { uiScale: 125, volumes: { Master: 0.3 } };
    await writeRawSlot(env, 1, raw);
    const q = expectLoaded(await env.store.load(1, core)).profile;
    expect(q.currency).toBe(p.currency);
    expect(Object.keys(q.store.items).sort()).toEqual(Object.keys(p.store.items).sort());
    expect(q.settings.uiScale).toBe(125);
    expect(q.settings.volumes).toEqual({ ...p.settings.volumes, Master: 0.3 });
    expect(q.settings.subtitles).toBe(p.settings.subtitles);
    expect(q.settings.keyHints, 'settings added later default on').toBe(true);
    // A player from before the tutorial existed is not sent through it.
    expect(q.tutorial).toEqual({ step: 0, done: true, skipped: false });
    expect(p.tutorial, 'a brand-new slot starts the tutorial').toEqual({ step: 0, done: false, skipped: false });
    expect(q).toMatchObject({ perks: [], perkPoints: 0, exp: 0, level: 1, buildings: [], facilities: {}, chapter: { act: 0, completed: false, epilogueSeen: false }, quickslots: [null, null, null, null], activeRaid: null, missingContent: [], playerHp: 100, rangeWeapon: 'core.weapon.p9' });
    expect(validateStore(q.store, core)).toEqual([]);
    const svc = new ProfileService(env.store, q);
    expect(await svc.run('old:grant', (d) => void grantItems(d, core, 'core.mat.scrap', 2, 'old:grant'))).toMatchObject({ ok: true, applied: true });
    const again = expectLoaded(await env.store.load(1, core)).profile;
    expect(countDef(again.store, 'core.mat.scrap', homeContainers(again))).toBe(2);
    expect(again.settings.uiScale).toBe(125);
  });
});

// --- (3) missing-content quarantine --------------------------------------------------------------------------------

interface Fixture {
  env: Env;
  original: ProfileState;
  ids: { bag: string; bagCid: string; band: string; ring: string; pistol: string; pmag: string; rifle: string; rmag: string; offer: string };
}

/**
 * Saved while the pack is registered: a pack bag in the stash holding known items (bandages, ring) and a pack pistol
 * loaded with a pack magazine; a pack rifle loaded with a core magazine; the pack perk; the pack building; an accepted
 * contract generated from the pack template.
 */
async function savedWithPack(): Promise<Fixture> {
  const env = await freshEnv();
  const p = newProfile(ext, 1, '확장 수집가', 'ext-quarantine', T0);
  p.flags['deploy_allowed'] = true;
  p.flags['ext.bunker_cleared'] = true;
  p.level = 3;
  p.perkPoints = 2;
  const bag = put(p, ext, EXT_BAG.id, STASH);
  const bagCid = bagContainerId(bag.instanceId);
  const band = put(p, ext, 'core.med.bandage', bagCid, 3);
  const ring = put(p, ext, 'core.val.ring', bagCid);
  const pistol = put(p, ext, EXT_PISTOL.id, bagCid);
  const pmag = loadInto(p.store, ext, p.ids, pistol, EXT_MAG.id, 'core.ammo.9.fmj', 12);
  const rifle = put(p, ext, EXT_RIFLE.id, STASH);
  const rmag = loadInto(p.store, ext, p.ids, rifle, 'core.mag.ar556', 'core.ammo.556.fmj', 30);
  unlockPerk(p, ext, 'core.perk.combat.steady');
  unlockPerk(p, ext, EXT_PERK.id);
  grantItems(p, ext, 'core.mat.scrap', 2, 'setup');
  placeBuilding(p, ext, ext.map('core.map.shelter'), EXT_BUILDING.id, 12, 20, 0);
  ensureContracts(p, ext);
  const offer = p.contracts.offers.find((o) => o.templateId === EXT_CONTRACT.id);
  expect(offer).toBeDefined();
  acceptContract(p, offer!.id);
  expect(validateStore(p.store, ext)).toEqual([]);
  expect(referenceErrors(p, ext)).toEqual([]);
  await env.store.commit(1, p, null, 'save-with-pack');
  return {
    env,
    original: persisted(p),
    ids: { bag: bag.instanceId, bagCid, band: band.instanceId, ring: ring.instanceId, pistol: pistol.instanceId, pmag: pmag.instanceId, rifle: rifle.instanceId, rmag: rmag.instanceId, offer: offer!.id },
  };
}

/** Load without the pack, then persist the quarantined profile (what the app's next checkpoint does). */
async function quarantinedAndPersisted(f: Fixture): Promise<ProfileState> {
  const q = expectLoaded(await f.env.store.load(1, core)).profile;
  await f.env.store.commit(1, q, undefined, 'persist-quarantine');
  return q;
}

describe('Stage 4 (3) — missing-content quarantine', () => {
  it('without the pack: unknown items/perk/building/contract go to missingContent (not deleted), known contents are rescued into incoming, the store stays valid', async () => {
    const f = await savedWithPack();
    const { store } = f.env;
    const before = JSON.stringify(await dumpDb(f.env));
    const r = expectLoaded(await store.load(1, core));
    expect(JSON.stringify(await dumpDb(f.env))).toBe(before); // loading never rewrites the save
    const q = r.profile;
    const unknownItems = [f.ids.bag, f.ids.pistol, f.ids.pmag, f.ids.rifle];
    expect(r.quarantined).toBe(unknownItems.length + 3); // + perk + building + contract
    expect(q.missingContent.map((m) => `${m.kind}:${m.defId}`).sort()).toEqual([
      `building:${EXT_BUILDING.id}`,
      `contract:${EXT_CONTRACT.id}`,
      `item:${EXT_BAG.id}`,
      `item:${EXT_MAG.id}`,
      `item:${EXT_PISTOL.id}`,
      `item:${EXT_RIFLE.id}`,
      `perk:${EXT_PERK.id}`,
    ]);

    // Nothing silently deleted: the raw instance of every unknown item is kept.
    for (const id of unknownItems) {
      const orig = f.original.store.items[id]!;
      const entry = q.missingContent.find((m) => m.kind === 'item' && m.itemId === id);
      expect(entry, id).toBeDefined();
      expect(entry!.raw).toMatchObject({ instanceId: id, definitionId: orig.definitionId, quantity: orig.quantity, durability: orig.durability });
      expect(q.store.items[id]).toBeUndefined();
    }
    expect((q.missingContent.find((m) => m.itemId === f.ids.rifle)!.raw as ItemInstance).weapon!.chamber).toBe('core.ammo.556.fmj');
    expect((q.missingContent.find((m) => m.itemId === f.ids.pmag)!.raw as ItemInstance).mag!.rounds).toHaveLength(11);
    expect(q.missingContent.find((m) => m.kind === 'building')!.raw).toEqual(f.original.buildings[0]);
    expect(q.missingContent.find((m) => m.kind === 'contract')!.raw).toEqual(f.original.contracts.offers.find((o) => o.id === f.ids.offer));
    expect(q.store.containers[f.ids.bagCid]).toBeUndefined();

    // Known contents of unknown containers/weapons are rescued into 'incoming'.
    const incoming = q.store.containers[INCOMING]!;
    for (const id of [f.ids.band, f.ids.ring, f.ids.rmag]) {
      expect(incoming.items).toContain(id);
      expect(q.store.items[id]).toMatchObject({ ownerContainerId: INCOMING, gridPosition: null });
    }
    expect(q.store.items[f.ids.band]!.quantity).toBe(3);
    expect(q.store.items[f.ids.rmag]!.mag!.rounds).toHaveLength(29);

    // Every instance still exists, live or quarantined; only registered content is referenced; ownership holds.
    const live = Object.keys(q.store.items);
    const held = q.missingContent.filter((m) => m.kind === 'item').map((m) => m.itemId);
    expect(new Set([...live, ...held])).toEqual(new Set(Object.keys(f.original.store.items)));
    expect(validateStore(q.store, core)).toEqual([]);
    expect(referenceErrors(q, core)).toEqual([]);
    expect(q.perks).toEqual(['core.perk.combat.steady']);
    expect(q.buildings).toEqual([]);
    expect(q.contracts.offers.map((o) => o.templateId)).not.toContain(EXT_CONTRACT.id);

    // The quarantined profile is a working profile, and re-loading without the pack does not quarantine twice.
    const svc = new ProfileService(store, q);
    expect(await svc.run('after-quarantine', (d) => void grantItems(d, core, 'core.mat.cloth', 1, 'after-quarantine'))).toMatchObject({ ok: true, applied: true });
    const r2 = expectLoaded(await store.load(1, core));
    expect(r2.quarantined).toBe(0);
    expect(r2.profile.missingContent).toEqual(persisted(svc.profile).missingContent);
  });

  it('with the pack registered again: restoreQuarantined brings items back into incoming, restores perk/building/contract, missingContent empty', async () => {
    const f = await savedWithPack();
    const q = await quarantinedAndPersisted(f);
    const probe = structuredClone(q);
    expect(restoreQuarantined(probe, ext)).toBe(7);
    expect(probe.missingContent).toEqual([]);

    const r = expectLoaded(await f.env.store.load(1, ext));
    const back = r.profile;
    expect(r.quarantined).toBe(0);
    expect(back.missingContent).toEqual([]);
    const incoming = back.store.containers[INCOMING]!;
    for (const id of [f.ids.bag, f.ids.pistol, f.ids.pmag, f.ids.rifle]) {
      expect(back.store.items[id], id).toMatchObject({ instanceId: id, definitionId: f.original.store.items[id]!.definitionId, ownerContainerId: INCOMING, gridPosition: null });
      expect(incoming.items).toContain(id);
    }
    for (const id of [f.ids.band, f.ids.ring, f.ids.rmag]) expect(incoming.items).toContain(id);
    expect(back.store.items[f.ids.pmag]!.mag!.rounds).toHaveLength(11);
    expect(back.store.items[f.ids.pistol]!.weapon).toMatchObject({ chamber: 'core.ammo.9.fmj', magazineId: null });
    expect(back.store.items[f.ids.rifle]!.weapon).toMatchObject({ chamber: 'core.ammo.556.fmj', magazineId: null });
    expect(new Set(Object.keys(back.store.items))).toEqual(new Set(Object.keys(f.original.store.items)));
    expect(back.perks).toEqual(['core.perk.combat.steady', EXT_PERK.id]);
    expect(aggregatePerks(ext, back.perks)).toMatchObject({ reloadMult: 0.9, carryKg: 4 });
    expect(back.buildings).toEqual(f.original.buildings);
    expect(back.contracts.offers.find((o) => o.id === f.ids.offer)).toEqual(f.original.contracts.offers.find((o) => o.id === f.ids.offer));
    expect(validateStore(back.store, ext)).toEqual([]);
    expect(referenceErrors(back, ext)).toEqual([]);

    // The restored rifle is usable again: the rescued core magazine loads back into it.
    loadWeapon(back, ext, f.ids.rifle, f.ids.rmag);
    expect(back.store.items[f.ids.rifle]!.weapon!.magazineId).toBe(f.ids.rmag);
    expect(validateStore(back.store, ext)).toEqual([]);
  });

  it('a restored pack backpack is a usable container again (its bag grid comes back with it)', async () => {
    const f = await savedWithPack();
    await quarantinedAndPersisted(f);
    const back = expectLoaded(await f.env.store.load(1, ext)).profile;
    expect(back.store.items[f.ids.bag]?.definitionId).toBe(EXT_BAG.id);
    expect(back.store.containers[f.ids.bagCid]).toMatchObject({ id: f.ids.bagCid, kind: 'grid', w: 5, h: 4 });
    expect(moveItem(back.store, ext, f.ids.ring, { containerId: f.ids.bagCid })).toEqual({ ok: true });
  });

  it('pack ammo stripped from known magazines and chambers is restored when the pack returns', async () => {
    const env = await freshEnv();
    const p = newProfile(ext, 1, '탄약 수집가', 'ext-rounds', T0);
    const mag = put(p, ext, 'core.mag.ar556', STASH);
    mag.mag!.rounds = [...Array.from({ length: 5 }, () => 'core.ammo.556.fmj'), ...Array.from({ length: 10 }, () => EXT_AMMO.id)];
    const carbine = Object.values(p.store.items).find((i) => i.definitionId === 'core.weapon.c556')!;
    carbine.weapon!.chamber = EXT_AMMO.id;
    const packRounds = (s: ProfileState): number => {
      let n = 0;
      for (const it of Object.values(s.store.items)) {
        if (it.definitionId === EXT_AMMO.id) n += it.quantity;
        n += (it.mag?.rounds ?? []).filter((r) => r === EXT_AMMO.id).length;
        n += (it.weapon?.tube ?? []).filter((r) => r === EXT_AMMO.id).length;
        if (it.weapon?.chamber === EXT_AMMO.id) n++;
      }
      return n;
    };
    expect(packRounds(p)).toBe(11);
    await env.store.commit(1, p, null, 'with-pack');

    const r = expectLoaded(await env.store.load(1, core));
    expect(r.quarantined).toBe(11);
    expect(packRounds(r.profile)).toBe(0);
    expect(r.profile.store.items[mag.instanceId]!.mag!.rounds).toEqual(Array.from({ length: 5 }, () => 'core.ammo.556.fmj'));
    expect(r.profile.missingContent.filter((m) => m.kind === 'round')).toHaveLength(11);
    await env.store.commit(1, r.profile, undefined, 'persist-quarantine');

    const back = expectLoaded(await env.store.load(1, ext)).profile;
    expect(back.missingContent).toEqual([]);
    expect(packRounds(back)).toBe(11);
  });

  it('a raid snapshot that references unregistered content is not resumed; load reports it unavailable instead of crashing', async () => {
    const env = await freshEnv();
    const { store } = env;
    const p = newProfile(ext, 1, '출격 테스터', 'ext-raid', T0);
    p.flags['deploy_allowed'] = true;
    const rifle = put(p, ext, EXT_RIFLE.id, STASH);
    loadInto(p.store, ext, p.ids, rifle, 'core.mag.ar556', 'core.ammo.556.fmj', 30);
    equipProfileItem(p, ext, rifle.instanceId, 'primary1');
    await store.commit(1, p, null, 'newgame:1');
    const svc = new ProfileService(store, p);
    const holder: { sim: SimState | null } = { sim: null };
    const dep = await svc.run('deploy:1:1', (d) => prepareDeploy(d, ext, DEST, T0), { raid: (launch) => (holder.sim = createRaidSim(ext, launch).sim), pinRaid: true });
    expect(dep).toMatchObject({ ok: true, applied: true });
    const sim = holder.sim!;
    expect(sim.loadoutItemIds).toContain(rifle.instanceId);
    expect(raidContentErrors(sim, ext)).toEqual([]);
    expect(raidContentErrors(sim, core)).toEqual(expect.arrayContaining([`unknown item ${EXT_RIFLE.id}`, `unknown item ${EXT_AMMO.id}`]));

    // With the pack the raid resumes.
    const withPack = expectLoaded(await store.load(1, ext));
    expect(withPack.raid).not.toBeNull();
    expect(withPack.raid!.raidId).toBe(withPack.profile.activeRaid!.raidId);

    // Without the pack: no throw, the profile loads, the raid is reported unavailable, nothing is written.
    const before = JSON.stringify(await dumpDb(env));
    const noPack = expectLoaded(await store.load(1, core));
    expect(noPack.profile.activeRaid).toMatchObject({ raidId: sim.raidId, mapId: QM });
    expect(noPack.raid).toBeNull();
    expect(noPack.raidRecoveredFrom).toBeNull();
    expect(JSON.stringify(await dumpDb(env))).toBe(before);

    // The snapshot was not destroyed: once the pack is back, the same raid resumes again.
    expect(expectLoaded(await store.load(1, ext)).raid).toEqual(withPack.raid);

    // raidContentErrors also names unknown maps and enemy archetypes.
    const ghost = emptySim('raid', 'r-ghost', 'ext.map.removed', 'seed', 'Day', 'Clear');
    const e = newActor('e1', 'enemy', 5, 5, 100, 'hostile');
    e.archetypeId = 'ext.enemy.removed';
    ghost.actors.push(e);
    expect(raidContentErrors(ghost, core)).toEqual(['unknown map ext.map.removed', 'unknown enemy ext.enemy.removed']);
  });
});
