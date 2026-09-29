import type { HitboxProfile } from '../content/types';
import { meleeItem, hitboxOf, type SimContext } from './context';
import { applyHit } from './combatResolve';
import { inIframes, isTraining, type ActorState } from './state';

export const MELEE_HALF_CONE = (70 * Math.PI) / 180;
export const MELEE_CONE_COS = Math.cos(MELEE_HALF_CONE);
/** TUNABLE: extra hit reach (u) beyond the weapon's reach, so the hit area matches the drawn swing arc. */
export const MELEE_REACH_BONUS = 0.45;
/** TUNABLE: a body partly inside the cone counts, up to this much angular size (rad). */
export const MELEE_EDGE_TOLERANCE = (10 * Math.PI) / 180;
/** Nominal body radius used to place the drawn arc on the hit edge (actors are 0.3u). */
export const MELEE_NOMINAL_BODY = 0.3;

/** Farthest target-centre distance a swing reaches. */
export function meleeHitRange(reach: number, targetRadius: number, attackerRadius: number): number {
  return reach + MELEE_REACH_BONUS + targetRadius + attackerRadius * 0.5;
}

/** Radius (u) of the drawn swing arc: the hit edge for a standard body, so what the arc sweeps is what gets hit. */
export function meleeArcRadius(reach: number, attackerRadius = 0.3): number {
  return meleeHitRange(reach, MELEE_NOMINAL_BODY, attackerRadius) - MELEE_NOMINAL_BODY * 0.5;
}

/** Height (u) of the swing: the arc is drawn around the attacker's chest at this height. */
export const MELEE_ARC_Z = 0.9;
/** TUNABLE: a visibly covered body counts up to this much farther on the ground than the side-on reach (u). */
export const MELEE_DEPTH_SLACK = 0.5;

/**
 * Does the swing sector cover any visible part of a target's body?
 * The arc is drawn on screen around the attacker's chest, and a body occupies a vertical strip on screen (feet → head),
 * so every body height z is tested in screen-plane terms: the offset of that body point from the swing centre is
 * (dx, dy − (z − MELEE_ARC_Z)). A point counts when it is within `range` and inside the ±70° cone (plus the body's
 * angular half-width, capped). What the arc visibly sweeps over is what it hits — not only the body centre point.
 * Points overlapping the attacker's own chest (screen distance < 0.35u) are ambiguous and ignored; the ground distance
 * is capped at range + MELEE_DEPTH_SLACK so depth ambiguity of the top-down view cannot stretch the reach far.
 */
export function swingCovers(dx: number, dy: number, dirX: number, dirY: number, range: number, radius: number, prof: HitboxProfile): boolean {
  if (Math.hypot(dx, dy) > range + MELEE_DEPTH_SLACK) return false;
  let zLo = Infinity;
  let zHi = -Infinity;
  for (const v of prof.volumes) {
    zLo = Math.min(zLo, v.z0);
    zHi = Math.max(zHi, v.z1);
  }
  zLo += 0.1;
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const z = zLo + ((zHi - zLo) * i) / N;
    const px = dx;
    const py = dy - (z - MELEE_ARC_Z);
    const dist = Math.hypot(px, py);
    if (dist < 0.35 || dist > range) continue;
    const cos = (px * dirX + py * dirY) / dist;
    const tol = Math.min(MELEE_EDGE_TOLERANCE, Math.asin(Math.min(1, radius / dist)));
    if (Math.acos(Math.max(-1, Math.min(1, cos))) - tol <= MELEE_HALF_CONE) return true;
  }
  return false;
}

export function startMelee(ctx: SimContext, a: ActorState): boolean {
  if (a.action) return false;
  const m = meleeItem(ctx, a);
  const spec = m?.def.melee;
  if (!spec) return false;
  // Training sims: swings cost no stamina for the player.
  const free = a.kind === 'player' && isTraining(ctx.sim);
  if (!free) {
    if (a.stamina < spec.stamina) return false;
    a.stamina -= spec.stamina;
    a.staminaIdle = 0;
  }
  a.sprinting = false;
  a.action = { type: 'melee', start: ctx.sim.time, duration: spec.cycle, elapsed: 0, itemId: m.item.instanceId, meleeDone: false, steps: [] };
  return true;
}

export function tickMelee(ctx: SimContext, a: ActorState): boolean {
  const act = a.action!;
  const it = act.itemId ? ctx.sim.store.items[act.itemId] : undefined;
  const spec = it ? ctx.content.item(it.definitionId).melee : undefined;
  if (!spec) return true;
  if (!act.meleeDone && act.elapsed >= act.duration * 0.4) {
    act.meleeDone = true;
    let best: ActorState | null = null;
    let bestD = Infinity;
    for (const t of ctx.sim.actors) {
      if (!t.alive || t.id === a.id || t.team === a.team || t.floor !== a.floor || t.kind === 'npc') continue;
      if (inIframes(ctx.sim, t)) continue; // rolled under the swing
      const dx = t.x - a.x;
      const dy = t.y - a.y;
      const d = Math.hypot(dx, dy);
      if (!swingCovers(dx, dy, a.aim.dirX, a.aim.dirY, meleeHitRange(spec.reach, t.radius, a.radius), t.radius, hitboxOf(ctx.content, t))) continue;
      const from = { x: a.x, y: a.y, z: 1.0 };
      const to = { x: t.x, y: t.y, z: 1.0 };
      if (!ctx.geo.projectileClear(ctx.sim, from, to, a.floor)) continue;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    ctx.sim.noises.push({ x: a.x, y: a.y, floor: a.floor, loudness: 0.3, radius: 3, tag: 'melee', sourceId: a.id, time: ctx.sim.time });
    ctx.sim.fx.push({ t: 'melee', actorId: a.id, hit: !!best, x: a.x, y: a.y, dirX: a.aim.dirX, dirY: a.aim.dirY, targetId: best?.id ?? null });
    if (best) {
      const prof = hitboxOf(ctx.content, best);
      const body = prof.volumes.find((v) => v.part === 'body')!;
      // Presentation: blood/feather burst and the flesh impact sound at the struck body.
      ctx.sim.fx.push({ t: 'impact', x: best.x - a.aim.dirX * best.radius * 0.5, y: best.y - a.aim.dirY * best.radius * 0.5, z: (body.z0 + body.z1) / 2, material: 'flesh', actor: true });
      applyHit(ctx, best, {
        part: 'body',
        baseDamage: spec.damage,
        ammo: { fleshMult: 1, penetration: spec.penetration, armorDamage: 0.5, headMult: 1 },
        range: 0,
        effectiveRange: 1,
        maxRange: 2,
        minRangeFactor: 1,
        carry: 1,
        buff: 1,
        attackerId: a.id,
        weaponDefId: it!.definitionId,
        bleedChance: spec.bleedChance,
        point: { x: best.x, y: best.y, z: (body.z0 + body.z1) / 2 },
        source: 'melee',
      });
    }
  }
  return act.elapsed + 1e-9 >= act.duration;
}
