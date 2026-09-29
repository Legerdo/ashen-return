import { EPS } from '../core/math';
import type { SimContext } from './context';
import { carriedWeightKg, normalLimitKg, weightMoveMult } from './movement';
import { isTraining, type ActionState, type ActionType, type ActorState } from './state';

/** Dodge roll TUNABLE values. */
export const DODGE = {
  /** Stamina per roll (free for the player in training sims). */
  stamina: 22,
  /** Roll length (s). No firing, reloading or item use while rolling. */
  duration: 0.42,
  /** Ground covered in the open at a normal load (u); overweight shortens it like walking speed. */
  distance: 3.0,
  /** Invulnerability from the start of the roll (s): bullets, frag blasts and melee swings pass through. */
  iframes: 0.3,
  /** Recovery after a roll ends before the next one can start (s). */
  cooldown: 0.35,
  /** Speed at the end of the roll relative to its start (linear deceleration). */
  endSpeed: 0.3,
  /** Hearing radius of a roll (u), scaled by ground and weather like footsteps. */
  noiseRadius: 5,
} as const;

/** Timed actions a roll interrupts (steps already committed stay committed). Melee, throws and rolls are never cut. */
const INTERRUPTIBLE: ReadonlySet<ActionType> = new Set<ActionType>(['reload', 'tubeReload', 'refillMag', 'heal', 'switch', 'sprintStop', 'loadMag', 'unloadMag']);

export type DodgeResult = 'started' | 'busy' | 'cooldown' | 'no_stamina';

/** Ground covered `t` seconds into a roll of length `dist` (linear deceleration to DODGE.endSpeed). */
export function dodgeProgress(t: number, dist: number): number {
  const T = DODGE.duration;
  const tt = Math.max(0, Math.min(T, t));
  const v0 = (2 * dist) / (T * (1 + DODGE.endSpeed));
  return v0 * (tt - ((1 - DODGE.endSpeed) * tt * tt) / (2 * T));
}

/** Velocity (u/s) that covers this tick's share of the roll; the whole roll sums to exactly `dist` in the open. */
export function dodgeVelocity(act: ActionState, dt: number): { vx: number; vy: number } {
  const dist = act.dist ?? DODGE.distance;
  const d = dodgeProgress(act.elapsed + dt, dist) - dodgeProgress(act.elapsed, dist);
  return { vx: ((act.dirX ?? 0) * d) / dt, vy: ((act.dirY ?? 0) * d) / dt };
}

export function isDodging(a: ActorState): boolean {
  return a.action?.type === 'dodge';
}

/**
 * Start a dodge roll toward (dirX, dirY) — the move input; a zero vector rolls toward the aim direction.
 * Costs stamina (none for the player in training sims), forces a standing stance, cancels an interruptible action and
 * grants DODGE.iframes of invulnerability. Used by the player command and by boss / elite AI alike.
 */
export function startDodge(ctx: SimContext, a: ActorState, dirX: number, dirY: number): DodgeResult {
  const sim = ctx.sim;
  if (!a.alive) return 'busy';
  if (a.action && !INTERRUPTIBLE.has(a.action.type)) return 'busy';
  if (a.dodgeReadyAt !== undefined && sim.time + 1e-9 < a.dodgeReadyAt) return 'cooldown';
  const free = a.kind === 'player' && isTraining(sim);
  if (!free && a.stamina < DODGE.stamina) return 'no_stamina';
  let dx = dirX;
  let dy = dirY;
  if (Math.hypot(dx, dy) < EPS) {
    dx = a.aim.dirX;
    dy = a.aim.dirY;
  }
  let l = Math.hypot(dx, dy);
  if (l < EPS) {
    dx = 1;
    dy = 0;
    l = 1;
  }
  dx /= l;
  dy /= l;
  if (!free) {
    a.stamina -= DODGE.stamina;
    a.staminaIdle = 0;
  }
  a.stance = 'stand';
  a.sprinting = false;
  a.handling.adsT = 0;
  const dist = DODGE.distance * weightMoveMult(carriedWeightKg(ctx, a), normalLimitKg(ctx, a));
  a.action = { type: 'dodge', start: sim.time, duration: DODGE.duration, elapsed: 0, dirX: dx, dirY: dy, dist, steps: [] };
  a.iframeUntil = sim.time + DODGE.iframes;
  a.dodgeReadyAt = sim.time + DODGE.duration + DODGE.cooldown;
  const g = ctx.geo.groundAt(a.x, a.y);
  const w = ctx.content.weather(sim.env.weather);
  sim.noises.push({ x: a.x, y: a.y, floor: a.floor, loudness: 0.35, radius: DODGE.noiseRadius * g.noiseMult * w.sound, tag: 'dodge', sourceId: a.id, time: sim.time });
  sim.fx.push({ t: 'dodge', actorId: a.id, x: a.x, y: a.y, dirX: dx, dirY: dy, material: g.footstep });
  return 'started';
}
