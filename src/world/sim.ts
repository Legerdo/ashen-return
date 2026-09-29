import type { ExitDef } from '../content/types';
import { SIM_DT } from '../core/clock';
import { rectContains } from '../core/math';
import { barrelBlocked, muzzleGeometry, updateAim, updateMuzzleHeight } from '../combat/aim';
import { stepProjectile } from '../combat/ballistics';
import { requestReload } from '../combat/reload';
import { processFire, updateHandling } from '../combat/weapons';
import { tickAI } from '../ai/brain';
import type { PlayerCommand, RaidOp } from './command';
import { activeWeaponItem, aliveShapes, allCarriedItemIds, hitboxOf, syncRng, type SimContext } from './context';
import { makeBallisticHandler } from './combatResolve';
import { pruneDrops } from './containers';
import { processDeath } from './death';
import { tickEvents } from './events';
import { interact, updatePrompt } from './interact';
import { startMedical, tickStatus } from './medical';
import { startMelee } from './melee';
import { carriedWeightKg, FOOTSTEP, moveActor, resolveSpeed, separateActors, updateStamina } from './movement';
import { applyOp, type OpResult } from './ops';
import { cancelAction, requestSwitch, tickAction } from './actions';
import { tickRange } from './range';
import { isTraining, type ActorState } from './state';
import { findThrowable, startThrow, tickThrown } from './throwables';
import { dodgeVelocity, isDodging, startDodge } from './dodge';

export const SEARCH_TIME_PER_SLOT = 0.3;
export const EXTRACT_TIME = 5;

export interface StepInput {
  cmd: PlayerCommand | null;
  ops: RaidOp[];
}

export interface StepOutput {
  opResults: OpResult[];
}

/**
 * One fixed 60 Hz simulation step. Order (LOCKED):
 *   UI ops → player → AI → range → timed actions → projectiles (continuous collision, damage) → throwables →
 *   status (bleed) → separation → search → events → exits (after all damage/death; death wins) → bookkeeping.
 */
export function stepSim(ctx: SimContext, input: StepInput, dt: number = SIM_DT): StepOutput {
  const sim = ctx.sim;
  const out: StepOutput = { opResults: [] };
  if (sim.outcome) return out;
  const tickStart = sim.time;
  for (const a of sim.actors) {
    a.px = a.x;
    a.py = a.y;
  }
  const pl = sim.actors.find((a) => a.kind === 'player') ?? null;
  for (const op of input.ops) out.opResults.push(pl && pl.alive ? applyOp(ctx, pl, op) : { ok: false, error: 'dead' });
  if (pl && pl.alive && input.cmd) playerTick(ctx, pl, input.cmd, tickStart, dt);
  tickAI(ctx, dt, tickStart);
  sim.noises = [];
  tickRange(ctx, dt, tickStart);
  for (const a of sim.actors) if (a !== pl && a.alive && a.action) tickAction(ctx, a, dt);
  if (sim.projectiles.length > 0) {
    const shapes = aliveShapes(ctx);
    const handler = makeBallisticHandler(ctx);
    for (const p of sim.projectiles) stepProjectile(p, dt, ctx.geo, sim, shapes, handler);
    // Pellets that ran out of range (or left the play space) without touching anything are logged as misses.
    for (const p of sim.projectiles) {
      if (p.alive) continue;
      const log = sim.shotLog.find((l) => l.shotId === p.shotId && l.pelletId === p.pelletId);
      if (log && log.firstHit === 'pending') {
        log.firstHit = 'none';
        log.range = Math.round(p.traveled * 1000) / 1000;
      }
    }
    sim.projectiles = sim.projectiles.filter((p) => p.alive);
  }
  if (sim.thrown.length > 0 || sim.smokes.length > 0) tickThrown(ctx, dt);
  for (const a of sim.actors) {
    if (!a.alive) continue;
    if (tickStatus(ctx, a, dt)) {
      a.alive = false;
      a.deathTick = sim.tick;
      if (a.ai) a.ai.mode = 'Dead';
      processDeath(ctx, a, 'bleeding');
    }
  }
  separateActors(ctx);
  if (pl) tickLoot(ctx, pl, dt);
  if (sim.mode === 'raid') {
    tickEvents(ctx, dt);
    if (pl) tickExits(ctx, pl, dt);
    if (pl && pl.alive) trackDiscovery(ctx, pl);
    pruneDrops(ctx);
  }
  sim.tick++;
  sim.time = sim.tick * SIM_DT;
  syncRng(ctx);
  return out;
}

function playerTick(ctx: SimContext, a: ActorState, cmd: PlayerCommand, tickStart: number, dt: number): void {
  const sim = ctx.sim;
  if (cmd.crouchToggle && !isDodging(a)) a.stance = a.stance === 'crouch' ? 'stand' : 'crouch';
  updateAim(a, cmd.aim);
  if (cmd.cancel && a.action && a.action.type === 'heal') cancelAction(a);
  if (cmd.weaponSlot) {
    if (a.action?.type === 'heal') cancelAction(a);
    requestSwitch(ctx, a, cmd.weaponSlot);
  }
  if (cmd.fireMode) {
    const aw = activeWeaponItem(ctx, a);
    if (aw) {
      const modes = aw.def.weapon!.modes;
      const i = modes.indexOf(aw.item.weapon!.fireMode);
      aw.item.weapon!.fireMode = modes[(i + 1) % modes.length]!;
      sim.fx.push({ t: 'message', key: `firemode.${aw.item.weapon!.fireMode}` });
    }
  }
  if (cmd.reload) {
    if (a.action?.type === 'heal') cancelAction(a);
    const r = requestReload(ctx, a, true);
    if (r === 'no_ammo' || r === 'full' || r === 'no_mag' || r === 'no_better') sim.fx.push({ t: 'message', key: `reload.${r}` });
  }
  // Hold R: explicit round-by-round top-up of the inserted magazine (never triggered by a tap).
  if (cmd.reloadHold && !a.action) requestReload(ctx, a, false, { allowRefill: true });
  if (cmd.quickslot !== null) {
    const id = a.quickslots[cmd.quickslot];
    const it = id ? sim.store.items[id] : undefined;
    if (it) {
      const def = ctx.content.item(it.definitionId);
      if (def.medical) {
        if (a.action?.type === 'heal' && a.action.itemId === id) cancelAction(a);
        else {
          const r = startMedical(ctx, a, it.instanceId);
          if (r !== 'started') sim.fx.push({ t: 'message', key: `med.${r}` });
        }
      } else if (def.throwable) startThrow(ctx, a, it.instanceId, { x: a.aim.targetX, y: a.aim.targetY });
    } else if (id) a.quickslots[cmd.quickslot] = null;
  }
  if (cmd.melee) startMelee(ctx, a);
  if (cmd.throwPressed) {
    const g = findThrowable(ctx, a, null);
    if (g) startThrow(ctx, a, g, { x: a.aim.targetX, y: a.aim.targetY });
    else sim.fx.push({ t: 'message', key: 'throw.none' });
  }
  if (cmd.interact) interact(ctx, a);
  // Movement.
  let mx = cmd.moveX;
  let my = cmd.moveY;
  const ml = Math.hypot(mx, my);
  if (ml > 1) {
    mx /= ml;
    my /= ml;
  }
  if (cmd.dodge && startDodge(ctx, a, mx, my) === 'no_stamina') sim.fx.push({ t: 'message', key: 'dodge.no_stamina' });
  const before = { x: a.x, y: a.y };
  const rolling = isDodging(a);
  if (rolling) {
    // The roll owns movement: a fixed decelerating burst along its direction (walls still stop it).
    const v = dodgeVelocity(a.action!, dt);
    a.sprinting = false;
    moveActor(ctx, a, v.vx, v.vy, dt);
  } else {
    const kg = carriedWeightKg(ctx, a);
    const wantsSprint = cmd.sprint && !cmd.firePressed && !(cmd.fireHeld && a.handling.triggerHeld && !a.sprinting);
    const sp = resolveSpeed(ctx, a, { x: mx, y: my, sprint: wantsSprint, ads: cmd.adsHeld }, kg);
    a.sprinting = sp.sprinting;
    moveActor(ctx, a, mx * sp.speed, my * sp.speed, dt);
  }
  const moved = Math.hypot(a.x - before.x, a.y - before.y);
  a.vx = (a.x - before.x) / dt;
  a.vy = (a.y - before.y) / dt;
  a.moving = moved > 0.1 * dt;
  sim.stats.distance += moved;
  updateStamina(a, a.sprinting, dt, isTraining(sim));
  if (!rolling) footsteps(ctx, a, moved);
  tickAction(ctx, a, dt);
  updateHandling(ctx, a, cmd.adsHeld, dt);
  const prof = hitboxOf(ctx.content, a);
  updateMuzzleHeight(a, prof, ctx.geo, sim, dt, !a.sprinting);
  const aw = activeWeaponItem(ctx, a);
  if (aw) a.aim.muzzleBlocked = barrelBlocked(muzzleGeometry(a, prof, aw.def.weapon!.muzzleLength), a.floor, ctx.geo, sim);
  const canFireHere = sim.mode === 'raid' || ctx.geo.regionAt(a.x, a.y)?.id === 'core.region.range';
  const medical = a.action?.type === 'heal';
  if (canFireHere && !medical) processFire(ctx, a, { held: cmd.fireHeld, pressed: cmd.firePressed }, tickStart, dt);
  else a.handling.triggerHeld = cmd.fireHeld;
  updatePrompt(ctx, a);
}

function footsteps(ctx: SimContext, a: ActorState, moved: number): void {
  const sim = ctx.sim;
  if (moved <= 0) return;
  a.footstepDist += moved;
  const stride = a.sprinting ? 1.8 : a.stance === 'crouch' ? 1.0 : FOOTSTEP.stride;
  if (a.footstepDist < stride) return;
  a.footstepDist -= stride;
  const g = ctx.geo.groundAt(a.x, a.y);
  const w = ctx.content.weather(sim.env.weather);
  const base = a.sprinting ? FOOTSTEP.sprint : a.stance === 'crouch' ? FOOTSTEP.crouch : FOOTSTEP.walk;
  const foliage = ctx.geo.inFoliage(a.x, a.y, sim) && a.stance !== 'crouch' ? 1.3 : 1;
  const radius = base * g.noiseMult * w.sound * foliage;
  sim.noises.push({ x: a.x, y: a.y, floor: a.floor, loudness: 0.3, radius, tag: 'footstep', sourceId: a.id, time: sim.time });
  sim.fx.push({ t: 'footstep', actorId: a.id, x: a.x, y: a.y, material: foliage > 1 ? 'foliage' : g.footstep, loud: a.sprinting });
}

function tickLoot(ctx: SimContext, pl: ActorState, dt: number): void {
  const sim = ctx.sim;
  if (!sim.loot) return;
  const wc = sim.containers[sim.loot.containerId];
  const sc = sim.store.containers[sim.loot.containerId];
  if (!wc || !sc || !pl.alive || Math.hypot(wc.x - pl.x, wc.y - pl.y) > 2.4) {
    sim.loot = null;
    sim.fx.push({ t: 'ui', kind: 'lootClosed', id: '' });
    return;
  }
  if (wc.locked) return;
  if (wc.searched >= sc.items.length) {
    wc.searched = Math.max(wc.searched, sc.items.length);
    return;
  }
  let speed = sim.perks.searchSpeedMult ?? 1;
  for (const id of allCarriedItemIds(sim, pl)) {
    const it = sim.store.items[id];
    const acc = it ? ctx.content.item(it.definitionId).accessory : undefined;
    if (acc?.searchSpeed && it?.ownerContainerId === `eq:${pl.id}:accessory`) speed *= acc.searchSpeed;
  }
  wc.searchProgress += dt * speed;
  while (wc.searchProgress >= SEARCH_TIME_PER_SLOT && wc.searched < sc.items.length) {
    wc.searchProgress -= SEARCH_TIME_PER_SLOT;
    wc.searched++;
    sim.fx.push({ t: 'search', containerId: wc.id, revealed: wc.searched });
  }
}

export function exitConditionMet(ctx: SimContext, ex: ExitDef, pl: ActorState): boolean {
  const c = ex.condition;
  switch (c.type) {
    case 'free':
      return true;
    case 'flag':
      return !!ctx.sim.flags[c.flag];
    case 'fee':
      return ctx.sim.credits >= c.credits;
    case 'item':
      return allCarriedItemIds(ctx.sim, pl).some((id) => ctx.sim.store.items[id]?.definitionId === c.itemId);
  }
}

function tickExits(ctx: SimContext, pl: ActorState, dt: number): void {
  const sim = ctx.sim;
  if (sim.outcome) return;
  for (const ex of ctx.geo.map.exits) {
    const st = sim.exits[ex.id] ?? (sim.exits[ex.id] = { progress: 0, enabled: true });
    const inside = pl.alive && rectContains(ex, pl.x, pl.y);
    const ok = inside && exitConditionMet(ctx, ex, pl);
    st.enabled = exitConditionMet(ctx, ex, pl);
    if (!ok) {
      st.progress = 0;
      continue;
    }
    st.progress += dt;
    // Survival and condition re-check happen here, after this tick's damage and deaths.
    if (st.progress + 1e-9 >= EXTRACT_TIME && pl.alive && !sim.outcome) {
      sim.outcome = { kind: 'extracted', exitId: ex.id, tick: sim.tick };
      sim.fx.push({ t: 'extracted', exitId: ex.id });
      if (!sim.progress.custom.includes(`exit:${ex.id}`)) sim.progress.custom.push(`exit:${ex.id}`);
    }
  }
}

function trackDiscovery(ctx: SimContext, pl: ActorState): void {
  const sim = ctx.sim;
  for (const poi of ctx.geo.map.pois) {
    if (sim.progress.visited.includes(poi.id)) continue;
    if (Math.hypot(poi.x - pl.x, poi.y - pl.y) <= poi.radius) {
      sim.progress.visited.push(poi.id);
      sim.fx.push({ t: 'objective', key: poi.nameKey });
    }
  }
  // Nested interiors (a control room inside a factory hall) are each discovered in their own right.
  for (const inter of ctx.geo.interiorsAt(pl.x, pl.y)) {
    if (sim.progress.discovered.includes(inter.id)) continue;
    sim.progress.discovered.push(inter.id);
    sim.fx.push({ t: 'objective', key: inter.nameKey });
  }
  const reg = ctx.geo.regionAt(pl.x, pl.y);
  if (reg && !sim.progress.discovered.includes(reg.id)) sim.progress.discovered.push(reg.id);
}
