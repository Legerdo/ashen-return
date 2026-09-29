import type { ContentRegistry } from '../content/registry';
import type { InteractableDef, ObstacleDef } from '../content/mapTypes';
import type { PerkEffects } from '../content/types';
import { allocId } from '../core/ids';
import { rectContains } from '../core/math';
import { standardAmmoFor } from '../combat/reload';
import type { AttachmentSlot, FireMode } from '../content/types';
import { attachChild, destroyItem, instantiate, placeNew, type ItemStore } from '../inventory/store';
import { equippedId, makeContext, type SimContext } from './context';
import { WorldGeometry } from './geometry';
import { emptySim, ensureEquipContainers, newActor, standardMagazineFor } from './spawn';
import { eqContainerId, type ActorState, type SimState } from './state';

/** ShootingRange2D armor presets for the targets (terminal selectable). */
export const RANGE_PRESETS = ['none', 'vest1', 'vest2', 'vest3', 'vest4', 'helmet1', 'helmet2', 'helmet3', 'helmet4', 'full2', 'full4'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const TRAINING_WEAPONS = ['core.weapon.p9', 'core.weapon.ar556', 'core.weapon.sgp', 'core.weapon.dmr'];
export const SHELTER_MAP = 'core.map.shelter';

function trainingAmmo(content: ContentRegistry, weaponDefId: string): string {
  return standardAmmoFor(content, content.item(weaponDefId).weapon!.caliber);
}

function presetParts(p: string): { vest: number; helmet: number } {
  if (p.startsWith('vest')) return { vest: Number(p.slice(4)), helmet: 0 };
  if (p.startsWith('helmet')) return { vest: 0, helmet: Number(p.slice(6)) };
  if (p.startsWith('full')) return { vest: Number(p.slice(4)), helmet: Number(p.slice(4)) };
  return { vest: 0, helmet: 0 };
}

export function applyPresetToDummy(ctx: SimContext, d: ActorState, preset: string): void {
  const sim = ctx.sim;
  for (const slot of ['vest', 'helmet'] as const) {
    const cur = equippedId(sim, d.id, slot);
    if (cur) destroyItem(sim.store, cur);
  }
  const parts = d.dummy?.preset === 'fixed_none' ? { vest: 0, helmet: 0 } : presetParts(preset);
  if (parts.vest > 0) placeNew(sim.store, ctx.content, instantiate(ctx.content, sim.ids, `core.armor.vest${parts.vest}`), { containerId: eqContainerId(d.id, 'vest') });
  if (parts.helmet > 0) placeNew(sim.store, ctx.content, instantiate(ctx.content, sim.ids, `core.armor.helmet${parts.helmet}`), { containerId: eqContainerId(d.id, 'helmet') });
}

export function setRangePreset(ctx: SimContext, preset: string): void {
  if (!ctx.sim.range) return;
  ctx.sim.range.preset = preset;
  for (const a of ctx.sim.actors) {
    if (a.kind !== 'dummy') continue;
    a.hp = a.maxHp;
    a.alive = true;
    if (a.dummy) a.dummy.respawnAt = null;
    applyPresetToDummy(ctx, a, preset);
  }
}

/**
 * Replace the training weapon (range rental rack). Training gear never touches the profile economy, and base sims
 * reload from the unlimited training reserve (combat/reload.ts), so no spare magazines or loose rounds are issued.
 */
export function setRangeWeapon(ctx: SimContext, defId: string): void {
  const sim = ctx.sim;
  const pl = sim.actors.find((a) => a.kind === 'player');
  if (!pl) return;
  pl.action = null;
  // The rental goes into its own class slot (pistol → secondary, long gun → primary 1); other carried weapons stay.
  const def = ctx.content.item(defId);
  const slot = def.weapon!.class === 'pistol' ? 'secondary' : 'primary1';
  issueTrainingWeapon(ctx, pl, { slot, defId, attachments: [], magDefId: null, ammoDefId: null, fireMode: null, durability: null });
  pl.activeSlot = slot;
  pl.handling.weaponId = null;
}

/** A weapon the player has equipped in the profile, mirrored into the shelter sim as a training copy. */
export interface TrainingWeapon {
  slot: 'primary1' | 'primary2' | 'secondary' | 'melee';
  defId: string;
  attachments: { slot: AttachmentSlot; defId: string }[];
  /** Inserted magazine type (null → the family's standard magazine). */
  magDefId: string | null;
  /** Loaded ammunition type (null → standard FMJ / buckshot). */
  ammoDefId: string | null;
  fireMode: FireMode | null;
  durability: number | null;
}

/** Put a fully loaded training copy of a weapon (with its attachments) into an equipment slot, replacing what is there. */
export function issueTrainingWeapon(ctx: SimContext, pl: ActorState, w: TrainingWeapon): void {
  const sim = ctx.sim;
  const c = ctx.content;
  const cur = equippedId(sim, pl.id, w.slot);
  if (cur) destroyItem(sim.store, cur);
  const def = c.item(w.defId);
  if (w.slot === 'melee' || !def.weapon) {
    const m = instantiate(c, sim.ids, w.defId);
    if (w.durability !== null) m.durability = w.durability;
    placeNew(sim.store, c, m, { containerId: eqContainerId(pl.id, w.slot) });
    return;
  }
  const spec = def.weapon;
  const ammo = w.ammoDefId && c.hasItem(w.ammoDefId) && c.item(w.ammoDefId).ammo?.caliber === spec.caliber ? w.ammoDefId : trainingAmmo(c, w.defId);
  const wi = instantiate(c, sim.ids, w.defId);
  if (w.durability !== null) wi.durability = w.durability;
  if (w.fireMode && spec.modes.includes(w.fireMode)) wi.weapon!.fireMode = w.fireMode;
  if (!placeNew(sim.store, c, wi, { containerId: eqContainerId(pl.id, w.slot) }).ok) return;
  for (const a of w.attachments) {
    if (!c.hasItem(a.defId)) continue;
    const ai = instantiate(c, sim.ids, a.defId);
    sim.store.items[ai.instanceId] = ai;
    attachChild(sim.store, wi.instanceId, ai.instanceId, { attachment: a.slot });
  }
  if (spec.magazineFamily) {
    const magOk = w.magDefId && c.hasItem(w.magDefId) && c.item(w.magDefId).magazine?.family === spec.magazineFamily;
    const magDefId = magOk ? w.magDefId! : standardMagazineFor(c, spec.magazineFamily, spec.caliber);
    const mag = instantiate(c, sim.ids, magDefId);
    mag.mag!.rounds = Array.from({ length: c.item(magDefId).magazine!.capacity }, () => ammo);
    sim.store.items[mag.instanceId] = mag;
    attachChild(sim.store, wi.instanceId, mag.instanceId, { magazine: true });
    wi.weapon!.chamber = mag.mag!.rounds.pop()!;
  } else {
    wi.weapon!.tube = Array.from({ length: spec.capacity }, () => ammo);
    wi.weapon!.chamber = wi.weapon!.tube.pop()!;
  }
}

/** The weapons a profile has equipped (eq:player:*), described for issueTrainingWeapon. Reads only. */
export function profileTrainingLoadout(store: ItemStore, content: ContentRegistry): TrainingWeapon[] {
  const out: TrainingWeapon[] = [];
  for (const slot of ['primary1', 'primary2', 'secondary', 'melee'] as const) {
    const id = store.containers[`eq:player:${slot}`]?.items[0];
    const it = id ? store.items[id] : undefined;
    if (!it || !content.hasItem(it.definitionId)) continue;
    const attachments = (Object.entries(it.attachments) as [AttachmentSlot, string][]).flatMap(([s, cid]) => (store.items[cid] ? [{ slot: s, defId: store.items[cid]!.definitionId }] : []));
    const mag = it.weapon?.magazineId ? store.items[it.weapon.magazineId] : undefined;
    const ammoDefId = it.weapon?.chamber ?? mag?.mag?.rounds[mag.mag.rounds.length - 1] ?? it.weapon?.tube?.[it.weapon.tube.length - 1] ?? null;
    out.push({ slot, defId: it.definitionId, attachments, magDefId: mag?.definitionId ?? null, ammoDefId, fireMode: it.weapon?.fireMode ?? null, durability: it.durability });
  }
  return out;
}

/** First slot holding something, in the raid's order (primary 1 → primary 2 → secondary → melee). */
export function firstArmedSlot(sim: SimState, pl: ActorState): ActorState['activeSlot'] {
  for (const s of ['primary1', 'primary2', 'secondary', 'melee'] as const) if (equippedId(sim, pl.id, s)) return s;
  return 'secondary';
}

export interface BaseSimOptions {
  seed: string;
  flags: Record<string, boolean>;
  perks: PerkEffects;
  /**
   * The player's equipped weapons (profile loadout), carried in the shelter as training copies. Omitted (tests,
   * legacy callers): a knife plus `weaponDefId` as a rental.
   */
  loadout?: TrainingWeapon[];
  /** Range rental issued on top of the loadout (null / omitted = none). */
  weaponDefId?: string | null;
  extraObstacles: ObstacleDef[];
  extraInteractables?: InteractableDef[];
  spawn?: { x: number; y: number };
}

export function createBaseSim(content: ContentRegistry, opts: BaseSimOptions): SimContext {
  const baseMap = content.map(SHELTER_MAP);
  const map = { ...baseMap, interactables: [...baseMap.interactables, ...(opts.extraInteractables ?? [])] };
  const sim: SimState = emptySim('base', `base-${opts.seed}`, map.id, opts.seed, 'Day', 'Clear');
  sim.flags = { ...opts.flags };
  sim.perks = { ...opts.perks };
  sim.range = { preset: 'none', headHits: 0, wallBlocks: 0, lowCoverHits: 0, reloads: 0, turretNextAt: 0 };
  const geo = new WorldGeometry(map, content, opts.extraObstacles);
  const ctx = makeContext(sim, content, geo);
  for (const d of map.doors) sim.doors[d.id] = { open: d.startOpen, locked: false };
  const sp = opts.spawn ?? map.playerSpawns[0]!;
  const pl = newActor('player', 'player', sp.x, sp.y, 100, 'player');
  pl.staminaMax = 100 + (opts.perks.staminaMax ?? 0);
  pl.stamina = pl.staminaMax;
  sim.actors.push(pl);
  ensureEquipContainers(sim.store, pl.id);
  const bag = instantiate(content, sim.ids, 'core.bag.basic');
  placeNew(sim.store, content, bag, { containerId: eqContainerId(pl.id, 'backpack') });
  if (opts.loadout) for (const w of opts.loadout) issueTrainingWeapon(ctx, pl, w);
  else placeNew(sim.store, content, instantiate(content, sim.ids, 'core.melee.knife'), { containerId: eqContainerId(pl.id, 'melee') });
  if (opts.weaponDefId) setRangeWeapon(ctx, opts.weaponDefId);
  else pl.activeSlot = firstArmedSlot(sim, pl);
  for (const t of map.rangeTargets ?? []) {
    const d = newActor(`dummy-${t.id}`, 'dummy', t.x, t.y, 100, 'hostile');
    d.stance = t.crouched ? 'crouch' : 'stand';
    d.aim.dirX = -1;
    d.aim.dirY = 0;
    d.aim.faceRight = false;
    d.dummy = { homeX: t.x, homeY: t.y, respawnAt: null, track: t.track ? { ...t.track, dir: 1 } : null, preset: t.armor === 'none' ? 'fixed_none' : 'preset', crouched: t.crouched };
    ensureEquipContainers(sim.store, d.id);
    sim.actors.push(d);
  }
  for (const t of map.turrets ?? []) {
    const tu = newActor(`turret-${t.id}`, 'turret', t.x, t.y, 9999, 'hostile');
    tu.invulnerable = true;
    tu.radius = 0.4;
    ensureEquipContainers(sim.store, tu.id);
    sim.actors.push(tu);
  }
  for (const n of map.npcSpots ?? []) {
    const a = newActor(`npc-${n.npcId}`, 'npc', n.x, n.y, 100, 'neutral');
    a.archetypeId = n.npcId;
    a.invulnerable = true;
    a.aim.dirX = 0;
    a.aim.dirY = 1;
    sim.actors.push(a);
  }
  setRangePreset(ctx, 'none');
  return ctx;
}

export function tickRange(ctx: SimContext, dt: number, tickStart: number): void {
  const sim = ctx.sim;
  if (!sim.range) return;
  const pl = sim.actors.find((a) => a.kind === 'player');
  for (const a of sim.actors) {
    if (a.kind === 'dummy' && a.dummy) {
      if (!a.alive && a.dummy.respawnAt !== null && sim.time >= a.dummy.respawnAt) {
        a.alive = true;
        a.hp = a.maxHp;
        a.status.bleeding = false;
        a.dummy.respawnAt = null;
        a.deathEventId = null;
        sim.processedDeaths = sim.processedDeaths.filter((d) => d !== `death:${sim.raidId}:${a.id}`);
        applyPresetToDummy(ctx, a, sim.range.preset);
      }
      const tr = a.dummy.track;
      if (tr && a.alive) {
        a.x += tr.speed * tr.dir * dt;
        if (a.x > tr.x1) {
          a.x = tr.x1;
          tr.dir = -1;
        } else if (a.x < tr.x0) {
          a.x = tr.x0;
          tr.dir = 1;
        }
        a.moving = true;
      }
    }
  }
  // Q05 drill turret: harmless training rounds that a high wall must block.
  for (const t of ctx.geo.map.turrets ?? []) {
    if (!pl || !pl.alive) break;
    if (!rectContains(t.zone, pl.x, pl.y)) continue;
    if (sim.time < sim.range.turretNextAt) continue;
    sim.range.turretNextAt = sim.time + 1.2;
    const tu = sim.actors.find((a) => a.id === `turret-${t.id}`);
    if (!tu) continue;
    const m = turretMuzzle(t, pl.x, pl.y);
    const dx = pl.x - m.x;
    const dy = pl.y - m.y;
    const d = Math.max(0.1, Math.hypot(dx, dy));
    const speed = 60;
    tu.aim.dirX = dx / d;
    tu.aim.dirY = dy / d;
    tu.aim.faceRight = dx >= 0;
    sim.projectiles.push({
      id: allocId(sim.ids, 'pr'),
      shotId: allocId(sim.ids, 'shot-turret'),
      pelletId: 0,
      ownerId: tu.id,
      team: 'hostile',
      weaponDefId: 'core.weapon.p9',
      ammoDefId: 'core.ammo.9.fmj',
      x: m.x,
      y: m.y,
      z: m.z,
      px: m.x,
      py: m.y,
      pz: m.z,
      vx: (dx / d) * speed,
      vy: (dy / d) * speed,
      vz: 0,
      traveled: 0,
      maxRange: 40,
      effRange: 40,
      minFactor: 1,
      baseDamage: 0,
      energy: 0,
      carry: 1,
      penetrations: 0,
      hitActors: [],
      alive: true,
      pending: Math.max(1e-6, tickStart + dt - sim.time),
      floor: 0,
      tracer: 0x7fe0ff,
      born: sim.time,
    });
    sim.fx.push({ t: 'shot', actorId: tu.id, weaponDefId: 'core.weapon.p9', x: m.x, y: m.y, z: m.z, dirX: dx / d, dirY: dy / d, suppressed: true, team: 'hostile' });
  }
}

/** TUNABLE: the drill turret's barrel sits on top of its machine prop (top 1.2u) and reaches past its edge. */
export const TURRET_MUZZLE = { reach: 0.7, z: 1.35 } as const;

/**
 * Where a drill turret's training round leaves the barrel when aimed at (tx, ty): outside the turret's own machine
 * prop, so the round flies toward the target instead of stopping inside the prop it stands on.
 */
export function turretMuzzle(t: { x: number; y: number }, tx: number, ty: number): { x: number; y: number; z: number } {
  const d = Math.max(0.1, Math.hypot(tx - t.x, ty - t.y));
  return { x: t.x + ((tx - t.x) / d) * TURRET_MUZZLE.reach, y: t.y + ((ty - t.y) / d) * TURRET_MUZZLE.reach, z: TURRET_MUZZLE.z };
}
