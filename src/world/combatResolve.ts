import type { HitPart } from '../content/types';
import type { BallisticHandler } from '../combat/ballistics';
import { computeDamage, type DamageResult } from '../combat/damage';
import type { Vec3 } from '../core/math';
import { equippedItem, actorById, type SimContext } from './context';
import type { ObstacleRuntime } from './geometry';
import type { ActorState, ProjectileState } from './state';
import { processDeath } from './death';

export interface HitSpec {
  part: HitPart;
  baseDamage: number;
  ammo: { fleshMult: number; penetration: number; armorDamage: number; headMult: number };
  range: number;
  effectiveRange: number;
  maxRange: number;
  minRangeFactor: number;
  carry: number;
  buff: number;
  attackerId: string;
  weaponDefId: string | null;
  bleedChance: number;
  point: Vec3;
  source: 'bullet' | 'melee' | 'explosion';
}

/** Apply a resolved hit to an actor: armor for that part only, HP, bleeding, death. */
export function applyHit(ctx: SimContext, target: ActorState, h: HitSpec): DamageResult {
  const sim = ctx.sim;
  const armorItem = h.part === 'head' ? equippedItem(sim, target.id, 'helmet') : h.part === 'body' ? equippedItem(sim, target.id, 'vest') : null;
  const armorDef = armorItem ? ctx.content.item(armorItem.definitionId).armor : undefined;
  const armor = armorItem && armorDef ? { rating: armorDef.rating, durability: armorItem.durability ?? 0, maxDurability: armorDef.maxDurability } : null;
  const res = computeDamage({
    baseDamage: h.baseDamage,
    ammo: h.ammo,
    part: h.part,
    range: Math.max(0, h.range),
    effectiveRange: h.effectiveRange,
    maxRange: h.maxRange,
    minRangeFactor: h.minRangeFactor,
    penetrationCarry: h.carry,
    explicitBuff: h.buff,
    armor,
    targetHp: target.hp,
  });
  if (armorItem && armor && res.armorAfter !== null) armorItem.durability = res.armorAfter;
  const invulnerable = target.invulnerable || (target.kind === 'player' && sim.debug.god);
  const loss = invulnerable ? 0 : res.actualHpLoss;
  target.hp = Math.max(0, target.hp - loss);
  target.status.lastHitTime = sim.time;
  const attacker = actorById(sim, h.attackerId);
  const byPlayer = attacker?.kind === 'player';
  if (h.bleedChance > 0 && loss > 0 && !target.status.bleeding && (target.kind === 'player' || target.kind === 'enemy')) {
    if (ctx.rng.get('combat').next() < h.bleedChance * (res.healthTransfer > 0.5 ? 1 : 0.4)) target.status.bleeding = true;
  }
  if (byPlayer) {
    sim.stats.hits++;
    if (h.part === 'head') sim.stats.headshots++;
    sim.stats.damageDealt += loss;
    if (sim.mode === 'base' || target.kind === 'enemy') sim.progress.hitParts.push({ part: h.part, context: sim.mode === 'base' ? 'range' : 'raid', tick: sim.tick, weaponDefId: h.weaponDefId });
    if (sim.progress.hitParts.length > 200) sim.progress.hitParts.splice(0, sim.progress.hitParts.length - 200);
    if (sim.range && target.kind === 'dummy') {
      if (h.part === 'head') sim.range.headHits++;
      if (attacker && attacker.handling.muzzleRaised) sim.range.lowCoverHits++;
    }
  }
  if (target.kind === 'player') sim.stats.damageTaken += loss;
  if (target.ai && attacker && attacker.team !== target.team) {
    // Being shot reveals the shooter's approximate direction, not an exact tracked position (same error model as hearing).
    const rng = ctx.rng.get('enemy');
    const err = 0.8 + Math.hypot(attacker.x - target.x, attacker.y - target.y) * 0.15;
    target.ai.lastHeardX = attacker.x + rng.gaussish() * err;
    target.ai.lastHeardY = attacker.y + rng.gaussish() * err;
    target.ai.lastHeardTime = sim.time;
    target.ai.detection = Math.max(target.ai.detection, 0.75);
  }
  const killed = target.hp <= 0 && !invulnerable;
  sim.fx.push({ t: 'hit', actorId: target.id, part: h.part, damage: Math.round(loss * 10) / 10, armorHit: !!armor && (armor.durability > 0), killed, x: h.point.x, y: h.point.y, z: h.point.z, byPlayer });
  if (killed && target.alive) {
    target.alive = false;
    target.deathTick = sim.tick;
    if (target.ai) target.ai.mode = 'Dead';
    target.action = null;
    if (byPlayer && target.kind === 'enemy') {
      const wd = h.weaponDefId ? ctx.content.item(h.weaponDefId) : null;
      const arch = target.archetypeId ? ctx.content.enemy(target.archetypeId) : null;
      sim.progress.kills.push({ actorId: target.id, archetypeId: target.archetypeId ?? '', role: arch?.role ?? 'unknown', weaponDefId: h.weaponDefId, weaponTags: wd?.tags ?? [], part: h.part, tick: sim.tick });
      sim.stats.kills++;
    }
    processDeath(ctx, target, h.source);
  }
  return res;
}

export function makeBallisticHandler(ctx: SimContext): BallisticHandler {
  const sim = ctx.sim;
  const logFor = (p: ProjectileState) => {
    for (let i = sim.shotLog.length - 1; i >= 0 && i >= sim.shotLog.length - 400; i--) {
      const e = sim.shotLog[i]!;
      if (e.shotId === p.shotId && e.pelletId === p.pelletId) return e;
    }
    return null;
  };
  return {
    hitActor(p, actorId, part, point, distance) {
      const target = actorById(sim, actorId);
      if (!target || !target.alive) return;
      const ammoDef = ctx.content.item(p.ammoDefId).ammo!;
      const res = applyHit(ctx, target, {
        part,
        baseDamage: p.baseDamage,
        ammo: ammoDef,
        range: distance,
        effectiveRange: p.effRange,
        maxRange: p.maxRange,
        minRangeFactor: p.minFactor,
        carry: p.carry,
        buff: 1,
        attackerId: p.ownerId,
        weaponDefId: p.weaponDefId,
        bleedChance: ammoDef.bleedChance,
        point,
        source: 'bullet',
      });
      sim.fx.push({ t: 'impact', x: point.x, y: point.y, z: point.z, material: 'flesh', actor: true });
      const log = logFor(p);
      if (log) {
        log.firstHit = `actor:${actorId}`;
        log.part = part;
        log.range = Math.round(distance * 1000) / 1000;
        log.rawDamage = res.rawDamage;
        log.armorBefore = res.armorBefore;
        log.armorLoss = res.armorLoss;
        log.calculatedHPDamage = res.calculatedHpDamage;
        log.actualHPLoss = res.actualHpLoss;
      }
    },
    hitObstacle(p, ob: ObstacleRuntime, point, distance, penetrated, exit) {
      const mat = ob.profile.material;
      if (penetrated) {
        sim.fx.push({ t: 'penetrate', x: point.x, y: point.y, z: point.z, material: mat });
        if (exit) sim.fx.push({ t: 'penetrate', x: exit.x, y: exit.y, z: exit.z, material: mat });
      } else {
        sim.fx.push({ t: 'impact', x: point.x, y: point.y, z: point.z, material: mat, actor: false });
        const log = logFor(p);
        if (log && log.firstHit === 'pending') {
          log.firstHit = `obstacle:${ob.id}`;
          log.range = Math.round(distance * 1000) / 1000;
        }
      }
      sim.noises.push({ x: point.x, y: point.y, floor: p.floor, loudness: 0.4, radius: 5, tag: 'impact', sourceId: p.ownerId, time: sim.time });
      if (ob.profile.destructible) {
        const hp = sim.obstacleHp[ob.id] ?? ob.profile.hp ?? 100;
        const next = hp - p.baseDamage * p.carry;
        sim.obstacleHp[ob.id] = next;
        if (next <= 0 && hp > 0) sim.fx.push({ t: 'impact', x: point.x, y: point.y, z: point.z, material: 'debris', actor: false });
      }
      if (sim.range && ob.def.tags?.includes('q05_wall')) {
        const owner = actorById(sim, p.ownerId);
        if (owner?.kind === 'turret') sim.range.wallBlocks++;
      }
    },
    hitGround(p, point) {
      const g = ctx.geo.groundAt(point.x, point.y);
      sim.fx.push({ t: 'impact', x: point.x, y: point.y, z: 0, material: g.footstep, actor: false });
      sim.noises.push({ x: point.x, y: point.y, floor: p.floor, loudness: 0.3, radius: 4, tag: 'impact', sourceId: p.ownerId, time: sim.time });
      const log = logFor(p);
      if (log && log.firstHit === 'pending') log.firstHit = 'ground';
    },
  };
}
