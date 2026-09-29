import type { ContentRegistry } from '../content/registry';
import type { ContainerSpawnDef, MapDef } from '../content/mapTypes';
import type { EnemyArchetypeDef, EquipSlot, PerkEffects, TimePhase, Weather } from '../content/types';
import { newCounter } from '../core/ids';
import { Rng, RngStreams } from '../core/rng';
import { SIM_DT } from '../core/clock';
import { addContainer, attachChild, emptyStore, instantiate, placeNew, type ItemStore } from '../inventory/store';
import { makeContext, type SimContext } from './context';
import { WorldGeometry } from './geometry';
import { eqContainerId, emptyProgress, emptyStats, pocketContainerId, type ActorState, type AIMode, type AIState, type SimState } from './state';
import { setupEventActors, spawnEvents } from './events';
import { cappedArmorTier, eligibleAt, groupCount, groupThreat } from './threat';
import { raidMap } from './procgen';

export function newActor(id: string, kind: ActorState['kind'], x: number, y: number, hp: number, team: ActorState['team']): ActorState {
  return {
    id,
    kind,
    team,
    archetypeId: null,
    x,
    y,
    px: x,
    py: y,
    floor: 0,
    vx: 0,
    vy: 0,
    stance: 'stand',
    sprinting: false,
    moving: false,
    hp,
    maxHp: hp,
    stamina: 100,
    staminaMax: 100,
    staminaIdle: 10,
    status: { bleeding: false, painkillerUntil: -1, flashedUntil: -1, lastHitTime: -99 },
    activeSlot: 'primary1',
    quickslots: [null, null, null, null],
    action: null,
    handling: { nextShotTime: 0, lastShotTime: -99, bloom: 0, recoilPitch: 0, recoilYaw: 0, shotIndex: 0, adsT: 0, triggerHeld: false, semiBufferedUntil: -1, muzzleZ: 1.0, muzzleRaised: false, weaponId: null },
    aim: { dirX: 1, dirY: 0, tracking: true, targetX: x + 3, targetY: y, targetZ: 1.0, targetActorId: null, muzzleBlocked: false, lowCoverAhead: false, faceRight: true },
    alive: true,
    deathTick: null,
    deathEventId: null,
    hitbox: 'core.hitbox.standing',
    ai: null,
    dummy: null,
    footstepDist: 0,
    radius: 0.3,
    invulnerable: false,
  };
}

export function ensureEquipContainers(store: ItemStore, actorId: string): void {
  const slots: EquipSlot[] = ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'];
  for (const s of slots) addContainer(store, { id: eqContainerId(actorId, s), kind: 'slot', w: 1, h: 1, accepts: s });
}

export function emptySim(mode: SimState['mode'], raidId: string, mapId: string, seed: string, phase: TimePhase, weather: Weather): SimState {
  return {
    version: 1,
    mode,
    raidId,
    mapId,
    seed,
    tick: 0,
    time: 0,
    rng: RngStreams.create(seed).getState(),
    ids: newCounter(raidId),
    env: { phase, weather },
    actors: [],
    store: emptyStore(),
    containers: {},
    doors: {},
    obstacleHp: {},
    projectiles: [],
    thrown: [],
    smokes: [],
    exits: {},
    events: [],
    progress: emptyProgress(),
    processedDeaths: [],
    outcome: null,
    stats: emptyStats(),
    shotLog: [],
    flags: {},
    registeredKeys: [],
    credits: 0,
    loadoutItemIds: [],
    activeQuests: [],
    perks: {},
    notes: [],
    deathBagContainerId: null,
    range: null,
    lastCheckpointTime: 0,
    loot: null,
    prompt: null,
    fx: [],
    noises: [],
    debug: { god: false, infiniteAmmo: false, freezeAI: false },
  };
}

export function newAIState(role: string, x: number, y: number, patrol: { x: number; y: number }[], mode: AIMode): AIState {
  return {
    mode,
    role,
    detection: 0,
    targetId: null,
    lastSeenX: x,
    lastSeenY: y,
    lastSeenTime: -99,
    lastHeardX: x,
    lastHeardY: y,
    lastHeardTime: -99,
    investigateX: x,
    investigateY: y,
    path: [],
    pathIndex: 0,
    repathAt: 0,
    goalX: x,
    goalY: y,
    coverX: null,
    coverY: null,
    nextDecisionAt: 0,
    burstLeft: 0,
    burstPauseUntil: 0,
    telegraphUntil: 0,
    telegraphing: false,
    shotsSinceRelocate: 0,
    patrolIndex: 0,
    patrol: patrol.map((p) => ({ ...p })),
    homeX: x,
    homeY: y,
    facing: 0,
    stuckTime: 0,
    lastPosX: x,
    lastPosY: y,
    reactionUntil: 0,
    alertShared: false,
    phase: 0,
    grenadesLeft: 0,
    supportsCalled: 0,
    modeSince: 0,
    searchUntil: 0,
    aimErrYaw: 0,
    aimErrPitch: 0,
    wantCrouch: false,
  };
}

/**
 * Standard (smallest-capacity) magazine definition of a family, found by data so extension packs can ship their own.
 * Core families keep their canonical `core.mag.<family>` id when it exists.
 */
export function standardMagazineFor(content: ContentRegistry, family: string, caliber: string): string {
  const canonical = `core.mag.${family}`;
  if (content.hasItem(canonical)) return canonical;
  const mags = [...content.items.values()].filter((d) => d.magazine && d.magazine.family === family && d.magazine.caliber === caliber);
  mags.sort((a, b) => a.magazine!.capacity - b.magazine!.capacity || a.id.localeCompare(b.id));
  if (!mags[0]) throw new Error(`no magazine definition for family ${family}`);
  return mags[0].id;
}

/** Load a weapon with a full magazine + chamber; returns weapon id. */
export function giveLoadedWeapon(content: ContentRegistry, sim: SimState, containerId: string, weaponDefId: string, ammoDefId: string, spareMags: number, looseRounds: number, spareContainer: string | null): string {
  const store = sim.store;
  const wdef = content.item(weaponDefId);
  const spec = wdef.weapon!;
  const w = instantiate(content, sim.ids, weaponDefId);
  const placed = placeNew(store, content, w, { containerId });
  if (!placed.ok) throw new Error(`cannot place weapon ${weaponDefId} into ${containerId}: ${placed.error}`);
  if (spec.magazineFamily) {
    const magDefId = standardMagazineFor(content, spec.magazineFamily, spec.caliber);
    const mag = instantiate(content, sim.ids, magDefId);
    const cap = content.item(magDefId).magazine!.capacity;
    mag.mag!.rounds = Array.from({ length: cap }, () => ammoDefId);
    store.items[mag.instanceId] = mag;
    attachChild(store, w.instanceId, mag.instanceId, { magazine: true });
    w.weapon!.chamber = mag.mag!.rounds.pop()!;
    for (let i = 0; i < spareMags && spareContainer; i++) {
      const sm = instantiate(content, sim.ids, magDefId);
      sm.mag!.rounds = Array.from({ length: cap }, () => ammoDefId);
      placeNew(store, content, sm, { containerId: spareContainer });
    }
  } else {
    w.weapon!.tube = Array.from({ length: spec.capacity }, () => ammoDefId);
    w.weapon!.chamber = w.weapon!.tube.pop()!;
  }
  let loose = looseRounds;
  while (loose > 0 && spareContainer) {
    const stackMax = content.item(ammoDefId).stackMax;
    const q = Math.min(stackMax, loose);
    const st = instantiate(content, sim.ids, ammoDefId, { quantity: q });
    st.quantity = q;
    if (!placeNew(store, content, st, { containerId: spareContainer }).ok) break;
    loose -= q;
  }
  return w.instanceId;
}

function weightedPick<T extends { weight: number }>(rng: Rng, list: T[]): T {
  return rng.weighted(list.map((v) => ({ weight: v.weight, value: v })));
}

export interface SpawnEnemyOpts {
  patrol?: { x: number; y: number }[];
  mode?: AIMode;
  investigate?: { x: number; y: number };
  idPrefix?: string;
  /** Spawn-group threat tier (world/threat.ts): gates weapons, caps armor, sets the AI skill. Absent = unscaled. */
  threat?: number;
}

/** Spawn an enemy with a real, finite loadout (weapon + magazines + loose rounds + armor + pocket loot). */
export function spawnEnemy(content: ContentRegistry, sim: SimState, archetypeId: string, x: number, y: number, rng: Rng, opts: SpawnEnemyOpts = {}): ActorState {
  const arch: EnemyArchetypeDef = content.enemy(archetypeId);
  const id = `${opts.idPrefix ?? 'e'}${sim.ids.next++}`;
  const a = newActor(id, 'enemy', x, y, arch.hp, 'hostile');
  a.archetypeId = archetypeId;
  a.hitbox = arch.role === 'boss' ? 'core.hitbox.large' : 'core.hitbox.standing';
  a.staminaMax = 100;
  ensureEquipContainers(sim.store, id);
  addContainer(sim.store, { id: pocketContainerId(id), kind: 'list', w: 0, h: 0 });
  // Threat scaling keeps the number of random draws identical (one weighted pick per pool), only the pools change.
  const wpick = weightedPick(rng, eligibleAt(arch.weapons, opts.threat));
  const slot: EquipSlot = content.item(wpick.itemId).weapon!.class === 'pistol' ? 'secondary' : 'primary1';
  giveLoadedWeapon(content, sim, eqContainerId(id, slot), wpick.itemId, wpick.ammoId, rng.int(wpick.spareMags[0], wpick.spareMags[1]), rng.int(wpick.looseRounds[0], wpick.looseRounds[1]), pocketContainerId(id));
  a.activeSlot = slot;
  const vt = cappedArmorTier(weightedPick(rng, arch.vest).tier, opts.threat);
  if (vt > 0) placeNew(sim.store, content, instantiate(content, sim.ids, `core.armor.vest${vt}`), { containerId: eqContainerId(id, 'vest') });
  const ht = cappedArmorTier(weightedPick(rng, arch.helmet).tier, opts.threat);
  if (ht > 0) placeNew(sim.store, content, instantiate(content, sim.ids, `core.armor.helmet${ht}`), { containerId: eqContainerId(id, 'helmet') });
  placeNew(sim.store, content, instantiate(content, sim.ids, 'core.melee.knife'), { containerId: eqContainerId(id, 'melee') });
  // Pocket loot (rolled once at spawn; the corpse later exposes exactly these items).
  const table = content.loot(arch.lootTable);
  const rolls = rng.int(table.rolls[0], table.rolls[1]);
  for (let i = 0; i < rolls; i++) {
    const e = weightedPick(rng, table.entries);
    const q = rng.int(e.qty[0], e.qty[1]);
    const inst = instantiate(content, sim.ids, e.itemId, { quantity: q });
    placeNew(sim.store, content, inst, { containerId: pocketContainerId(id) });
  }
  if (arch.role === 'boss') {
    placeNew(sim.store, content, instantiate(content, sim.ids, 'core.med.firstaid'), { containerId: pocketContainerId(id) });
    // Max 3 targeted grenades: real items, consumed when thrown.
    const frags = instantiate(content, sim.ids, 'core.throw.frag', { quantity: 3 });
    frags.quantity = 3;
    placeNew(sim.store, content, frags, { containerId: pocketContainerId(id) });
  }
  const mode: AIMode = opts.mode ?? (opts.patrol && opts.patrol.length > 1 ? 'Patrol' : 'Idle');
  a.ai = newAIState(arch.role, x, y, opts.patrol ?? [], mode);
  if (opts.threat !== undefined) a.ai.skill = opts.threat;
  if (arch.role === 'boss') a.ai.grenadesLeft = 3;
  if (opts.investigate) {
    a.ai.investigateX = opts.investigate.x;
    a.ai.investigateY = opts.investigate.y;
    a.ai.lastHeardX = opts.investigate.x;
    a.ai.lastHeardY = opts.investigate.y;
    a.ai.lastHeardTime = sim.time;
  }
  const ang = rng.range(0, Math.PI * 2);
  a.aim.dirX = Math.cos(ang);
  a.aim.dirY = Math.sin(ang);
  a.aim.faceRight = a.aim.dirX >= 0;
  a.ai.facing = ang;
  sim.actors.push(a);
  return a;
}

/** Roll a world container's contents once (at raid creation). */
export function fillContainer(content: ContentRegistry, sim: SimState, cid: string, def: ContainerSpawnDef, rng: Rng, launch: RaidLaunch | null): void {
  const store = sim.store;
  const extra: { itemId: string; qty: number; questTags?: string[] }[] = [];
  for (const q of def.questItems ?? []) {
    if (!launch) continue;
    if (!launch.activeQuests.includes(q.questId)) continue;
    if (q.unlessFlag && launch.flags[q.unlessFlag]) continue;
    if (launch.questItemsHeld.includes(q.itemId)) continue;
    extra.push({ itemId: q.itemId, qty: q.qty, questTags: content.item(q.itemId).kind === 'quest' ? content.item(q.itemId).tags : [] });
  }
  if (def.keyItem && launch) {
    const keyId = content.item(def.keyItem).keyId!;
    if (!launch.registeredKeys.includes(keyId) && !launch.keyItemsHeld.includes(def.keyItem)) extra.push({ itemId: def.keyItem, qty: 1 });
  }
  for (const g of def.guaranteed ?? []) extra.push({ itemId: g.itemId, qty: g.qty });
  const cont = store.containers[cid]!;
  for (const e of extra) {
    const inst = instantiate(content, sim.ids, e.itemId, { quantity: e.qty, ...(e.questTags ? { questTags: e.questTags } : {}) });
    inst.quantity = Math.min(e.qty, content.item(e.itemId).stackMax);
    if (!placeNew(store, content, inst, { containerId: cont.id }).ok) {
      // Story items must never vanish: grow the container instead of dropping them.
      cont.h += 2;
      placeNew(store, content, inst, { containerId: cont.id });
    }
  }
  const table = content.loot(def.lootTable);
  const rolls = rng.int(table.rolls[0], table.rolls[1]);
  for (let i = 0; i < rolls; i++) {
    const eligible = table.entries.filter((e) => !e.minTrust);
    if (eligible.length === 0) break;
    const e = weightedPick(rng, eligible);
    const q = rng.int(e.qty[0], e.qty[1]);
    const inst = instantiate(content, sim.ids, e.itemId, { quantity: q });
    inst.quantity = Math.max(1, Math.min(q, content.item(e.itemId).stackMax));
    if (content.item(e.itemId).weapon) inst.durability = Math.round(rng.range(55, 95));
    if (content.item(e.itemId).armor) inst.durability = Math.round(content.item(e.itemId).armor!.maxDurability * rng.range(0.5, 1));
    const r = placeNew(store, content, inst, { containerId: cont.id });
    if (!r.ok) break;
  }
  for (const g of table.guaranteed ?? []) {
    const inst = instantiate(content, sim.ids, g.itemId, { quantity: rng.int(g.qty[0], g.qty[1]) });
    placeNew(store, content, inst, { containerId: cont.id });
  }
}

export interface RaidLaunch {
  raidId: string;
  mapId: string;
  seed: string;
  phase: TimePhase;
  weather: Weather;
  flags: Record<string, boolean>;
  registeredKeys: string[];
  activeQuests: string[];
  /** Quest item definitions the player already holds/extracted (so they are not duplicated). */
  questItemsHeld: string[];
  keyItemsHeld: string[];
  perks: PerkEffects;
  notesKnown: string[];
  /** Loadout store: items owned by eq:player:* and their descendants. */
  loadout: ItemStore;
  quickslots: (string | null)[];
  deathBag: { store: ItemStore; rootIds: string[]; x: number; y: number; sourceRaidId: string } | null;
  bossActive: boolean;
  /** Raid threat tier 0–3 from story progress (world/threat.ts). Absent: enemy loadouts, numbers and skill unscaled. */
  threat?: number;
  /** Procedural layout seed (world/procgen.ts): the raid runs on raidMap(mapId, layoutSeed). Absent: the authored map. */
  layoutSeed?: string;
}

/** The map a raid runs on: the authored map, or its procedural layer when the raid carries a layout seed. */
export function raidMapFor(content: ContentRegistry, sim: Pick<SimState, 'mapId' | 'layoutSeed'>): MapDef {
  return sim.layoutSeed ? raidMap(content, sim.mapId, sim.layoutSeed) : content.map(sim.mapId);
}

/** Geometry for a raid snapshot (creation and every resume rebuild the same layout from the stored seed). */
export function raidGeometry(content: ContentRegistry, sim: Pick<SimState, 'mapId' | 'layoutSeed'>): WorldGeometry {
  return new WorldGeometry(raidMapFor(content, sim), content);
}

/** Minimum distance between the player spawn and any hostile present at raid start. */
export const SAFE_SPAWN_DIST = 18;

function spawnSafe(geo: WorldGeometry, x: number, y: number, enemies: { x: number; y: number }[]): boolean {
  for (const e of enemies) if (Math.hypot(e.x - x, e.y - y) < SAFE_SPAWN_DIST) return false;
  return geo.movementBlockers(x, y, 0.35, 0, { doors: {}, obstacleHp: {}, smokes: [], time: 0 }).length === 0;
}

export function createRaidSim(content: ContentRegistry, launch: RaidLaunch): { sim: SimState; ctx: SimContext } {
  const sim = emptySim('raid', launch.raidId, launch.mapId, launch.seed, launch.phase, launch.weather);
  if (launch.threat !== undefined) sim.threat = launch.threat;
  if (launch.layoutSeed !== undefined) sim.layoutSeed = launch.layoutSeed;
  const map: MapDef = raidMapFor(content, sim);
  sim.flags = { ...launch.flags };
  sim.registeredKeys = [...launch.registeredKeys];
  sim.activeQuests = [...launch.activeQuests];
  sim.perks = { ...launch.perks };
  sim.notes = [...launch.notesKnown];
  const geo = new WorldGeometry(map, content);
  const ctx = makeContext(sim, content, geo);
  const worldRng = ctx.rng.get('world');
  const lootRng = ctx.rng.get('loot');
  const enemyRng = ctx.rng.get('enemy');
  // Doors
  for (const d of map.doors) sim.doors[d.id] = { open: d.startOpen, locked: !!(d.keyId || d.powerFlag) && !(d.powerFlag && launch.flags[d.powerFlag] && !d.keyId) };
  // Events first (event containers depend on them).
  spawnEvents(ctx, launch);
  // Containers
  for (const cdef of map.containers) {
    let c = cdef;
    if (c.eventId) {
      const ev = sim.events.find((e) => e.defId === c.eventId);
      if (!ev) continue;
      // Emergency signal: only the crate at the chosen flare spot exists; trap variant carries poor loot.
      if (c.eventId === 'core.event.emergency_signal') {
        if (Math.hypot(ev.x - c.x, ev.y - c.y) > 1) continue;
        if (ev.variant === 'trap') c = { ...c, lootTable: 'core.loot.signal_trap' };
      }
    }
    const t = content.containerType(c.type);
    const cid = `ct:${c.id}`;
    addContainer(sim.store, { id: cid, kind: 'grid', w: t.gridW, h: t.gridH });
    sim.containers[cid] = {
      id: cid,
      kind: c.eventId ? 'event' : 'world',
      typeId: c.type,
      x: c.x,
      y: c.y,
      floor: 0,
      searched: 0,
      searchProgress: 0,
      keyId: c.keyId,
      locked: !!c.keyId || !!c.eventId,
      actorId: null,
      nameKey: t.nameKey,
      createdTick: 0,
      opened: false,
    };
    fillContainer(content, sim, cid, c, lootRng, launch);
    const ev = c.eventId ? sim.events.find((e) => e.defId === c.eventId) : undefined;
    if (ev) {
      ev.data['containerId'] = cid;
      // Only the pump crate stays sealed until the event succeeds; other event crates open freely.
      if (ev.defId !== 'core.event.pump_restart') sim.containers[cid]!.locked = false;
    }
  }
  // Player spawn is chosen before any hostile exists: clear of obstacles and away from event actors (convoy start);
  // every hostile spawned afterwards keeps its distance from it (group points ≥ 20u, event guards ≥ 18u).
  const pendingPlayerSpawns = worldRng.shuffle([...map.playerSpawns]);
  const threats = sim.events.filter((e) => e.defId === 'core.event.moving_supply').map((e) => ({ x: e.x, y: e.y }));
  const minThreat = (c: { x: number; y: number }) => Math.min(99, ...threats.map((t) => Math.hypot(t.x - c.x, t.y - c.y)));
  const clearSpawns = pendingPlayerSpawns.filter((c) => spawnSafe(geo, c.x, c.y, []));
  const pool = clearSpawns.length ? clearSpawns : pendingPlayerSpawns;
  const playerSpawn = pool.find((c) => minThreat(c) >= 20) ?? [...pool].sort((a, b) => minThreat(b) - minThreat(a))[0]!;
  setupEventActors(ctx, { x: playerSpawn.x, y: playerSpawn.y, minDist: SAFE_SPAWN_DIST });
  // Enemies. With a raid threat each group is scaled to its own tier (region loot tier shifts it): archetypes above
  // the tier stay out (a group with none left stays empty), the first tier fields one enemy fewer at most.
  for (const g of map.enemyGroups) {
    if (g.requiresQuest && !launch.activeQuests.includes(g.requiresQuest)) continue;
    if (g.requiresFlag && !launch.flags[g.requiresFlag]) continue;
    if (g.unlessFlag && launch.flags[g.unlessFlag]) continue;
    if (g.boss && !launch.bossActive) continue;
    const gt = launch.threat === undefined ? undefined : groupThreat(launch.threat, map.regions.find((r) => r.id === g.regionId)?.lootTier ?? 2);
    const archetypes = gt === undefined ? g.archetypes : g.archetypes.filter((a) => (content.enemy(a.id).minThreat ?? 0) <= gt);
    if (archetypes.length === 0) continue;
    if (!enemyRng.chance(g.chance)) continue;
    const count = groupCount(g.count, gt);
    const n = enemyRng.int(count[0], count[1]);
    const pts = enemyRng.shuffle([...g.points]).filter((p) => Math.hypot(p.x - playerSpawn.x, p.y - playerSpawn.y) >= 20);
    for (let i = 0; i < n && i < pts.length; i++) {
      const p = pts[i]!;
      const arch = enemyRng.weighted(archetypes.map((a) => ({ weight: a.weight, value: a.id })));
      const patrol = g.patrol.length > 1 ? g.patrol : [];
      spawnEnemy(content, sim, arch, p.x, p.y, enemyRng, { patrol, mode: patrol.length > 1 && i === 0 ? 'Patrol' : 'Idle', ...(gt === undefined ? {} : { threat: gt }) });
    }
  }
  // Player
  const sp = playerSpawn;
  const pl = newActor('player', 'player', sp.x, sp.y, 100, 'player');
  pl.staminaMax = 100 + (launch.perks.staminaMax ?? 0);
  pl.stamina = pl.staminaMax;
  sim.actors.unshift(pl);
  ensureEquipContainers(sim.store, 'player');
  for (const [cid, c] of Object.entries(launch.loadout.containers)) {
    if (sim.store.containers[cid] && sim.store.containers[cid]!.items.length === 0) sim.store.containers[cid] = c;
    else if (!sim.store.containers[cid]) sim.store.containers[cid] = c;
  }
  for (const [id, it] of Object.entries(launch.loadout.items)) sim.store.items[id] = it;
  sim.loadoutItemIds = Object.keys(launch.loadout.items);
  pl.quickslots = [...launch.quickslots];
  pl.activeSlot = sim.store.containers[eqContainerId('player', 'primary1')]?.items.length ? 'primary1' : sim.store.containers[eqContainerId('player', 'primary2')]?.items.length ? 'primary2' : sim.store.containers[eqContainerId('player', 'secondary')]?.items.length ? 'secondary' : 'melee';
  // Exits
  for (const ex of map.exits) sim.exits[ex.id] = { progress: 0, enabled: ex.condition.type !== 'flag' || !!launch.flags[ex.condition.flag] };
  // Death bag (recovery mode: latest bag, same map only).
  if (launch.deathBag) {
    const cid = `deathbag:${launch.deathBag.sourceRaidId}`;
    addContainer(sim.store, { id: cid, kind: 'list', w: 0, h: 0 });
    for (const [id, it] of Object.entries(launch.deathBag.store.items)) sim.store.items[id] = it;
    for (const [id, c] of Object.entries(launch.deathBag.store.containers)) if (id !== 'deathbag') sim.store.containers[id] = c;
    for (const rid of launch.deathBag.rootIds) {
      const it = sim.store.items[rid];
      if (!it) continue;
      it.ownerContainerId = cid;
      it.gridPosition = null;
      sim.store.containers[cid]!.items.push(rid);
    }
    sim.containers[cid] = { id: cid, kind: 'deathbag', typeId: 'deathbag', x: launch.deathBag.x, y: launch.deathBag.y, floor: 0, searched: 9999, searchProgress: 0, keyId: null, locked: false, actorId: null, nameKey: 'world.deathbag', createdTick: 0, opened: false };
    sim.deathBagContainerId = cid;
  }
  sim.lastCheckpointTime = 0;
  sim.rng = ctx.rng.getState();
  return { sim, ctx };
}

export const RAID_DT = SIM_DT;
