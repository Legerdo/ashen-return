import { viewToClient, worldToView } from '../core/coords';
import { allocId } from '../core/ids';
import { Rng } from '../core/rng';
import { instantiate, placeNew } from '../inventory/store';
import { grantItems } from '../progression/profile';
import type { SaveStore } from '../save/saveStore';
import { createDrop } from '../world/containers';
import { activeWeaponItem, carriedContainerIds, type SimContext } from '../world/context';
import { spawnEnemy } from '../world/spawn';
import { pocketContainerId } from '../world/state';
import type { GameApp } from './app';

/** Is a circle of radius r at (px, py) overlapping any movement blocker? */
function blockedAt(X: SimContext, px: number, py: number, r: number, floor = 0): boolean {
  return X.geo.movementBlockers(px, py, r, floor, X.sim).some((o) => {
    const cx = Math.max(o.box.x0, Math.min(px, o.box.x1));
    const cy = Math.max(o.box.y0, Math.min(py, o.box.y1));
    return (cx - px) ** 2 + (cy - py) ** 2 < r * r;
  });
}

/** Frame-time summary (ms) of a recorded run: average, percentiles, 1% low (mean of the worst 1%). */
function summarize(xs: number[]): { n: number; avg: number; p50: number; p95: number; p99: number; max: number; low1: number } {
  const n = xs.length;
  if (n === 0) return { n: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0, low1: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(n - 1, Math.floor(f * n))]!;
  const worst = s.slice(Math.floor(n * 0.99));
  return { n, avg: s.reduce((a, b) => a + b, 0) / n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[n - 1]!, low1: worst.reduce((a, b) => a + b, 0) / Math.max(1, worst.length) };
}

/**
 * Scripted-test API, installed only in dev builds and the `--mode e2e` bundle (never in the release dist/).
 * Everything here either reads state or uses the same transactional / simulation paths as real play;
 * the only shortcuts are explicit debug switches (teleport, god, infinite ammo, AI freeze, time scale, give).
 */
export function installTestHooks(app: GameApp, store: SaveStore): void {
  const c = app.content;
  const perf = { target: 0, loop: false };
  const ctx = () => app.ctx;
  const pl = () => ctx()?.sim.actors.find((a) => a.kind === 'player') ?? null;
  const api = {
    app,
    store,
    mode: () => app.mode,
    busy: () => app.busy,
    panel: () => app.panel,
    paused: () => app.paused,
    toasts: () => app.toasts.map((t) => t.text),
    profile: () => (app.profile ? structuredClone(app.profile) : null),
    summary: () => (app.lastSummary ? structuredClone(app.lastSummary) : null),
    player: () => {
      const p = pl();
      if (!p) return null;
      return { x: p.x, y: p.y, hp: p.hp, alive: p.alive, floor: p.floor, stance: p.stance, action: p.action?.type ?? null, activeSlot: p.activeSlot, bleeding: p.status.bleeding, aim: { ...p.aim }, stamina: p.stamina, staminaMax: p.staminaMax, sprinting: p.sprinting, quickslots: [...p.quickslots], adsT: p.handling.adsT };
    },
    sim: () => {
      const s = ctx()?.sim;
      if (!s) return null;
      return {
        mode: s.mode,
        mapId: s.mapId,
        raidId: s.raidId,
        seed: s.seed,
        tick: s.tick,
        time: s.time,
        outcome: s.outcome,
        env: { ...s.env },
        flags: { ...s.flags },
        progress: structuredClone(s.progress),
        stats: { ...s.stats },
        projectiles: s.projectiles.length,
        loot: s.loot ? { ...s.loot } : null,
        prompt: s.prompt ? { ...s.prompt } : null,
        region: ctx()!.geo.regionAt(pl()?.x ?? 0, pl()?.y ?? 0)?.id ?? null,
        items: Object.keys(s.store.items).length,
      };
    },
    /** Per-item ownership snapshot of the current raid (for duplication checks). */
    /** Active weapon state of the player (chamber / magazine / tube), for scripted fire & reload checks. */
    weapon: () => {
      const x = ctx();
      const p = pl();
      if (!x || !p) return null;
      const aw = activeWeaponItem(x, p);
      if (!aw) return null;
      const w = aw.item;
      const mag = w.weapon?.magazineId ? x.sim.store.items[w.weapon.magazineId] : undefined;
      const magCap = mag ? c.item(mag.definitionId).magazine?.capacity ?? null : null;
      return { defId: aw.def.id, chamber: w.weapon?.chamber ?? null, magRounds: mag?.mag?.rounds.length ?? null, magCapacity: magCap, tube: w.weapon?.tube?.length ?? null, tubeCapacity: aw.def.weapon!.magazineFamily ? null : aw.def.weapon!.capacity, fireMode: w.weapon?.fireMode ?? null, durability: w.durability, action: p.action?.type ?? null, slot: p.activeSlot };
    },
    /** Last `n` shot-log entries (pellet granularity). */
    shotLog: (n = 50) => ctx()?.sim.shotLog.slice(-n).map((l) => ({ ...l })) ?? [],
    rangeStats: () => (ctx()?.sim.range ? { ...ctx()!.sim.range! } : null),
    /** Controls-tutorial director state (null outside the tutorial). */
    tutorial: () => {
      const t = app.tutorial;
      if (!t) return null;
      const g = t.finished ? null : t.target();
      return { step: t.step, id: t.finished ? null : t.id, progress: t.progress, finished: t.finished, target: g ? { key: g.key, x: g.x, y: g.y } : null };
    },
    raidItems: () => {
      const s = ctx()?.sim;
      if (!s) return [];
      return Object.values(s.store.items).map((i) => ({ id: i.instanceId, def: i.definitionId, qty: i.quantity, owner: i.ownerContainerId }));
    },
    carried: () => {
      const s = ctx()?.sim;
      const p = pl();
      if (!s || !p) return [];
      const out: { id: string; def: string; qty: number; container: string }[] = [];
      for (const cid of [...carriedContainerIds(s, p), `eq:player:primary1`, `eq:player:primary2`, `eq:player:secondary`, `eq:player:helmet`, `eq:player:vest`, `eq:player:backpack`]) {
        for (const id of s.store.containers[cid]?.items ?? []) {
          const it = s.store.items[id];
          if (it) out.push({ id, def: it.definitionId, qty: it.quantity, container: cid });
        }
      }
      return out;
    },
    containers: () => {
      const s = ctx()?.sim;
      if (!s) return [];
      return Object.values(s.containers).map((w) => ({
        id: w.id,
        kind: w.kind,
        typeId: w.typeId,
        x: w.x,
        y: w.y,
        floor: w.floor,
        locked: w.locked,
        keyId: w.keyId,
        searched: w.searched,
        items: (s.store.containers[w.id]?.items ?? []).map((id) => s.store.items[id]?.definitionId ?? '?'),
        itemIds: [...(s.store.containers[w.id]?.items ?? [])],
      }));
    },
    /** Walkable standing spots within interaction range of (x, y) with a clear line of sight (nearest first). */
    reachSpots: (x: number, y: number, n = 6): { x: number; y: number }[] => {
      const X = ctx();
      if (!X) return [];
      const r = 0.4;
      const out: { x: number; y: number }[] = [];
      const blocked = (px: number, py: number) =>
        X.geo.movementBlockers(px, py, r, 0, X.sim).some((o) => {
          const cx = Math.max(o.box.x0, Math.min(px, o.box.x1));
          const cy = Math.max(o.box.y0, Math.min(py, o.box.y1));
          return (cx - px) ** 2 + (cy - py) ** 2 < r * r;
        });
      for (const d of [1.0, 1.25, 0.85, 1.5]) {
        for (let k = 0; k < 16 && out.length < n; k++) {
          const ang = (k / 16) * Math.PI * 2;
          const px = x + Math.cos(ang) * d;
          const py = y + Math.sin(ang) * d;
          if (px < 1 || py < 1 || px > X.geo.map.width - 1 || py > X.geo.map.height - 1 || blocked(px, py)) continue;
          const near = { x: x + Math.cos(ang) * 0.55, y: y + Math.sin(ang) * 0.55, z: 0.9 };
          if (X.geo.visionBlocked(X.sim, { x: px, y: py, z: 1.0 }, near, 0, 1)) continue;
          out.push({ x: px, y: py });
        }
      }
      return out;
    },
    /** Debug: grant credits through a normal profile transaction (used only when a scripted run is short; logged). */
    giveCredits: async (n: number): Promise<boolean> => {
      const r = await app.tx(`debug:credits:${app.nextNonce()}`, (d) => {
        d.currency += n;
      });
      return r.ok && r.applied;
    },
    enemies: () => {
      const s = ctx()?.sim;
      if (!s) return [];
      return s.actors
        .filter((a) => a.kind === 'enemy')
        .map((a) => ({ id: a.id, archetypeId: a.archetypeId, role: a.ai?.role ?? null, x: a.x, y: a.y, hp: a.hp, alive: a.alive, mode: a.ai?.mode ?? null }));
    },
    exits: () => {
      const x = ctx();
      if (!x) return [];
      return x.geo.map.exits.map((e) => ({ id: e.id, nameKey: e.nameKey, x: e.x, y: e.y, w: e.w, h: e.h, enabled: x.sim.exits[e.id]?.enabled ?? false, progress: x.sim.exits[e.id]?.progress ?? 0 }));
    },
    pois: () => ctx()?.geo.map.pois.map((p) => ({ ...p })) ?? [],
    interactables: () => ctx()?.geo.map.interactables.map((i) => ({ ...i })) ?? [],
    doors: () => {
      const x = ctx();
      if (!x) return [];
      return x.geo.map.doors.map((d) => ({ id: d.id, x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2, keyId: d.keyId, powerFlag: d.powerFlag, open: x.sim.doors[d.id]?.open ?? false }));
    },
    /** A walkable spot `dist` units from an actor with a clear projectile line to its torso (for scripted fights). */
    clearShotSpot: (actorId: string, dist = 5): { x: number; y: number } | null => {
      const x = ctx();
      if (!x) return null;
      const t = x.sim.actors.find((a) => a.id === actorId);
      if (!t) return null;
      const r = 0.4;
      for (const d of [dist, dist - 1, dist + 1.5, dist - 2, dist + 3, dist + 5]) {
        if (d < 1.5) continue;
        for (let k = 0; k < 24; k++) {
          const ang = (k / 24) * Math.PI * 2;
          const px = t.x + Math.cos(ang) * d;
          const py = t.y + Math.sin(ang) * d;
          if (px < 1.5 || py < 1.5 || px > x.geo.map.width - 1.5 || py > x.geo.map.height - 1.5) continue;
          const hit = x.geo.movementBlockers(px, py, r, t.floor, x.sim).some((o) => {
            const cx = Math.max(o.box.x0, Math.min(px, o.box.x1));
            const cy = Math.max(o.box.y0, Math.min(py, o.box.y1));
            return (cx - px) ** 2 + (cy - py) ** 2 < r * r;
          });
          if (hit) continue;
          // Muzzle point ~0.9u toward the target (the spot lies at t + d·(cos, sin)).
          const from = { x: px - Math.cos(ang) * 0.9, y: py - Math.sin(ang) * 0.9, z: 1.25 };
          if (!x.geo.projectileClear(x.sim, { x: px, y: py, z: 1.25 }, { x: t.x, y: t.y, z: 1.1 }, t.floor)) continue;
          if (!x.geo.projectileClear(x.sim, from, { x: t.x, y: t.y, z: 1.4 }, t.floor)) continue;
          return { x: px, y: py };
        }
      }
      return null;
    },
    teleport: (x: number, y: number): boolean => {
      const p = pl();
      if (!p) return false;
      p.x = p.px = x;
      p.y = p.py = y;
      p.vx = p.vy = 0;
      return true;
    },
    /** Debug: set the player's condition (used to set up the healing step without scripting an enemy hit). */
    setPlayerCondition: (hp: number, bleeding = false): boolean => {
      const p = pl();
      if (!p || !p.alive) return false;
      p.hp = Math.max(1, Math.min(p.maxHp, hp));
      p.status.bleeding = bleeding;
      return true;
    },
    setDebug: (flags: { god?: boolean; infiniteAmmo?: boolean; freezeAI?: boolean; noSpread?: boolean }): void => {
      const s = ctx()?.sim;
      if (s) Object.assign(s.debug, flags);
    },
    timeScale: (k: number): void => {
      app.clock.timeScale = Math.max(0.1, Math.min(8, k));
    },
    /** Put a new item into the player's bag (or pockets) inside the running raid/shelter sim. */
    giveRaid: (defId: string, qty = 1): string | null => {
      const x = ctx();
      const p = pl();
      if (!x || !p) return null;
      const inst = instantiate(c, x.sim.ids, defId, { quantity: qty });
      const bagId = x.sim.store.containers[`eq:${p.id}:backpack`]?.items[0];
      const targets = [...(bagId ? [`bag:${bagId}`] : []), pocketContainerId(p.id)];
      for (const t of targets) {
        if (placeNew(x.sim.store, c, inst, { containerId: t }).ok) return inst.instanceId;
      }
      return null;
    },
    /** Grant items into the profile stash through a normal profile transaction. */
    giveProfile: async (defId: string, qty = 1): Promise<boolean> => {
      const tx = `debug:give:${defId}:${app.nextNonce()}`;
      const r = await app.tx(tx, (d) => grantItems(d, c, defId, qty, tx));
      return r.ok && r.applied;
    },
    setFlag: async (flag: string, value = true): Promise<boolean> => {
      const r = await app.tx(`debug:flag:${flag}:${app.nextNonce()}`, (d) => {
        d.flags[flag] = value;
      });
      return r.ok && r.applied;
    },
    worldToClient: (x: number, y: number, z = 0): { x: number; y: number } => {
      const v = worldToView(app.view, x, y, z);
      const cpos = viewToClient(app.rectProvider(), v.sx, v.sy);
      return { x: cpos.clientX, y: cpos.clientY };
    },
    frameStats: () => {
      const ft = app.frameTimes.slice();
      if (ft.length === 0) return { n: 0, avgMs: 0, p99Ms: 0, low1Fps: 0 };
      const ms = ft.map((s) => s * 1000).sort((a, b) => a - b);
      const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
      const worst = ms.slice(Math.floor(ms.length * 0.99));
      const p99 = worst.reduce((a, b) => a + b, 0) / Math.max(1, worst.length);
      return { n: ms.length, avgMs: avg, p99Ms: p99, low1Fps: 1000 / p99, simStepMs: app.simStepMs };
    },
    resetFrameStats: (): void => {
      app.frameTimes.length = 0;
    },
    // --- A22 performance load (real actors, real rounds, real drop piles in the running raid) ------------------------
    /**
     * Spawn `n` enemies (live AI, real finite loadouts) on free spots rMin..rMax units around the player, investigating
     * it. `invulnerable` keeps friendly fire from thinning a measurement load (hits are still fully resolved).
     */
    spawnEnemies: (n: number, rMin = 5, rMax = 12, invulnerable = false): number => {
      const X = ctx();
      const p = pl();
      if (!X || !p) return 0;
      const kinds = ['core.enemy.sentry', 'core.enemy.flanker', 'core.enemy.rusher', 'core.enemy.marksman'];
      const rng = Rng.fromSeed(`perf-enemies|${X.sim.raidId}`);
      let made = 0;
      for (let tries = 0; made < n && tries < n * 80; tries++) {
        const ang = rng.range(0, Math.PI * 2);
        const d = rng.range(rMin, rMax);
        const x = p.x + Math.cos(ang) * d;
        const y = p.y + Math.sin(ang) * d;
        if (x < 2 || y < 2 || x > X.geo.map.width - 2 || y > X.geo.map.height - 2 || blockedAt(X, x, y, 0.45, p.floor)) continue;
        const e = spawnEnemy(c, X.sim, kinds[made % kinds.length]!, x, y, rng, { mode: 'Investigate', investigate: { x: p.x, y: p.y }, idPrefix: 'perf' });
        if (invulnerable) e.invulnerable = true;
        made++;
      }
      return made;
    },
    /** Put `n` ground drop piles (1–3 real items each) on free spots within `r` units of the player. */
    spawnDrops: (n: number, r = 9): number => {
      const X = ctx();
      const p = pl();
      if (!X || !p) return 0;
      const pool = ['core.mat.scrap', 'core.mat.cloth', 'core.med.bandage', 'core.ammo.9.fmj', 'core.mat.wire', 'core.val.watch', 'core.mat.metal', 'core.mat.powder'];
      const rng = Rng.fromSeed(`perf-drops|${X.sim.raidId}`);
      let made = 0;
      for (let tries = 0; made < n && tries < n * 80; tries++) {
        const x = p.x + rng.range(-r, r);
        const y = p.y + rng.range(-r * 0.6, r * 0.6);
        if (Math.hypot(x - p.x, y - p.y) < 1.2 || blockedAt(X, x, y, 0.3, p.floor)) continue;
        if (Object.values(X.sim.containers).some((w) => w.kind === 'drop' && Math.hypot(w.x - x, w.y - y) < 0.7)) continue;
        const cid = createDrop(X, x, y, p.floor);
        for (let k = rng.int(1, 3); k > 0; k--) {
          const def = rng.pick(pool);
          placeNew(X.sim.store, c, instantiate(c, X.sim.ids, def, { quantity: def.includes('.ammo.') ? 20 : 1 }), { containerId: cid });
        }
        made++;
      }
      return made;
    },
    /**
     * Keep at least `n` rounds in flight: real 5.56 FMJ projectiles (real speed, collision, penetration, impacts)
     * fired by the spawned enemies from a ring around the player across the view. Zero base damage so the load
     * persists for the whole measurement. 0 stops the top-up.
     */
    sustainProjectiles: (n: number): void => {
      perf.target = n;
      if (perf.loop) return;
      perf.loop = true;
      const rng = Rng.fromSeed('perf-projectiles');
      const tick = () => {
        const X = ctx();
        const p = pl();
        if (perf.target > 0 && X && p && app.mode === 'raid') {
          const sim = X.sim;
          const owners = sim.actors.filter((a) => a.kind === 'enemy' && a.alive);
          let alive = 0;
          for (const q of sim.projectiles) if (q.alive) alive++;
          const speed = c.item('core.weapon.ar556').weapon!.muzzleVelocity;
          for (; alive < perf.target && owners.length > 0; alive++) {
            const a0 = rng.range(0, Math.PI * 2);
            const sx = p.x + Math.cos(a0) * 14;
            const sy = p.y + Math.sin(a0) * 9;
            const dx = p.x + rng.range(-6, 6) - sx;
            const dy = p.y + rng.range(-4, 4) - sy;
            const d = Math.hypot(dx, dy) || 1;
            sim.projectiles.push({ id: allocId(sim.ids, 'pr'), shotId: allocId(sim.ids, 'shot-perf'), pelletId: 0, ownerId: rng.pick(owners).id, team: 'hostile', weaponDefId: 'core.weapon.ar556', ammoDefId: 'core.ammo.556.fmj', x: sx, y: sy, z: 1.1, px: sx, py: sy, pz: 1.1, vx: (dx / d) * speed, vy: (dy / d) * speed, vz: 0, traveled: 0, maxRange: 40, effRange: 40, minFactor: 1, baseDamage: 0, energy: 20, carry: 1, penetrations: 0, hitActors: [], alive: true, pending: 1e-6, floor: p.floor, tracer: 0xffe08a, born: sim.time });
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    /** Current load: live enemies (total / within 16u of the player), live projectiles, drop piles, JS heap (Chromium). */
    loadStats: () => {
      const X = ctx();
      const p = pl();
      if (!X || !p) return null;
      const enemies = X.sim.actors.filter((a) => a.kind === 'enemy' && a.alive);
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
      return {
        enemies: enemies.length,
        enemiesNear: enemies.filter((a) => Math.hypot(a.x - p.x, a.y - p.y) <= 16).length,
        projectiles: X.sim.projectiles.filter((q) => q.alive).length,
        drops: Object.values(X.sim.containers).filter((w) => w.kind === 'drop').length,
        items: Object.keys(X.sim.store.items).length,
        heapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
        domNodes: document.getElementsByTagName('*').length,
      };
    },
    perfStart: (): void => {
      app.perfLog = { dt: [], sim: [], app: [] };
    },
    /** Stop recording and summarise frame interval (rAF-to-rAF), sim step and sim+UI time, all in ms. */
    perfStop: () => {
      const l = app.perfLog;
      app.perfLog = null;
      if (!l) return null;
      const dt = l.dt.map((s) => s * 1000);
      return { frame: summarize(dt), sim: summarize(l.sim), app: summarize(l.app), over20: dt.filter((x) => x > 20).length, over33: dt.filter((x) => x > 33.4).length, seconds: dt.reduce((a, b) => a + b, 0) / 1000 };
    },
    renderer: () => {
      const cv = document.querySelector<HTMLCanvasElement>('#game-canvas-host canvas');
      const kind = cv && (cv.getContext('webgl2') || cv.getContext('webgl')) ? 'WebGL' : 'Canvas';
      const probe = document.createElement('canvas').getContext('webgl');
      const ext = probe?.getExtension('WEBGL_debug_renderer_info');
      return { kind, gpu: probe && ext ? String(probe.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown' };
    },
    audio: () => ({ unlocked: app.audio.unlocked, failed: app.audio.unlockFailed, state: app.audio.ctx?.state ?? null, loops: app.audio.activeLoops(), playCount: app.audio.playCount }),
  };
  (window as unknown as { __ASHEN_TEST__: typeof api }).__ASHEN_TEST__ = api;
}
