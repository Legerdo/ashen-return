import type { HitPart, HitboxProfile } from '../content/types';
import { EPS, lineBox3, lineCylinder, type Vec3 } from '../core/math';
import type { ProjectileState, Team } from '../world/state';
import type { DynamicState, ObstacleRuntime, WorldGeometry } from '../world/geometry';
import { penetrate } from './damage';

/**
 * Continuous projectile ballistics. Each step sweeps the segment previous→next position and resolves the
 * minimum valid t across obstacles, actor hit volumes and the ground. Physics-query order is never used as
 * hit priority: candidates are sorted by (t, stable key).
 */

export interface ActorShape {
  id: string;
  team: Team;
  x: number;
  y: number;
  facingX: number;
  facingY: number;
  profile: HitboxProfile;
  floor: number;
}

export type Candidate =
  | { kind: 'actor'; t: number; key: string; actorId: string; part: HitPart }
  | { kind: 'obstacle'; t: number; tExit: number; key: string; ob: ObstacleRuntime }
  | { kind: 'ground'; t: number; key: string };

export interface BallisticHandler {
  hitActor(p: ProjectileState, actorId: string, part: HitPart, point: Vec3, distance: number): void;
  hitObstacle(p: ProjectileState, ob: ObstacleRuntime, point: Vec3, distance: number, penetrated: boolean, exit: Vec3 | null): void;
  hitGround(p: ProjectileState, point: Vec3, distance: number): void;
}

export const MAX_PENETRATIONS = 2;

/** World-space hit cylinders of an actor. */
export function hitCylinders(a: ActorShape): { part: HitPart; cx: number; cy: number; r: number; z0: number; z1: number }[] {
  return a.profile.volumes.map((v) => ({
    part: v.part,
    cx: a.x + a.facingX * v.forward,
    cy: a.y + a.facingY * v.forward,
    r: v.radius,
    z0: v.z0,
    z1: v.z1,
  }));
}

/** First volume of one actor crossed by the line o + d·t (t in [0,1]); null if none. */
export function actorEntry(a: ActorShape, o: Vec3, d: Vec3): { t: number; part: HitPart } | null {
  let best: { t: number; part: HitPart } | null = null;
  const topZ = Math.max(...a.profile.volumes.map((v) => v.z1));
  for (const c of hitCylinders(a)) {
    const hit = lineCylinder(o, d, c.cx, c.cy, c.r, c.z0, c.z1, c.z1 >= topZ);
    if (!hit) continue;
    const [t0, t1] = hit;
    if (t1 < 0 || t0 > 1) continue;
    const t = Math.max(0, t0);
    if (!best || t < best.t - EPS || (Math.abs(t - best.t) <= EPS && partPriority(c.part) < partPriority(best.part))) best = { t, part: c.part };
  }
  return best;
}

function partPriority(p: HitPart): number {
  return p === 'head' ? 0 : p === 'body' ? 1 : 2;
}

export function collectCandidates(
  o: Vec3,
  d: Vec3,
  floor: number,
  geo: WorldGeometry,
  dyn: DynamicState,
  actors: readonly ActorShape[],
  ownerId: string,
  exclude: readonly string[],
): Candidate[] {
  const out: Candidate[] = [];
  const ex = o.x + d.x;
  const ey = o.y + d.y;
  for (const ob of geo.query(o.x, o.y, ex, ey)) {
    if (ob.floor !== floor || !ob.profile.blocksProjectile || !geo.isActive(ob, dyn)) continue;
    const hit = lineBox3(o, d, ob.box);
    if (!hit) continue;
    const [t0, t1] = hit;
    // Ignore faces we are merely touching (e.g. resuming exactly at a penetrated obstacle's exit face).
    if (t1 <= 1e-7 || t0 > 1 || t1 - Math.max(0, t0) <= 1e-9) continue;
    out.push({ kind: 'obstacle', t: Math.max(0, t0), tExit: t1, key: `o:${ob.id}`, ob });
  }
  const segLen2 = d.x * d.x + d.y * d.y;
  for (const a of actors) {
    if (a.id === ownerId || a.floor !== floor || exclude.includes(a.id)) continue;
    // Broad phase: distance from actor to the segment's 2D line within segment length + margin.
    const rx = a.x - o.x;
    const ry = a.y - o.y;
    if (segLen2 > EPS) {
      let tt = (rx * d.x + ry * d.y) / segLen2;
      tt = Math.max(0, Math.min(1, tt));
      const cx = o.x + d.x * tt - a.x;
      const cy = o.y + d.y * tt - a.y;
      if (cx * cx + cy * cy > 1.0) continue;
    } else if (rx * rx + ry * ry > 1.0) continue;
    const e = actorEntry(a, o, d);
    if (e) out.push({ kind: 'actor', t: e.t, key: `a:${a.id}`, actorId: a.id, part: e.part });
  }
  if (d.z < -EPS) {
    const t = -o.z / d.z;
    if (t >= 0 && t <= 1) out.push({ kind: 'ground', t, key: 'g' });
  } else if (o.z <= 0) {
    out.push({ kind: 'ground', t: 0, key: 'g' });
  }
  return sortCandidates(out);
}

export function sortCandidates(c: Candidate[]): Candidate[] {
  return c.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Advance one projectile by dt (or its pending sub-tick remainder on the spawning tick). */
export function stepProjectile(p: ProjectileState, dt: number, geo: WorldGeometry, dyn: DynamicState, actors: readonly ActorShape[], handler: BallisticHandler): void {
  if (!p.alive) return;
  let rt = p.pending > 0 ? p.pending : dt;
  p.pending = 0;
  p.px = p.x;
  p.py = p.y;
  p.pz = p.z;
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
  if (!(speed > EPS)) {
    p.alive = false;
    return;
  }
  let segLen = speed * rt;
  const remaining = p.maxRange - p.traveled;
  if (remaining <= EPS) {
    p.alive = false;
    return;
  }
  if (segLen > remaining) {
    rt = remaining / speed;
    segLen = remaining;
  }
  const o: Vec3 = { x: p.x, y: p.y, z: p.z };
  const d: Vec3 = { x: p.vx * rt, y: p.vy * rt, z: p.vz * rt };
  const cands = collectCandidates(o, d, p.floor, geo, dyn, actors, p.ownerId, p.hitActors);
  let skipUntil = -1;
  for (const c of cands) {
    if (c.t < skipUntil) continue;
    const point = { x: o.x + d.x * c.t, y: o.y + d.y * c.t, z: o.z + d.z * c.t };
    const distance = p.traveled + c.t * segLen;
    if (c.kind === 'actor') {
      if (p.hitActors.includes(c.actorId)) continue;
      p.hitActors.push(c.actorId);
      handler.hitActor(p, c.actorId, c.part, point, distance);
      stopAt(p, point);
      return;
    }
    if (c.kind === 'ground') {
      handler.hitGround(p, point, distance);
      stopAt(p, point);
      return;
    }
    const ob = c.ob;
    const thickness = Math.max(0, c.tExit - c.t) * segLen;
    if (p.penetrations < MAX_PENETRATIONS && Number.isFinite(ob.profile.penetrationResistance)) {
      const r = penetrate(p.energy, ob.profile.penetrationResistance, thickness);
      if (r.passed) {
        p.energy = r.after;
        p.carry *= r.carryMult;
        p.vx *= r.speedMult;
        p.vy *= r.speedMult;
        p.vz *= r.speedMult;
        p.penetrations++;
        const exit = { x: o.x + d.x * c.tExit, y: o.y + d.y * c.tExit, z: o.z + d.z * c.tExit };
        handler.hitObstacle(p, ob, point, distance, true, exit);
        skipUntil = c.tExit;
        if (c.tExit >= 1) {
          // The obstacle extends beyond this step: resume from its exit face on the next tick.
          p.x = exit.x;
          p.y = exit.y;
          p.z = exit.z;
          p.traveled += c.tExit * segLen;
          if (p.traveled >= p.maxRange - EPS) p.alive = false;
          return;
        }
        continue;
      }
    }
    handler.hitObstacle(p, ob, point, distance, false, null);
    stopAt(p, point);
    return;
  }
  p.x = o.x + d.x;
  p.y = o.y + d.y;
  p.z = o.z + d.z;
  p.traveled += segLen;
  if (p.traveled >= p.maxRange - EPS || p.z > 14) p.alive = false;
}

function stopAt(p: ProjectileState, point: Vec3): void {
  p.x = point.x;
  p.y = point.y;
  p.z = point.z;
  p.alive = false;
}
