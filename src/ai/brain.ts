import type { BehaviorProfile, EnemyArchetypeDef } from '../content/types';
import { updateAim, updateMuzzleHeight } from '../combat/aim';
import { requestReload } from '../combat/reload';
import { processFire, roundsInWeapon, type TriggerState } from '../combat/weapons';
import { activeWeaponItem, carriedContainerIds, hitboxOf, type SimContext } from '../world/context';
import { toggleDoor } from '../world/interact';
import { SIM_DT } from '../core/clock';
import { DODGE, dodgeVelocity, isDodging, startDodge } from '../world/dodge';
import { moveActor, updateStamina } from '../world/movement';
import { startMelee } from '../world/melee';
import { spawnEnemy } from '../world/spawn';
import type { ActorState, AIMode, NoiseEvent } from '../world/state';
import { findThrowable, startThrow } from '../world/throwables';
import { skillOf } from '../world/threat';
import { navFor, type NavGrid } from './nav';
import { canSee, confirmTime, hear, visionRange } from './senses';

const CALM: AIMode[] = ['Idle', 'Patrol', 'Return'];
const COMBAT: AIMode[] = ['Combat', 'Cover', 'Flank', 'Reload'];
const AI_WALK = 2.9;
const AI_RUN = 4.3;
const AI_CROUCH = 1.6;

interface Intent {
  goal: { x: number; y: number } | null;
  speed: number;
  crouch: boolean;
  trigger: TriggerState;
  aim: { x: number; y: number; z: number } | null;
  face: { x: number; y: number } | null;
}

export function tickAI(ctx: SimContext, dt: number, tickStart: number): void {
  const sim = ctx.sim;
  if (sim.mode !== 'raid') return;
  const nav = navFor(ctx.geo);
  const pl = sim.actors.find((a) => a.kind === 'player') ?? null;
  const noises = sim.noises.slice();
  for (const e of sim.actors) {
    if (e.kind !== 'enemy' || !e.alive || !e.ai) continue;
    if (sim.debug.freezeAI) continue;
    const arch = ctx.content.enemy(e.archetypeId!);
    for (const n of noises) processNoise(ctx, e, n);
    const intent = think(ctx, e, arch, pl, nav, dt);
    act(ctx, e, intent, nav, dt, tickStart);
  }
}

function setMode(ctx: SimContext, e: ActorState, m: AIMode): void {
  const ai = e.ai!;
  if (ai.mode === m) return;
  const wasCalm = CALM.includes(ai.mode) || ai.mode === 'Suspicious' || ai.mode === 'Investigate' || ai.mode === 'Search';
  ai.mode = m;
  ai.modeSince = ctx.sim.time;
  ai.path = [];
  ai.repathAt = 0;
  if (COMBAT.includes(m) && wasCalm) ctx.sim.fx.push({ t: 'alert', actorId: e.id, mode: m });
}

function processNoise(ctx: SimContext, e: ActorState, n: NoiseEvent): void {
  const ai = e.ai!;
  const h = hear(ctx, e, n);
  if (!h.heard) return;
  ai.lastHeardX = h.estX;
  ai.lastHeardY = h.estY;
  ai.lastHeardTime = ctx.sim.time;
  if (ai.disarmed) return;
  if (CALM.includes(ai.mode) || ai.mode === 'Search') {
    ai.investigateX = h.estX;
    ai.investigateY = h.estY;
    setMode(ctx, e, n.tag === 'gunshot' || n.tag === 'explosion' ? 'Investigate' : 'Suspicious');
  } else if (ai.mode === 'Suspicious' || ai.mode === 'Investigate') {
    ai.investigateX = h.estX;
    ai.investigateY = h.estY;
  }
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function hasAnyAmmo(ctx: SimContext, e: ActorState): boolean {
  const aw = activeWeaponItem(ctx, e);
  if (!aw) return false;
  if (roundsInWeapon(ctx, aw.item) > 0) return true;
  const spec = aw.def.weapon!;
  for (const cid of carriedContainerIds(ctx.sim, e)) {
    for (const id of ctx.sim.store.containers[cid]?.items ?? []) {
      const it = ctx.sim.store.items[id];
      if (!it) continue;
      const d = ctx.content.item(it.definitionId);
      if (d.ammo?.caliber === spec.caliber) return true;
      if (d.magazine && d.magazine.family === spec.magazineFamily && (it.mag?.rounds.length ?? 0) > 0) return true;
    }
  }
  return false;
}

function findCover(ctx: SimContext, nav: NavGrid, e: ActorState, tx: number, ty: number, radius: number, towardThreat: boolean): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  const base = Math.atan2(ty - e.y, tx - e.x);
  const doorOk = (d: string) => !ctx.sim.doors[d]?.locked;
  for (const r of [1.5, 3, 4.5, 6, 8]) {
    if (r > radius) break;
    for (let k = 0; k < 10; k++) {
      const ang = base + (k / 10) * Math.PI * 2;
      const x = e.x + Math.cos(ang) * r;
      const y = e.y + Math.sin(ang) * r;
      if (!nav.walkableAt(x, y, doorOk)) continue;
      const dT = dist(x, y, tx, ty);
      if (dT < 3) continue;
      const covered = !ctx.geo.projectileClear(ctx.sim, { x: tx, y: ty, z: 1.25 }, { x, y, z: 0.8 }, e.floor);
      if (!covered) continue;
      const peek = ctx.geo.projectileClear(ctx.sim, { x: tx, y: ty, z: 1.3 }, { x, y, z: 1.55 }, e.floor);
      let score = r + (peek ? 0 : 2.5);
      score += towardThreat ? dT * 0.35 : -dT * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}

function nextPatrol(e: ActorState): { x: number; y: number } | null {
  const ai = e.ai!;
  if (ai.patrol.length === 0) return null;
  const p = ai.patrol[ai.patrolIndex % ai.patrol.length]!;
  if (dist(e.x, e.y, p.x, p.y) < 0.7) {
    ai.patrolIndex = (ai.patrolIndex + 1) % ai.patrol.length;
  }
  return ai.patrol[ai.patrolIndex % ai.patrol.length]!;
}

function think(ctx: SimContext, e: ActorState, arch: EnemyArchetypeDef, pl: ActorState | null, nav: NavGrid, dt: number): Intent {
  const sim = ctx.sim;
  const ai = e.ai!;
  const beh = arch.behavior;
  const rng = ctx.rng.get('enemy');
  const intent: Intent = { goal: null, speed: AI_WALK * beh.moveSpeedMult, crouch: false, trigger: { held: false, pressed: false }, aim: null, face: null };
  const sight = pl ? canSee(ctx, e, pl, beh) : { visible: false, distance: 99, quality: 0 };
  if (ai.disarmed) {
    // Whole finite loadout spent: never re-engage (and never re-alert). Melee only when cornered; rushers still charge.
    if (sight.visible && pl) {
      ai.lastSeenX = pl.x;
      ai.lastSeenY = pl.y;
      ai.lastSeenTime = sim.time;
      intent.face = { x: pl.x, y: pl.y };
      if (sight.distance < 2.2) {
        startMelee(ctx, e);
        return intent;
      }
      if (arch.role === 'rusher' && sight.distance < 8) {
        intent.goal = { x: pl.x, y: pl.y };
        intent.speed = AI_RUN * beh.moveSpeedMult;
        return intent;
      }
    }
    if (ai.mode !== 'Return' && ai.mode !== 'Idle' && ai.mode !== 'Patrol') setMode(ctx, e, 'Return');
  }
  if (sight.visible && pl) {
    const range = visionRange(ctx, beh, pl);
    ai.detection = Math.min(1.5, ai.detection + dt / (confirmTime(beh, sight, range) * skillOf(ai.skill).confirm));
    if (ai.detection >= 1 && ai.disarmed) {
      ai.lastSeenX = pl.x;
      ai.lastSeenY = pl.y;
      ai.lastSeenTime = sim.time;
    } else if (ai.detection >= 1) {
      if (!COMBAT.includes(ai.mode)) {
        setMode(ctx, e, 'Combat');
        ai.reactionUntil = Math.max(ai.reactionUntil, sim.time + beh.reactionSec * skillOf(ai.skill).reaction);
        ai.alertShared = false;
        // Archetypes that telegraph (the commander) open with an announced burst, never a pre-armed one.
        ai.burstLeft = beh.telegraphSec > 0 ? 0 : rng.int(beh.burst[0], beh.burst[1]);
      }
      ai.lastSeenX = pl.x;
      ai.lastSeenY = pl.y;
      ai.lastSeenTime = sim.time;
      ai.targetId = pl.id;
    } else if (CALM.includes(ai.mode) && !ai.disarmed) {
      ai.investigateX = pl.x;
      ai.investigateY = pl.y;
      setMode(ctx, e, 'Suspicious');
    }
  } else if (!COMBAT.includes(ai.mode)) {
    ai.detection = Math.max(0, ai.detection - dt * 0.2);
  }
  // Share an approximate alert with nearby allies (never the exact live position, never map-wide).
  if (COMBAT.includes(ai.mode) && !ai.alertShared && sim.time - ai.modeSince > 0.6) {
    ai.alertShared = true;
    for (const o of sim.actors) {
      if (o === e || o.kind !== 'enemy' || !o.alive || !o.ai || o.ai.disarmed || COMBAT.includes(o.ai.mode)) continue;
      if (dist(o.x, o.y, e.x, e.y) > 12) continue;
      o.ai.investigateX = ai.lastSeenX + rng.gaussish() * 2;
      o.ai.investigateY = ai.lastSeenY + rng.gaussish() * 2;
      o.ai.lastHeardTime = sim.time;
      setMode(ctx, o, 'Investigate');
    }
  }
  if (COMBAT.includes(ai.mode) && sim.time - ai.lastSeenTime > beh.memorySec) {
    ai.investigateX = ai.lastSeenX;
    ai.investigateY = ai.lastSeenY;
    ai.searchUntil = sim.time + 12;
    setMode(ctx, e, 'Search');
  }
  switch (ai.mode) {
    case 'Idle': {
      if (sim.time >= ai.nextDecisionAt) {
        ai.facing += rng.range(-1.4, 1.4);
        ai.nextDecisionAt = sim.time + rng.range(2.5, 4.5);
      }
      intent.face = { x: e.x + Math.cos(ai.facing) * 3, y: e.y + Math.sin(ai.facing) * 3 };
      if (ai.patrol.length > 1 && rng.next() < dt * 0.05) setMode(ctx, e, 'Patrol');
      break;
    }
    case 'Patrol':
      intent.goal = nextPatrol(e);
      if (!intent.goal) setMode(ctx, e, 'Idle');
      break;
    case 'Suspicious':
      intent.face = { x: ai.investigateX, y: ai.investigateY };
      if (sim.time - ai.modeSince > 1.0) setMode(ctx, e, 'Investigate');
      break;
    case 'Investigate':
      intent.goal = { x: ai.investigateX, y: ai.investigateY };
      if (dist(e.x, e.y, ai.investigateX, ai.investigateY) < 1.2 || sim.time - ai.modeSince > 25) {
        ai.searchUntil = sim.time + 6;
        setMode(ctx, e, 'Search');
      }
      break;
    case 'Search': {
      if (sim.time >= ai.nextDecisionAt || ai.path.length === 0) {
        ai.goalX = ai.investigateX + rng.range(-5, 5);
        ai.goalY = ai.investigateY + rng.range(-5, 5);
        ai.nextDecisionAt = sim.time + rng.range(2.5, 4);
      }
      intent.goal = { x: ai.goalX, y: ai.goalY };
      if (sim.time > ai.searchUntil) setMode(ctx, e, 'Return');
      break;
    }
    case 'Return': {
      const home = ai.patrol[0] ?? { x: ai.homeX, y: ai.homeY };
      intent.goal = home;
      if (dist(e.x, e.y, home.x, home.y) < 1) setMode(ctx, e, ai.patrol.length > 1 ? 'Patrol' : 'Idle');
      break;
    }
    default:
      combat(ctx, e, arch, beh, pl, sight.visible, nav, intent, dt);
  }
  return intent;
}

function aimAt(ctx: SimContext, e: ActorState, beh: BehaviorProfile, pl: ActorState, intent: Intent): void {
  const ai = e.ai!;
  const sim = ctx.sim;
  const rng = ctx.rng.get('enemy');
  if (sim.time >= ai.nextDecisionAt - 1e-9 || (ai.aimErrYaw === 0 && ai.aimErrPitch === 0)) {
    const d = dist(e.x, e.y, pl.x, pl.y);
    let f = (1 + d / 25) * skillOf(ai.skill).aim;
    if (pl.moving) f *= 1.3;
    if (sim.env.phase === 'Night') f *= 1.25;
    if (sim.env.weather === 'Storm') f *= 1.2;
    if (sim.time - ai.modeSince < 1) f *= 1.6;
    ai.aimErrYaw = rng.gaussish() * beh.aimErrorDeg * f;
    ai.aimErrPitch = rng.gaussish() * beh.aimErrorDeg * f * 0.7;
    ai.wantCrouch = rng.next() < beh.headAimChance;
    ai.nextDecisionAt = sim.time + 0.35;
  }
  const prof = hitboxOf(ctx.content, pl);
  const head = prof.volumes.find((v) => v.part === 'head')!;
  const body = prof.volumes.find((v) => v.part === 'body')!;
  const tz = ai.wantCrouch ? (head.z0 + head.z1) / 2 : body.z0 + (body.z1 - body.z0) * 0.62;
  const dx = pl.x - e.x;
  const dy = pl.y - e.y;
  const d = Math.max(0.5, Math.hypot(dx, dy));
  const yaw = (ai.aimErrYaw * Math.PI) / 180;
  const lateral = Math.tan(yaw) * d;
  const px = -dy / d;
  const py = dx / d;
  intent.aim = { x: pl.x + px * lateral, y: pl.y + py * lateral, z: tz + Math.tan((ai.aimErrPitch * Math.PI) / 180) * d };
}

function combat(ctx: SimContext, e: ActorState, arch: EnemyArchetypeDef, beh: BehaviorProfile, pl: ActorState | null, visible: boolean, nav: NavGrid, intent: Intent, dt: number): void {
  const sim = ctx.sim;
  const ai = e.ai!;
  const rng = ctx.rng.get('enemy');
  const role = arch.role;
  const tx = visible && pl ? pl.x : ai.lastSeenX;
  const ty = visible && pl ? pl.y : ai.lastSeenY;
  const d = dist(e.x, e.y, tx, ty);
  intent.face = { x: tx, y: ty };
  const aw = activeWeaponItem(ctx, e);
  const loaded = aw ? !!aw.item.weapon!.chamber : false;
  const reloading = e.action?.type === 'reload' || e.action?.type === 'tubeReload' || e.action?.type === 'refillMag';
  // Boss phases & support.
  if (role === 'boss') bossPhase(ctx, e, arch);
  // Bosses and elites roll out of the line of fire (same roll, stamina and invulnerability rules as the player).
  if (arch.dodge && pl) evasiveRoll(ctx, e, arch.dodge, pl, nav);
  // Out of rounds in the weapon → reload (finite spare mags/rounds only).
  if (!loaded && !reloading && !e.action) {
    const r = requestReload(ctx, e, false);
    if (r === 'no_ammo' || r === 'no_weapon') {
      if (!hasAnyAmmo(ctx, e)) {
        ai.disarmed = true;
        if (pl && visible && d < 2.2) startMelee(ctx, e);
        else if (pl && visible && d < 8 && role === 'rusher') intent.goal = { x: tx, y: ty };
        else {
          ai.searchUntil = sim.time + 4;
          setMode(ctx, e, 'Return');
        }
        return;
      }
    } else setMode(ctx, e, 'Reload');
  }
  if (ai.mode === 'Reload') {
    if (!reloading && loaded) setMode(ctx, e, 'Combat');
    if (role === 'boss' && ai.phase >= 3) {
      // Long reload opening in the final phase: stands exposed.
      intent.goal = null;
    } else {
      if (ai.coverX === null || sim.time >= ai.repathAt) {
        const c = findCover(ctx, nav, e, tx, ty, beh.coverSeekRadius, false);
        if (c) {
          ai.coverX = c.x;
          ai.coverY = c.y;
        }
      }
      intent.goal = ai.coverX !== null ? { x: ai.coverX, y: ai.coverY! } : null;
      intent.crouch = ai.coverX !== null && dist(e.x, e.y, ai.coverX, ai.coverY!) < 0.6;
      intent.speed = AI_RUN * beh.moveSpeedMult;
    }
    return;
  }
  // Movement by role.
  switch (role) {
    case 'sentry':
    case 'support': {
      if (ai.coverX === null || (sim.time >= ai.nextDecisionAt + 3 && rng.next() < 0.02)) {
        const c = findCover(ctx, nav, e, tx, ty, beh.coverSeekRadius, false);
        ai.coverX = c ? c.x : e.x;
        ai.coverY = c ? c.y : e.y;
      }
      intent.goal = { x: ai.coverX, y: ai.coverY! };
      const atCover = dist(e.x, e.y, ai.coverX, ai.coverY!) < 0.6;
      intent.crouch = atCover && !(visible && ai.burstLeft > 0 && sim.time >= ai.burstPauseUntil);
      if (!visible && sim.time - ai.lastSeenTime > 2) intent.goal = { x: ai.lastSeenX, y: ai.lastSeenY };
      break;
    }
    case 'flanker': {
      if (sim.time >= ai.repathAt || ai.path.length === 0) {
        const side = rng.next() < 0.5 ? 1 : -1;
        const ang = Math.atan2(e.y - ty, e.x - tx) + side * (Math.PI / 2.2);
        const r = beh.preferredRange[0] + rng.range(0, beh.preferredRange[1] - beh.preferredRange[0]);
        const cand = nav.nearestWalkable(tx + Math.cos(ang) * r, ty + Math.sin(ang) * r, 3);
        if (cand) {
          ai.goalX = cand.x;
          ai.goalY = cand.y;
        }
        ai.repathAt = sim.time + rng.range(3.5, 5);
      }
      intent.goal = { x: ai.goalX, y: ai.goalY };
      intent.speed = (visible ? AI_WALK : AI_RUN) * beh.moveSpeedMult;
      break;
    }
    case 'rusher': {
      if (d > beh.preferredRange[0]) {
        if (sim.time >= ai.repathAt || ai.coverX === null) {
          const c = findCover(ctx, nav, e, tx, ty, 6, true);
          ai.coverX = c && dist(c.x, c.y, tx, ty) < d - 1 ? c.x : tx;
          ai.coverY = c && dist(c.x, c.y, tx, ty) < d - 1 ? c.y : ty;
          ai.repathAt = sim.time + 1.6;
        }
        intent.goal = { x: ai.coverX, y: ai.coverY! };
        intent.speed = AI_RUN * beh.moveSpeedMult;
      } else intent.goal = null;
      break;
    }
    case 'marksman': {
      if (d < beh.preferredRange[0] && sim.time >= ai.repathAt) {
        const ang = Math.atan2(e.y - ty, e.x - tx) + rng.range(-0.6, 0.6);
        const cand = nav.nearestWalkable(e.x + Math.cos(ang) * 7, e.y + Math.sin(ang) * 7, 3);
        if (cand) {
          ai.goalX = cand.x;
          ai.goalY = cand.y;
        }
        ai.repathAt = sim.time + 4;
      }
      if (ai.shotsSinceRelocate >= beh.relocateAfterShots && sim.time >= ai.repathAt) {
        const ang = Math.atan2(e.y - ty, e.x - tx) + (rng.next() < 0.5 ? 1 : -1) * rng.range(0.6, 1.2);
        const cand = nav.nearestWalkable(tx + Math.cos(ang) * Math.max(d, beh.preferredRange[0]), ty + Math.sin(ang) * Math.max(d, beh.preferredRange[0]), 4);
        if (cand) {
          ai.goalX = cand.x;
          ai.goalY = cand.y;
        }
        ai.shotsSinceRelocate = 0;
        ai.repathAt = sim.time + 5;
      }
      intent.goal = dist(e.x, e.y, ai.goalX, ai.goalY) > 0.8 && ai.goalX !== 0 ? { x: ai.goalX, y: ai.goalY } : null;
      break;
    }
    case 'boss':
      bossMove(ctx, e, visible, tx, ty, intent);
      break;
  }
  // Shooting.
  if (pl && visible && sim.time >= ai.reactionUntil && aw && loaded && !e.action) {
    const muzzle = { x: e.x + e.aim.dirX * aw.def.weapon!.muzzleLength, y: e.y + e.aim.dirY * aw.def.weapon!.muzzleLength, z: e.handling.muzzleZ };
    const clear = ctx.geo.projectileClear(sim, muzzle, { x: pl.x, y: pl.y, z: 1.2 }, e.floor) || ctx.geo.projectileClear(sim, muzzle, { x: pl.x, y: pl.y, z: 1.6 }, e.floor);
    const inRange = d <= aw.def.weapon!.maxRange * (role === 'rusher' ? 0.6 : 0.95);
    aimAt(ctx, e, beh, pl, intent);
    if (clear && inRange) {
      if (ai.burstLeft <= 0 && sim.time >= ai.burstPauseUntil) {
        ai.burstLeft = rng.int(beh.burst[0], beh.burst[1]);
        if (beh.telegraphSec > 0) {
          ai.telegraphUntil = sim.time + beh.telegraphSec;
          ai.telegraphing = true;
          sim.fx.push({ t: 'telegraph', actorId: e.id, x: e.x, y: e.y, tx: pl.x, ty: pl.y, until: ai.telegraphUntil });
        }
      }
      if (ai.telegraphing && sim.time >= ai.telegraphUntil) ai.telegraphing = false;
      if (ai.burstLeft > 0 && !ai.telegraphing && sim.time >= ai.burstPauseUntil) {
        const mode = aw.item.weapon!.fireMode;
        if (mode === 'auto') intent.trigger = { held: true, pressed: !e.handling.triggerHeld };
        else intent.trigger = { held: true, pressed: sim.time >= e.handling.nextShotTime };
        intent.crouch = false;
      }
    }
  } else if (!visible) {
    ai.telegraphing = false;
    intent.aim = { x: tx, y: ty, z: 1.2 };
  }
}

/** Player aim within this cone of the line to the enemy counts as "shooting at me" (cos 8°). */
const DODGE_AIM_COS = Math.cos((8 * Math.PI) / 180);

/**
 * Evasive roll for archetypes with `dodge`. An opportunity arises on the tick after the player fired toward this enemy
 * (aim within 8° of the line) or after the enemy was hit — never on the very tick of the shot, so the AI reacts to the
 * muzzle flash rather than reading the trigger. The roll goes perpendicular to the line of fire, to a side whose landing
 * spot is walkable. Only then is one 'enemy' stream number drawn against `chance`; archetypes without `dodge` never
 * reach this function, so their random draws are unchanged.
 */
function evasiveRoll(ctx: SimContext, e: ActorState, spec: { chance: number; cooldown: number }, pl: ActorState, nav: NavGrid): boolean {
  const sim = ctx.sim;
  if (e.action || !pl.alive || e.stamina < DODGE.stamina) return false;
  if (e.dodgeReadyAt !== undefined && sim.time + 1e-9 < e.dodgeReadyAt) return false;
  const dx = e.x - pl.x;
  const dy = e.y - pl.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.5 || d > 40) return false;
  const lastTick = (t: number) => t < sim.time - 1e-9 && t >= sim.time - SIM_DT - 1e-9;
  const shotAtMe = lastTick(pl.handling.lastShotTime) && (pl.aim.dirX * dx + pl.aim.dirY * dy) / d >= DODGE_AIM_COS;
  const wasHit = e.status.lastHitTime >= sim.time - SIM_DT - 1e-9;
  if (!shotAtMe && !wasHit) return false;
  const px = -dy / d;
  const py = dx / d;
  const doorOk = (id: string) => !sim.doors[id]?.locked;
  const first = Math.floor(sim.time / SIM_DT) % 2 === 0 ? 1 : -1;
  let side = 0;
  for (const s of [first, -first]) {
    if (nav.walkableAt(e.x + px * s * DODGE.distance, e.y + py * s * DODGE.distance, doorOk) && nav.walkableAt(e.x + px * s * DODGE.distance * 0.5, e.y + py * s * DODGE.distance * 0.5, doorOk)) {
      side = s;
      break;
    }
  }
  if (side === 0) return false;
  if (ctx.rng.get('enemy').next() >= spec.chance) {
    // Missed chance: no second look at the same volley before the cooldown.
    e.dodgeReadyAt = sim.time + Math.min(spec.cooldown, 0.6);
    return false;
  }
  if (startDodge(ctx, e, px * side, py * side) !== 'started') return false;
  e.dodgeReadyAt = Math.max(e.dodgeReadyAt ?? 0, sim.time + spec.cooldown);
  return true;
}

function bossPhase(ctx: SimContext, e: ActorState, arch: EnemyArchetypeDef): void {
  const ai = e.ai!;
  const sim = ctx.sim;
  const frac = e.hp / e.maxHp;
  const phase = frac >= 0.6 ? 1 : frac >= 0.3 ? 2 : 3;
  if (phase !== ai.phase) {
    const prev = ai.phase;
    ai.phase = phase;
    if (prev !== 0 && phase > prev && ai.supportsCalled < 2) {
      const spots = ctx.geo.map.eventSpots['boss_support'] ?? [];
      const s = spots[ai.supportsCalled % Math.max(1, spots.length)];
      if (s) {
        // The called squad fights at the commander's own tier (never gated out by the support's minThreat).
        spawnEnemy(ctx.content, sim, 'core.enemy.support', s.x, s.y, ctx.rng.get('enemy'), { mode: 'Investigate', investigate: { x: ai.lastSeenX, y: ai.lastSeenY }, ...(ai.skill === undefined ? {} : { threat: ai.skill }) });
        ai.supportsCalled++;
        sim.fx.push({ t: 'message', key: 'boss.support' });
      }
    }
    // Phase tuning (TUNABLE): shorter attack intervals in phase 3.
    void arch;
  }
}

function bossMove(ctx: SimContext, e: ActorState, visible: boolean, tx: number, ty: number, intent: Intent): void {
  const ai = e.ai!;
  const sim = ctx.sim;
  const rng = ctx.rng.get('enemy');
  const covers = ctx.geo.map.eventSpots['boss_cover'] ?? [];
  const flanks = ctx.geo.map.eventSpots['boss_flank'] ?? [];
  if (ai.phase <= 1) {
    if (ai.coverX === null || ai.shotsSinceRelocate >= 8) {
      const c = covers.length ? covers[Math.floor(rng.next() * covers.length)]! : { x: e.x, y: e.y };
      ai.coverX = c.x;
      ai.coverY = c.y;
      ai.shotsSinceRelocate = 0;
    }
    intent.goal = { x: ai.coverX, y: ai.coverY! };
  } else if (ai.phase === 2) {
    if (sim.time >= ai.repathAt || ai.coverX === null) {
      const pool = flanks.length ? flanks : covers;
      const c = pool.length ? pool[Math.floor(rng.next() * pool.length)]! : { x: e.x, y: e.y };
      ai.coverX = c.x;
      ai.coverY = c.y;
      ai.repathAt = sim.time + 6;
    }
    intent.goal = { x: ai.coverX, y: ai.coverY! };
    intent.speed = AI_RUN * 0.9;
    // Targeted grenades (max 3 total, each consumes a real carried grenade).
    if (!visible && !e.action && sim.time >= ai.searchUntil && Math.hypot(tx - e.x, ty - e.y) < 12) {
      const g = findThrowable(ctx, e, 'core.throw.frag');
      if (g && ai.grenadesLeft > 0) {
        if (startThrow(ctx, e, g, { x: tx, y: ty })) {
          ai.grenadesLeft--;
          ai.searchUntil = sim.time + 8;
        }
      }
    }
  } else {
    if (sim.time >= ai.repathAt || ai.coverX === null) {
      const c = covers.length ? covers[Math.floor(rng.next() * covers.length)]! : { x: e.x, y: e.y };
      ai.coverX = c.x;
      ai.coverY = c.y;
      ai.repathAt = sim.time + 5;
    }
    intent.goal = { x: ai.coverX, y: ai.coverY! };
    if (ai.burstLeft <= 0) ai.burstPauseUntil = Math.min(ai.burstPauseUntil, sim.time + 0.45);
  }
}

function act(ctx: SimContext, e: ActorState, intent: Intent, nav: NavGrid, dt: number, tickStart: number): void {
  const sim = ctx.sim;
  const ai = e.ai!;
  const arch = ctx.content.enemy(e.archetypeId!);
  const doorOk = (d: string) => !sim.doors[d]?.locked;
  const rolling = isDodging(e);
  e.stance = intent.crouch && !rolling ? 'crouch' : 'stand';
  let vx = 0;
  let vy = 0;
  if (rolling) {
    // Same roll as the player's: a fixed decelerating burst (the path is kept and resumed afterwards).
    const v = dodgeVelocity(e.action!, dt);
    vx = v.vx;
    vy = v.vy;
  } else if (intent.goal && !(e.action?.type === 'melee')) {
    const g = intent.goal;
    const gd = dist(e.x, e.y, g.x, g.y);
    if (gd > 0.35) {
      const goalMoved = ai.path.length === 0 || dist(ai.goalX, ai.goalY, g.x, g.y) > 1.5;
      if ((goalMoved || sim.time >= ai.repathAt) && sim.time >= ai.repathAt - 5) {
        const p = nav.findPath(e.x, e.y, g.x, g.y, doorOk, 6000);
        ai.path = p ?? [];
        ai.pathIndex = 0;
        if (goalMoved) {
          ai.goalX = g.x;
          ai.goalY = g.y;
        }
        ai.repathAt = Math.max(ai.repathAt, sim.time + 1.2 + (e.id.length % 5) * 0.07);
      }
      const wp = ai.path[ai.pathIndex];
      if (wp) {
        const wd = dist(e.x, e.y, wp.x, wp.y);
        if (wd < 0.3 && ai.pathIndex < ai.path.length - 1) ai.pathIndex++;
        const w2 = ai.path[ai.pathIndex]!;
        const d2 = Math.max(1e-6, dist(e.x, e.y, w2.x, w2.y));
        let spd = e.stance === 'crouch' ? AI_CROUCH : intent.speed;
        spd *= ctx.geo.groundAt(e.x, e.y).moveMult * ctx.geo.foliageMoveMult(e.x, e.y, sim);
        vx = ((w2.x - e.x) / d2) * spd;
        vy = ((w2.y - e.y) / d2) * spd;
        // Open unlocked closed doors in the way.
        for (const d of ctx.geo.map.doors) {
          const st = sim.doors[d.id];
          if (!st || st.open || st.locked) continue;
          const cx = (d.x0 + d.x1) / 2;
          const cy = (d.y0 + d.y1) / 2;
          if (dist(e.x, e.y, cx, cy) < 1.1) toggleDoor(ctx, e, d.id);
        }
      }
    }
  }
  const before = { x: e.x, y: e.y };
  moveActor(ctx, e, vx, vy, dt);
  const moved = dist(before.x, before.y, e.x, e.y);
  e.moving = moved > 0.2 * dt;
  e.vx = (e.x - before.x) / dt;
  e.vy = (e.y - before.y) / dt;
  if ((vx !== 0 || vy !== 0) && moved < 0.05 * dt) {
    ai.stuckTime += dt;
    if (ai.stuckTime > 1.2) {
      ai.path = [];
      ai.repathAt = 0;
      ai.stuckTime = 0;
      ai.goalX += 1;
    }
  } else ai.stuckTime = 0;
  // Footstep noise for AI too (same rules).
  // Aim / face.
  const aimPt = intent.aim ?? (intent.face ? { x: intent.face.x, y: intent.face.y, z: 1.2 } : vx !== 0 || vy !== 0 ? { x: e.x + vx, y: e.y + vy, z: 1.2 } : null);
  if (aimPt) updateAim(e, { x: aimPt.x, y: aimPt.y, z: aimPt.z, actorId: null });
  const prof = hitboxOf(ctx.content, e);
  updateMuzzleHeight(e, prof, ctx.geo, sim, dt, true);
  const res = processFire(ctx, e, intent.trigger, tickStart, dt);
  if (res.shots > 0) {
    ai.burstLeft -= res.shots;
    ai.shotsSinceRelocate += res.shots;
    if (ai.burstLeft <= 0) {
      const rng = ctx.rng.get('enemy');
      const pause = arch.behavior.burstPause;
      const phaseMult = arch.role === 'boss' && ai.phase >= 3 ? 0.45 : 1;
      ai.burstPauseUntil = sim.time + rng.range(pause[0], pause[1]) * phaseMult;
    }
  }
  // AI stamina (melee swings, dodge rolls) recovers by the same rules as the player's.
  updateStamina(e, false, dt);
}
