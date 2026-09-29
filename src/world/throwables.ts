import { allocId } from '../core/ids';
import { lineBox3, norm2, type Vec3 } from '../core/math';
import { destroyItem } from '../inventory/store';
import { carriedContainerIds, hitboxOf, type SimContext } from './context';
import type { DynamicState, WorldGeometry } from './geometry';
import { applyHit } from './combatResolve';
import { inIframes, type ActorState, type ThrownState } from './state';

export const GRAVITY = 9.8;
export const THROW_WINDUP = 0.35;
export const THROW_STEP = 1 / 60;
export const HAND_Z = 1.5;

export interface ThrowBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  resting: boolean;
}

/** Launch velocity toward a ground target with a fixed speed (low arc, clamped to 45° at max range). */
export function launchVelocity(from: { x: number; y: number }, to: { x: number; y: number }, speed: number): Vec3 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.max(0.3, Math.hypot(dx, dy));
  const n = norm2(dx, dy);
  const dirx = n.x === 0 && n.y === 0 ? 1 : n.x;
  const diry = n.x === 0 && n.y === 0 ? 0 : n.y;
  const s = Math.min(1, (GRAVITY * d) / (speed * speed));
  const theta = 0.5 * Math.asin(s);
  const h = speed * Math.cos(theta);
  return { x: dirx * h, y: diry * h, z: speed * Math.sin(theta) };
}

/** One integration step shared by the trajectory preview and the real thrown object (A13: identical paths). */
export function stepThrowBody(b: ThrowBody, dt: number, geo: WorldGeometry, dyn: DynamicState, floor: number): void {
  if (b.resting) return;
  b.vz -= GRAVITY * dt;
  const nx = b.x + b.vx * dt;
  const ny = b.y + b.vy * dt;
  const nz = b.z + b.vz * dt;
  const o = { x: b.x, y: b.y, z: b.z };
  const d = { x: nx - b.x, y: ny - b.y, z: nz - b.z };
  let bounced = false;
  for (const ob of geo.query(Math.min(b.x, nx) - 0.2, Math.min(b.y, ny) - 0.2, Math.max(b.x, nx) + 0.2, Math.max(b.y, ny) + 0.2)) {
    if (ob.floor !== floor || !ob.profile.blocksMovement || !geo.isActive(ob, dyn)) continue;
    const hit = lineBox3(o, d, ob.box);
    if (!hit || hit[0] < 0 || hit[0] > 1) continue;
    // Reflect on the axis whose face was hit.
    const px = b.x + d.x * hit[0];
    const py = b.y + d.y * hit[0];
    const pz = b.z + d.z * hit[0];
    const ex = Math.min(Math.abs(px - ob.box.x0), Math.abs(px - ob.box.x1));
    const ey = Math.min(Math.abs(py - ob.box.y0), Math.abs(py - ob.box.y1));
    const ez = Math.abs(pz - ob.box.z1);
    if (ez < ex && ez < ey && b.vz < 0) {
      b.vz = -b.vz * 0.3;
      b.vx *= 0.6;
      b.vy *= 0.6;
      b.z = ob.box.z1 + 0.01;
    } else if (ex < ey) b.vx = -b.vx * 0.4;
    else b.vy = -b.vy * 0.4;
    bounced = true;
    break;
  }
  if (!bounced) {
    b.x = nx;
    b.y = ny;
    b.z = nz;
  }
  if (b.z <= 0) {
    b.z = 0;
    if (Math.abs(b.vz) < 1.2) {
      b.vz = 0;
    } else b.vz = -b.vz * 0.3;
    b.vx *= 0.6;
    b.vy *= 0.6;
    if (Math.hypot(b.vx, b.vy) < 0.4 && b.vz === 0) b.resting = true;
  }
}

/** Predicted path for the HUD (same integrator as the real throw). */
export function predictTrajectory(geo: WorldGeometry, dyn: DynamicState, floor: number, origin: Vec3, vel: Vec3, fuse: number): Vec3[] {
  const b: ThrowBody = { x: origin.x, y: origin.y, z: origin.z, vx: vel.x, vy: vel.y, vz: vel.z, resting: false };
  const pts: Vec3[] = [{ x: b.x, y: b.y, z: b.z }];
  const steps = Math.ceil(fuse / THROW_STEP);
  for (let i = 0; i < steps && !b.resting; i++) {
    stepThrowBody(b, THROW_STEP, geo, dyn, floor);
    pts.push({ x: b.x, y: b.y, z: b.z });
  }
  return pts;
}

export function throwOrigin(a: ActorState): Vec3 {
  return { x: a.x + a.aim.dirX * 0.3, y: a.y + a.aim.dirY * 0.3, z: HAND_Z };
}

/** First carried throwable (quickslots take priority). */
export function findThrowable(ctx: SimContext, a: ActorState, preferDef: string | null): string | null {
  const ids: string[] = [];
  for (const q of a.quickslots) if (q) ids.push(q);
  for (const cid of carriedContainerIds(ctx.sim, a)) ids.push(...(ctx.sim.store.containers[cid]?.items ?? []));
  let first: string | null = null;
  for (const id of ids) {
    const it = ctx.sim.store.items[id];
    if (!it || !carriedContainerIds(ctx.sim, a).includes(it.ownerContainerId ?? '')) continue;
    const d = ctx.content.item(it.definitionId);
    if (!d.throwable) continue;
    if (preferDef && it.definitionId === preferDef) return id;
    first ??= id;
  }
  return first;
}

export function startThrow(ctx: SimContext, a: ActorState, itemId: string, target: { x: number; y: number }): boolean {
  if (a.action) return false;
  const it = ctx.sim.store.items[itemId];
  if (!it || !ctx.content.item(it.definitionId).throwable) return false;
  a.sprinting = false;
  a.action = { type: 'throw', start: ctx.sim.time, duration: THROW_WINDUP, elapsed: 0, itemId, throwItemDef: it.definitionId, throwTarget: { ...target }, steps: [] };
  return true;
}

export function tickThrowAction(ctx: SimContext, a: ActorState): boolean {
  const act = a.action!;
  if (act.elapsed + 1e-9 < act.duration) return false;
  const it = act.itemId ? ctx.sim.store.items[act.itemId] : undefined;
  if (!it || !act.throwTarget) return true;
  const def = ctx.content.item(it.definitionId);
  const spec = def.throwable!;
  // Consume one grenade (commit).
  if (it.quantity > 1) it.quantity -= 1;
  else destroyItem(ctx.sim.store, it.instanceId);
  const o = throwOrigin(a);
  const v = launchVelocity(o, act.throwTarget, spec.throwSpeed);
  const t: ThrownState = { id: allocId(ctx.sim.ids, 'th'), ownerId: a.id, itemDefId: def.id, x: o.x, y: o.y, z: o.z, vx: v.x, vy: v.y, vz: v.z, fuseAt: ctx.sim.time + spec.fuse, resting: false, floor: a.floor };
  ctx.sim.thrown.push(t);
  return true;
}

export function tickThrown(ctx: SimContext, dt: number): void {
  const sim = ctx.sim;
  for (const t of sim.thrown) {
    stepThrowBody(t, dt, ctx.geo, sim, t.floor);
    if (sim.time + dt >= t.fuseAt - 1e-9) detonate(ctx, t);
  }
  sim.thrown = sim.thrown.filter((t) => sim.time + dt < t.fuseAt - 1e-9);
  sim.smokes = sim.smokes.filter((s) => s.until > sim.time);
}

function detonate(ctx: SimContext, t: ThrownState): void {
  const sim = ctx.sim;
  const spec = ctx.content.item(t.itemDefId).throwable!;
  sim.noises.push({ x: t.x, y: t.y, floor: t.floor, loudness: 1, radius: spec.noiseRadius, tag: 'explosion', sourceId: t.ownerId, time: sim.time });
  sim.fx.push({ t: 'explosion', x: t.x, y: t.y, kind: spec.type });
  if (spec.type === 'smoke') {
    sim.smokes.push({ id: t.id, x: t.x, y: t.y, radius: spec.smokeRadius ?? 2.6, until: sim.time + (spec.smokeDuration ?? 15), floor: t.floor });
    sim.fx.push({ t: 'smoke', x: t.x, y: t.y, radius: spec.smokeRadius ?? 2.6 });
    return;
  }
  const blast = { x: t.x, y: t.y, z: Math.max(0.3, t.z + 0.3) };
  for (const a of sim.actors) {
    if (!a.alive || a.floor !== t.floor || a.kind === 'npc') continue;
    const prof = hitboxOf(ctx.content, a);
    const d = Math.hypot(a.x - t.x, a.y - t.y);
    if (spec.type === 'frag') {
      const outer = spec.outerRadius ?? 4;
      const inner = spec.innerRadius ?? 1;
      if (d > outer) continue;
      if (inIframes(sim, a)) continue; // rolled through the blast
      const center = { x: a.x, y: a.y, z: (prof.volumes.find((v) => v.part === 'body')?.z0 ?? 0.35) + 0.4 };
      // Blast occlusion: blocked by any projectile-blocking obstacle between blast and target body.
      if (!ctx.geo.projectileClear(sim, blast, center, t.floor)) continue;
      const dmg = d <= inner ? (spec.damage ?? 80) : (spec.damage ?? 80) * (1 - (d - inner) / (outer - inner));
      if (dmg <= 0) continue;
      applyHit(ctx, a, { part: 'body', baseDamage: dmg, ammo: { fleshMult: 1, penetration: 25, armorDamage: 0.8, headMult: 1 }, range: 0, effectiveRange: 1, maxRange: 2, minRangeFactor: 1, carry: 1, buff: 1, attackerId: t.ownerId, weaponDefId: t.itemDefId, bleedChance: 0.5, point: center, source: 'explosion' });
    } else if (spec.type === 'flash') {
      const r = spec.flashRadius ?? 9;
      if (d > r) continue;
      const eye = { x: a.x, y: a.y, z: prof.eyeZ };
      if (ctx.geo.visionBlocked(sim, blast, eye, t.floor, 2)) continue;
      const toX = (t.x - a.x) / Math.max(0.01, d);
      const toY = (t.y - a.y) / Math.max(0.01, d);
      const facing = a.aim.dirX * toX + a.aim.dirY * toY;
      const facingFactor = facing > 0.3 ? 1 : facing > -0.3 ? 0.6 : 0.3;
      const intensity = (1 - d / r) * facingFactor;
      a.status.flashedUntil = Math.max(a.status.flashedUntil, sim.time + 4 * intensity);
      if (a.ai) {
        a.ai.detection = Math.min(a.ai.detection, 0.2);
        a.ai.reactionUntil = sim.time + 3 * intensity;
      }
      if (a.kind === 'player') sim.fx.push({ t: 'flash', x: t.x, y: t.y, intensity });
    }
  }
  if (spec.type === 'frag') {
    for (const ob of ctx.geo.query(t.x - 4, t.y - 4, t.x + 4, t.y + 4)) {
      if (!ob.profile.destructible || !ctx.geo.isActive(ob, sim)) continue;
      const cx = (ob.box.x0 + ob.box.x1) / 2;
      const cy = (ob.box.y0 + ob.box.y1) / 2;
      const d = Math.hypot(cx - t.x, cy - t.y);
      if (d > 3) continue;
      sim.obstacleHp[ob.id] = (sim.obstacleHp[ob.id] ?? ob.profile.hp ?? 100) - 120 * (1 - d / 3);
    }
  }
}
