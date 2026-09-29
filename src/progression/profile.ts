import type { ContentRegistry } from '../content/registry';
import type { AudioBus, EquipSlot, PerkEffects, TimePhase, Weather } from '../content/types';
import { newCounter, type IdCounterState } from '../core/ids';
import type { TxLedgerState } from '../core/tx';
import { addContainer, bagContainerId, emptyStore, findFreeSpot, instantiate, moveItem, placeNew, type ItemInstance, type ItemStore } from '../inventory/store';
import { CONTENT_VERSION } from '../content/core';

export const SCHEMA_VERSION = 1;
export const STASH = 'stash';
export const INCOMING = 'incoming';
export const SHELF = 'shelf';
export const DEATHBAG = 'deathbag';
export const PLAYER = 'player';
/**
 * Secret pocket: a small secure container carried on every raid. Its contents are never lost — they come back on
 * death as well as on extraction. It is the player's pocket container in the raid sim (pk:player).
 */
export const SECURE_POCKET = 'pk:player';
/** TUNABLE: secret pocket grid size. */
export const SECURE_POCKET_SIZE = { w: 2, h: 2 } as const;
/** Item tag: the item itself survives death (returns to its slot empty; its contents go to the death bag). */
export const KEEP_ON_DEATH = 'keep_on_death';

export const EXP_TABLE = [0, 300, 800, 1500, 2400, 3500, 4800, 6300, 8000, 10000];
export const MAX_LEVEL = 10;

export interface Settings {
  volumes: Record<AudioBus, number>;
  uiScale: number;
  subtitles: boolean;
  /** Always-visible control-key strip along the bottom edge (the bottom HUD moves up above it). */
  keyHints: boolean;
  directionalAid: boolean;
  shapeCues: boolean;
  aimToggle: boolean;
  bindings: Record<string, string[]>;
  cameraShake: number;
  flashIntensity: number;
  damageNumbers: boolean;
  healthBars: boolean;
  debugOverlay: boolean;
  /** Procedural terrain layer on raid maps (start points, cover clusters, loot caches, ground patches per raid seed). */
  proceduralTerrain: boolean;
}

export function defaultSettings(): Settings {
  return {
    volumes: { Master: 0.8, Music: 0.5, Weapons: 0.8, Impacts: 0.8, Footsteps: 0.7, Ambience: 0.6, UI: 0.7, Voice: 0.8 },
    uiScale: 100,
    subtitles: true,
    keyHints: true,
    directionalAid: true,
    shapeCues: true,
    aimToggle: false,
    bindings: {},
    cameraShake: 1,
    flashIntensity: 1,
    damageNumbers: true,
    healthBars: false,
    debugOverlay: false,
    proceduralTerrain: true,
  };
}

export type QuestStatus = 'locked' | 'available' | 'active' | 'ready' | 'completed';
export interface QuestProgress {
  status: QuestStatus;
  progress: Record<string, number>;
}

export interface ContractObjective {
  type: 'Deliver' | 'Visit' | 'Kill' | 'HitPart' | 'ExtractWith' | 'Event';
  target: string;
  count: number;
  mapId: string | null;
  weaponTag: string | null;
  npcId: string | null;
}

export interface GeneratedContract {
  id: string;
  templateId: string;
  generation: number;
  giver: string;
  objective: ContractObjective;
  params: Record<string, string | number>;
  rewardCredits: number;
  rewardExp: number;
  trust: number;
  status: 'offered' | 'active' | 'ready' | 'completed';
  progress: number;
  /** Visit contracts also require a successful extraction after the visit. */
  needsExtract: boolean;
  visitedPending: boolean;
}

export interface TraderState {
  trust: number;
  generation: number;
  stock: Record<string, number>;
}

export interface MarketOffer {
  offerId: string;
  itemId: string;
  qty: number;
  price: number;
}

export interface PlacedBuilding {
  guid: string;
  buildingId: string;
  x: number;
  y: number;
  rot: 0 | 1;
}

export interface CraftJob {
  jobId: string;
  recipeId: string;
  station: string;
  remaining: number;
  total: number;
  fee: number;
}

export interface Forecast {
  destId: string;
  seed: string;
  phase: TimePhase;
  weather: Weather;
  generation: number;
}

export interface RaidSummary {
  raidId: string;
  mapId: string;
  outcome: 'extracted' | 'dead' | 'abandoned';
  exitId: string | null;
  kills: number;
  headshots: number;
  expGained: number;
  itemsIn: { defId: string; qty: number }[];
  itemsLost: { defId: string; qty: number }[];
  /** Death: what survived (secret pocket contents, keep-on-death items such as the basic bag). */
  itemsKept?: { defId: string; qty: number }[];
  incoming: number;
  levelUps: number;
  duration: number;
  questUpdates: string[];
  notesFound: string[];
  feePaid: number;
}

export interface ItemLogEntry {
  tx: string;
  event: 'create' | 'destroy' | 'transfer';
  defId: string;
  qty: number;
  itemId: string;
  reason: string;
}

export interface ProfileState {
  schemaVersion: number;
  gameVersion: string;
  contentVersion: string;
  slotId: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  playTime: number;
  seed: string;
  ledger: TxLedgerState;
  ids: IdCounterState;
  currency: number;
  store: ItemStore;
  quickslots: (string | null)[];
  chapter: { act: number; completed: boolean; epilogueSeen: boolean };
  quests: Record<string, QuestProgress>;
  contracts: { generation: number; offers: GeneratedContract[]; completed: string[] };
  exp: number;
  level: number;
  perkPoints: number;
  perks: string[];
  traders: Record<string, TraderState>;
  flags: Record<string, boolean>;
  buildings: PlacedBuilding[];
  facilities: Record<string, number>;
  notes: Record<string, { found: boolean; read: boolean }>;
  keys: { registered: string[] };
  market: { generation: number; offers: MarketOffer[] };
  crafting: { jobs: CraftJob[] };
  settings: Settings;
  lastDeathBag: { raidId: string; mapId: string; x: number; y: number } | null;
  activeRaid: { raidId: string; mapId: string; destId: string; startedAt: number } | null;
  raidCounter: number;
  generation: number;
  stats: { raids: number; extractions: number; deaths: number; kills: number; headshots: number };
  forecasts: Record<string, Forecast>;
  /** Quarantined state whose definitions are not registered (e.g. a removed extension pack). Restored when they return. */
  missingContent: { kind?: 'item' | 'round' | 'quest' | 'perk' | 'building' | 'key' | 'contract' | 'craft'; itemId: string; defId: string; raw: unknown }[];
  log: { key: string; params?: Record<string, string | number> }[];
  lastRaidSummary: RaidSummary | null;
  itemLog: ItemLogEntry[];
  rangeWeapon: string;
  reliefGeneration: number;
  /** Player condition carried between raids (death resets to full at the shelter). */
  playerHp: number;
  playerBleeding: boolean;
  /**
   * First-run controls tutorial: the next step to play (steps before it are done) and whether it is finished or was
   * skipped. Saves from before the tutorial existed load as done (see normalizeProfile).
   */
  tutorial: TutorialProgress;
}

export interface TutorialProgress {
  step: number;
  done: boolean;
  skipped: boolean;
}

export function levelForExp(exp: number): number {
  let lv = 1;
  for (let i = 0; i < EXP_TABLE.length; i++) if (exp >= EXP_TABLE[i]!) lv = i + 1;
  return Math.min(MAX_LEVEL, lv);
}

export function stashHeight(p: ProfileState): number {
  return (p.facilities['core.facility.stash'] ?? 0) > 0 ? 14 : 10;
}

export function logItem(p: ProfileState, e: ItemLogEntry): void {
  p.itemLog.push(e);
  if (p.itemLog.length > 600) p.itemLog.splice(0, p.itemLog.length - 600);
}

export function pushLog(p: ProfileState, key: string, params?: Record<string, string | number>): void {
  p.log.push(params ? { key, params } : { key });
  if (p.log.length > 80) p.log.splice(0, p.log.length - 80);
}

/** Player-owned profile containers that count as "home storage". */
export function homeContainers(p: ProfileState): string[] {
  const out = [STASH, INCOMING];
  if (p.store.containers[SHELF]) out.push(SHELF);
  return out;
}

export function loadoutContainers(): string[] {
  const slots: EquipSlot[] = ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'];
  return slots.map((s) => `eq:${PLAYER}:${s}`);
}

/** Deposit an owner-less or movable item into the stash (first fit), falling back to the incoming container. */
export function deposit(p: ProfileState, content: ContentRegistry, itemId: string, tx: string): 'stash' | 'shelf' | 'incoming' {
  const it = p.store.items[itemId];
  if (!it) throw new Error(`deposit: missing ${itemId}`);
  const def = content.item(it.definitionId);
  // Try merging stackables into existing stash stacks first.
  if (def.stackMax > 1) {
    for (const cid of [STASH, SHELF]) {
      const c = p.store.containers[cid];
      if (!c) continue;
      for (const oid of c.items) {
        const o = p.store.items[oid];
        if (!o || o === it || o.definitionId !== it.definitionId || o.modifiers.join() !== it.modifiers.join() || o.questTags.join() !== it.questTags.join()) continue;
        const room = def.stackMax - o.quantity;
        if (room <= 0) continue;
        const mv = Math.min(room, it.quantity);
        o.quantity += mv;
        it.quantity -= mv;
        if (it.quantity <= 0) {
          detachFromOwner(p.store, it);
          delete p.store.items[itemId];
          logItem(p, { tx, event: 'transfer', defId: it.definitionId, qty: mv, itemId, reason: `merged:${oid}` });
          return cid === SHELF ? 'shelf' : 'stash';
        }
      }
    }
  }
  for (const cid of [STASH, SHELF]) {
    const c = p.store.containers[cid];
    if (!c) continue;
    const spot = findFreeSpot(p.store, content, c, def, itemId);
    if (spot) {
      const bag = p.store.containers[bagContainerId(itemId)];
      if (def.kind === 'backpack' && bag && bag.items.length > 0) break;
      const r = moveOrAdopt(p.store, content, it, { containerId: cid, x: spot.x, y: spot.y, rotation: spot.rotation });
      if (r) return cid === SHELF ? 'shelf' : 'stash';
    }
  }
  moveOrAdopt(p.store, content, it, { containerId: INCOMING });
  return 'incoming';
}

function detachFromOwner(store: ItemStore, it: ItemInstance): void {
  if (!it.ownerContainerId) return;
  const c = store.containers[it.ownerContainerId];
  if (c) c.items = c.items.filter((x) => x !== it.instanceId);
  it.ownerContainerId = null;
}

function moveOrAdopt(store: ItemStore, content: ContentRegistry, it: ItemInstance, target: { containerId: string; x?: number; y?: number; rotation?: 0 | 1 }): boolean {
  if (it.ownerContainerId) return moveItem(store, content, it.instanceId, target, { allowNonEmptyBag: true }).ok;
  const c = store.containers[target.containerId];
  if (!c) return false;
  it.ownerContainerId = c.id;
  it.gridPosition = target.x !== undefined && target.y !== undefined ? { x: target.x, y: target.y } : null;
  if (target.rotation !== undefined) it.rotation = target.rotation;
  c.items.push(it.instanceId);
  return true;
}

/** Create new items (split into stacks) and deposit them. Returns created ids. */
export function grantItems(p: ProfileState, content: ContentRegistry, defId: string, qty: number, tx: string, opts: { modifiers?: string[]; durability?: number } = {}): string[] {
  const def = content.item(defId);
  const out: string[] = [];
  let left = qty;
  while (left > 0) {
    const q = Math.min(left, def.stackMax);
    const inst = instantiate(content, p.ids, defId, { quantity: q, ...(opts.modifiers ? { modifiers: opts.modifiers } : {}), ...(opts.durability !== undefined ? { durability: opts.durability } : {}) });
    inst.quantity = q;
    p.store.items[inst.instanceId] = inst;
    if (def.kind === 'backpack') addContainer(p.store, { id: bagContainerId(inst.instanceId), kind: 'grid', w: def.backpack!.w, h: def.backpack!.h });
    logItem(p, { tx, event: 'create', defId, qty: q, itemId: inst.instanceId, reason: 'grant' });
    const where = deposit(p, content, inst.instanceId, tx);
    if (p.store.items[inst.instanceId]) out.push(inst.instanceId);
    void where;
    left -= q;
  }
  return out;
}

export function aggregatePerks(content: ContentRegistry, perks: string[]): PerkEffects {
  const e: PerkEffects = {};
  // Each owned perk counts once, even if an imported save lists it twice.
  for (const id of new Set(perks)) {
    if (!content.perks.has(id)) continue;
    const pe = content.perk(id).effects;
    // Staged perks carry cumulative totals: take the maximum for additive stats.
    if (pe.staminaMax !== undefined) e.staminaMax = Math.max(e.staminaMax ?? 0, pe.staminaMax);
    if (pe.carryKg !== undefined) e.carryKg = Math.max(e.carryKg ?? 0, pe.carryKg);
    for (const k of ['healTimeMult', 'bandageTimeMult', 'bleedRateMult', 'stabilizeMult', 'reloadMult', 'swapTimeMult'] as const) if (pe[k] !== undefined) e[k] = (e[k] ?? 1) * pe[k]!;
    for (const k of ['searchSpeedMult', 'repairMult', 'recoilRecoveryMult'] as const) if (pe[k] !== undefined) e[k] = (e[k] ?? 1) * pe[k]!;
    if (pe.mapInfo) e.mapInfo = true;
  }
  return e;
}

/** Brand-new save slot: shelter, starter kit, Q01 active. */
export function newProfile(content: ContentRegistry, slotId: number, name: string, seed: string, now: number): ProfileState {
  const p: ProfileState = {
    schemaVersion: SCHEMA_VERSION,
    gameVersion: __GAME_VERSION__,
    contentVersion: CONTENT_VERSION,
    slotId,
    name,
    createdAt: now,
    updatedAt: now,
    playTime: 0,
    seed,
    ledger: { committed: [] },
    ids: newCounter(`s${slotId}`),
    currency: 1500,
    store: emptyStore(),
    quickslots: [null, null, null, null],
    chapter: { act: 0, completed: false, epilogueSeen: false },
    quests: {},
    contracts: { generation: 0, offers: [], completed: [] },
    exp: 0,
    level: 1,
    perkPoints: 0,
    perks: [],
    traders: {},
    flags: {},
    buildings: [],
    facilities: {},
    notes: {},
    keys: { registered: [] },
    market: { generation: 0, offers: [] },
    crafting: { jobs: [] },
    settings: defaultSettings(),
    lastDeathBag: null,
    activeRaid: null,
    raidCounter: 0,
    generation: 0,
    stats: { raids: 0, extractions: 0, deaths: 0, kills: 0, headshots: 0 },
    forecasts: {},
    missingContent: [],
    log: [],
    lastRaidSummary: null,
    itemLog: [],
    rangeWeapon: 'core.weapon.p9',
    reliefGeneration: -1,
    playerHp: 100,
    playerBleeding: false,
    tutorial: { step: 0, done: false, skipped: false },
  };
  addContainer(p.store, { id: STASH, kind: 'grid', w: 12, h: 10 });
  addContainer(p.store, { id: INCOMING, kind: 'list', w: 0, h: 0 });
  addContainer(p.store, { id: DEATHBAG, kind: 'list', w: 0, h: 0 });
  addContainer(p.store, { id: SECURE_POCKET, kind: 'grid', w: SECURE_POCKET_SIZE.w, h: SECURE_POCKET_SIZE.h });
  for (const cid of loadoutContainers()) addContainer(p.store, { id: cid, kind: 'slot', w: 1, h: 1, accepts: cid.split(':')[2] });
  for (const q of content.quests.values()) p.quests[q.id] = { status: 'locked', progress: {} };
  for (const t of content.traders.values()) p.traders[t.id] = { trust: 0, generation: -1, stock: {} };
  for (const n of content.notes.values()) p.notes[n.id] = { found: false, read: false };
  const tx = 'newprofile';
  // Starter loadout: P9 with a full magazine + 2 spare, knife, basic bag, bandages.
  const put = (defId: string, cid: string, fill?: string) => {
    const it = instantiate(content, p.ids, defId);
    const r = placeNew(p.store, content, it, { containerId: cid });
    if (!r.ok) throw new Error(`starter ${defId}: ${r.error}`);
    if (fill && it.mag) it.mag.rounds = Array.from({ length: content.item(defId).magazine!.capacity }, () => fill);
    logItem(p, { tx, event: 'create', defId, qty: 1, itemId: it.instanceId, reason: 'starter' });
    return it;
  };
  const bag = put('core.bag.basic', `eq:${PLAYER}:backpack`);
  const bagCid = bagContainerId(bag.instanceId);
  put('core.melee.knife', `eq:${PLAYER}:melee`);
  const p9 = put('core.weapon.p9', `eq:${PLAYER}:secondary`);
  const mag = instantiate(content, p.ids, 'core.mag.p9');
  mag.mag!.rounds = Array.from({ length: 15 }, () => 'core.ammo.9.fmj');
  p.store.items[mag.instanceId] = mag;
  mag.ownerContainerId = `item:${p9.instanceId}`;
  p9.containedItems.push(mag.instanceId);
  p9.weapon!.magazineId = mag.instanceId;
  p9.weapon!.chamber = mag.mag!.rounds.pop()!;
  put('core.mag.p9', bagCid, 'core.ammo.9.fmj');
  put('core.mag.p9', bagCid, 'core.ammo.9.fmj');
  const band = instantiate(content, p.ids, 'core.med.bandage', { quantity: 2 });
  band.quantity = 2;
  placeNew(p.store, content, band, { containerId: bagCid });
  p.quickslots[0] = band.instanceId;
  // Starter stash: a worn carbine with ammo, spare 9mm, cloth.
  grantItems(p, content, 'core.weapon.c556', 1, tx, { durability: 72 });
  const c1 = grantItems(p, content, 'core.mag.c556', 2, tx);
  for (const id of c1) p.store.items[id]!.mag!.rounds = Array.from({ length: 20 }, () => 'core.ammo.556.fmj');
  grantItems(p, content, 'core.ammo.556.fmj', 40, tx);
  grantItems(p, content, 'core.ammo.9.fmj', 45, tx);
  grantItems(p, content, 'core.mat.cloth', 2, tx);
  p.quests['core.quest.q01_ready'] = { status: 'active', progress: {} };
  return p;
}
