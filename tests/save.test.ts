/**
 * A19 — 저장 슬롯 격리, 손상 복구, export/import round-trip, quota 실패 안전.
 *
 * Every test runs against its own fake-indexeddb factory + database name, so no state is shared between tests.
 * Raw rows are inspected through a second IndexedDB connection (independent of SaveStore's own read paths) to prove
 * "byte-for-byte unchanged" / "nothing partially applied" / "orphans cleaned".
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { ProfileService } from '../src/game/profileService';
import { countDef } from '../src/inventory/store';
import { defaultSettings, grantItems, homeContainers, newProfile, type ProfileState, type Settings } from '../src/progression/profile';
import { prepareDeploy } from '../src/progression/raidFlow';
import { checksum } from '../src/save/checksum';
import { DB_VERSION, PROFILE_BACKUPS, SaveStore, type ExportPackage, type JournalRow, type LoadFailure, type LoadResult, type PointerRow, type RecordRow } from '../src/save/saveStore';
import { deserializeSim, raidContentErrors, serializeSim } from '../src/save/schema';
import { createRaidSim } from '../src/world/spawn';
import type { SimState } from '../src/world/state';

const content = createContent();
const T0 = 1_700_000_000_000;
const DEST = 'core.dest.quarantine_main';
const PHASES = ['write', 'verify', 'swap'] as const;

// --- isolated database per test -------------------------------------------------------------------------------

interface Env {
  factory: IDBFactory;
  name: string;
  store: SaveStore;
}

let dbSeq = 0;
async function freshEnv(): Promise<Env> {
  const factory = new IDBFactory();
  const name = `a19-${++dbSeq}`;
  const store = new SaveStore(factory, name);
  await store.open();
  return { factory, name, store };
}

/** Simulate a crashed / closed tab: drop the connection and open the same database with a brand-new SaveStore. */
async function reopen(env: Env): Promise<SaveStore> {
  env.store.close();
  env.store = new SaveStore(env.factory, env.name);
  await env.store.open();
  return env.store;
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

interface DbDump {
  records: RecordRow[];
  pointers: PointerRow[];
  journal: JournalRow[];
  meta: { key: string; value: unknown }[];
}

/** Raw read of every object store through a second connection. */
async function dumpDb(env: Env): Promise<DbDump> {
  const db = await reqP(env.factory.open(env.name, DB_VERSION));
  try {
    const t = db.transaction(['records', 'pointers', 'journal', 'meta'], 'readonly');
    const [records, pointers, journal, meta] = await Promise.all([
      reqP(t.objectStore('records').getAll()),
      reqP(t.objectStore('pointers').getAll()),
      reqP(t.objectStore('journal').getAll()),
      reqP(t.objectStore('meta').getAll()),
    ]);
    return { records: records as RecordRow[], pointers: pointers as PointerRow[], journal: journal as JournalRow[], meta: meta as DbDump['meta'] };
  } finally {
    db.close();
  }
}

function slotRows(d: DbDump, slot: number): Omit<DbDump, 'meta'> {
  return {
    records: d.records.filter((r) => r.slotId === slot),
    pointers: d.pointers.filter((p) => p.slotId === slot),
    journal: d.journal.filter((j) => j.slotId === slot),
  };
}

/** Rewrite one stored record in place (bit rot the checksum must catch, or a crafted record). */
async function rewriteRecord(env: Env, recordId: string, edit: (r: RecordRow) => void): Promise<void> {
  const db = await reqP(env.factory.open(env.name, DB_VERSION));
  try {
    const t = db.transaction('records', 'readwrite');
    const os = t.objectStore('records');
    const r = (await reqP(os.get(recordId))) as RecordRow | undefined;
    if (!r) throw new Error(`record ${recordId} not found`);
    edit(r);
    os.put(r);
    await txDone(t);
  } finally {
    db.close();
  }
}

async function deleteRecord(env: Env, recordId: string): Promise<void> {
  const db = await reqP(env.factory.open(env.name, DB_VERSION));
  try {
    const t = db.transaction('records', 'readwrite');
    t.objectStore('records').delete(recordId);
    await txDone(t);
  } finally {
    db.close();
  }
}

/** Damage the payload without updating the stored checksum. */
const bitrot = (r: RecordRow): void => {
  r.payload = `${r.payload.slice(0, Math.floor(r.payload.length / 3))}#bitrot#`;
};

// --- profile / raid helpers -----------------------------------------------------------------------------------

function mkProfile(slot: number, name: string, currency = 1500): ProfileState {
  const p = newProfile(content, slot, name, `seed-${slot}-${name}`, T0);
  p.currency = currency;
  return p;
}

/** The JSON view of a profile exactly as SaveStore persists it. */
function persisted(p: ProfileState): ProfileState {
  return JSON.parse(JSON.stringify(p)) as ProfileState;
}

function expectLoaded(r: LoadResult | LoadFailure): LoadResult {
  expect('kind' in r ? r : 'loaded').toBe('loaded');
  return r as LoadResult;
}

function withoutSlotMeta(p: ProfileState): Record<string, unknown> {
  const o = structuredClone(p) as unknown as Record<string, unknown>;
  delete o['slotId'];
  delete o['updatedAt'];
  return o;
}

interface Deployed {
  svc: ProfileService;
  sim: SimState;
}

/** New game committed to `slot`, then the real deployment transaction (loadout → raid, snapshot pinned) like App.deploy. */
async function deploy(env: Env, slot = 1): Promise<Deployed> {
  const p = mkProfile(slot, `Raider-${slot}`);
  p.flags['deploy_allowed'] = true;
  await env.store.commit(slot, p, null, `newgame:${slot}`);
  const svc = new ProfileService(env.store, p);
  const holder: { sim: SimState | null } = { sim: null };
  const r = await svc.run(`deploy:${slot}:1`, (d) => prepareDeploy(d, content, DEST, T0 + 1000), {
    raid: (launch, draft) => {
      const s = createRaidSim(content, launch).sim;
      s.credits = draft.currency;
      holder.sim = s;
      return s;
    },
    pinRaid: true,
  });
  expect(r).toMatchObject({ ok: true, applied: true });
  expect(holder.sim).not.toBeNull();
  return { svc, sim: holder.sim! };
}

/** A later in-raid snapshot of the same raid (what App.checkpointRaid persists). */
function snapAt(sim: SimState, tick: number): SimState {
  const s = structuredClone({ ...sim, fx: [] });
  s.tick = tick;
  s.time = tick / 60;
  return s;
}

/** What load() must hand back for a committed snapshot. */
const roundTripped = (s: SimState): SimState => deserializeSim(serializeSim(s));

// --- A19a -------------------------------------------------------------------------------------------------------

describe('A19a — save slot isolation', () => {
  it('edits, corruption and deletion of slot 1 never change slots 2 and 3 (deep-equal loads, byte-identical rows)', async () => {
    const env = await freshEnv();
    const { store } = env;
    const ps = [mkProfile(1, 'Alpha', 1111), mkProfile(2, 'Bravo', 2222), mkProfile(3, 'Charlie', 3333)] as const;
    for (const p of ps) await store.commit(p.slotId, p, null, `newgame:${p.slotId}`);
    for (const p of ps) expect(expectLoaded(await store.load(p.slotId, content)).profile).toEqual(persisted(p));
    const load2 = expectLoaded(await store.load(2, content));
    const load3 = expectLoaded(await store.load(3, content));
    const rows = async (slot: number) => JSON.stringify(slotRows(await dumpDb(env), slot));
    const raw2 = await rows(2);
    const raw3 = await rows(3);
    const othersUntouched = async () => {
      expect(await rows(2)).toBe(raw2);
      expect(await rows(3)).toBe(raw3);
      expect(expectLoaded(await store.load(2, content))).toEqual(load2);
      expect(expectLoaded(await store.load(3, content))).toEqual(load3);
    };

    // Six edits on slot 1: backup rotation and per-slot record cleanup run on every commit.
    const p1 = ps[0];
    for (let i = 0; i < 6; i++) {
      p1.currency += 10;
      grantItems(p1, content, 'core.mat.cloth', 1, `edit:${i}`);
      await store.commit(1, p1, undefined, `edit:${i}`);
    }
    const l1 = expectLoaded(await store.load(1, content));
    expect(l1.profile.currency).toBe(1171);
    expect(l1.profile).toEqual(persisted(p1));
    expect((await store.pointer(1))!.backups).toHaveLength(PROFILE_BACKUPS);
    await othersUntouched();

    // Corrupting slot 1 affects slot 1 only.
    await store.corruptCurrent(1);
    expect(await store.load(1, content)).toMatchObject({ kind: 'corrupt' });
    await othersUntouched();

    // Deleting slot 1 removes exactly its pointer and records.
    await store.deleteSlot(1);
    expect(await store.load(1, content)).toEqual({ kind: 'empty' });
    const afterDelete = await dumpDb(env);
    expect(afterDelete.records.filter((r) => r.slotId === 1 || r.recordId.startsWith('1:'))).toEqual([]);
    expect(afterDelete.pointers.map((p) => p.slotId)).toEqual([2, 3]);
    await othersUntouched();

    // A new game in the freed slot starts from scratch (no stale backups) and does not touch the other slots.
    const again = mkProfile(1, 'Delta', 999);
    await store.commit(1, again, null, 'newgame:1:again');
    expect(expectLoaded(await store.load(1, content)).profile).toEqual(persisted(again));
    expect((await store.pointer(1))!.backups).toEqual([]);
    await othersUntouched();
  });

  it('listSlots reports an independent summary per slot', async () => {
    const { store } = await freshEnv();
    expect(await store.listSlots()).toEqual([
      { slotId: 1, summary: null },
      { slotId: 2, summary: null },
      { slotId: 3, summary: null },
    ]);
    const a = mkProfile(1, 'Alpha', 1111);
    const c = mkProfile(3, 'Charlie', 3333);
    c.level = 4;
    c.playTime = 1234;
    c.chapter = { act: 3, completed: true, epilogueSeen: false };
    c.activeRaid = { raidId: 'r3-1', mapId: 'core.map.quarantine_main', destId: DEST, startedAt: T0 };
    await store.commit(1, a, null, 'newgame:1');
    await store.commit(3, c, null, 'newgame:3');
    const list = await store.listSlots();
    expect(list.map((s) => s.slotId)).toEqual([1, 2, 3]);
    expect(list[0]!.summary).toEqual({ name: 'Alpha', level: 1, act: 0, playTime: 0, currency: 1111, updatedAt: a.updatedAt, inRaid: false, chapterComplete: false });
    expect(list[1]!.summary).toBeNull();
    expect(list[2]!.summary).toEqual({ name: 'Charlie', level: 4, act: 3, playTime: 1234, currency: 3333, updatedAt: c.updatedAt, inRaid: true, chapterComplete: true });

    // Updating one slot changes only that slot's summary.
    a.currency = 5000;
    await store.commit(1, a, undefined, 'edit:1');
    const list2 = await store.listSlots();
    expect(list2[0]!.summary!.currency).toBe(5000);
    expect(list2[1]).toEqual(list[1]);
    expect(list2[2]).toEqual(list[2]);

    await store.deleteSlot(3);
    const list3 = await store.listSlots();
    expect(list3[2]).toEqual({ slotId: 3, summary: null });
    expect(list3[0]).toEqual(list2[0]);
  });
});

// --- A19b -------------------------------------------------------------------------------------------------------

describe('A19b — corruption recovery', () => {
  /** 1:p:1 (1000) → 1:p:2 (1100) → 1:p:3 (1200, current). */
  async function threeSaves(env: Env): Promise<ProfileState> {
    const p = mkProfile(1, 'Delta', 1000);
    await env.store.commit(1, p, null, 'c1');
    p.currency = 1100;
    await env.store.commit(1, p, undefined, 'c2');
    p.currency = 1200;
    await env.store.commit(1, p, undefined, 'c3');
    return p;
  }

  it('strict load reports corrupt and writes nothing; allowBackup returns the most recent valid backup', async () => {
    const env = await freshEnv();
    const { store } = env;
    await threeSaves(env);
    expect(await store.pointer(1)).toMatchObject({ profile: '1:p:3', backups: ['1:p:2', '1:p:1'] });
    await store.corruptCurrent(1);
    const before = JSON.stringify(await dumpDb(env));

    const strict = await store.load(1, content);
    expect(strict).toEqual({ kind: 'corrupt', errors: ['checksum mismatch'], backups: ['1:p:2', '1:p:1'] });
    expect(JSON.stringify(await dumpDb(env))).toBe(before); // not auto-overwritten, not deleted

    const rec = expectLoaded(await store.load(1, content, true));
    expect(rec.recoveredFrom).toBe('1:p:2');
    expect(rec.profile.currency).toBe(1100);
    expect(JSON.stringify(await dumpDb(env))).toBe(before); // recovery stays read-only until the user confirms

    // The corrupt record is still reported corrupt (never silently accepted) and cannot be exported.
    expect(await store.load(1, content)).toMatchObject({ kind: 'corrupt' });
    await expect(store.exportSlot(1)).rejects.toThrow(/corrupt/);

    // Newest backup damaged as well → the next older valid snapshot is used.
    await rewriteRecord(env, '1:p:2', bitrot);
    const rec2 = expectLoaded(await store.load(1, content, true));
    expect(rec2.recoveredFrom).toBe('1:p:1');
    expect(rec2.profile.currency).toBe(1000);

    // Everything damaged → corrupt without usable backups (and still nothing written).
    await rewriteRecord(env, '1:p:1', bitrot);
    const snap = JSON.stringify(await dumpDb(env));
    expect(await store.load(1, content, true)).toEqual({ kind: 'corrupt', errors: ['checksum mismatch'], backups: [] });
    expect(JSON.stringify(await dumpDb(env))).toBe(snap);
  });

  it('records with a valid checksum but unparsable, malformed, too-new or missing content are rejected, not loaded', async () => {
    const env = await freshEnv();
    const { store } = env;
    await threeSaves(env);
    const reseal = (payload: string) => (r: RecordRow) => {
      r.payload = payload;
      r.checksum = checksum(payload);
    };

    await rewriteRecord(env, '1:p:3', reseal('{"schemaVersion":1,"slotId":1'));
    const bad = await store.load(1, content);
    expect(bad).toMatchObject({ kind: 'corrupt' });
    expect((bad as { errors: string[] }).errors[0]).toMatch(/^json:/);

    await rewriteRecord(env, '1:p:3', reseal(JSON.stringify({ schemaVersion: 1, slotId: 1, currency: 'lots' })));
    const shape = await store.load(1, content);
    expect(shape).toMatchObject({ kind: 'corrupt' });
    expect((shape as { errors: string[] }).errors).toEqual(expect.arrayContaining(['field seed must be string', 'field currency must be number', 'field store must be object']));

    const future = persisted(mkProfile(1, 'Future'));
    future.schemaVersion = 2;
    await rewriteRecord(env, '1:p:3', reseal(JSON.stringify(future)));
    expect(await store.load(1, content)).toEqual({ kind: 'corrupt', errors: ['schema 2 is newer than supported 1'], backups: ['1:p:2', '1:p:1'] });

    // Each of these still recovers from the most recent valid backup.
    expect(expectLoaded(await store.load(1, content, true))).toMatchObject({ recoveredFrom: '1:p:2', profile: { currency: 1100 } });

    // Pointer to a record that no longer exists.
    await deleteRecord(env, '1:p:3');
    expect(await store.load(1, content)).toEqual({ kind: 'corrupt', errors: ['record missing'], backups: ['1:p:2', '1:p:1'] });
    expect(expectLoaded(await store.load(1, content, true)).recoveredFrom).toBe('1:p:2');
  });

  it('app recovery flow: the confirmed backup becomes the new current save and the corrupt record is never promoted', async () => {
    const env = await freshEnv();
    const { store } = env;
    await threeSaves(env);
    await store.corruptCurrent(1);
    const rec = expectLoaded(await store.load(1, content, true));
    const svc = new ProfileService(store, rec.profile);
    expect(await svc.checkpoint(rec.raid ?? undefined)).toBe(true); // App.continueGame after the user confirms
    const now = expectLoaded(await store.load(1, content));
    expect(now.recoveredFrom).toBeNull();
    expect(now.profile.currency).toBe(1100);
    expect((await store.pointer(1))!.profile).toBe('1:p:4');
    // If the new current record is lost too, the corrupt 1:p:3 (rotated into the backups) is skipped.
    await store.corruptCurrent(1);
    const again = expectLoaded(await store.load(1, content, true));
    expect(again.recoveredFrom).not.toBe('1:p:3');
    expect(again.profile.currency).toBe(1100);
  });
});

// --- A19c -------------------------------------------------------------------------------------------------------

describe('A19c — raid snapshots', () => {
  it('deployment pins the snapshot, checkpoints advance it, load returns the latest snapshot of profile.activeRaid', async () => {
    const env = await freshEnv();
    const { store } = env;
    const { svc, sim } = await deploy(env);
    expect(await store.pointer(1)).toMatchObject({ raid: '1:r:2', raidBackups: ['1:r:2'] });
    expect((await store.listSlots())[0]!.summary!.inRaid).toBe(true);
    const atDeploy = expectLoaded(await store.load(1, content));
    expect(atDeploy.profile.activeRaid!.raidId).toBe(sim.raidId);
    expect(atDeploy.raid).toEqual(roundTripped(sim));
    expect(atDeploy.raidRecoveredFrom).toBeNull();

    const cp = snapAt(sim, 60);
    expect(await svc.checkpoint(cp)).toBe(true);
    expect(await store.pointer(1)).toMatchObject({ raid: '1:r:3', raidBackups: ['1:r:2'] });
    // A profile-only transaction during the raid keeps the raid pointer (raid: undefined).
    expect(
      await svc.run('settings:1', (d) => {
        d.settings.uiScale = 125;
      }),
    ).toMatchObject({ ok: true, applied: true });
    expect(await store.pointer(1)).toMatchObject({ raid: '1:r:3', raidBackups: ['1:r:2'] });

    const l = expectLoaded(await store.load(1, content));
    expect(l.raid).toEqual(roundTripped(cp));
    expect(l.raid!.raidId).toBe(l.profile.activeRaid!.raidId);
    expect(l.raid!.tick).toBe(60);
    expect(l.raidRecoveredFrom).toBeNull();
    expect(l.profile.settings.uiScale).toBe(125);
    expect(raidContentErrors(l.raid!, content)).toEqual([]);
  });

  it('a corrupted latest raid snapshot falls back to the backup snapshot (raidRecoveredFrom set)', async () => {
    const env = await freshEnv();
    const { store } = env;
    const { svc, sim } = await deploy(env);
    expect(await svc.checkpoint(snapAt(sim, 60))).toBe(true); // 1:r:3 current, 1:r:2 pinned backup
    await rewriteRecord(env, '1:r:3', bitrot);
    const l = expectLoaded(await store.load(1, content));
    expect(l.recoveredFrom).toBeNull();
    expect(l.raidRecoveredFrom).toBe('1:r:2');
    expect(l.raid).toEqual(roundTripped(sim));
    expect(l.raid!.raidId).toBe(l.profile.activeRaid!.raidId);
  });

  it('with several checkpoints, a corrupted latest snapshot falls back to the most recent valid snapshot', async () => {
    const env = await freshEnv();
    const { store } = env;
    const { svc, sim } = await deploy(env);
    expect(await svc.checkpoint(snapAt(sim, 60))).toBe(true); // 1:r:3
    expect(await svc.checkpoint(snapAt(sim, 120))).toBe(true); // 1:r:4 current; backups = pinned 1:r:2 + previous 1:r:3
    expect(await store.pointer(1)).toMatchObject({ raid: '1:r:4', raidBackups: ['1:r:2', '1:r:3'] });
    await rewriteRecord(env, '1:r:4', bitrot);
    const l = expectLoaded(await store.load(1, content));
    // Spec §14 IndexedDB: restore the *last valid* snapshot — the tick-60 checkpoint, not the older tick-0 deployment one.
    expect({ from: l.raidRecoveredFrom, tick: l.raid?.tick }).toEqual({ from: '1:r:3', tick: 60 });
  });

  it('if every checkpoint is damaged, the pinned deployment snapshot is still resumable', async () => {
    const env = await freshEnv();
    const { store } = env;
    const { svc, sim } = await deploy(env);
    expect(await svc.checkpoint(snapAt(sim, 60))).toBe(true);
    expect(await svc.checkpoint(snapAt(sim, 120))).toBe(true);
    await rewriteRecord(env, '1:r:4', bitrot);
    await rewriteRecord(env, '1:r:3', bitrot);
    const l = expectLoaded(await store.load(1, content));
    expect(l.raidRecoveredFrom).toBe('1:r:2');
    expect(l.raid).toEqual(roundTripped(sim));
  });

  it('a snapshot of a different raid is never resumed for profile.activeRaid', async () => {
    const env = await freshEnv();
    const { store } = env;
    const { svc, sim } = await deploy(env);
    const foreign = snapAt(sim, 999);
    foreign.raidId = 'r1-999';
    expect(await svc.checkpoint(foreign)).toBe(true); // becomes the raid pointer
    const l = expectLoaded(await store.load(1, content));
    expect(l.raid!.raidId).toBe(sim.raidId);
    expect(l.raid!.tick).toBe(0);
    expect(l.raidRecoveredFrom).toBe('1:r:2');
  });

  it('raid: null clears the raid pointer, the raid backups and their records', async () => {
    const env = await freshEnv();
    const { store } = env;
    const { svc, sim } = await deploy(env);
    expect(await svc.checkpoint(snapAt(sim, 60))).toBe(true);
    const r = await svc.run(
      `raidend:${sim.raidId}`,
      (d) => {
        d.activeRaid = null;
        d.generation++;
      },
      { raid: null },
    );
    expect(r).toMatchObject({ ok: true, applied: true });
    expect(await store.pointer(1)).toMatchObject({ raid: null, raidBackups: [] });
    expect((await dumpDb(env)).records.filter((x) => x.kind === 'raid')).toEqual([]);
    const l = expectLoaded(await store.load(1, content));
    expect(l.profile.activeRaid).toBeNull();
    expect(l.raid).toBeNull();
    expect(l.raidRecoveredFrom).toBeNull();
    expect((await store.listSlots())[0]!.summary!.inRaid).toBe(false);
  });
});

// --- A19d -------------------------------------------------------------------------------------------------------

function reseal(pkg: ExportPackage): ExportPackage {
  return { ...pkg, checksum: checksum(`${pkg.profile}|${pkg.raid ?? ''}`) };
}

function withProfile(pkg: ExportPackage, edit: (p: ProfileState) => void, seal = true): ExportPackage {
  const p = JSON.parse(pkg.profile) as ProfileState;
  edit(p);
  const next = { ...pkg, profile: JSON.stringify(p) };
  return seal ? reseal(next) : next;
}

function withRaid(pkg: ExportPackage, edit: (s: SimState) => void, seal = true): ExportPackage {
  const s = JSON.parse(pkg.raid!) as SimState;
  edit(s);
  const next = { ...pkg, raid: JSON.stringify(s) };
  return seal ? reseal(next) : next;
}

const half = (s: string): string => s.slice(0, Math.floor(s.length / 2));

type Tamper = [label: string, make: (pkg: ExportPackage) => unknown, expectedError: string];

const TAMPERS: Tamper[] = [
  ['profile edited, checksum kept', (k) => withProfile(k, (p) => void (p.currency = 999_999), false), 'checksum mismatch'],
  ['raid edited, checksum kept', (k) => withRaid(k, (s) => void (s.tick += 1), false), 'checksum mismatch'],
  ['forged checksum field', (k) => ({ ...k, checksum: '00000000000000' }), 'checksum mismatch'],
  ['truncated profile JSON', (k) => ({ ...k, profile: half(k.profile) }), 'checksum mismatch'],
  ['truncated profile JSON, checksum recomputed', (k) => reseal({ ...k, profile: half(k.profile) }), 'profile json invalid'],
  ['truncated raid JSON, checksum recomputed', (k) => reseal({ ...k, raid: half(k.raid!) }), 'raid json invalid'],
  ['unknown item definition', (k) => withProfile(k, (p) => void (Object.values(p.store.items)[0]!.definitionId = 'ext.removed.item')), 'unknown item definition ext.removed.item'],
  ['unknown ammo in a magazine', (k) => withProfile(k, (p) => void Object.values(p.store.items).find((i) => i.mag)!.mag!.rounds.push('ext.removed.ammo')), 'unknown ammo ext.removed.ammo'],
  ['unknown perk', (k) => withProfile(k, (p) => void p.perks.push('ext.removed.perk')), 'unknown perk ext.removed.perk'],
  ['unknown building', (k) => withProfile(k, (p) => void p.buildings.push({ guid: 'bld-x', buildingId: 'ext.removed.building', x: 12, y: 20, rot: 0 })), 'unknown building ext.removed.building'],
  ['unknown quest', (k) => withProfile(k, (p) => void (p.quests['ext.removed.quest'] = { status: 'active', progress: {} })), 'unknown quest ext.removed.quest'],
  ['unknown trader', (k) => withProfile(k, (p) => void (p.traders['ext.removed.trader'] = { trust: 0, generation: -1, stock: {} })), 'unknown trader ext.removed.trader'],
  ['raid snapshot of a different raid', (k) => withRaid(k, (s) => void (s.raidId = 'r1-999')), 'raid snapshot does not match profile'],
  ['raid snapshot but the profile is not in a raid', (k) => withProfile(k, (p) => void (p.activeRaid = null)), 'raid snapshot does not match profile'],
  ['profile in a raid but the snapshot is missing', (k) => reseal({ ...k, raid: null }), 'profile references a raid snapshot that is missing'],
  ['wrong format', (k) => ({ ...k, format: 'other-game-save' }), 'wrong format'],
  ['unsupported package version', (k) => ({ ...k, version: 2 }), 'unsupported package version'],
  ['missing profile', (k) => ({ ...k, profile: 42 }), 'missing profile'],
  ['newer schema', (k) => withProfile(k, (p) => void (p.schemaVersion = 99)), 'schema 99 is newer than supported 1'],
  ['malformed profile shape', (k) => withProfile(k, (p) => void ((p as unknown as Record<string, unknown>)['currency'] = 'lots')), 'field currency must be number'],
  ['not an object', () => 'ashen-return-save', 'not a save package'],
  ['null', () => null, 'not a save package'],
];

describe('A19d — export / import', () => {
  let basePkg: Promise<ExportPackage> | null = null;
  /** Slot 1 of a throwaway database: deployed raid + one checkpoint (tick 77), exported. */
  function exportedRaidPackage(): Promise<ExportPackage> {
    basePkg ??= (async () => {
      const env = await freshEnv();
      const { svc, sim } = await deploy(env);
      expect(await svc.checkpoint(snapAt(sim, 77))).toBe(true);
      return env.store.exportSlot(1);
    })();
    return basePkg;
  }

  it('export → validateImport → importInto another slot yields an identical profile (except slotId/updatedAt) and raid', async () => {
    const env = await freshEnv();
    const { store } = env;
    const { svc, sim } = await deploy(env, 1);
    expect(await svc.checkpoint(snapAt(sim, 77))).toBe(true);
    const pkg = await store.exportSlot(1);
    expect(pkg).toMatchObject({ format: 'ashen-return-save', version: 1, gameVersion: '1.0.0', slotId: 1 });
    expect(typeof pkg.raid).toBe('string');
    expect(pkg.checksum).toBe(checksum(`${pkg.profile}|${pkg.raid}`));

    // What the UI writes to / reads from the downloaded file.
    const fileText = JSON.stringify(pkg);
    const v = SaveStore.validateImport(JSON.parse(fileText), content);
    expect('errors' in v ? v.errors : 'valid').toBe('valid');

    // Target slot 3 is occupied by an unrelated save that the import replaces atomically.
    await store.commit(3, mkProfile(3, 'Old-3', 10), null, 'newgame:3');
    expect(await store.importInto(3, JSON.parse(fileText), content)).toEqual({ ok: true });

    const src = expectLoaded(await store.load(1, content));
    const dst = expectLoaded(await store.load(3, content));
    expect(dst.profile.slotId).toBe(3);
    expect(dst.profile.name).toBe('Raider-1');
    expect(withoutSlotMeta(dst.profile)).toEqual(withoutSlotMeta(src.profile));
    expect(dst.raid).not.toBeNull();
    expect(dst.raid).toEqual(src.raid);
    expect(dst.raid!.tick).toBe(77);
    expect(dst.raidRecoveredFrom).toBeNull();
    const ptr3 = (await store.pointer(3))!;
    expect(ptr3.raidBackups).toEqual([ptr3.raid]); // the imported snapshot is pinned
    expect(ptr3.backups).toHaveLength(1); // the replaced save stays recoverable as a backup

    // Re-exporting the imported slot yields the same data again.
    const again = await store.exportSlot(3);
    expect(deserializeSim(again.raid!)).toEqual(deserializeSim(pkg.raid!));
    expect(withoutSlotMeta(JSON.parse(again.profile) as ProfileState)).toEqual(withoutSlotMeta(JSON.parse(pkg.profile) as ProfileState));
  });

  it('round trip of a shelter save without a raid snapshot', async () => {
    const env = await freshEnv();
    const { store } = env;
    const p = mkProfile(2, 'Homebody', 4321);
    grantItems(p, content, 'core.val.ring', 2, 'grant');
    p.perks = ['core.perk.combat.steady'];
    p.flags['deploy_allowed'] = true;
    await store.commit(2, p, null, 'newgame:2');
    const pkg = await store.exportSlot(2);
    expect(pkg.raid).toBeNull();
    expect(await store.importInto(1, JSON.parse(JSON.stringify(pkg)), content)).toEqual({ ok: true });
    const a = expectLoaded(await store.load(2, content));
    const b = expectLoaded(await store.load(1, content));
    expect(b.profile.slotId).toBe(1);
    expect(withoutSlotMeta(b.profile)).toEqual(withoutSlotMeta(a.profile));
    expect(countDef(b.profile.store, 'core.val.ring', homeContainers(b.profile))).toBe(2);
    expect(b.raid).toBeNull();
    expect(await store.pointer(1)).toMatchObject({ raid: null, raidBackups: [] });
  });

  it.each(TAMPERS)('rejects a tampered package (%s) and leaves the target slot byte-for-byte unchanged', async (_label, make, expected) => {
    const pkg = await exportedRaidPackage();
    const env = await freshEnv();
    await env.store.commit(2, mkProfile(2, 'Existing', 4242), null, 'newgame:2');
    const before = JSON.stringify(await dumpDb(env));
    const bad = make(structuredClone(pkg));
    const v = SaveStore.validateImport(bad, content);
    expect('errors' in v ? v.errors : 'accepted').toContain(expected);
    const r = await env.store.importInto(2, bad, content);
    expect(r).toEqual({ ok: false, errors: expect.arrayContaining([expected]) });
    expect(JSON.stringify(await dumpDb(env))).toBe(before);
    expect(expectLoaded(await env.store.load(2, content)).profile.name).toBe('Existing');
  });

  it('truncated package file text never reaches the store (JSON.parse fails before importInto)', async () => {
    const pkg = await exportedRaidPackage();
    expect(() => JSON.parse(half(JSON.stringify(pkg)))).toThrow(SyntaxError);
  });

  it('rejects a package whose raid snapshot references unknown definitions (nothing partially applied)', async () => {
    const pkg = await exportedRaidPackage();
    const bad = withRaid(pkg, (s) => {
      const id = s.loadoutItemIds[0]!;
      s.store.items[id]!.definitionId = 'ext.removed.weapon';
    });
    // Sanity: such a snapshot can never be resumed by load().
    expect(raidContentErrors(deserializeSim(bad.raid!), content)).toContain('unknown item ext.removed.weapon');
    const env = await freshEnv();
    await env.store.commit(2, mkProfile(2, 'Existing', 4242), null, 'newgame:2');
    const before = JSON.stringify(await dumpDb(env));
    const v = SaveStore.validateImport(bad, content);
    expect('errors' in v ? 'rejected' : 'accepted').toBe('rejected');
    const r = await env.store.importInto(2, bad, content);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(await dumpDb(env))).toBe(before);
  });

  it.each(PHASES)('an import whose commit fails at %s leaves the target slot unchanged, and reopening cleans up', async (phase) => {
    const pkg = await exportedRaidPackage();
    const env = await freshEnv();
    await env.store.commit(2, mkProfile(2, 'Existing', 4242), null, 'newgame:2');
    const ptr = await env.store.pointer(2);
    const existing = expectLoaded(await env.store.load(2, content));
    env.store.faultInjector = (ph) => {
      if (ph === phase) throw new DOMException('quota', 'QuotaExceededError');
    };
    await expect(env.store.importInto(2, pkg, content)).rejects.toThrow('quota');
    env.store.faultInjector = null;
    expect(await env.store.pointer(2)).toEqual(ptr);
    expect(expectLoaded(await env.store.load(2, content))).toEqual(existing);
    const store = await reopen(env);
    const dump = await dumpDb(env);
    expect(dump.journal).toEqual([]);
    expect(dump.records.map((r) => r.recordId)).toEqual(['2:p:1']);
    expect(expectLoaded(await store.load(2, content))).toEqual(existing);
  });
});

// --- A19e -------------------------------------------------------------------------------------------------------

describe('A19e — quota failure and crash safety', () => {
  it.each(PHASES)('QuotaExceededError at %s: run() → save.err.quota, in-memory profile unchanged, disk keeps the previous valid save', async (phase) => {
    const env = await freshEnv();
    const { store } = env;
    const p = mkProfile(1, 'Quota', 1500);
    await store.commit(1, p, null, 'newgame:1');
    const svc = new ProfileService(store, p);
    const first = await svc.run('tx:first', (d) => {
      d.currency += 100;
      grantItems(d, content, 'core.mat.cloth', 3, 'tx:first');
    });
    expect(first).toMatchObject({ ok: true, applied: true });
    const mem = svc.profile;
    const memSnap = structuredClone(mem);
    const disk = expectLoaded(await store.load(1, content));
    const ptr = await store.pointer(1);
    const recordIds = (await dumpDb(env)).records.map((r) => r.recordId);

    const seen: string[] = [];
    store.faultInjector = (ph) => {
      seen.push(ph);
      if (ph === phase) throw new DOMException('quota', 'QuotaExceededError');
    };
    let changes = 0;
    svc.onChange = () => {
      changes++;
    };
    const mutate = (d: ProfileState) => {
      d.currency -= 700;
      grantItems(d, content, 'core.val.ring', 1, 'tx:second');
    };
    const r = await svc.run('tx:second', mutate);
    expect(r).toEqual({ ok: false, applied: false, reason: 'save.err.quota' });
    expect(seen).toEqual(PHASES.slice(0, PHASES.indexOf(phase) + 1));
    expect(svc.profile).toBe(mem);
    expect(svc.profile).toEqual(memSnap);
    expect(changes).toBe(0);
    expect(svc.lastError).toContain('QuotaExceededError');
    expect(await store.pointer(1)).toEqual(ptr);
    expect(expectLoaded(await store.load(1, content))).toEqual(disk);
    const dump = await dumpDb(env);
    const pending = dump.journal.filter((j) => j.state === 'pending');
    if (phase === 'write') {
      expect(pending).toEqual([]);
      expect(dump.records.map((x) => x.recordId)).toEqual(recordIds);
    } else {
      expect(pending.map((j) => j.recordIds)).toEqual([['1:p:3']]);
    }

    // Space freed: the same transaction id can be retried because it was never committed.
    store.faultInjector = null;
    const retry = await svc.run('tx:second', mutate);
    expect(retry).toMatchObject({ ok: true, applied: true });
    expect(svc.profile.currency).toBe(memSnap.currency - 700);
    expect(changes).toBe(1);
    const reloaded = expectLoaded(await store.load(1, content)).profile;
    expect(reloaded.currency).toBe(memSnap.currency - 700);
    expect(countDef(reloaded.store, 'core.val.ring', homeContainers(reloaded))).toBe(1);
    expect(reloaded.ledger.committed).toEqual(['tx:first', 'tx:second']);
  });

  it('non-quota failures map to save.err.write; Firefox NS_ERROR_DOM_QUOTA_REACHED maps to save.err.quota', async () => {
    const env = await freshEnv();
    const p = mkProfile(1, 'Errors', 1000);
    await env.store.commit(1, p, null, 'newgame:1');
    const svc = new ProfileService(env.store, p);
    env.store.faultInjector = () => {
      throw new Error('EIO: device not ready');
    };
    expect(await svc.run('tx:a', (d) => void (d.currency = 1))).toEqual({ ok: false, applied: false, reason: 'save.err.write' });
    env.store.faultInjector = (ph) => {
      if (ph === 'verify') throw new DOMException('quota', 'NS_ERROR_DOM_QUOTA_REACHED');
    };
    expect(await svc.run('tx:b', (d) => void (d.currency = 2))).toEqual({ ok: false, applied: false, reason: 'save.err.quota' });
    expect(svc.profile).toBe(p);
    expect(svc.profile.currency).toBe(1000);
    env.store.faultInjector = null;
    expect(expectLoaded(await env.store.load(1, content)).profile.currency).toBe(1000);
  });

  it('checkpoint() under quota pressure returns false and keeps the previous raid snapshot', async () => {
    const env = await freshEnv();
    const { svc, sim } = await deploy(env);
    const ptr = await env.store.pointer(1);
    env.store.faultInjector = (ph) => {
      if (ph === 'swap') throw new DOMException('quota', 'QuotaExceededError');
    };
    expect(await svc.checkpoint(snapAt(sim, 500))).toBe(false);
    expect(svc.lastError).toContain('QuotaExceededError');
    env.store.faultInjector = null;
    expect(await env.store.pointer(1)).toEqual(ptr);
    const l = expectLoaded(await env.store.load(1, content));
    expect(l.raid).toEqual(roundTripped(sim));
    expect(l.raidRecoveredFrom).toBeNull();
  });

  it('queued transactions are serialized: a failed commit does not leak into the next queued transaction', async () => {
    const env = await freshEnv();
    const p = mkProfile(1, 'Queue', 1000);
    await env.store.commit(1, p, null, 'newgame:1');
    const svc = new ProfileService(env.store, p);
    let armed = true;
    env.store.faultInjector = (ph) => {
      if (armed && ph === 'swap') {
        armed = false;
        throw new DOMException('quota', 'QuotaExceededError');
      }
    };
    const [a, b] = await Promise.all([svc.run('tx:a', (d) => void (d.currency += 500)), svc.run('tx:b', (d) => void (d.currency += 1))]);
    expect(a).toEqual({ ok: false, applied: false, reason: 'save.err.quota' });
    expect(b).toMatchObject({ ok: true, applied: true });
    expect(svc.profile.currency).toBe(1001);
    expect(svc.profile.ledger.committed).toEqual(['tx:b']);
    expect(expectLoaded(await env.store.load(1, content)).profile.currency).toBe(1001);
  });

  it.each(['verify', 'swap'] as const)('crash at %s leaves a pending journal; reopening cleans unreferenced records and loads the previous valid state', async (phase) => {
    const env = await freshEnv();
    const { svc, sim } = await deploy(env); // seq 2 (deploy, pinned raid)
    expect(await svc.checkpoint(snapAt(sim, 30))).toBe(true); // seq 3
    const valid = expectLoaded(await env.store.load(1, content));
    const ptr = (await env.store.pointer(1))!;
    const referenced = [...new Set([ptr.profile, ptr.raid, ...ptr.backups, ...ptr.raidBackups].filter((x): x is string => !!x))].sort();

    env.store.faultInjector = (ph) => {
      if (ph === phase) throw new DOMException('quota', 'QuotaExceededError');
    };
    expect(await svc.checkpoint(snapAt(sim, 90))).toBe(false); // seq 4 dies after the temp records were written
    const mid = await dumpDb(env);
    expect(mid.journal.filter((j) => j.state === 'pending').map((j) => j.recordIds)).toEqual([['1:p:4', '1:r:4']]);
    expect(mid.records.map((r) => r.recordId)).toEqual(expect.arrayContaining(['1:p:4', '1:r:4']));
    expect(await env.store.pointer(1)).toEqual(ptr);

    // The tab dies; a new SaveStore opens the same database and runs journal recovery.
    const store = await reopen(env);
    const after = await dumpDb(env);
    expect(after.journal).toEqual([]);
    expect(after.records.map((r) => r.recordId).sort()).toEqual(referenced);
    expect(await store.pointer(1)).toEqual(ptr);
    const l = expectLoaded(await store.load(1, content));
    expect(l).toEqual(valid);
    expect(l.raid!.tick).toBe(30);

    // ...and the recovered store keeps working.
    const svc2 = new ProfileService(store, l.profile);
    expect(await svc2.checkpoint(snapAt(l.raid!, 45))).toBe(true);
    expect(expectLoaded(await store.load(1, content)).raid!.tick).toBe(45);
  });

  it('a stale pending journal row never deletes a record that a later successful commit made current', async () => {
    const env = await freshEnv();
    const p = mkProfile(1, 'Stale', 1000);
    await env.store.commit(1, p, null, 'newgame:1'); // seq 1
    const svc = new ProfileService(env.store, p);
    env.store.faultInjector = (ph) => {
      if (ph === 'verify') throw new DOMException('quota', 'QuotaExceededError');
    };
    expect((await svc.run('tx:a', (d) => void (d.currency = 1))).ok).toBe(false); // pending journal for 1:p:2
    env.store.faultInjector = null;
    expect(await svc.run('tx:b', (d) => void (d.currency = 2000))).toMatchObject({ ok: true, applied: true }); // 1:p:2 current
    expect((await dumpDb(env)).journal.filter((j) => j.state === 'pending')).toHaveLength(1);
    const store = await reopen(env);
    const l = expectLoaded(await store.load(1, content));
    expect(l.profile.currency).toBe(2000);
    expect(l.recoveredFrom).toBeNull();
    expect((await dumpDb(env)).journal).toEqual([]);
  });
});

// --- A19f -------------------------------------------------------------------------------------------------------

describe('A19f — meta settings', () => {
  it('getMeta/setMeta round trip, overwrite, independence from slots and survival across reopen', async () => {
    const env = await freshEnv();
    let store = env.store;
    expect(await store.getMeta('settings')).toBeNull();
    const d = defaultSettings();
    const settings: Settings = { ...d, uiScale: 125, subtitles: false, cameraShake: 0.25, volumes: { ...d.volumes, Music: 0.1, Voice: 0 }, bindings: { fire: ['Mouse0'], reload: ['KeyR', 'KeyT'] } };
    await store.setMeta('settings', settings);
    expect(await store.getMeta<Settings>('settings')).toEqual(settings);
    settings.uiScale = 999; // the stored value is a copy
    expect((await store.getMeta<Settings>('settings'))!.uiScale).toBe(125);
    await store.setMeta('settings', { ...settings, uiScale: 150 });
    expect((await store.getMeta<Settings>('settings'))!.uiScale).toBe(150);
    await store.setMeta('lastSlot', 2);
    expect(await store.getMeta<number>('lastSlot')).toBe(2);

    // Meta is not part of any slot: slot commits/deletion leave it alone; it survives a reopen.
    await store.commit(1, mkProfile(1, 'Meta'), null, 'newgame:1');
    await store.deleteSlot(1);
    store = await reopen(env);
    expect(await store.getMeta<Settings>('settings')).toEqual({ ...settings, uiScale: 150 });
    expect(await store.getMeta<number>('lastSlot')).toBe(2);

    // main.ts merges a partial saved settings object with the defaults.
    await store.setMeta('settings', { volumes: { Master: 0.2 }, uiScale: 125 });
    const saved = await store.getMeta<Partial<Settings>>('settings');
    const merged: Settings = { ...d, ...(saved ?? {}), volumes: { ...d.volumes, ...(saved?.volumes ?? {}) }, bindings: { ...(saved?.bindings ?? {}) } };
    expect(merged).toEqual({ ...d, uiScale: 125, volumes: { ...d.volumes, Master: 0.2 } });
  });
});
