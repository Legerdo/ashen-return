import type { AmmoSpec, AttachmentSpec, ItemDef, PerkEffects, WeaponSpec } from '../content/types';
import { allocId } from '../core/ids';
import { hash32 } from '../core/rng';
import { clamp } from '../core/math';
import type { ItemInstance } from '../inventory/store';
import { activeWeaponItem, hitboxOf, type SimContext } from '../world/context';
import type { ActorState, ProjectileState } from '../world/state';
import { applyAngles, barrelBlocked, diskSample, muzzleGeometry, shotBaseDirection } from './aim';

export interface WeaponStats {
  def: ItemDef;
  spec: WeaponSpec;
  recoilDeg: number;
  stabilizeSec: number;
  noiseRadius: number;
  adsMoveSpreadMult: number;
  durabilityFactor: number;
  reloadMult: number;
  suppressed: boolean;
  weightKg: number;
}

export const BLOOM_MAX = 3;
export const BLOOM_RECOVERY_DELAY = 0.15;
export const BLOOM_RECOVERY_RATE = 3;
export const HIP_SPREAD_MULT = 4;
export const MOVING_SPREAD_MULT = 1.5;
export const CROUCH_SPREAD_MULT = 0.8;
export const DURABILITY_LOSS_PER_SHOT = 0.05;
export const SPRINT_TO_FIRE = 0.12;

export function attachmentSpecs(ctx: SimContext, w: ItemInstance): AttachmentSpec[] {
  const out: AttachmentSpec[] = [];
  for (const id of Object.values(w.attachments)) {
    if (!id) continue;
    const it = ctx.sim.store.items[id];
    if (!it) continue;
    const d = ctx.content.item(it.definitionId);
    if (d.attachment) out.push(d.attachment);
  }
  return out;
}

export function weaponStats(ctx: SimContext, w: ItemInstance, perks: PerkEffects | null): WeaponStats {
  const def = ctx.content.item(w.definitionId);
  const spec = def.weapon!;
  let recoil = spec.recoilDeg;
  let stab = spec.stabilizeSec;
  let noise = spec.gunshotRadius;
  let adsMove = 1;
  let suppressed = false;
  let weight = def.weightKg;
  for (const id of Object.values(w.attachments)) {
    if (!id) continue;
    const it = ctx.sim.store.items[id];
    if (!it) continue;
    const ad = ctx.content.item(it.definitionId);
    weight += ad.weightKg;
    const a = ad.attachment;
    if (!a) continue;
    recoil *= a.recoilMult;
    stab *= a.adsTimeMult;
    noise *= a.noiseMult;
    adsMove *= a.adsMoveSpreadMult;
    if (a.noiseMult < 1) suppressed = true;
  }
  if (perks?.stabilizeMult) stab *= perks.stabilizeMult;
  const dur = w.durability ?? 100;
  return {
    def,
    spec,
    recoilDeg: recoil,
    stabilizeSec: stab,
    noiseRadius: noise,
    adsMoveSpreadMult: adsMove,
    durabilityFactor: 1 + 0.25 * (1 - clamp(dur, 0, 100) / 100),
    reloadMult: perks?.reloadMult ?? 1,
    suppressed,
    weightKg: weight,
  };
}

/** Ammo that the next shot will use (chamber first). */
export function chamberAmmo(w: ItemInstance): string | null {
  return w.weapon?.chamber ?? null;
}

export function magazineOf(ctx: SimContext, w: ItemInstance): ItemInstance | null {
  const id = w.weapon?.magazineId;
  return id ? (ctx.sim.store.items[id] ?? null) : null;
}

/** Rounds physically in the weapon (chamber + inserted magazine or tube). */
export function roundsInWeapon(ctx: SimContext, w: ItemInstance): number {
  let n = w.weapon?.chamber ? 1 : 0;
  if (w.weapon?.tube) n += w.weapon.tube.length;
  const mag = magazineOf(ctx, w);
  if (mag?.mag) n += mag.mag.rounds.length;
  return n;
}

export function ammoSpecFor(ctx: SimContext, ammoDefId: string): AmmoSpec {
  const a = ctx.content.item(ammoDefId).ammo;
  if (!a) throw new Error(`not ammo: ${ammoDefId}`);
  return a;
}

/** Current cone half-angle in degrees. */
export function currentSpreadDeg(a: ActorState, stats: WeaponStats, ammo: AmmoSpec | null): number {
  const precise = ammo?.spreadOverrideDeg ?? stats.spec.precisionSpreadDeg;
  const hip = precise * HIP_SPREAD_MULT;
  let s = hip + (precise - hip) * clamp(a.handling.adsT, 0, 1);
  if (a.moving) s *= MOVING_SPREAD_MULT * (a.handling.adsT > 0.5 ? stats.adsMoveSpreadMult : 1);
  if (a.stance === 'crouch') s *= CROUCH_SPREAD_MULT;
  s += a.handling.bloom;
  s *= stats.durabilityFactor;
  return s;
}

/** Deterministic recoil pattern by weapon definition and shot index. */
export function recoilPattern(defId: string, shotIndex: number): { pitch: number; yaw: number } {
  const h = hash32(`${defId}#${shotIndex}`);
  const u1 = (h & 0xffff) / 0xffff;
  const u2 = (h >>> 16) / 0xffff;
  return { pitch: 0.5 + 0.35 * u1, yaw: (u2 - 0.5) * 0.7 };
}

export interface TriggerState {
  held: boolean;
  pressed: boolean;
}

/** Can this actor pull the trigger right now (actions that block firing). */
export function fireBlocked(a: ActorState): boolean {
  if (!a.alive) return true;
  const act = a.action;
  if (!act) return false;
  return act.type !== 'reload' && act.type !== 'tubeReload' ? true : false;
}

export interface FireResult {
  shots: number;
  dry: boolean;
}

/**
 * Fire processing for one simulation tick [tickStart, tickStart+dt). Shot times are exact (60/RPM cadence carried
 * across ticks) so the fire rate is independent of render FPS.
 */
export function processFire(ctx: SimContext, a: ActorState, trigger: TriggerState, tickStart: number, dt: number): FireResult {
  const res: FireResult = { shots: 0, dry: false };
  const aw = activeWeaponItem(ctx, a);
  const h = a.handling;
  const tickEnd = tickStart + dt;
  if (!aw) {
    h.triggerHeld = trigger.held;
    return res;
  }
  const w = aw.item;
  const stats = weaponStats(ctx, w, a.kind === 'player' ? ctx.sim.perks : null);
  const spec = stats.spec;
  const interval = 60 / spec.rpm;
  if (trigger.pressed && a.sprinting) {
    // Sprint → stop sprinting first, then enter normal firing state.
    a.sprinting = false;
    if (!a.action) a.action = { type: 'sprintStop', start: ctx.sim.time, duration: SPRINT_TO_FIRE, elapsed: 0, steps: [] };
    h.semiBufferedUntil = tickStart + SPRINT_TO_FIRE + 0.05;
  }
  // A new trigger press cancels a reload in progress (already committed steps stay committed).
  if (trigger.pressed && a.action && (a.action.type === 'reload' || a.action.type === 'tubeReload') && w.weapon!.chamber) {
    a.action = null;
  }
  const blocked = fireBlocked(a) || a.sprinting;
  const mode = w.weapon!.fireMode;
  if (trigger.pressed && mode !== 'auto') h.semiBufferedUntil = Math.max(h.semiBufferedUntil, tickStart + 0.1);
  if (!blocked) {
    let t = Math.max(h.nextShotTime, tickStart);
    if (mode === 'auto') {
      while (trigger.held && t < tickEnd - 1e-12) {
        if (!w.weapon!.chamber && !(ctx.sim.debug.infiniteAmmo && a.kind === 'player')) {
          if (trigger.pressed) res.dry = true;
          break;
        }
        fireOne(ctx, a, w, stats, t, tickEnd);
        res.shots++;
        t += interval;
        h.nextShotTime = t;
      }
    } else if (h.semiBufferedUntil >= tickStart && t < tickEnd - 1e-12) {
      if (!w.weapon!.chamber && !(ctx.sim.debug.infiniteAmmo && a.kind === 'player')) {
        if (trigger.pressed) res.dry = true;
        h.semiBufferedUntil = -1;
      } else {
        fireOne(ctx, a, w, stats, t, tickEnd);
        res.shots++;
        h.nextShotTime = t + interval;
        h.semiBufferedUntil = -1;
      }
    }
  }
  if (res.dry) ctx.sim.fx.push({ t: 'dryfire', actorId: a.id });
  h.triggerHeld = trigger.held;
  return res;
}

function fireOne(ctx: SimContext, a: ActorState, w: ItemInstance, stats: WeaponStats, shotTime: number, tickEnd: number): void {
  const sim = ctx.sim;
  const wr = w.weapon!;
  const spec = stats.spec;
  let ammoId = wr.chamber;
  if (!ammoId) {
    // Debug infinite ammo only: synthesize a chamber round of the weapon's FMJ.
    ammoId = `core.ammo.${spec.caliber}.${spec.caliber === '12g' ? 'buck' : 'fmj'}`;
  } else if (!(sim.debug.infiniteAmmo && a.kind === 'player')) {
    wr.chamber = null;
    // Feed next round.
    if (wr.tube) wr.chamber = wr.tube.pop() ?? null;
    else {
      const mag = magazineOf(ctx, w);
      if (mag?.mag && mag.mag.rounds.length > 0) wr.chamber = mag.mag.rounds.pop()!;
    }
  }
  const ammo = ammoSpecFor(ctx, ammoId);
  if (w.durability !== null) w.durability = Math.max(0, w.durability - DURABILITY_LOSS_PER_SHOT);
  const profile = hitboxOf(ctx.content, a);
  const mg = muzzleGeometry(a, profile, spec.muzzleLength);
  const base = shotBaseDirection(a, mg);
  const noSpread = !!sim.debug.noSpread;
  const spread = noSpread ? 0 : currentSpreadDeg(a, stats, ammo);
  const pellets = ammo.pelletsOverride ?? spec.pellets;
  const combat = ctx.rng.get('combat');
  const h = a.handling;
  const shotId = allocId(sim.ids, `shot-${a.id}`);
  const effRange = ammo.rangeOverride?.effective ?? spec.effectiveRange;
  const maxRange = ammo.rangeOverride?.max ?? spec.maxRange;
  const minFactor = ammo.rangeOverride?.minFactor ?? spec.minRangeFactor;
  const speed = spec.muzzleVelocity * (ammo.velocityMult ?? 1);
  const blocked = barrelBlocked(mg, a.floor, ctx.geo, sim);
  for (let i = 0; i < pellets; i++) {
    const u1 = combat.next();
    const u2 = combat.next();
    const off = diskSample(u1, u2, spread);
    const dir = noSpread ? base : applyAngles(base, off.yaw + h.recoilYaw, off.pitch + h.recoilPitch);
    const p: ProjectileState = {
      id: allocId(sim.ids, 'pr'),
      shotId,
      pelletId: i,
      ownerId: a.id,
      team: a.team,
      weaponDefId: w.definitionId,
      ammoDefId: ammoId,
      x: mg.barrelStart.x,
      y: mg.barrelStart.y,
      z: mg.barrelStart.z,
      px: mg.barrelStart.x,
      py: mg.barrelStart.y,
      pz: mg.barrelStart.z,
      vx: dir.x * speed,
      vy: dir.y * speed,
      vz: dir.z * speed,
      traveled: -spec.muzzleLength,
      maxRange,
      effRange,
      minFactor,
      baseDamage: ammo.damageOverride ?? spec.damage,
      energy: ammo.envEnergy,
      carry: 1,
      penetrations: 0,
      hitActors: [],
      alive: true,
      pending: Math.max(1e-6, tickEnd - shotTime),
      floor: a.floor,
      tracer: ammo.tracer,
      born: shotTime,
    };
    sim.projectiles.push(p);
    if (sim.shotLog.length >= 400) sim.shotLog.splice(0, sim.shotLog.length - 399);
    sim.shotLog.push({
      shotId,
      pelletId: i,
      weaponId: w.definitionId,
      ammoId,
      shotTime,
      origin: [mg.muzzle.x, mg.muzzle.y, mg.muzzle.z],
      aim: [a.aim.targetX, a.aim.targetY, a.aim.targetZ],
      spreadSeed: [u1, u2],
      firstHit: 'pending',
      barrelBlocked: blocked,
      part: null,
      range: 0,
      rawDamage: 0,
      armorBefore: null,
      armorLoss: 0,
      calculatedHPDamage: 0,
      actualHPLoss: 0,
    });
  }
  // Recoil and bloom after the shot (applies to the following shot).
  const rp = recoilPattern(w.definitionId, h.shotIndex);
  h.recoilPitch = clamp(h.recoilPitch + stats.recoilDeg * rp.pitch, -8, 8);
  h.recoilYaw = clamp(h.recoilYaw + stats.recoilDeg * rp.yaw, -4, 4);
  h.bloom = Math.min(BLOOM_MAX, h.bloom + spec.bloomPerShot);
  h.shotIndex++;
  h.lastShotTime = shotTime;
  if (a.kind === 'player') sim.stats.shotsFired++;
  const weatherSound = ctx.content.weather(sim.env.weather).sound;
  // Rain/storm mask distant gunshots a little for AI hearing (never affects audio playback rules).
  const radius = stats.noiseRadius * (0.85 + 0.15 * weatherSound);
  const noise = { x: mg.muzzle.x, y: mg.muzzle.y, floor: a.floor, loudness: 1, radius, tag: 'gunshot', sourceId: a.id, time: shotTime };
  sim.noises.push(noise);
  sim.fx.push({ t: 'shot', actorId: a.id, weaponDefId: w.definitionId, x: mg.muzzle.x, y: mg.muzzle.y, z: mg.muzzle.z, dirX: base.x, dirY: base.y, suppressed: stats.suppressed, team: a.team });
}

/** Per-tick handling recovery: ADS stabilization, bloom and recoil recovery. */
export function updateHandling(ctx: SimContext, a: ActorState, adsHeld: boolean, dt: number): void {
  const h = a.handling;
  const aw = activeWeaponItem(ctx, a);
  if (!aw) {
    h.adsT = 0;
    return;
  }
  const stats = weaponStats(ctx, aw.item, a.kind === 'player' ? ctx.sim.perks : null);
  if (h.weaponId !== aw.item.instanceId) {
    h.weaponId = aw.item.instanceId;
    h.bloom = 0;
    h.recoilPitch = 0;
    h.recoilYaw = 0;
    h.shotIndex = 0;
    h.adsT = 0;
  }
  const canAds = adsHeld && !a.sprinting && (!a.action || a.action.type === 'reload' || a.action.type === 'tubeReload');
  if (canAds) h.adsT = Math.min(1, h.adsT + dt / Math.max(0.05, stats.stabilizeSec));
  else h.adsT = Math.max(0, h.adsT - dt / 0.1);
  const since = ctx.sim.time - h.lastShotTime;
  if (since > BLOOM_RECOVERY_DELAY) h.bloom = Math.max(0, h.bloom - BLOOM_RECOVERY_RATE * dt);
  if (since > 0.08) {
    const rec = a.kind === 'player' ? (ctx.sim.perks.recoilRecoveryMult ?? 1) : 1;
    const tau = Math.max(0.06, (stats.stabilizeSec * 1.2) / rec);
    const k = Math.exp(-dt / tau);
    h.recoilPitch *= k;
    h.recoilYaw *= k;
    if (Math.abs(h.recoilPitch) < 0.001) h.recoilPitch = 0;
    if (Math.abs(h.recoilYaw) < 0.001) h.recoilYaw = 0;
    if (since > 0.5) h.shotIndex = 0;
  }
}
