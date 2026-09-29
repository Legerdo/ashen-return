import type { ContentRegistry } from '../content/registry';
import type { ProfileState } from '../progression/profile';
import type { SimState } from '../world/state';
import { checksum } from './checksum';
import { checkProfileShape, deserializeSim, hydrateProfile, migrateProfile, normalizeProfile, quarantineMissing, raidContentErrors, referenceErrors, serializeSim } from './schema';

/**
 * IndexedDB persistence.
 *   commit: write temp records + pending journal → read back & verify checksums → swap slot pointer (+ keep previous
 *   valid snapshots as backups) → mark journal committed. Any failure before the pointer swap leaves the previous
 *   valid save untouched (quota errors included).
 *   load:   definition registry → containers → items → equipment refs → progression/world → UI (validated here).
 */

export const DB_NAME = 'ashen-return';
export const DB_VERSION = 1;
export const SLOT_IDS = [1, 2, 3] as const;
export const PROFILE_BACKUPS = 3;

export interface RecordRow {
  recordId: string;
  slotId: number;
  kind: 'profile' | 'raid';
  seq: number;
  createdAt: number;
  checksum: string;
  payload: string;
}

export interface SlotSummary {
  name: string;
  level: number;
  act: number;
  playTime: number;
  currency: number;
  updatedAt: number;
  inRaid: boolean;
  chapterComplete: boolean;
}

export interface PointerRow {
  slotId: number;
  seq: number;
  profile: string | null;
  raid: string | null;
  backups: string[];
  raidBackups: string[];
  updatedAt: number;
  summary: SlotSummary | null;
}

export interface JournalRow {
  txId: string;
  slotId: number;
  state: 'pending' | 'committed';
  recordIds: string[];
  at: number;
}

export interface LoadResult {
  profile: ProfileState;
  raid: SimState | null;
  /** Set when the current record was corrupted and a backup was used (user confirmation required by the UI). */
  recoveredFrom: string | null;
  raidRecoveredFrom: string | null;
  quarantined: number;
}

export type LoadFailure = { kind: 'empty' } | { kind: 'corrupt'; errors: string[]; backups: string[] };

export interface ExportPackage {
  format: 'ashen-return-save';
  version: 1;
  exportedAt: number;
  gameVersion: string;
  slotId: number;
  profile: string;
  raid: string | null;
  checksum: string;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new DOMException('aborted', 'AbortError'));
  });
}

export class SaveStore {
  private db: IDBDatabase | null = null;
  /** Test hook: throw from here to simulate QuotaExceededError / crashes at a given commit phase. */
  faultInjector: ((phase: 'write' | 'verify' | 'swap') => void) | null = null;
  lastCommitMs = 0;

  constructor(
    private readonly factory: IDBFactory = globalThis.indexedDB,
    private readonly dbName: string = DB_NAME,
  ) {}

  async open(): Promise<void> {
    if (this.db) return;
    const r = this.factory.open(this.dbName, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'recordId' });
      if (!db.objectStoreNames.contains('pointers')) db.createObjectStore('pointers', { keyPath: 'slotId' });
      if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', { keyPath: 'txId' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    this.db = await req(r);
    await this.recoverJournal();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private get d(): IDBDatabase {
    if (!this.db) throw new Error('SaveStore not open');
    return this.db;
  }

  /** Remove records written by commits that never reached the pointer swap (crash / quota / tab close). */
  private async recoverJournal(): Promise<void> {
    const t = this.d.transaction(['journal', 'pointers', 'records'], 'readwrite');
    const journal = (await req(t.objectStore('journal').getAll())) as JournalRow[];
    const pointers = (await req(t.objectStore('pointers').getAll())) as PointerRow[];
    const referenced = new Set<string>();
    for (const p of pointers) for (const id of [p.profile, p.raid, ...p.backups, ...p.raidBackups]) if (id) referenced.add(id);
    for (const j of journal) {
      if (j.state === 'pending') for (const id of j.recordIds) if (!referenced.has(id)) t.objectStore('records').delete(id);
      t.objectStore('journal').delete(j.txId);
    }
    await done(t);
  }

  async pointer(slotId: number): Promise<PointerRow | null> {
    const t = this.d.transaction('pointers', 'readonly');
    const p = (await req(t.objectStore('pointers').get(slotId))) as PointerRow | undefined;
    return p ?? null;
  }

  async listSlots(): Promise<{ slotId: number; summary: SlotSummary | null }[]> {
    const out: { slotId: number; summary: SlotSummary | null }[] = [];
    for (const s of SLOT_IDS) {
      const p = await this.pointer(s);
      out.push({ slotId: s, summary: p?.profile ? p.summary : null });
    }
    return out;
  }

  private async readRecord(id: string): Promise<RecordRow | null> {
    const t = this.d.transaction('records', 'readonly');
    const r = (await req(t.objectStore('records').get(id))) as RecordRow | undefined;
    return r ?? null;
  }

  private static verify(r: RecordRow | null): boolean {
    return !!r && checksum(r.payload) === r.checksum;
  }

  /**
   * Atomic commit of a profile (and optionally the raid snapshot).
   * raid: undefined → keep current raid pointer; null → clear; SimState → new raid snapshot.
   */
  async commit(slotId: number, profile: ProfileState, raid: SimState | null | undefined, txId: string, opts: { pinRaid?: boolean } = {}): Promise<void> {
    const started = performance.now();
    const old = await this.pointer(slotId);
    const seq = (old?.seq ?? 0) + 1;
    const now = Date.now();
    profile.updatedAt = now;
    const pPayload = JSON.stringify(profile);
    const rows: RecordRow[] = [{ recordId: `${slotId}:p:${seq}`, slotId, kind: 'profile', seq, createdAt: now, checksum: checksum(pPayload), payload: pPayload }];
    let raidId: string | null | undefined = undefined;
    if (raid === null) raidId = null;
    else if (raid) {
      const rPayload = serializeSim(raid);
      rows.push({ recordId: `${slotId}:r:${seq}`, slotId, kind: 'raid', seq, createdAt: now, checksum: checksum(rPayload), payload: rPayload });
      raidId = `${slotId}:r:${seq}`;
    }
    const jid = `${txId}#${slotId}:${seq}`;
    // Phase 1: temp records + pending journal.
    this.faultInjector?.('write');
    {
      const t = this.d.transaction(['records', 'journal'], 'readwrite');
      for (const r of rows) t.objectStore('records').put(r);
      t.objectStore('journal').put({ txId: jid, slotId, state: 'pending', recordIds: rows.map((r) => r.recordId), at: now } satisfies JournalRow);
      await done(t);
    }
    // Phase 2: integrity verification by reading back.
    this.faultInjector?.('verify');
    for (const r of rows) {
      const back = await this.readRecord(r.recordId);
      if (!SaveStore.verify(back) || back!.payload !== r.payload) throw new Error(`save verification failed for ${r.recordId}`);
    }
    // Phase 3: pointer swap + backups + journal commit + cleanup (single IDB transaction).
    this.faultInjector?.('swap');
    {
      const t = this.d.transaction(['pointers', 'journal', 'records'], 'readwrite');
      const cur = ((await req(t.objectStore('pointers').get(slotId))) as PointerRow | undefined) ?? { slotId, seq: 0, profile: null, raid: null, backups: [], raidBackups: [], updatedAt: 0, summary: null };
      const backups = cur.profile ? [cur.profile, ...cur.backups].slice(0, PROFILE_BACKUPS) : cur.backups;
      let raidPtr = cur.raid;
      let raidBackups = cur.raidBackups;
      if (raidId === null) {
        raidPtr = null;
        raidBackups = [];
      } else if (raidId) {
        // Keep the pinned deployment snapshot + the previous checkpoint as raid backups.
        const pinned = opts.pinRaid ? [raidId] : cur.raidBackups.slice(0, 1);
        raidBackups = [...new Set([...pinned, ...(cur.raid && !opts.pinRaid ? [cur.raid] : [])])].slice(0, 2);
        raidPtr = raidId;
      }
      const next: PointerRow = {
        slotId,
        seq,
        profile: rows[0]!.recordId,
        raid: raidPtr,
        backups,
        raidBackups,
        updatedAt: now,
        summary: { name: profile.name, level: profile.level, act: profile.chapter.act, playTime: profile.playTime, currency: profile.currency, updatedAt: now, inRaid: !!profile.activeRaid, chapterComplete: profile.chapter.completed },
      };
      t.objectStore('pointers').put(next);
      t.objectStore('journal').put({ txId: jid, slotId, state: 'committed', recordIds: rows.map((r) => r.recordId), at: now } satisfies JournalRow);
      // Cleanup records no longer referenced by this slot.
      const keep = new Set([next.profile, next.raid, ...next.backups, ...next.raidBackups].filter(Boolean) as string[]);
      const all = (await req(t.objectStore('records').getAllKeys())) as string[];
      for (const k of all) if (k.startsWith(`${slotId}:`) && !keep.has(k)) t.objectStore('records').delete(k);
      await done(t);
    }
    this.lastCommitMs = performance.now() - started;
  }

  private parseProfile(r: RecordRow | null, content: ContentRegistry): { profile: ProfileState; quarantined: number } | { errors: string[] } {
    if (!r) return { errors: ['record missing'] };
    if (!SaveStore.verify(r)) return { errors: ['checksum mismatch'] };
    let raw: unknown;
    try {
      raw = JSON.parse(r.payload);
    } catch (e) {
      return { errors: [`json: ${String(e)}`] };
    }
    const migrated = migrateProfile(raw as Record<string, unknown>);
    const chk = checkProfileShape(migrated);
    if (!chk.ok) return { errors: chk.errors };
    const p = normalizeProfile(migrated as unknown as ProfileState);
    const quarantined = quarantineMissing(p, content);
    hydrateProfile(p, content);
    return { profile: p, quarantined };
  }

  async load(slotId: number, content: ContentRegistry, allowBackup = false): Promise<LoadResult | LoadFailure> {
    const ptr = await this.pointer(slotId);
    if (!ptr || !ptr.profile) return { kind: 'empty' };
    const primary = this.parseProfile(await this.readRecord(ptr.profile), content);
    let profile: ProfileState | null = null;
    let quarantined = 0;
    let recoveredFrom: string | null = null;
    if ('profile' in primary) {
      profile = primary.profile;
      quarantined = primary.quarantined;
    } else {
      if (!allowBackup) return { kind: 'corrupt', errors: primary.errors, backups: ptr.backups };
      for (const b of ptr.backups) {
        const r = this.parseProfile(await this.readRecord(b), content);
        if ('profile' in r) {
          profile = r.profile;
          quarantined = r.quarantined;
          recoveredFrom = b;
          break;
        }
      }
      if (!profile) return { kind: 'corrupt', errors: primary.errors, backups: [] };
    }
    let raid: SimState | null = null;
    let raidRecoveredFrom: string | null = null;
    if (profile.activeRaid) {
      // Latest snapshot first, then the backups from newest to oldest (the pinned deployment snapshot is the last resort).
      const seqOf = (id: string) => Number(id.split(':').pop() ?? 0);
      const backups = [...ptr.raidBackups].filter((id) => id !== ptr.raid).sort((a, b) => seqOf(b) - seqOf(a));
      const ids = [ptr.raid, ...backups].filter(Boolean) as string[];
      for (const id of ids) {
        const r = await this.readRecord(id);
        if (!SaveStore.verify(r)) continue;
        try {
          const s = deserializeSim(r!.payload);
          if (s.raidId !== profile.activeRaid.raidId) continue;
          if (raidContentErrors(s, content).length > 0) continue;
          raid = s;
          if (id !== ptr.raid) raidRecoveredFrom = id;
          break;
        } catch {
          continue;
        }
      }
    }
    return { profile, raid, recoveredFrom, raidRecoveredFrom, quarantined };
  }

  async deleteSlot(slotId: number): Promise<void> {
    const t = this.d.transaction(['pointers', 'records'], 'readwrite');
    t.objectStore('pointers').delete(slotId);
    const all = (await req(t.objectStore('records').getAllKeys())) as string[];
    for (const k of all) if (k.startsWith(`${slotId}:`)) t.objectStore('records').delete(k);
    await done(t);
  }

  async getMeta<T>(key: string): Promise<T | null> {
    const t = this.d.transaction('meta', 'readonly');
    const r = (await req(t.objectStore('meta').get(key))) as { key: string; value: T } | undefined;
    return r ? r.value : null;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    const t = this.d.transaction('meta', 'readwrite');
    t.objectStore('meta').put({ key, value });
    await done(t);
  }

  // --- export / import -----------------------------------------------------------------------------------------

  async exportSlot(slotId: number): Promise<ExportPackage> {
    const ptr = await this.pointer(slotId);
    if (!ptr?.profile) throw new Error('empty slot');
    const pr = await this.readRecord(ptr.profile);
    if (!SaveStore.verify(pr)) throw new Error('current save is corrupted; restore a backup before exporting');
    const rr = ptr.raid ? await this.readRecord(ptr.raid) : null;
    const raidPayload = rr && SaveStore.verify(rr) ? rr.payload : null;
    return { format: 'ashen-return-save', version: 1, exportedAt: Date.now(), gameVersion: __GAME_VERSION__, slotId, profile: pr!.payload, raid: raidPayload, checksum: checksum(`${pr!.payload}|${raidPayload ?? ''}`) };
  }

  /** Validate an export package completely before touching storage; then commit atomically into targetSlot. */
  static validateImport(pkg: unknown, content: ContentRegistry): { profile: ProfileState; raid: SimState | null } | { errors: string[] } {
    const errors: string[] = [];
    if (!pkg || typeof pkg !== 'object') return { errors: ['not a save package'] };
    const o = pkg as Partial<ExportPackage>;
    if (o.format !== 'ashen-return-save') errors.push('wrong format');
    if (o.version !== 1) errors.push('unsupported package version');
    if (typeof o.profile !== 'string') errors.push('missing profile');
    if (errors.length) return { errors };
    if (checksum(`${o.profile}|${o.raid ?? ''}`) !== o.checksum) return { errors: ['checksum mismatch'] };
    let raw: unknown;
    try {
      raw = JSON.parse(o.profile!);
    } catch {
      return { errors: ['profile json invalid'] };
    }
    const migrated = migrateProfile(raw as Record<string, unknown>);
    const chk = checkProfileShape(migrated);
    if (!chk.ok) return { errors: chk.errors };
    const profile = normalizeProfile(migrated as unknown as ProfileState);
    const refs = referenceErrors(profile, content);
    if (refs.length) return { errors: refs.slice(0, 10) };
    hydrateProfile(profile, content);
    let raid: SimState | null = null;
    if (o.raid) {
      try {
        raid = deserializeSim(o.raid);
      } catch {
        return { errors: ['raid json invalid'] };
      }
      if (!profile.activeRaid || raid.raidId !== profile.activeRaid.raidId) return { errors: ['raid snapshot does not match profile'] };
      // A raid that could not be resumed must not be imported: its loadout would be lost on the next load.
      const raidErrs = raidContentErrors(raid, content);
      if (raidErrs.length) return { errors: raidErrs };
    } else if (profile.activeRaid) return { errors: ['profile references a raid snapshot that is missing'] };
    return { profile, raid };
  }

  async importInto(targetSlot: number, pkg: unknown, content: ContentRegistry): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const v = SaveStore.validateImport(pkg, content);
    if ('errors' in v) return { ok: false, errors: v.errors };
    v.profile.slotId = targetSlot;
    await this.commit(targetSlot, v.profile, v.raid, `import:${Date.now()}`, { pinRaid: !!v.raid });
    return { ok: true };
  }

  /** Test/debug helper: corrupt the current profile record of a slot. */
  async corruptCurrent(slotId: number): Promise<void> {
    const ptr = await this.pointer(slotId);
    if (!ptr?.profile) return;
    const t = this.d.transaction('records', 'readwrite');
    const r = (await req(t.objectStore('records').get(ptr.profile))) as RecordRow;
    r.payload = r.payload.slice(0, Math.floor(r.payload.length / 2)) + '#corrupt#';
    t.objectStore('records').put(r);
    await done(t);
  }
}
