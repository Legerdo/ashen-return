import { createContent } from '../src/content/core';
import { MapBuilder } from '../src/content/maps/builder';
import type { MapDef } from '../src/content/mapTypes';
import type { ContentRegistry } from '../src/content/registry';
import { SIM_DT } from '../src/core/clock';
import { instantiate, placeNew, bagContainerId } from '../src/inventory/store';
import { idleCommand, type PlayerCommand } from '../src/world/command';
import { makeContext, type SimContext } from '../src/world/context';
import { WorldGeometry } from '../src/world/geometry';
import { stepSim } from '../src/world/sim';
import { emptySim, ensureEquipContainers, giveLoadedWeapon, newActor } from '../src/world/spawn';
import { eqContainerId, type ActorState } from '../src/world/state';

/** Build a registry with an extra test arena map. */
export function contentWith(maps: MapDef[]): ContentRegistry {
  return createContent([{ id: `test-${maps.map((m) => m.id).join('+')}`, version: '0', maps }]);
}

export function arena(id: string, w: number, h: number, build: (b: MapBuilder) => void = () => {}): MapDef {
  const b = new MapBuilder(id, 'map.shelter.name', 'raid', w, h, 'concrete');
  build(b);
  b.spawn(2, h / 2);
  b.region({ id: 'test.region', nameKey: 'region.range', rects: [{ x: 0, y: 0, w, h }], ambience: 'wind', lootTier: 0 });
  return b.build();
}

export interface TestWorld {
  content: ContentRegistry;
  ctx: SimContext;
  player: ActorState;
}

/** Minimal raid-mode sim with a player standing at (x, y) facing +x. */
export function world(map: MapDef, px = 2, py = 5): TestWorld {
  const content = contentWith([map]);
  const sim = emptySim('raid', 'test-raid', map.id, 'seed-test', 'Day', 'Clear');
  const geo = new WorldGeometry(map, content);
  const ctx = makeContext(sim, content, geo);
  const pl = newActor('player', 'player', px, py, 100, 'player');
  sim.actors.push(pl);
  ensureEquipContainers(sim.store, 'player');
  const bag = instantiate(content, sim.ids, 'core.bag.basic');
  placeNew(sim.store, content, bag, { containerId: eqContainerId('player', 'backpack') });
  return { content, ctx, player: pl };
}

export function bagOf(t: TestWorld): string {
  const bag = t.ctx.sim.store.containers[eqContainerId('player', 'backpack')]!.items[0]!;
  return bagContainerId(bag);
}

export function equip(t: TestWorld, weaponDefId: string, ammoDefId: string, spareMags = 2, loose = 0): string {
  const def = t.content.item(weaponDefId);
  const slot = def.weapon!.class === 'pistol' ? 'secondary' : 'primary1';
  const id = giveLoadedWeapon(t.content, t.ctx.sim, eqContainerId('player', slot), weaponDefId, ammoDefId, spareMags, loose, bagOf(t));
  t.player.activeSlot = slot;
  return id;
}

/** Stationary target without AI (hostile team so projectiles resolve against it). */
export function target(t: TestWorld, x: number, y: number, opts: { crouch?: boolean; vest?: number; helmet?: number; hp?: number; id?: string } = {}): ActorState {
  const a = newActor(opts.id ?? `t${t.ctx.sim.actors.length}`, 'dummy', x, y, opts.hp ?? 100, 'hostile');
  a.stance = opts.crouch ? 'crouch' : 'stand';
  a.aim.dirX = -1;
  a.aim.dirY = 0;
  ensureEquipContainers(t.ctx.sim.store, a.id);
  if (opts.vest) placeNew(t.ctx.sim.store, t.content, instantiate(t.content, t.ctx.sim.ids, `core.armor.vest${opts.vest}`), { containerId: eqContainerId(a.id, 'vest') });
  if (opts.helmet) placeNew(t.ctx.sim.store, t.content, instantiate(t.content, t.ctx.sim.ids, `core.armor.helmet${opts.helmet}`), { containerId: eqContainerId(a.id, 'helmet') });
  t.ctx.sim.actors.push(a);
  return a;
}

export function aimCmd(x: number, y: number, z: number, extra: Partial<PlayerCommand> = {}, actorId: string | null = null): PlayerCommand {
  return { ...idleCommand(), aim: { x, y, z, actorId, viewDistPx: 999 }, ...extra };
}

export function tick(t: TestWorld, cmd: PlayerCommand | null, n = 1): void {
  for (let i = 0; i < n; i++) stepSim(t.ctx, { cmd, ops: [] }, SIM_DT);
}

/** Drain projectiles until none remain (max ticks). */
export function settle(t: TestWorld, maxTicks = 240, cmd: PlayerCommand | null = null): void {
  for (let i = 0; i < maxTicks && t.ctx.sim.projectiles.length > 0; i++) stepSim(t.ctx, { cmd, ops: [] }, SIM_DT);
}
