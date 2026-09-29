import { describe, expect, it } from 'vitest';
import { updateAim } from '../src/combat/aim';
import { processFire } from '../src/combat/weapons';
import { createContent } from '../src/content/core';
import type { EquipSlot, ItemDef } from '../src/content/types';
import { SIM_DT } from '../src/core/clock';
import { allocId } from '../src/core/ids';
import { instantiate, itemsInContainerDeep, moveItem, placeNew, validateStore, type ItemStore } from '../src/inventory/store';
import { equipProfileItem, loadWeapon } from '../src/progression/actions';
import { DEATHBAG, INCOMING, KEEP_ON_DEATH, levelForExp, newProfile, SECURE_POCKET, STASH, type ProfileState } from '../src/progression/profile';
import { refreshQuests } from '../src/progression/quests';
import { commitRaidEnd, DISCOVERY_EXP, prepareDeploy } from '../src/progression/raidFlow';
import { idleCommand, type PlayerCommand, type RaidOp } from '../src/world/command';
import { allCarriedItemIds, player, type SimContext } from '../src/world/context';
import { BLEED_RATE } from '../src/world/medical';
import type { OpResult } from '../src/world/ops';
import { EXTRACT_TIME, stepSim } from '../src/world/sim';
import { createRaidSim, spawnEnemy, type RaidLaunch } from '../src/world/spawn';
import type { ActorState, SimEvent } from '../src/world/state';

/**
 * A11 — "탈출과 치명 피해가 같은 tick에 경쟁할 때 사망 우선" + 사망 가방 정책.
 * Raids go through the real path (newProfile → prepareDeploy → createRaidSim → stepSim → commitRaidEnd).
 * Map AI is frozen (debug switch also used by the e2e suite) so only the arranged damage can hurt the player.
 */

const content = createContent();
const MAIN_DEST = 'core.dest.quarantine_main';
const MAIN_MAP = 'core.map.quarantine_main';
const OUTER_DEST = 'core.dest.outer_supply_route';
const OUTER_MAP = 'core.map.outer_supply_route';
const Q01 = 'core.quest.q01_ready';
const DRAIN = 'exit.west_drain';

function freshProfile(seed: string): ProfileState {
  const p = newProfile(content, 1, 'A11', seed, 0);
  p.quests[Q01] = { status: 'completed', progress: {} };
  for (const f of content.quest(Q01).rewards.flags ?? []) p.flags[f] = true;
  p.flags['outer_route_unlocked'] = true;
  refreshQuests(p, content); // Q02 (+ optional training quests) active
  return p;
}

function deploy(p: ProfileState, destId: string): { launch: RaidLaunch; ctx: SimContext } {
  const launch = prepareDeploy(p, content, destId, 0);
  const { ctx } = createRaidSim(content, launch);
  ctx.sim.credits = p.currency; // same as GameApp.deploy
  ctx.sim.debug.freezeAI = true;
  return { launch, ctx };
}

function step(ctx: SimContext, cmd: PlayerCommand | null, ops: RaidOp[] = []): { fx: SimEvent[]; ops: OpResult[] } {
  const out = stepSim(ctx, { cmd, ops }, SIM_DT);
  const fx = ctx.sim.fx;
  ctx.sim.fx = [];
  return { fx, ops: out.opResults };
}

function aimCmd(x: number, y: number, z = 1.2, extra: Partial<PlayerCommand> = {}): PlayerCommand {
  return { ...idleCommand(), aim: { x, y, z, actorId: null, viewDistPx: 999 }, ...extra };
}

const stand = (pl: ActorState): PlayerCommand => aimCmd(pl.x + 4, pl.y);

function teleport(a: ActorState, x: number, y: number): void {
  a.x = a.px = x;
  a.y = a.py = y;
  a.vx = a.vy = 0;
}

function exitCenter(mapId: string, exitId: string): { x: number; y: number } {
  const ex = content.map(mapId).exits.find((e) => e.id === exitId)!;
  return { x: ex.x + ex.w / 2, y: ex.y + ex.h / 2 };
}

/** Bleed out within a few ticks where the player stands. */
function bleedOut(ctx: SimContext): void {
  const pl = player(ctx.sim);
  pl.status.bleeding = true;
  pl.hp = BLEED_RATE * SIM_DT * 2.5;
  for (let i = 0; i < 10 && !ctx.sim.outcome; i++) step(ctx, stand(pl));
  expect(ctx.sim.outcome).toMatchObject({ kind: 'dead', cause: 'bleeding' });
}

function extractAt(ctx: SimContext, exitId: string): void {
  const pl = player(ctx.sim);
  const c = exitCenter(ctx.sim.mapId, exitId);
  teleport(pl, c.x, c.y);
  for (let i = 0; i < 400 && !ctx.sim.outcome; i++) step(ctx, stand(pl));
  expect(ctx.sim.outcome).toMatchObject({ kind: 'extracted', exitId });
}

/** Item content independent of where it lives (owner / grid position may change when moved). */
function itemView(store: ItemStore, id: string) {
  const it = store.items[id]!;
  return {
    id,
    def: it.definitionId,
    qty: it.quantity,
    durability: it.durability,
    chamber: it.weapon?.chamber ?? null,
    tube: it.weapon?.tube ?? null,
    magazineId: it.weapon?.magazineId ?? null,
    rounds: it.mag?.rounds ?? null,
    contained: [...it.containedItems].sort(),
    medPool: it.medPool ?? null,
  };
}

const viewsOf = (store: ItemStore, ids: string[]) => [...ids].sort().map((id) => itemView(store, id));
const deepIds = (store: ItemStore, cid: string) => itemsInContainerDeep(store, cid).sort();
/** Home storage snapshot (ids, quantities, positions) used to prove nothing was deposited. */
const homeSnapshot = (p: ProfileState) =>
  JSON.parse(JSON.stringify([STASH, INCOMING].map((cid) => ({ cid, items: deepIds(p.store, cid).map((id) => ({ ...itemView(p.store, id), owner: p.store.items[id]!.ownerContainerId, pos: p.store.items[id]!.gridPosition })) }))));

/** Everything a death keeps: equipped keep-on-death items (the basic bag, not its contents) + secret pocket contents. */
function keptOnDeath(sim: SimContext['sim']): string[] {
  const kept: string[] = [];
  for (const s of ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory']) {
    const id = sim.store.containers[`eq:player:${s}`]?.items[0];
    if (id && content.item(sim.store.items[id]!.definitionId).tags.includes(KEEP_ON_DEATH)) kept.push(id);
  }
  kept.push(...itemsInContainerDeep(sim.store, SECURE_POCKET));
  return kept.sort();
}

/** What a death actually moves into the death bag: carried items minus keptOnDeath. */
function lostOnDeath(sim: SimContext['sim'], pl: ActorState): string[] {
  const kept = new Set(keptOnDeath(sim));
  return allCarriedItemIds(sim, pl).filter((id) => !kept.has(id)).sort();
}

/** Where a recovered death-bag root goes: its equipment slot, or the bag for everything else. */
function recoverOp(sim: SimContext['sim'], id: string): RaidOp {
  const def = content.item(sim.store.items[id]!.definitionId);
  if (['weapon', 'melee', 'armor', 'backpack', 'accessory'].includes(def.kind)) return { op: 'equip', itemId: id, slot: slotFor(def) };
  const bag = sim.store.containers['eq:player:backpack']!.items[0]!;
  return { op: 'move', itemId: id, target: { containerId: `bag:${bag}` } };
}

function slotFor(def: ItemDef): EquipSlot {
  if (def.kind === 'weapon') return def.weapon!.class === 'pistol' ? 'secondary' : 'primary1';
  if (def.kind === 'melee') return 'melee';
  if (def.kind === 'backpack') return 'backpack';
  if (def.kind === 'armor') return def.armor!.slot;
  return 'accessory';
}

/** Shelter preparation through the real shelter actions: equip the starter-stash carbine with a loaded magazine. */
function equipStashCarbine(p: ProfileState): string {
  const carbine = Object.values(p.store.items).find((i) => i.definitionId === 'core.weapon.c556' && i.ownerContainerId === STASH)!;
  equipProfileItem(p, content, carbine.instanceId, 'primary1');
  const mag = Object.values(p.store.items).find((i) => i.definitionId === 'core.mag.c556' && i.ownerContainerId === STASH)!;
  loadWeapon(p, content, carbine.instanceId, mag.instanceId);
  return carbine.instanceId;
}

/** Everything that must survive a death untouched (death rules: only stats/hp/bag/discovery change). */
function progressionSnapshot(p: ProfileState) {
  return JSON.parse(JSON.stringify({ currency: p.currency, quests: p.quests, perks: p.perks, perkPoints: p.perkPoints, keys: p.keys, traders: p.traders, buildings: p.buildings, facilities: p.facilities, extractions: p.stats.extractions }));
}

// --- A11 (a) same-tick race --------------------------------------------------------------------------------------

type Lethal = 'projectile' | 'explosion' | 'bleeding';

/** Player standing in the free west drain exit, one tick before the 5 s extraction completes. */
function raceSetup(seed: string, lethal: Lethal) {
  const p = freshProfile(seed);
  const { ctx } = deploy(p, MAIN_DEST);
  const pl = player(ctx.sim);
  const c = exitCenter(MAIN_MAP, DRAIN);
  teleport(pl, c.x, c.y);
  // A hostile marksman with its real, finite DMR loadout stands 3u east of the player (AI frozen).
  const shooter = spawnEnemy(content, ctx.sim, 'core.enemy.marksman', pl.x + 3, pl.y, ctx.rng.get('enemy'), { mode: 'Idle' });
  if (lethal === 'explosion') pl.hp = 50; // an earlier wound (same condition shortcut as the e2e setPlayerCondition hook)
  let guard = 0;
  while (ctx.sim.exits[DRAIN]!.progress + SIM_DT + 1e-9 < EXTRACT_TIME && guard++ < 400) step(ctx, stand(pl));
  expect(ctx.sim.outcome).toBeNull();
  expect(ctx.sim.exits[DRAIN]!.progress).toBeGreaterThan(EXTRACT_TIME - 2 * SIM_DT);
  return { p, ctx, pl, shooter };
}

/** Arrange damage that becomes lethal inside the very next stepSim call. */
function arrangeLethal(ctx: SimContext, pl: ActorState, shooter: ActorState, lethal: Lethal): void {
  const sim = ctx.sim;
  if (lethal === 'projectile') {
    // Head shot from the marksman's real DMR, fired at the start of the coming tick (projectile resolves in it).
    const spec = content.item(sim.store.items[sim.store.containers[`eq:${shooter.id}:primary1`]!.items[0]!]!.definitionId).weapon!;
    const d = Math.hypot(pl.x - shooter.x, pl.y - shooter.y);
    const m = shooter.handling.muzzleZ;
    const aimZ = m + ((1.6 - m) * (d - spec.muzzleLength)) / d; // line from the barrel start crosses z=1.6 at the player
    updateAim(shooter, { x: pl.x, y: pl.y, z: aimZ, actorId: null });
    sim.debug.noSpread = true;
    expect(processFire(ctx, shooter, { held: true, pressed: true }, sim.time, SIM_DT).shots).toBe(1);
    expect(sim.projectiles).toHaveLength(1);
  } else if (lethal === 'explosion') {
    // A frag grenade resting at the player's feet whose fuse ends during the coming tick (80 dmg inside 1u).
    sim.thrown.push({ id: allocId(sim.ids, 'th'), ownerId: shooter.id, itemDefId: 'core.throw.frag', x: pl.x + 0.5, y: pl.y, z: 0, vx: 0, vy: 0, vz: 0, fuseAt: sim.time + SIM_DT, resting: true, floor: 0 });
  } else {
    pl.status.bleeding = true;
    pl.hp = BLEED_RATE * SIM_DT * 0.5; // less than one tick of bleeding left
  }
}

describe('A11 (a) extraction completing on the same tick as lethal damage → death wins', () => {
  it.each<Lethal>(['projectile', 'explosion', 'bleeding'])('%s: dead, never extracted; settlement moves carried items to the death bag only', (lethal) => {
    const seed = `a11|race|${lethal}`;
    // Control: identical raid without the lethal arrangement extracts on exactly that tick.
    const control = raceSetup(seed, lethal);
    const controlTick = control.ctx.sim.tick;
    const cfx = step(control.ctx, stand(control.pl)).fx;
    expect(control.ctx.sim.outcome).toEqual({ kind: 'extracted', exitId: DRAIN, tick: controlTick });
    expect(cfx.some((e) => e.t === 'extracted')).toBe(true);

    const { p, ctx, pl, shooter } = raceSetup(seed, lethal);
    const sim = ctx.sim;
    expect(sim.tick).toBe(controlTick);
    arrangeLethal(ctx, pl, shooter, lethal);
    const { fx } = step(ctx, stand(pl));
    const cause = lethal === 'projectile' ? 'bullet' : lethal;
    expect(sim.outcome).toEqual({ kind: 'dead', tick: controlTick, cause });
    expect(pl.alive).toBe(false);
    expect(pl.hp).toBe(0);
    expect(fx.some((e) => e.t === 'extracted')).toBe(false);
    expect(fx.some((e) => e.t === 'died')).toBe(true);
    expect(sim.progress.custom).not.toContain(`exit:${DRAIN}`);
    expect(sim.exits[DRAIN]!.progress).toBeLessThan(EXTRACT_TIME);
    if (lethal === 'projectile') expect(sim.shotLog[sim.shotLog.length - 1]).toMatchObject({ firstHit: 'actor:player', part: 'head', actualHPLoss: 100 });
    if (lethal === 'explosion') expect(fx.some((e) => e.t === 'hit' && e.actorId === 'player' && e.killed)).toBe(true);
    // A late tick can never flip the outcome.
    step(ctx, stand(pl));
    expect(sim.outcome?.kind).toBe('dead');

    // Settlement.
    const carried = allCarriedItemIds(sim, pl).sort();
    const lost = lostOnDeath(sim, pl);
    const lostViews = viewsOf(sim.store, lost);
    const bagId = sim.store.containers['eq:player:backpack']!.items[0]!;
    expect(keptOnDeath(sim)).toEqual([bagId]); // starter kit: the basic bag (its contents are lost)
    expect(lost.length).toBeGreaterThan(0);
    const home = homeSnapshot(p);
    const prog = progressionSnapshot(p);
    const expBefore = p.exp;
    const discBefore = new Set(Object.keys(p.flags).filter((f) => f.startsWith('disc:')));
    const summary = commitRaidEnd(p, content, sim);
    expect(summary.outcome).toBe('dead');
    expect(summary.exitId).toBeNull();
    expect(summary.itemsIn).toEqual([]);
    expect(summary.incoming).toBe(0);
    expect(summary.feePaid).toBe(0);
    expect(summary.itemsLost).toHaveLength(lost.length);
    // Zero items reach the stash / incoming container; every lost item is in the death bag, unchanged; the basic bag
    // itself comes back empty to the backpack slot.
    expect(homeSnapshot(p)).toEqual(home);
    expect(deepIds(p.store, DEATHBAG)).toEqual(lost);
    expect(viewsOf(p.store, lost)).toEqual(lostViews);
    expect(p.store.containers['eq:player:backpack']!.items).toEqual([bagId]);
    expect(p.store.containers[`bag:${bagId}`]!.items).toEqual([]);
    expect(summary.itemsKept).toEqual([{ defId: 'core.bag.basic', qty: 1 }]);
    // Settlement works on a private copy of the raid (a failed save can be retried without losing anything):
    // the finished live raid is left untouched and is discarded by the app afterwards.
    expect(allCarriedItemIds(sim, pl).sort()).toEqual(carried);
    expect(sim.outcome?.kind).toBe('dead');
    expect(validateStore(p.store, content)).toEqual([]);
    // Death rules: currency, quests, perks, keys, traders, buildings stay; only discovery EXP (common progress) is granted.
    expect(progressionSnapshot(p)).toEqual(prog);
    const newDisc = new Set([...sim.progress.visited, ...sim.progress.discovered].filter((d) => !discBefore.has(`disc:${d}`)));
    expect(sim.progress.kills).toEqual([]);
    expect(summary.expGained).toBe(newDisc.size * DISCOVERY_EXP);
    expect(p.exp - expBefore).toBe(newDisc.size * DISCOVERY_EXP);
    expect(p.level).toBe(levelForExp(p.exp));
    expect(p.stats).toMatchObject({ deaths: 1, extractions: 0, raids: 1 });
    expect(p.lastDeathBag).toEqual({ raidId: sim.raidId, mapId: MAIN_MAP, x: pl.x, y: pl.y });
    expect(p.playerHp).toBe(100);
    expect(p.playerBleeding).toBe(false);
    expect(p.activeRaid).toBeNull();
  });
});

// --- A11 (b) death bag policy -------------------------------------------------------------------------------------

interface DeathRecord {
  raidId: string;
  roots: string[];
  ids: string[];
  views: ReturnType<typeof viewsOf>;
  at: { x: number; y: number };
}

/** Deploy to the main map, bleed out inside the west drain, settle. Returns the resulting death bag. */
function dieOnMain(p: ProfileState, prepare?: (ctx: SimContext) => void): DeathRecord {
  const { ctx } = deploy(p, MAIN_DEST);
  const pl = player(ctx.sim);
  prepare?.(ctx);
  const c = exitCenter(MAIN_MAP, DRAIN);
  teleport(pl, c.x, c.y - 1.5);
  const carried = lostOnDeath(ctx.sim, pl);
  const views = viewsOf(ctx.sim.store, carried);
  bleedOut(ctx);
  const at = { x: pl.x, y: pl.y };
  const summary = commitRaidEnd(p, content, ctx.sim);
  expect(summary.outcome).toBe('dead');
  const ids = deepIds(p.store, DEATHBAG);
  expect(ids).toEqual([...carried].sort());
  expect(viewsOf(p.store, ids)).toEqual(views);
  expect(p.lastDeathBag).toEqual({ raidId: ctx.sim.raidId, mapId: MAIN_MAP, ...at });
  return { raidId: ctx.sim.raidId, roots: [...p.store.containers[DEATHBAG]!.items], ids, views, at };
}

/** Open a world container next to the player position and wait until `defId` is revealed; returns its item id. */
function lootFrom(ctx: SimContext, cid: string, standAt: { x: number; y: number }, defId: string): string {
  const sim = ctx.sim;
  const pl = player(sim);
  const wc = sim.containers[cid]!;
  teleport(pl, standAt.x, standAt.y);
  step(ctx, aimCmd(wc.x, wc.y, 0.6, { interact: true }));
  expect(sim.loot?.containerId).toBe(cid);
  const items = sim.store.containers[cid]!.items;
  const id = items.find((x) => sim.store.items[x]!.definitionId === defId)!;
  expect(id, `${defId} in ${cid}`).toBeDefined();
  for (let i = 0; i < 600 && wc.searched <= items.indexOf(id); i++) step(ctx, aimCmd(wc.x, wc.y, 0.6));
  const bag = sim.store.containers['eq:player:backpack']!.items[0]!;
  const r = step(ctx, aimCmd(wc.x, wc.y, 0.6), [{ op: 'move', itemId: id, target: { containerId: `bag:${bag}` } }, { op: 'closeLoot' }]);
  expect(r.ops[0]).toEqual({ ok: true });
  return id;
}

describe('A11 (b) death bag policy', () => {
  it('other-map deploy leaves the bag in the profile; same-map deploy spawns exactly that bag; recovering + extracting returns every item', () => {
    const p = freshProfile('a11|bag|recover');
    const d1 = dieOnMain(p);

    // Raid 2 on a different map: no bag spawned, bag stays in the profile untouched.
    const r2 = deploy(p, OUTER_DEST);
    expect(r2.launch.deathBag).toBeNull();
    expect(r2.ctx.sim.deathBagContainerId).toBeNull();
    expect(Object.values(r2.ctx.sim.containers).filter((c) => c.kind === 'deathbag')).toEqual([]);
    for (const id of d1.ids) expect(r2.ctx.sim.store.items[id], id).toBeUndefined();
    expect(deepIds(p.store, DEATHBAG)).toEqual(d1.ids);
    extractAt(r2.ctx, 'exit.rail_tunnel');
    expect(commitRaidEnd(p, content, r2.ctx.sim).outcome).toBe('extracted');
    expect(deepIds(p.store, DEATHBAG)).toEqual(d1.ids);
    expect(viewsOf(p.store, d1.ids)).toEqual(d1.views);
    expect(p.lastDeathBag).toEqual({ raidId: d1.raidId, mapId: MAIN_MAP, ...d1.at });

    // Raid 3 back on the death map: the bag is spawned with exactly those items and leaves the profile (single owner).
    const r3 = deploy(p, MAIN_DEST);
    const sim = r3.ctx.sim;
    const cid = `deathbag:${d1.raidId}`;
    expect(r3.launch.deathBag?.rootIds).toEqual(d1.roots);
    expect(Object.keys(r3.launch.deathBag!.store.items).sort()).toEqual(d1.ids);
    for (const id of d1.ids) expect(p.store.items[id], id).toBeUndefined();
    expect(p.lastDeathBag).toBeNull();
    expect(sim.deathBagContainerId).toBe(cid);
    expect(Object.values(sim.containers).filter((c) => c.kind === 'deathbag').map((c) => c.id)).toEqual([cid]);
    expect(sim.containers[cid]).toMatchObject({ kind: 'deathbag', x: d1.at.x, y: d1.at.y, locked: false });
    expect(sim.store.containers[cid]!.items).toEqual(d1.roots);
    expect(deepIds(sim.store, cid)).toEqual(d1.ids);
    expect(viewsOf(sim.store, d1.ids)).toEqual(d1.views);
    expect(validateStore(sim.store, content)).toEqual([]);

    // Recover: open the bag, equip every equipment root and pack the rest into the (kept) basic bag, then extract.
    const pl = player(sim);
    teleport(pl, d1.at.x, d1.at.y + 0.8);
    step(r3.ctx, aimCmd(d1.at.x, d1.at.y, 0.3, { interact: true }));
    expect(sim.loot?.containerId).toBe(cid);
    const ops: RaidOp[] = d1.roots.map((id) => recoverOp(sim, id));
    const res = step(r3.ctx, stand(pl), ops);
    expect(res.ops).toEqual(ops.map(() => ({ ok: true })));
    expect(sim.store.containers[cid]!.items).toEqual([]);
    expect(lostOnDeath(sim, pl)).toEqual(d1.ids);
    extractAt(r3.ctx, DRAIN);
    const s3 = commitRaidEnd(p, content, sim);
    expect(s3.outcome).toBe('extracted');
    // Every bag item is back in the profile exactly once with identical content; the bag is consumed.
    for (const id of d1.ids) expect(p.store.items[id], id).toBeDefined();
    expect(viewsOf(p.store, d1.ids)).toEqual(d1.views);
    expect(deepIds(p.store, DEATHBAG)).toEqual([]);
    expect(p.lastDeathBag).toBeNull();
    expect(validateStore(p.store, content)).toEqual([]);
  });

  it('extracting without recovering returns the unrecovered bag to the profile, still recoverable next time', () => {
    const p = freshProfile('a11|bag|unrecovered');
    const d1 = dieOnMain(p);
    const r2 = deploy(p, MAIN_DEST);
    expect(r2.ctx.sim.deathBagContainerId).toBe(`deathbag:${d1.raidId}`);
    extractAt(r2.ctx, 'exit.east_road');
    expect(commitRaidEnd(p, content, r2.ctx.sim).outcome).toBe('extracted');
    expect(deepIds(p.store, DEATHBAG)).toEqual(d1.ids);
    expect(viewsOf(p.store, d1.ids)).toEqual(d1.views);
    expect(r2.ctx.sim.outcome?.kind).toBe('extracted'); // the live raid is over; its copy of the bag is discarded
    expect(p.lastDeathBag).toEqual({ raidId: d1.raidId, mapId: MAIN_MAP, ...d1.at });
    expect(validateStore(p.store, content)).toEqual([]);
    const r3 = deploy(p, MAIN_DEST);
    expect(r3.launch.deathBag?.rootIds).toEqual(d1.roots);
    expect(deepIds(r3.ctx.sim.store, `deathbag:${d1.raidId}`)).toEqual(d1.ids);
  });

  it('a second death on another map replaces the previous bag: old items destroyed and logged once, never duplicated', () => {
    const p = freshProfile('a11|bag|replace-other-map');
    const d1 = dieOnMain(p);
    equipStashCarbine(p);
    const { ctx } = deploy(p, OUTER_DEST);
    const pl = player(ctx.sim);
    const carried2 = lostOnDeath(ctx.sim, pl);
    const views2 = viewsOf(ctx.sim.store, carried2);
    bleedOut(ctx);
    const at = { x: pl.x, y: pl.y };
    expect(commitRaidEnd(p, content, ctx.sim).outcome).toBe('dead');
    expect(d1.ids.filter((id) => id in p.store.items || id in ctx.sim.store.items)).toEqual([]);
    expect(deepIds(p.store, DEATHBAG)).toEqual(carried2);
    expect(viewsOf(p.store, carried2)).toEqual(views2);
    expect(p.lastDeathBag).toEqual({ raidId: ctx.sim.raidId, mapId: OUTER_MAP, ...at });
    for (const root of d1.roots) expect(p.itemLog.filter((e) => e.itemId === root && e.event === 'destroy' && e.reason === 'deathbag-replaced'), root).toHaveLength(1);
    expect(validateStore(p.store, content)).toEqual([]);
  });

  it('a second death on the same map with the spawned bag unrecovered replaces it too (destroyed and logged, not duplicated)', () => {
    const p = freshProfile('a11|bag|replace-same-map');
    const d1 = dieOnMain(p);
    equipStashCarbine(p);
    const { ctx } = deploy(p, MAIN_DEST);
    expect(deepIds(ctx.sim.store, `deathbag:${d1.raidId}`)).toEqual(d1.ids);
    const pl = player(ctx.sim);
    const carried2 = lostOnDeath(ctx.sim, pl);
    bleedOut(ctx); // at the spawn, far from the old bag
    expect(commitRaidEnd(p, content, ctx.sim).outcome).toBe('dead');
    // Not duplicated: the replaced bag is gone from the profile and the new bag holds only this raid's items
    // (the finished live raid is discarded; settlement worked on a copy of it).
    expect(d1.ids.filter((id) => id in p.store.items)).toEqual([]);
    expect(deepIds(p.store, DEATHBAG)).toEqual(carried2);
    expect(p.lastDeathBag?.raidId).toBe(ctx.sim.raidId);
    expect(validateStore(p.store, content)).toEqual([]);
    // Logged: same policy record as when the replaced bag was still in the profile.
    for (const root of d1.roots) expect(p.itemLog.filter((e) => e.itemId === root && e.event === 'destroy' && e.reason === 'deathbag-replaced'), `destroy log for replaced bag item ${root}`).toHaveLength(1);
  });

  it('unique key / quest items inside the recovered bag are not placed a second time by the world spawn', () => {
    const p = freshProfile('a11|bag|unique'); // Q02 active, farm back-room key unregistered
    const KEY = 'core.keyitem.farm_backroom';
    const RELIEF = 'core.quest.relief_package';
    const worldCount = (ctx: SimContext, defId: string) => Object.values(ctx.sim.store.items).filter((i) => i.definitionId === defId).length;
    const d1 = dieOnMain(p, (ctx) => {
      // Baseline: a raid places each of them exactly once.
      expect(worldCount(ctx, KEY)).toBe(1);
      expect(worldCount(ctx, RELIEF)).toBe(1);
      lootFrom(ctx, 'ct:farm_tower_box', { x: 34, y: 86 }, KEY);
      lootFrom(ctx, 'ct:farm_relief', { x: 28, y: 61.2 }, RELIEF);
    });
    const bagDefs = d1.ids.map((id) => p.store.items[id]!.definitionId);
    expect(bagDefs).toContain(KEY);
    expect(bagDefs).toContain(RELIEF);
    const r2 = deploy(p, MAIN_DEST);
    expect(deepIds(r2.ctx.sim.store, `deathbag:${d1.raidId}`)).toEqual(d1.ids);
    // The player holds these again through the recoverable bag, so the world must not create another copy.
    expect.soft(worldCount(r2.ctx, KEY), `${KEY} instances in the raid`).toBe(1);
    expect.soft(worldCount(r2.ctx, RELIEF), `${RELIEF} instances in the raid`).toBe(1);
  });
});

describe('A11 (d) secret pocket and keep-on-death gear', () => {
  it('secret pocket contents (brought in and looted into it) come back on death and on extraction; the basic bag comes back empty', () => {
    const p = freshProfile('a11|pocket');
    const ring = instantiate(content, p.ids, 'core.val.ring');
    expect(placeNew(p.store, content, ring, { containerId: SECURE_POCKET, x: 0, y: 0 }).ok).toBe(true);
    const { ctx } = deploy(p, MAIN_DEST);
    const sim = ctx.sim;
    const pl = player(sim);
    expect(sim.store.containers[SECURE_POCKET]!.items).toEqual([ring.instanceId]);
    expect(p.store.items[ring.instanceId], 'the pocket travels with the loadout (single owner)').toBeUndefined();
    // Loot the farm key into the pocket through a normal raid move.
    const key = lootFrom(ctx, 'ct:farm_tower_box', { x: 34, y: 86 }, 'core.keyitem.farm_backroom');
    expect(step(ctx, stand(pl), [{ op: 'move', itemId: key, target: { containerId: SECURE_POCKET } }]).ops).toEqual([{ ok: true }]);
    const bagId = sim.store.containers['eq:player:backpack']!.items[0]!;
    const lost = lostOnDeath(sim, pl);
    expect(lost).not.toContain(key);
    expect(lost).not.toContain(bagId);
    bleedOut(ctx);
    const s = commitRaidEnd(p, content, sim);
    expect(s.outcome).toBe('dead');
    expect([...p.store.containers[SECURE_POCKET]!.items].sort()).toEqual([key, ring.instanceId].sort());
    expect(p.store.items[ring.instanceId]!.gridPosition).toEqual({ x: 0, y: 0 });
    expect(p.store.containers['eq:player:backpack']!.items).toEqual([bagId]);
    expect(deepIds(p.store, DEATHBAG)).toEqual(lost);
    expect(s.itemsKept!.map((k) => k.defId).sort()).toEqual(['core.bag.basic', 'core.keyitem.farm_backroom', 'core.val.ring'].sort());
    expect(validateStore(p.store, content)).toEqual([]);

    // Extraction: the pocket comes home as it is.
    const r2 = deploy(p, OUTER_DEST);
    expect([...r2.ctx.sim.store.containers[SECURE_POCKET]!.items].sort()).toEqual([key, ring.instanceId].sort());
    extractAt(r2.ctx, 'exit.rail_tunnel');
    expect(commitRaidEnd(p, content, r2.ctx.sim).outcome).toBe('extracted');
    expect([...p.store.containers[SECURE_POCKET]!.items].sort()).toEqual([key, ring.instanceId].sort());
    expect(validateStore(p.store, content)).toEqual([]);
  });

  it('a non-basic bag is lost with its contents (only keep_on_death items survive)', () => {
    const p = freshProfile('a11|pocket|hiker');
    const basic = p.store.containers['eq:player:backpack']!.items[0]!;
    // Swap to a hiker bag through the shelter action (basic bag contents moved first).
    for (const id of [...p.store.containers[`bag:${basic}`]!.items]) moveItemTo(p, id, STASH);
    const hiker = instantiate(content, p.ids, 'core.bag.hiker');
    expect(placeNew(p.store, content, hiker, { containerId: STASH }).ok).toBe(true);
    equipProfileItem(p, content, hiker.instanceId, 'backpack');
    const { ctx } = deploy(p, MAIN_DEST);
    expect(keptOnDeath(ctx.sim)).toEqual([]);
    bleedOut(ctx);
    commitRaidEnd(p, content, ctx.sim);
    expect(deepIds(p.store, DEATHBAG)).toContain(hiker.instanceId);
    expect(p.store.containers['eq:player:backpack']!.items).toEqual([]);
  });
});

function moveItemTo(p: ProfileState, id: string, cid: string): void {
  const r = moveItem(p.store, content, id, { containerId: cid });
  if (!r.ok) {
    // Stash full in a fresh profile is impossible for the starter kit; fall back to the incoming list.
    expect(moveItem(p.store, content, id, { containerId: INCOMING }).ok).toBe(true);
  }
}

// --- A11 (c) abandon -----------------------------------------------------------------------------------------------

describe('A11 (c) abandoning a raid is treated as death for loot', () => {
  it('op abandon: carried items (incl. raid loot) go to the death bag, nothing is deposited', () => {
    const p = freshProfile('a11|abandon');
    const { ctx } = deploy(p, MAIN_DEST);
    const sim = ctx.sim;
    const pl = player(sim);
    const looted = lootFrom(ctx, 'ct:farm_tower_box', { x: 34, y: 86 }, 'core.keyitem.farm_backroom');
    const carried = lostOnDeath(sim, pl);
    expect(carried).toContain(looted);
    const views = viewsOf(sim.store, carried);
    const home = homeSnapshot(p);
    const prog = progressionSnapshot(p);
    const tick = sim.tick;
    const r = step(ctx, stand(pl), [{ op: 'abandon' }]);
    expect(r.ops).toEqual([{ ok: true }]);
    expect(sim.outcome).toEqual({ kind: 'abandoned', tick });
    const summary = commitRaidEnd(p, content, sim);
    expect(summary.outcome).toBe('abandoned');
    expect(summary.itemsIn).toEqual([]);
    expect(summary.incoming).toBe(0);
    expect(summary.exitId).toBeNull();
    expect(homeSnapshot(p)).toEqual(home);
    expect(deepIds(p.store, DEATHBAG)).toEqual(carried);
    expect(viewsOf(p.store, carried)).toEqual(views);
    expect(p.lastDeathBag).toEqual({ raidId: sim.raidId, mapId: MAIN_MAP, x: pl.x, y: pl.y });
    expect(p.stats).toMatchObject({ deaths: 1, extractions: 0 });
    expect(progressionSnapshot(p)).toEqual(prog);
    expect(validateStore(p.store, content)).toEqual([]);
  });

  it('abandon on the tick the extraction would complete → abandoned, never extracted', () => {
    const p = freshProfile('a11|abandon|exit');
    const { ctx } = deploy(p, MAIN_DEST);
    const sim = ctx.sim;
    const pl = player(sim);
    const c = exitCenter(MAIN_MAP, DRAIN);
    teleport(pl, c.x, c.y);
    while (sim.exits[DRAIN]!.progress + SIM_DT + 1e-9 < EXTRACT_TIME) step(ctx, stand(pl));
    const carried = lostOnDeath(sim, pl);
    const tick = sim.tick;
    const { fx } = step(ctx, stand(pl), [{ op: 'abandon' }]);
    expect(sim.outcome).toEqual({ kind: 'abandoned', tick });
    expect(fx.some((e) => e.t === 'extracted')).toBe(false);
    const summary = commitRaidEnd(p, content, sim);
    expect(summary.outcome).toBe('abandoned');
    expect(summary.itemsIn).toEqual([]);
    expect(deepIds(p.store, DEATHBAG)).toEqual(carried);
    expect(p.stats.extractions).toBe(0);
    expect(validateStore(p.store, content)).toEqual([]);
  });
});
