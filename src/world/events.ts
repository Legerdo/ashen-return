import type { SimContext } from './context';
import type { ActorState, RaidEventState } from './state';
import type { RaidLaunch } from './spawn';
import { spawnEnemy } from './spawn';
import { groupThreat } from './threat';

/**
 * Dynamic raid events (deterministic from the raid seed via the 'world' + 'enemy' streams).
 * Events never remove or block story objects or extraction points.
 */
export const EVENT_PUMP = 'core.event.pump_restart';
export const EVENT_SIGNAL = 'core.event.emergency_signal';
export const EVENT_CONVOY = 'core.event.moving_supply';

export function spawnEvents(ctx: SimContext, launch: RaidLaunch | null): void {
  const { sim, content, geo } = ctx;
  const rng = ctx.rng.get('world');
  for (const def of content.raidEvents.values()) {
    if (!def.mapIds.includes(sim.mapId)) continue;
    const mult = def.weatherMult[sim.env.weather] ?? 1;
    // Deterministic roll (always consumed to keep the stream stable).
    const roll = rng.next();
    const forced = launch?.flags[`debug_force_${def.id}`] ?? false;
    if (!forced && roll >= def.chance * mult) continue;
    if (def.id === EVENT_PUMP) {
      const spot = geo.map.eventSpots['pump']?.[0];
      if (!spot) continue;
      sim.events.push(mkEvent(def.id, spot.x, spot.y, 'pump'));
    } else if (def.id === EVENT_SIGNAL) {
      const spots = geo.map.eventSpots['signal'] ?? [];
      if (spots.length === 0) continue;
      const spot = spots[Math.floor(rng.next() * spots.length)]!;
      const variant = rng.next() < 0.6 ? 'rescue' : 'trap';
      const ev = mkEvent(def.id, spot.x, spot.y, variant);
      ev.state = 'active';
      sim.events.push(ev);
    } else if (def.id === EVENT_CONVOY) {
      const route = geo.map.eventSpots['convoy'] ?? [];
      if (route.length < 2) continue;
      const ev = mkEvent(def.id, route[0]!.x, route[0]!.y, 'convoy');
      ev.state = 'active';
      ev.data['routeIndex'] = 1;
      sim.events.push(ev);
    }
  }
}

function mkEvent(defId: string, x: number, y: number, variant: string): RaidEventState {
  return { id: defId, defId, state: 'idle', x, y, variant, startedAt: 0, endsAt: 0, data: {} };
}

/** Nearest standing spot around (x, y) whose body circle does not overlap a solid obstacle (deterministic ring search). */
export function clearSpotNear(ctx: SimContext, x: number, y: number, radius = 0.4): { x: number; y: number } {
  const { geo, sim } = ctx;
  const free = (px: number, py: number): boolean => {
    if (px < 1 || py < 1 || px > geo.map.width - 1 || py > geo.map.height - 1) return false;
    return !geo.movementBlockers(px, py, radius, 0, sim).some((o) => {
      const cx = Math.max(o.box.x0, Math.min(px, o.box.x1));
      const cy = Math.max(o.box.y0, Math.min(py, o.box.y1));
      return (cx - px) ** 2 + (cy - py) ** 2 < radius * radius;
    });
  };
  if (free(x, y)) return { x, y };
  for (let ring = 1; ring <= 10; ring++) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const px = x + Math.cos(a) * ring * 0.5;
      const py = y + Math.sin(a) * ring * 0.5;
      if (free(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}

/**
 * Post-container setup that needs actors (convoy guards) — called after containers exist.
 * `avoid`: the chosen player spawn; a guard that would start closer than `minDist` is not spawned.
 */
/** Spawn options scaling an event enemy like a spawn group at its position (nothing without a raid threat). */
function threatAt(ctx: SimContext, x: number, y: number): { threat?: number } {
  const t = ctx.sim.threat;
  return t === undefined ? {} : { threat: groupThreat(t, ctx.geo.regionAt(x, y)?.lootTier ?? 2) };
}

export function setupEventActors(ctx: SimContext, avoid?: { x: number; y: number; minDist: number }): void {
  const { sim, content } = ctx;
  const rng = ctx.rng.get('enemy');
  for (const ev of sim.events) {
    if (ev.defId === EVENT_CONVOY && !ev.data['guards']) {
      // Guards stand next to the cart, never inside the parked vehicles around it.
      const spots = [clearSpotNear(ctx, ev.x + 1, ev.y), clearSpotNear(ctx, ev.x - 1, ev.y + 0.5)];
      const roles = ['core.enemy.sentry', 'core.enemy.rusher'];
      const ids: string[] = [];
      spots.forEach((s, i) => {
        if (avoid && Math.hypot(s.x - avoid.x, s.y - avoid.y) < avoid.minDist) return;
        ids.push(spawnEnemy(content, sim, roles[i]!, s.x, s.y, rng, { mode: 'Patrol', ...threatAt(ctx, s.x, s.y) }).id);
      });
      ev.data['guards'] = ids.join(',') || 'none';
      const cid = ev.data['containerId'];
      if (typeof cid === 'string' && sim.containers[cid]) sim.containers[cid]!.locked = true;
    }
  }
}

export function interactEvent(ctx: SimContext, a: ActorState, eventId: string): void {
  const sim = ctx.sim;
  const ev = sim.events.find((e) => e.id === eventId || e.defId === eventId);
  if (!ev || ev.state !== 'idle') return;
  if (ev.defId === EVENT_PUMP) {
    const rng = ctx.rng.get('world');
    ev.state = 'active';
    ev.startedAt = sim.time;
    ev.endsAt = sim.time + 60 + Math.floor(rng.next() * 31);
    ev.data['nextPulse'] = sim.time;
    ev.data['starter'] = a.id;
    sim.fx.push({ t: 'event', eventId: ev.id, state: 'active' });
    sim.fx.push({ t: 'message', key: 'event.pump.started' });
    // Investigators come to check the noise (approximate position only).
    const spots = ctx.geo.map.eventSpots['pump_investigators'] ?? [];
    const erng = ctx.rng.get('enemy');
    for (let i = 0; i < Math.min(2, spots.length); i++) {
      const s = spots[i]!;
      spawnEnemy(ctx.content, sim, i === 0 ? 'core.enemy.sentry' : 'core.enemy.flanker', s.x, s.y, erng, { mode: 'Investigate', investigate: { x: ev.x + erng.range(-3, 3), y: ev.y + erng.range(-3, 3) }, ...threatAt(ctx, s.x, s.y) });
    }
  }
}

export function tickEvents(ctx: SimContext, dt: number): void {
  const sim = ctx.sim;
  const pl = sim.actors.find((x) => x.kind === 'player');
  for (const ev of sim.events) {
    if (ev.defId === EVENT_PUMP && ev.state === 'active') {
      const next = Number(ev.data['nextPulse'] ?? 0);
      if (sim.time >= next) {
        sim.noises.push({ x: ev.x, y: ev.y, floor: 0, loudness: 1, radius: 38, tag: 'machine', sourceId: 'event', time: sim.time });
        ev.data['nextPulse'] = sim.time + 2.5;
      }
      if (sim.time >= ev.endsAt) {
        if (pl?.alive) {
          ev.state = 'success';
          const cid = ev.data['containerId'];
          if (typeof cid === 'string' && sim.containers[cid]) sim.containers[cid]!.locked = false;
          if (!sim.progress.eventsCompleted.includes(ev.defId)) sim.progress.eventsCompleted.push(ev.defId);
          sim.fx.push({ t: 'event', eventId: ev.id, state: 'success' });
          sim.fx.push({ t: 'message', key: 'event.pump.success' });
        } else ev.state = 'failed';
      }
    } else if (ev.defId === EVENT_SIGNAL && ev.state === 'active' && ev.variant === 'trap' && !ev.data['triggered'] && pl?.alive) {
      if (Math.hypot(pl.x - ev.x, pl.y - ev.y) < 9) {
        ev.data['triggered'] = true;
        const erng = ctx.rng.get('enemy');
        const spots = (ctx.geo.map.eventSpots['signal_ambush'] ?? []).filter((s) => Math.hypot(s.x - ev.x, s.y - ev.y) < 26).slice(0, 2);
        spots.forEach((s, i) => spawnEnemy(ctx.content, sim, i === 0 ? 'core.enemy.rusher' : 'core.enemy.flanker', s.x, s.y, erng, { mode: 'Investigate', investigate: { x: pl.x + erng.range(-2, 2), y: pl.y + erng.range(-2, 2) }, ...threatAt(ctx, s.x, s.y) }));
        sim.fx.push({ t: 'message', key: 'event.signal.trap' });
      }
    } else if (ev.defId === EVENT_CONVOY && ev.state === 'active') {
      const guards = String(ev.data['guards'] ?? '').split(',').filter(Boolean);
      const alive = guards.map((g) => sim.actors.find((x) => x.id === g)).filter((g) => g && g.alive);
      const cid = ev.data['containerId'];
      const cart = typeof cid === 'string' ? sim.containers[cid] : undefined;
      if (!cart) continue;
      if (alive.length === 0) {
        if (cart.locked) {
          cart.locked = false;
          sim.fx.push({ t: 'message', key: 'event.convoy.stopped' });
        }
        continue;
      }
      const inCombat = alive.some((g) => g!.ai && (g!.ai.mode === 'Combat' || g!.ai.mode === 'Cover' || g!.ai.mode === 'Flank'));
      if (inCombat) continue;
      const route = ctx.geo.map.eventSpots['convoy'] ?? [];
      let idx = Number(ev.data['routeIndex'] ?? 1) % route.length;
      const tgt = route[idx]!;
      const dx = tgt.x - cart.x;
      const dy = tgt.y - cart.y;
      const d = Math.hypot(dx, dy);
      const step = 1.1 * dt;
      if (d <= step) {
        cart.x = tgt.x;
        cart.y = tgt.y;
        idx = (idx + 1) % route.length;
        ev.data['routeIndex'] = idx;
      } else {
        cart.x += (dx / d) * step;
        cart.y += (dy / d) * step;
      }
      ev.x = cart.x;
      ev.y = cart.y;
      for (const g of alive) {
        if (!g!.ai) continue;
        g!.ai.patrol = [{ x: cart.x + 0.8, y: cart.y + 0.6 }, { x: cart.x - 0.8, y: cart.y - 0.6 }];
        if (g!.ai.mode === 'Idle') g!.ai.mode = 'Patrol';
      }
    }
  }
}
