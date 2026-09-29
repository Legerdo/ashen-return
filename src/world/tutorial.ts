import type { ContentRegistry } from '../content/registry';
import { TUTORIAL_CRATE, TUTORIAL_DOOR, TUTORIAL_EXIT, TUTORIAL_MAP_ID, TUTORIAL_MOVE_SPOT, TUTORIAL_THROW_SPOT } from '../content/maps/tutorial';
import { addContainer, bagContainerId, instantiate, moveItem, placeNew } from '../inventory/store';
import { allCarriedItemIds, equippedId, makeContext, type SimContext } from './context';
import { WorldGeometry } from './geometry';
import { emptySim, ensureEquipContainers, fillContainer, giveLoadedWeapon, newActor } from './spawn';
import { eqContainerId, pocketContainerId, type ActorState, type SimEvent } from './state';
import { magazineOf } from '../combat/weapons';

/**
 * First-run controls tutorial. The course is a raid-rules training sim (sim.training): exits, loot and doors work as
 * in a raid, while stamina never drains and reloads draw from the unlimited training reserve. The player is
 * invulnerable and nothing here touches the profile economy — only the step index is persisted (profile.tutorial).
 *
 * TutorialDirector evaluates the current step after every fixed step from simulation state and that step's fx
 * events (plus which UI panel is open, for the inventory / map lessons). It is deterministic and DOM-free.
 */

export const TUTORIAL_STEPS = ['move', 'sprint', 'dodge', 'crouch', 'door', 'loot', 'inventory', 'shoot', 'ads', 'reload', 'melee', 'throw', 'heal', 'map', 'extract'] as const;
export type TutorialStepId = (typeof TUTORIAL_STEPS)[number];

/** TUNABLE: lesson thresholds. */
export const TUTORIAL = {
  moveRadius: 1.3,
  sprintSeconds: 0.7,
  /** Dodge lesson: two rolls, so the short recovery between rolls is felt once. */
  dodgeRolls: 2,
  shootHits: 3,
  /** ADS lesson: a hit counts once the sight has settled this far (handling.adsT). */
  adsSettled: 0.75,
  healHp: 70,
} as const;

export const CRATE_CID = `ct:${TUTORIAL_CRATE}`;
const DUMMY = (id: string) => `dummy-${id}`;

export interface TutorialTarget {
  key: string;
  x: number;
  y: number;
  z: number;
  nameKey: string;
  labelKey: string;
}

export function createTutorialSim(content: ContentRegistry, seed: string): SimContext {
  const map = content.map(TUTORIAL_MAP_ID);
  const sim = emptySim('raid', `tutorial-${seed}`, map.id, seed, 'Day', 'Clear');
  sim.training = true;
  // Range bookkeeping: target respawn (tickRange) and the reload counter the reload lesson reads.
  sim.range = { preset: 'none', headHits: 0, wallBlocks: 0, lowCoverHits: 0, reloads: 0, turretNextAt: 0 };
  const geo = new WorldGeometry(map, content);
  const ctx = makeContext(sim, content, geo);
  for (const d of map.doors) sim.doors[d.id] = { open: d.startOpen, locked: false };
  for (const c of map.containers) {
    const t = content.containerType(c.type);
    const cid = `ct:${c.id}`;
    addContainer(sim.store, { id: cid, kind: 'grid', w: t.gridW, h: t.gridH });
    sim.containers[cid] = { id: cid, kind: 'world', typeId: c.type, x: c.x, y: c.y, floor: 0, searched: 0, searchProgress: 0, keyId: null, locked: false, actorId: null, nameKey: t.nameKey, createdTick: 0, opened: false };
    fillContainer(content, sim, cid, c, ctx.rng.get('loot'), null);
  }
  const sp = map.playerSpawns[0]!;
  const pl = newActor('player', 'player', sp.x, sp.y, 100, 'player');
  pl.invulnerable = true;
  sim.actors.push(pl);
  ensureEquipContainers(sim.store, pl.id);
  placeNew(sim.store, content, instantiate(content, sim.ids, 'core.bag.basic'), { containerId: eqContainerId(pl.id, 'backpack') });
  placeNew(sim.store, content, instantiate(content, sim.ids, 'core.melee.knife'), { containerId: eqContainerId(pl.id, 'melee') });
  giveLoadedWeapon(content, sim, eqContainerId(pl.id, 'secondary'), 'core.weapon.p9', 'core.ammo.9.fmj', 0, 0, null);
  pl.activeSlot = 'secondary';
  for (const t of map.rangeTargets ?? []) {
    const d = newActor(DUMMY(t.id), 'dummy', t.x, t.y, 100, 'hostile');
    d.aim.dirX = -1;
    d.aim.dirY = 0;
    d.aim.faceRight = false;
    d.dummy = { homeX: t.x, homeY: t.y, respawnAt: null, track: null, preset: 'fixed_none', crouched: t.crouched };
    ensureEquipContainers(sim.store, d.id);
    sim.actors.push(d);
  }
  for (const ex of map.exits) sim.exits[ex.id] = { progress: 0, enabled: true };
  sim.rng = ctx.rng.getState();
  return ctx;
}

function playerOf(ctx: SimContext): ActorState {
  return ctx.sim.actors.find((a) => a.kind === 'player')!;
}

function carriedDef(ctx: SimContext, pl: ActorState, defId: string): string | null {
  for (const id of allCarriedItemIds(ctx.sim, pl)) if (ctx.sim.store.items[id]?.definitionId === defId) return id;
  return null;
}

/** Put a fresh item into the player's bag (pocket fallback); returns its id. */
function giveCarried(ctx: SimContext, pl: ActorState, defId: string, qty = 1): string {
  const sim = ctx.sim;
  const inst = instantiate(ctx.content, sim.ids, defId, { quantity: qty });
  inst.quantity = qty;
  const bag = equippedId(sim, pl.id, 'backpack');
  if (bag && placeNew(sim.store, ctx.content, inst, { containerId: bagContainerId(bag) }).ok) return inst.instanceId;
  addContainer(sim.store, { id: pocketContainerId(pl.id), kind: 'list', w: 0, h: 0 });
  placeNew(sim.store, ctx.content, inst, { containerId: pocketContainerId(pl.id) });
  return inst.instanceId;
}

export class TutorialDirector {
  step: number;
  /** Step-local counter (hits landed in the shooting lesson). */
  progress = 0;
  /** Items handed out to keep a lesson completable (the app announces them). */
  readonly gifts: string[] = [];
  private sprintT = 0;
  private reloads0 = 0;

  constructor(
    readonly ctx: SimContext,
    startStep: number,
  ) {
    this.step = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, Math.floor(startStep)));
    this.fastForward();
    this.enter();
  }

  get id(): TutorialStepId {
    return TUTORIAL_STEPS[Math.min(this.step, TUTORIAL_STEPS.length - 1)]!;
  }

  get finished(): boolean {
    return this.step >= TUTORIAL_STEPS.length;
  }

  /** Resuming at a later step: re-apply the world changes of the lessons already done (door open, crate taken). */
  private fastForward(): void {
    const sim = this.ctx.sim;
    const pl = playerOf(this.ctx);
    const at = (id: TutorialStepId) => TUTORIAL_STEPS.indexOf(id);
    if (this.step > at('door')) {
      const d = sim.doors[TUTORIAL_DOOR];
      if (d) d.open = true;
    }
    if (this.step > at('loot')) {
      const crate = sim.store.containers[CRATE_CID];
      const bag = equippedId(sim, pl.id, 'backpack');
      if (crate && bag) for (const id of [...crate.items]) moveItem(sim.store, this.ctx.content, id, { containerId: bagContainerId(bag) });
      const wc = sim.containers[CRATE_CID];
      if (wc) {
        wc.opened = true;
        wc.searched = 9999;
      }
      this.assignBandage(pl);
    }
  }

  private assignBandage(pl: ActorState): void {
    const band = carriedDef(this.ctx, pl, 'core.med.bandage');
    if (band && !pl.quickslots.includes(band) && !pl.quickslots[0]) pl.quickslots[0] = band;
  }

  /** Per-step setup so every lesson stays completable whatever happened before. */
  private enter(): void {
    const ctx = this.ctx;
    const sim = ctx.sim;
    const pl = playerOf(ctx);
    this.progress = 0;
    this.sprintT = 0;
    this.reloads0 = sim.range?.reloads ?? 0;
    switch (this.id) {
      case 'reload': {
        // A full gun cannot be reloaded: take a few rounds out as if they had been fired.
        const w = equippedId(sim, pl.id, pl.activeSlot);
        const wi = w ? sim.store.items[w] : undefined;
        const mag = wi ? magazineOf(ctx, wi) : null;
        if (mag?.mag && mag.mag.rounds.length >= ctx.content.item(mag.definitionId).magazine!.capacity) mag.mag.rounds.splice(0, 6);
        break;
      }
      case 'throw':
        if (!allCarriedItemIds(sim, pl).some((id) => ctx.content.item(sim.store.items[id]!.definitionId).throwable)) {
          giveCarried(ctx, pl, 'core.throw.smoke');
          this.gifts.push('core.throw.smoke');
        }
        break;
      case 'heal': {
        if (!carriedDef(ctx, pl, 'core.med.bandage')) {
          giveCarried(ctx, pl, 'core.med.bandage');
          this.gifts.push('core.med.bandage');
        }
        const band = carriedDef(ctx, pl, 'core.med.bandage')!;
        if (!pl.quickslots.includes(band)) pl.quickslots[0] = band;
        pl.hp = Math.min(pl.hp, TUTORIAL.healHp);
        pl.status.bleeding = true;
        break;
      }
      default:
        break;
    }
  }

  /**
   * Evaluate the current lesson after a simulation step. `fx` are that step's events; `panel` the open UI panel.
   * Returns the id of the lesson that was just completed (the director has moved on), or null.
   */
  update(dt: number, fx: readonly SimEvent[], panel: string | null): TutorialStepId | null {
    if (this.finished) return null;
    const ctx = this.ctx;
    const sim = ctx.sim;
    const pl = playerOf(ctx);
    const isDummy = (id: string) => sim.actors.some((a) => a.id === id && a.kind === 'dummy');
    let done = false;
    switch (this.id) {
      case 'move':
        done = Math.hypot(pl.x - TUTORIAL_MOVE_SPOT.x, pl.y - TUTORIAL_MOVE_SPOT.y) <= TUTORIAL.moveRadius;
        break;
      case 'sprint':
        if (pl.sprinting && pl.moving) this.sprintT += dt;
        done = this.sprintT >= TUTORIAL.sprintSeconds;
        break;
      case 'dodge':
        for (const e of fx) if (e.t === 'dodge' && e.actorId === pl.id) this.progress++;
        done = this.progress >= TUTORIAL.dodgeRolls;
        break;
      case 'crouch':
        done = pl.stance === 'crouch';
        break;
      case 'door':
        done = !!sim.doors[TUTORIAL_DOOR]?.open;
        break;
      case 'loot': {
        const crate = sim.store.containers[CRATE_CID];
        done = !!crate && crate.items.length === 0;
        if (done) this.assignBandage(pl);
        break;
      }
      case 'inventory':
        done = panel === 'inventory';
        break;
      case 'shoot':
        for (const e of fx) if (e.t === 'hit' && e.byPlayer && isDummy(e.actorId)) this.progress++;
        done = this.progress >= TUTORIAL.shootHits;
        break;
      case 'ads':
        done = fx.some((e) => e.t === 'hit' && e.byPlayer && isDummy(e.actorId) && pl.handling.adsT >= TUTORIAL.adsSettled);
        break;
      case 'reload':
        done = (sim.range?.reloads ?? 0) > this.reloads0;
        break;
      case 'melee':
        done = fx.some((e) => e.t === 'melee' && e.actorId === pl.id && e.hit);
        break;
      case 'throw':
        done = sim.thrown.length > 0 || fx.some((e) => e.t === 'smoke' || e.t === 'explosion');
        break;
      case 'heal':
        done = !pl.status.bleeding;
        break;
      case 'map':
        done = panel === 'map';
        break;
      case 'extract':
        done = sim.outcome?.kind === 'extracted' && sim.outcome.exitId === TUTORIAL_EXIT;
        break;
    }
    if (!done) return null;
    const completed = this.id;
    this.step++;
    if (!this.finished) this.enter();
    return completed;
  }

  /** Where the current lesson happens (HUD marker / off-screen arrow), if it has a place. */
  target(): TutorialTarget | null {
    const map = this.ctx.geo.map;
    const dummy = (id: string, labelKey: string): TutorialTarget | null => {
      const a = this.ctx.sim.actors.find((x) => x.id === DUMMY(id));
      return a ? { key: `tut:${id}`, x: a.x, y: a.y, z: 2.1, nameKey: `tutorial.target.${id}`, labelKey } : null;
    };
    switch (this.id) {
      case 'move':
        return { key: 'tut:move', x: TUTORIAL_MOVE_SPOT.x, y: TUTORIAL_MOVE_SPOT.y, z: 0.6, nameKey: 'tutorial.mark.spot', labelKey: 'tutorial.mark.go' };
      case 'crouch':
        return { key: 'tut:cover', x: 9.5, y: 8.6, z: 1.6, nameKey: 'tutorial.mark.cover', labelKey: 'tutorial.mark.crouch' };
      case 'door': {
        const d = map.doors.find((x) => x.id === TUTORIAL_DOOR)!;
        return { key: 'tut:door', x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 + 0.6, z: 2.4, nameKey: 'tutorial.mark.door', labelKey: 'tutorial.mark.open' };
      }
      case 'loot': {
        const c = map.containers.find((x) => x.id === TUTORIAL_CRATE)!;
        return { key: 'tut:crate', x: c.x, y: c.y, z: 1.6, nameKey: 'tutorial.mark.crate', labelKey: 'tutorial.mark.search' };
      }
      case 'shoot':
        return dummy('near', 'tutorial.mark.fire');
      case 'ads':
        return dummy('far', 'tutorial.mark.aim');
      case 'melee':
        return dummy('melee', 'tutorial.mark.melee');
      case 'throw':
        return { key: 'tut:throw', x: TUTORIAL_THROW_SPOT.x, y: TUTORIAL_THROW_SPOT.y, z: 0.4, nameKey: 'tutorial.mark.throwspot', labelKey: 'tutorial.mark.throw' };
      case 'extract': {
        const ex = map.exits.find((x) => x.id === TUTORIAL_EXIT)!;
        return { key: 'tut:exit', x: ex.x + ex.w / 2, y: ex.y + ex.h / 2, z: 0.6, nameKey: 'exit.tutorial', labelKey: 'tutorial.mark.extract' };
      }
      default:
        return null;
    }
  }
}
