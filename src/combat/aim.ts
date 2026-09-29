import type { HitboxProfile } from '../content/types';
import { EPS, approach, isFiniteVec, lineBox3, norm2, type Vec3 } from '../core/math';
import type { DynamicState, WorldGeometry } from '../world/geometry';
import type { ActorState } from '../world/state';

/**
 * Aim pipeline (LOCKED order): aim anchor → effective target → direction → body/weapon pose → hand/muzzle socket.
 * The muzzle never re-aims at the cursor (no muzzle→cursor→muzzle loop).
 */

export const NEAR_ENTER_PX = 12;
export const NEAR_EXIT_PX = 18;
/** Facing flip hysteresis on the aim x component. */
export const FLIP_THRESHOLD = 0.12;

export const LOW_COVER = {
  baseMuzzleZ: 1.0,
  raisedMuzzleZ: 1.35,
  raiseTime: 0.18,
  frontReach: 0.35,
  clearance: 0.05,
} as const;

export interface AimInput {
  x: number;
  y: number;
  z: number;
  actorId: string | null;
  /** Cursor distance from the projected aim anchor in base-view pixels (player only). */
  viewDistPx?: number;
}

export function anchorOf(a: ActorState, profile: HitboxProfile): Vec3 {
  return { x: a.x, y: a.y, z: profile.anchorZ };
}

/** Update the actor's aim direction with near-cursor hysteresis. Never produces NaN; never spins. */
export function updateAim(a: ActorState, input: AimInput): void {
  const aim = a.aim;
  if (!isFiniteVec({ x: input.x, y: input.y, z: input.z })) return;
  const dx = input.x - a.x;
  const dy = input.y - a.y;
  const viewDist = input.viewDistPx ?? Math.hypot(dx, dy) * 16;
  if (aim.tracking) {
    if (viewDist < NEAR_ENTER_PX) aim.tracking = false;
  } else if (viewDist > NEAR_EXIT_PX) {
    aim.tracking = true;
  }
  if (aim.tracking) {
    const n = norm2(dx, dy);
    if (n.x !== 0 || n.y !== 0) {
      aim.dirX = n.x;
      aim.dirY = n.y;
    }
  }
  aim.targetX = input.x;
  aim.targetY = input.y;
  aim.targetZ = input.z;
  aim.targetActorId = input.actorId;
  if (aim.dirX > FLIP_THRESHOLD) aim.faceRight = true;
  else if (aim.dirX < -FLIP_THRESHOLD) aim.faceRight = false;
}

export interface MuzzleGeometry {
  anchor: Vec3;
  barrelStart: Vec3;
  muzzle: Vec3;
}

export function muzzleGeometry(a: ActorState, profile: HitboxProfile, barrelLength: number): MuzzleGeometry {
  const mz = a.handling.muzzleZ;
  return {
    anchor: anchorOf(a, profile),
    barrelStart: { x: a.x, y: a.y, z: mz },
    muzzle: { x: a.x + a.aim.dirX * barrelLength, y: a.y + a.aim.dirY * barrelLength, z: mz },
  };
}

/** Base muzzle height for the stance (before any low-cover raise). */
export function baseMuzzleZ(profile: HitboxProfile): number {
  return profile.muzzleZ;
}

/**
 * Low-cover close shooting: standing within 0.35u (front of body) of a low projectile-blocking obstacle whose top
 * is above the base muzzle, raise the muzzle to 1.35u over ~0.18s, only if the raised line clears the top by 0.05u.
 */
export function updateMuzzleHeight(a: ActorState, profile: HitboxProfile, geo: WorldGeometry, dyn: DynamicState, dt: number, canRaise: boolean): void {
  const base = baseMuzzleZ(profile);
  let target = base;
  a.aim.lowCoverAhead = false;
  if (canRaise && a.stance === 'stand') {
    const reach = a.radius + LOW_COVER.frontReach;
    const o = { x: a.x, y: a.y, z: base };
    const d = { x: a.aim.dirX * reach, y: a.aim.dirY * reach, z: 0 };
    let nearestT = Infinity;
    let nearestTop = 0;
    for (const ob of geo.query(a.x - reach, a.y - reach, a.x + reach, a.y + reach)) {
      if (ob.floor !== a.floor || !ob.profile.blocksProjectile || !geo.isActive(ob, dyn)) continue;
      const hit = lineBox3(o, d, ob.box);
      if (!hit || hit[1] < 0 || hit[0] > 1) continue;
      const t = Math.max(0, hit[0]);
      if (t < nearestT) {
        nearestT = t;
        nearestTop = ob.box.z1;
      }
    }
    // Only a low obstacle (top above the base muzzle but low enough to clear by 0.05u) allows the raise.
    if (nearestT !== Infinity && nearestTop > base && nearestTop + LOW_COVER.clearance <= LOW_COVER.raisedMuzzleZ + EPS) {
      a.aim.lowCoverAhead = true;
      target = LOW_COVER.raisedMuzzleZ;
    }
  }
  const rate = (LOW_COVER.raisedMuzzleZ - LOW_COVER.baseMuzzleZ) / LOW_COVER.raiseTime;
  a.handling.muzzleZ = approach(a.handling.muzzleZ, target, rate * dt);
  a.handling.muzzleRaised = a.handling.muzzleZ > base + 0.01;
}

/** Is the barrel (barrelStart → muzzle) intersecting an active projectile blocker? */
export function barrelBlocked(m: MuzzleGeometry, floor: number, geo: WorldGeometry, dyn: DynamicState): boolean {
  const d = { x: m.muzzle.x - m.barrelStart.x, y: m.muzzle.y - m.barrelStart.y, z: m.muzzle.z - m.barrelStart.z };
  for (const ob of geo.query(m.barrelStart.x, m.barrelStart.y, m.muzzle.x, m.muzzle.y)) {
    if (ob.floor !== floor || !ob.profile.blocksProjectile || !geo.isActive(ob, dyn)) continue;
    const hit = lineBox3(m.barrelStart, d, ob.box);
    if (hit && hit[1] >= 0 && hit[0] <= 1) return true;
  }
  return false;
}

/** Shot base direction from the muzzle toward the effective target (flat forward when the target is behind/too close). */
export function shotBaseDirection(a: ActorState, m: MuzzleGeometry): Vec3 {
  const aim = a.aim;
  if (!aim.tracking) return { x: aim.dirX, y: aim.dirY, z: 0 };
  const vx = aim.targetX - m.muzzle.x;
  const vy = aim.targetY - m.muzzle.y;
  const vz = aim.targetZ - m.muzzle.z;
  const fwd = vx * aim.dirX + vy * aim.dirY;
  if (fwd < 0.5) return { x: aim.dirX, y: aim.dirY, z: 0 };
  const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!(l > EPS)) return { x: aim.dirX, y: aim.dirY, z: 0 };
  return { x: vx / l, y: vy / l, z: vz / l };
}

/** Rotate a direction by yaw/pitch offsets (degrees). */
export function applyAngles(dir: Vec3, yawDeg: number, pitchDeg: number): Vec3 {
  const h = Math.hypot(dir.x, dir.y);
  const yaw = Math.atan2(dir.y, dir.x) + (yawDeg * Math.PI) / 180;
  const pitch = Math.atan2(dir.z, h) + (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pitch);
  return { x: cp * Math.cos(yaw), y: cp * Math.sin(yaw), z: Math.sin(pitch) };
}

/** Uniform disk sample (r = sqrt(u1), θ = 2π u2) scaled by spread radius in degrees → yaw/pitch offsets. */
export function diskSample(u1: number, u2: number, spreadDeg: number): { yaw: number; pitch: number } {
  const r = Math.sqrt(u1) * spreadDeg;
  const th = 2 * Math.PI * u2;
  return { yaw: r * Math.cos(th), pitch: r * Math.sin(th) };
}
