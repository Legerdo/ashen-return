import type { ContentRegistry } from '../content/registry';
import { bagContainerId, destroyItem, findFreeSpot, instantiate, type ItemInstance } from '../inventory/store';
import { DEATHBAG, defaultSettings, INCOMING, loadoutContainers, SCHEMA_VERSION, SECURE_POCKET, SECURE_POCKET_SIZE, STASH, stashHeight, type ProfileState } from '../progression/profile';
import type { SimState } from '../world/state';

/**
 * Save schema validation, migration and missing-content quarantine.
 * Unknown definitions are never silently deleted: they move into profile.missingContent with the raw instance.
 */

export interface SchemaCheck {
  ok: boolean;
  errors: string[];
}

const REQUIRED_PROFILE: [keyof ProfileState, string][] = [
  ['schemaVersion', 'number'],
  ['slotId', 'number'],
  ['seed', 'string'],
  ['currency', 'number'],
  ['store', 'object'],
  ['quests', 'object'],
  ['ledger', 'object'],
  ['ids', 'object'],
  ['flags', 'object'],
  ['traders', 'object'],
  ['notes', 'object'],
  ['keys', 'object'],
];

/**
 * Legacy v0 layout (pre-release test saves): { version: 0, legacy: { money, slot, seed, name, items[] } }.
 * Migration is content-free: legacy items land in a list-kind stash that hydrateProfile() re-lays out into the
 * real grid once the content registry (item sizes) is known. Every structural field of v1 is created here.
 */
export function migrateProfile(raw: Record<string, unknown>): Record<string, unknown> {
  let r = { ...raw };
  const v = typeof r['schemaVersion'] === 'number' ? (r['schemaVersion'] as number) : typeof r['version'] === 'number' ? (r['version'] as number) : 0;
  if (v === 0 && !('store' in r) && 'legacy' in r) {
    const legacy = r['legacy'] as { money: number; slot: number; seed: string; name: string; items: ItemInstance[] };
    const items = legacy.items ?? [];
    const containers: Record<string, { id: string; kind: 'grid' | 'list' | 'slot'; w: number; h: number; items: string[]; accepts?: string }> = {
      stash: { id: STASH, kind: 'list', w: 0, h: 0, items: items.map((i) => i.instanceId) },
      [INCOMING]: { id: INCOMING, kind: 'list', w: 0, h: 0, items: [] },
      [DEATHBAG]: { id: DEATHBAG, kind: 'list', w: 0, h: 0, items: [] },
    };
    for (const cid of loadoutContainers()) containers[cid] = { id: cid, kind: 'slot', w: 1, h: 1, items: [], accepts: cid.split(':')[2]! };
    r = {
      schemaVersion: 1,
      gameVersion: 'legacy-0',
      contentVersion: 'legacy-0',
      slotId: legacy.slot,
      name: legacy.name,
      createdAt: 0,
      updatedAt: 0,
      playTime: 0,
      seed: legacy.seed,
      ledger: { committed: [] },
      // A fresh id prefix can never collide with the legacy instance ids.
      ids: { prefix: `s${legacy.slot}m0`, next: 1 },
      currency: legacy.money,
      store: { items: Object.fromEntries(items.map((i) => [i.instanceId, { ...i, ownerContainerId: STASH, gridPosition: null }])), containers },
      quests: {},
      traders: {},
      flags: {},
      notes: {},
      keys: { registered: [] },
      __migratedFrom: 0,
    };
  }
  return r;
}

/**
 * Content-aware completion after migration/normalization: required containers, the stash grid (legacy list stashes
 * are re-laid out, overflow goes to the incoming list) and per-definition quest/trader/note entries.
 */
export function hydrateProfile(p: ProfileState, content: ContentRegistry): void {
  const s = p.store;
  const ensure = (id: string, kind: 'grid' | 'list' | 'slot', w: number, h: number, accepts?: string) => {
    if (!s.containers[id]) s.containers[id] = { id, kind, w, h, items: [], ...(accepts ? { accepts } : {}) };
  };
  ensure(INCOMING, 'list', 0, 0);
  ensure(DEATHBAG, 'list', 0, 0);
  // Saves from before the secret pocket existed get an empty one.
  ensure(SECURE_POCKET, 'grid', SECURE_POCKET_SIZE.w, SECURE_POCKET_SIZE.h);
  for (const cid of loadoutContainers()) ensure(cid, 'slot', 1, 1, cid.split(':')[2]!);
  const stash = s.containers[STASH];
  if (!stash) ensure(STASH, 'grid', 12, stashHeight(p));
  else if (stash.kind !== 'grid') {
    const ids = [...stash.items];
    const grid = { id: STASH, kind: 'grid' as const, w: 12, h: stashHeight(p), items: [] as string[] };
    s.containers[STASH] = grid;
    for (const id of ids) {
      const it = s.items[id];
      if (!it) continue;
      const spot = content.hasItem(it.definitionId) ? findFreeSpot(s, content, grid, content.item(it.definitionId), id) : null;
      if (spot) {
        it.ownerContainerId = STASH;
        it.gridPosition = { x: spot.x, y: spot.y };
        it.rotation = spot.rotation;
        grid.items.push(id);
      } else {
        it.ownerContainerId = INCOMING;
        it.gridPosition = null;
        s.containers[INCOMING]!.items.push(id);
      }
    }
  }
  for (const q of content.quests.values()) p.quests[q.id] ??= { status: 'locked', progress: {} };
  for (const t of content.traders.values()) p.traders[t.id] ??= { trust: 0, generation: -1, stock: {} };
  for (const n of content.notes.values()) p.notes[n.id] ??= { found: false, read: false };
}

export function checkProfileShape(raw: unknown): SchemaCheck {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not an object'] };
  const o = raw as Record<string, unknown>;
  for (const [k, t] of REQUIRED_PROFILE) if (typeof o[k] !== t) errors.push(`field ${String(k)} must be ${t}`);
  if (typeof o['schemaVersion'] === 'number' && (o['schemaVersion'] as number) > SCHEMA_VERSION) errors.push(`schema ${o['schemaVersion']} is newer than supported ${SCHEMA_VERSION}`);
  const store = o['store'] as { items?: unknown; containers?: unknown } | undefined;
  if (store && (typeof store.items !== 'object' || typeof store.containers !== 'object')) errors.push('store malformed');
  return { ok: errors.length === 0, errors };
}

/** Fill fields introduced later with defaults so older v1 saves keep loading. */
export function normalizeProfile(p: ProfileState): ProfileState {
  const d = defaultSettings();
  p.settings = { ...d, ...(p.settings ?? {}), volumes: { ...d.volumes, ...(p.settings?.volumes ?? {}) } };
  p.missingContent ??= [];
  p.itemLog ??= [];
  p.log ??= [];
  p.forecasts ??= {};
  p.buildings ??= [];
  p.facilities ??= {};
  p.crafting ??= { jobs: [] };
  p.market ??= { generation: -1, offers: [] };
  p.contracts ??= { generation: -1, offers: [], completed: [] };
  p.chapter ??= { act: 0, completed: false, epilogueSeen: false };
  p.quickslots ??= [null, null, null, null];
  p.stats ??= { raids: 0, extractions: 0, deaths: 0, kills: 0, headshots: 0 };
  p.playerHp ??= 100;
  p.playerBleeding ??= false;
  // Saves from before the tutorial existed: those players already know the controls.
  p.tutorial ??= { step: 0, done: true, skipped: false };
  p.rangeWeapon ??= 'core.weapon.p9';
  p.reliefGeneration ??= -1;
  p.generation ??= 0;
  p.raidCounter ??= 0;
  p.perks = [...new Set(p.perks ?? [])];
  p.perkPoints ??= 0;
  p.exp ??= 0;
  p.level ??= 1;
  p.lastDeathBag ??= null;
  p.activeRaid ??= null;
  p.lastRaidSummary ??= null;
  return p;
}

function incomingList(p: ProfileState): { items: string[] } {
  const c = p.store.containers[INCOMING];
  if (c) return c;
  p.store.containers[INCOMING] = { id: INCOMING, kind: 'list', w: 0, h: 0, items: [] };
  return p.store.containers[INCOMING]!;
}

/** Move a known item out of an item that is about to be quarantined, into the incoming list. */
function rescue(p: ProfileState, childId: string): void {
  const c = p.store.items[childId];
  if (!c) return;
  const owner = c.ownerContainerId;
  if (owner?.startsWith('item:')) {
    const parent = p.store.items[owner.slice(5)];
    if (parent) {
      parent.containedItems = parent.containedItems.filter((x) => x !== childId);
      if (parent.weapon?.magazineId === childId) parent.weapon.magazineId = null;
      for (const [slot, id] of Object.entries(parent.attachments)) if (id === childId) delete parent.attachments[slot as keyof typeof parent.attachments];
    }
  } else if (owner) {
    const cont = p.store.containers[owner];
    if (cont) cont.items = cont.items.filter((x) => x !== childId);
  }
  c.ownerContainerId = INCOMING;
  c.gridPosition = null;
  incomingList(p).items.push(childId);
}

/** Bring quarantined state back once its definitions are registered again (e.g. the pack was re-installed). */
export function restoreQuarantined(p: ProfileState, content: ContentRegistry): number {
  const keep: ProfileState['missingContent'] = [];
  let restored = 0;
  const rounds = new Map<string, number>();
  for (const q of p.missingContent) {
    const kind = q.kind ?? 'item';
    if (kind === 'item' && content.hasItem(q.defId)) {
      const raw = structuredClone(q.raw) as ItemInstance;
      if (!p.store.items[raw.instanceId]) {
        // Children were rescued into incoming when quarantined; the item comes back on its own.
        raw.containedItems = [];
        raw.attachments = {};
        if (raw.weapon) {
          raw.weapon.magazineId = null;
          if (raw.weapon.chamber && !content.hasItem(raw.weapon.chamber)) raw.weapon.chamber = null;
          if (raw.weapon.tube) raw.weapon.tube = raw.weapon.tube.filter((r) => content.hasItem(r));
        }
        if (raw.mag) raw.mag.rounds = raw.mag.rounds.filter((r) => content.hasItem(r));
        raw.ownerContainerId = INCOMING;
        raw.gridPosition = null;
        p.store.items[raw.instanceId] = raw;
        incomingList(p).items.push(raw.instanceId);
        // A backpack comes back as a usable (empty) container: its old contents were rescued when it was quarantined.
        const bp = content.item(raw.definitionId).backpack;
        if (bp && !p.store.containers[bagContainerId(raw.instanceId)]) p.store.containers[bagContainerId(raw.instanceId)] = { id: bagContainerId(raw.instanceId), kind: 'grid', w: bp.w, h: bp.h, items: [] };
      }
      restored++;
    } else if (kind === 'round' && content.hasItem(q.defId)) {
      // Rounds stripped from known magazines/chambers come back as loose ammunition.
      rounds.set(q.defId, (rounds.get(q.defId) ?? 0) + 1);
      restored++;
    } else if (kind === 'quest' && content.quests.has(q.defId)) {
      p.quests[q.defId] ??= q.raw as ProfileState['quests'][string];
      restored++;
    } else if (kind === 'perk' && content.perks.has(q.defId)) {
      if (!p.perks.includes(q.defId)) p.perks.push(q.defId);
      restored++;
    } else if (kind === 'building' && content.buildings.has(q.defId)) {
      const b = q.raw as ProfileState['buildings'][number];
      if (!p.buildings.some((x) => x.guid === b.guid)) p.buildings.push(b);
      restored++;
    } else if (kind === 'key' && content.keys.has(q.defId)) {
      if (!p.keys.registered.includes(q.defId)) p.keys.registered.push(q.defId);
      restored++;
    } else if (kind === 'contract' && content.contracts.has(q.defId)) {
      const c = q.raw as ProfileState['contracts']['offers'][number];
      if (!p.contracts.offers.some((x) => x.id === c.id)) p.contracts.offers.push(c);
      restored++;
    } else if (kind === 'craft' && content.recipes.has(q.defId)) {
      const j = q.raw as ProfileState['crafting']['jobs'][number];
      if (!p.crafting.jobs.some((x) => x.jobId === j.jobId)) p.crafting.jobs.push(j);
      restored++;
    } else keep.push(q);
  }
  for (const [defId, qty] of rounds) {
    const max = Math.max(1, content.item(defId).stackMax);
    for (let left = qty; left > 0; left -= max) {
      const st = instantiate(content, p.ids, defId, { quantity: Math.min(max, left) });
      st.quantity = Math.min(max, left);
      st.ownerContainerId = INCOMING;
      p.store.items[st.instanceId] = st;
      incomingList(p).items.push(st.instanceId);
    }
  }
  p.missingContent = keep;
  return restored;
}

/**
 * Quarantine state whose definitions are not registered (e.g. a removed extension pack). Nothing is silently deleted:
 * the raw state is kept in profile.missingContent, known contents of unknown containers are rescued into the incoming
 * list, and everything is restored automatically when the definitions come back. Returns the number quarantined now.
 */
export function quarantineMissing(p: ProfileState, content: ContentRegistry): number {
  restoreQuarantined(p, content);
  let n = 0;
  const push = (e: ProfileState['missingContent'][number]) => {
    p.missingContent.push(e);
    n++;
  };
  const unknown = Object.values(p.store.items).filter((it) => !content.hasItem(it.definitionId));
  const unknownIds = new Set(unknown.map((i) => i.instanceId));
  for (const it of unknown) {
    for (const child of [...it.containedItems]) if (!unknownIds.has(child)) rescue(p, child);
    const bag = p.store.containers[bagContainerId(it.instanceId)];
    if (bag) for (const child of [...bag.items]) if (!unknownIds.has(child)) rescue(p, child);
  }
  for (const it of unknown) push({ kind: 'item', itemId: it.instanceId, defId: it.definitionId, raw: structuredClone(it) });
  for (const it of unknown) if (p.store.items[it.instanceId]) destroyItem(p.store, it.instanceId);
  p.quickslots = p.quickslots.map((q) => (q && p.store.items[q] ? q : null));
  // Unknown rounds inside known magazines / chambers / tubes.
  for (const it of Object.values(p.store.items)) {
    const strip = (list: string[]): string[] =>
      list.filter((r) => {
        if (content.hasItem(r)) return true;
        push({ kind: 'round', itemId: `round:${it.instanceId}:${n}`, defId: r, raw: { from: it.instanceId } });
        return false;
      });
    if (it.mag) it.mag.rounds = strip(it.mag.rounds);
    if (it.weapon?.tube) it.weapon.tube = strip(it.weapon.tube);
    if (it.weapon?.chamber && !content.hasItem(it.weapon.chamber)) {
      push({ kind: 'round', itemId: `round:${it.instanceId}:chamber`, defId: it.weapon.chamber, raw: { from: it.instanceId } });
      it.weapon.chamber = null;
    }
  }
  for (const [id, st] of Object.entries(p.quests)) {
    if (content.quests.has(id)) continue;
    push({ kind: 'quest', itemId: `quest:${id}`, defId: id, raw: st });
    delete p.quests[id];
  }
  for (const id of p.perks) if (!content.perks.has(id)) push({ kind: 'perk', itemId: `perk:${id}`, defId: id, raw: id });
  p.perks = p.perks.filter((x) => content.perks.has(x));
  for (const b of p.buildings) if (!content.buildings.has(b.buildingId)) push({ kind: 'building', itemId: `building:${b.guid}`, defId: b.buildingId, raw: b });
  p.buildings = p.buildings.filter((b) => content.buildings.has(b.buildingId));
  for (const k of p.keys.registered) if (!content.keys.has(k)) push({ kind: 'key', itemId: `key:${k}`, defId: k, raw: k });
  p.keys.registered = p.keys.registered.filter((k) => content.keys.has(k));
  for (const c of p.contracts.offers) if (!content.contracts.has(c.templateId)) push({ kind: 'contract', itemId: `contract:${c.id}`, defId: c.templateId, raw: c });
  p.contracts.offers = p.contracts.offers.filter((c) => content.contracts.has(c.templateId));
  for (const j of p.crafting.jobs) if (!content.recipes.has(j.recipeId)) push({ kind: 'craft', itemId: `craft:${j.jobId}`, defId: j.recipeId, raw: j });
  p.crafting.jobs = p.crafting.jobs.filter((j) => content.recipes.has(j.recipeId));
  if (!content.hasItem(p.rangeWeapon)) p.rangeWeapon = 'core.weapon.p9';
  return n;
}

/** Strict reference check used for imports (nothing partially applied on failure). */
export function referenceErrors(p: ProfileState, content: ContentRegistry): string[] {
  const errs: string[] = [];
  for (const it of Object.values(p.store.items)) {
    if (!content.hasItem(it.definitionId)) errs.push(`unknown item definition ${it.definitionId}`);
    if (it.mag) for (const r of it.mag.rounds) if (!content.hasItem(r)) errs.push(`unknown ammo ${r}`);
  }
  for (const id of Object.keys(p.quests)) if (!content.quests.has(id)) errs.push(`unknown quest ${id}`);
  for (const id of p.perks) if (!content.perks.has(id)) errs.push(`unknown perk ${id}`);
  for (const b of p.buildings) if (!content.buildings.has(b.buildingId)) errs.push(`unknown building ${b.buildingId}`);
  for (const id of Object.keys(p.traders)) if (!content.traders.has(id)) errs.push(`unknown trader ${id}`);
  return errs;
}

/** Pending NoiseEvents are kept so a resumed raid hears exactly what an uninterrupted one would. */
export function serializeSim(sim: SimState): string {
  return JSON.stringify({ ...sim, fx: [], loot: null, prompt: null });
}

export function deserializeSim(json: string): SimState {
  const s = JSON.parse(json) as SimState;
  s.fx = [];
  s.noises ??= [];
  s.loot = null;
  s.prompt = null;
  return s;
}

/** A raid snapshot is only resumable when every definition it references is registered. */
export function raidContentErrors(s: SimState, content: ContentRegistry): string[] {
  const errs: string[] = [];
  if (!content.maps.has(s.mapId)) errs.push(`unknown map ${s.mapId}`);
  for (const it of Object.values(s.store.items)) if (!content.hasItem(it.definitionId)) errs.push(`unknown item ${it.definitionId}`);
  for (const a of s.actors) if (a.kind === 'enemy' && a.archetypeId && !content.enemies.has(a.archetypeId)) errs.push(`unknown enemy ${a.archetypeId}`);
  return errs.slice(0, 10);
}
