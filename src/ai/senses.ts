import type { BehaviorProfile } from '../content/types';
import { hitboxOf, type SimContext } from '../world/context';
import type { ActorState, NoiseEvent } from '../world/state';

/**
 * AI perception uses real occlusion, light (time of day + nearby lights), posture, weather and noise.
 * Audio playback volume/mute/unlock never feeds into these functions.
 */
export interface Sight {
  visible: boolean;
  distance: number;
  quality: number;
}

export function lightAt(ctx: SimContext, x: number, y: number): number {
  let best = 0;
  for (const l of ctx.geo.map.lights) {
    const d = Math.hypot(l.x - x, l.y - y);
    if (d < l.radius) best = Math.max(best, 1 - d / l.radius);
  }
  return best;
}

export function visionRange(ctx: SimContext, beh: BehaviorProfile, target: ActorState): number {
  const sim = ctx.sim;
  const w = ctx.content.weather(sim.env.weather);
  const p = ctx.content.timePhase(sim.env.phase);
  let r = beh.detectRange * w.aiVision * p.aiVision;
  if (sim.env.phase !== 'Day') {
    const lit = lightAt(ctx, target.x, target.y);
    r = Math.max(r, beh.detectRange * w.aiVision * (0.55 + 0.45 * lit));
  }
  if (target.stance === 'crouch') r *= 0.72;
  if (ctx.geo.inFoliage(target.x, target.y, sim)) r *= target.stance === 'crouch' ? 0.45 : 0.65;
  if (target.sprinting) r *= 1.25;
  else if (target.moving) r *= 1.08;
  // Recent muzzle flash is very visible, especially at night.
  if (sim.time - target.handling.lastShotTime < 1.0) r *= sim.env.phase === 'Night' ? 1.9 : 1.35;
  return r;
}

export function canSee(ctx: SimContext, e: ActorState, target: ActorState, beh: BehaviorProfile): Sight {
  const sim = ctx.sim;
  const dx = target.x - e.x;
  const dy = target.y - e.y;
  const dist = Math.hypot(dx, dy);
  const none: Sight = { visible: false, distance: dist, quality: 0 };
  if (!target.alive || target.floor !== e.floor) return none;
  if (e.status.flashedUntil > sim.time) return none;
  const range = visionRange(ctx, beh, target);
  if (dist > range) return none;
  if (dist > 1.8) {
    const face = Math.atan2(e.aim.dirY, e.aim.dirX);
    const ang = Math.atan2(dy, dx);
    let diff = Math.abs(ang - face);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (diff > ((beh.fovDeg / 2) * Math.PI) / 180) return none;
  }
  const eye = { x: e.x, y: e.y, z: hitboxOf(ctx.content, e).eyeZ };
  const tp = hitboxOf(ctx.content, target);
  const head = tp.volumes.find((v) => v.part === 'head')!;
  const body = tp.volumes.find((v) => v.part === 'body')!;
  const pts = [
    { x: target.x, y: target.y, z: (head.z0 + head.z1) / 2 },
    { x: target.x, y: target.y, z: (body.z0 + body.z1) / 2 },
  ];
  let seen = 0;
  for (const p of pts) if (!ctx.geo.visionBlocked(sim, eye, p, e.floor)) seen++;
  if (seen === 0) return none;
  const q = (seen / pts.length) * (1 - 0.5 * (dist / Math.max(range, 0.01)));
  return { visible: true, distance: dist, quality: Math.max(0.15, q) };
}

/** Confirmation time (0.35–0.8s) scaled by distance and sight quality. */
export function confirmTime(beh: BehaviorProfile, s: Sight, range: number): number {
  const t = beh.confirmMin + (beh.confirmMax - beh.confirmMin) * Math.min(1, s.distance / Math.max(1, range));
  return t / Math.max(0.35, s.quality);
}

export interface Heard {
  heard: boolean;
  estX: number;
  estY: number;
}

/** Hearing: only an approximate investigation point, never the exact current position. */
export function hear(ctx: SimContext, e: ActorState, n: NoiseEvent): Heard {
  if (n.floor !== e.floor || n.sourceId === e.id) return { heard: false, estX: 0, estY: 0 };
  const src = ctx.sim.actors.find((a) => a.id === n.sourceId);
  if (src && src.team === e.team) return { heard: false, estX: 0, estY: 0 };
  const d = Math.hypot(n.x - e.x, n.y - e.y);
  if (d > n.radius) return { heard: false, estX: 0, estY: 0 };
  const occ = ctx.geo.soundOccluders(ctx.sim, e.x, e.y, n.x, n.y, e.floor);
  const eff = n.radius * Math.pow(0.55, occ);
  if (d > eff) return { heard: false, estX: 0, estY: 0 };
  const rng = ctx.rng.get('enemy');
  const err = 0.8 + d * 0.15;
  return { heard: true, estX: n.x + rng.gaussish() * err, estY: n.y + rng.gaussish() * err };
}
