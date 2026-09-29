import { allocId } from '../core/ids';
import { addContainer, findFreeSpot, moveItem, type ItemInstance } from '../inventory/store';
import { carriedContainerIds, type SimContext } from './context';
import type { ActorState, WorldContainerState } from './state';

/** Create a ground drop pile at (x, y) and return its container id. Drops always accept items (list container). */
export function createDrop(ctx: SimContext, x: number, y: number, floor: number): string {
  const sim = ctx.sim;
  const id = allocId(sim.ids, 'drop');
  const cid = `drop:${id}`;
  addContainer(sim.store, { id: cid, kind: 'list', w: 0, h: 0 });
  const wc: WorldContainerState = {
    id: cid,
    kind: 'drop',
    typeId: 'drop',
    x,
    y,
    floor,
    searched: 9999,
    searchProgress: 0,
    keyId: null,
    locked: false,
    actorId: null,
    nameKey: 'world.drop',
    createdTick: sim.tick,
    opened: false,
  };
  sim.containers[cid] = wc;
  return cid;
}

/** Nearest existing drop pile within 0.6u, or a new one. */
export function dropNear(ctx: SimContext, x: number, y: number, floor: number): string {
  for (const c of Object.values(ctx.sim.containers)) {
    if (c.kind === 'drop' && c.floor === floor && Math.hypot(c.x - x, c.y - y) < 0.6) return c.id;
  }
  return createDrop(ctx, x, y, floor);
}

export function dropItem(ctx: SimContext, a: ActorState, itemId: string): boolean {
  const cid = dropNear(ctx, a.x + a.aim.dirX * 0.4, a.y + a.aim.dirY * 0.4, a.floor);
  const r = moveItem(ctx.sim.store, ctx.content, itemId, { containerId: cid });
  return r.ok;
}

/** Put an item into the actor's carried containers (first fit), else drop it at their feet. */
export function stowOrDrop(ctx: SimContext, a: ActorState, itemId: string): 'stowed' | 'dropped' {
  const it = ctx.sim.store.items[itemId];
  if (!it) return 'dropped';
  const def = ctx.content.item(it.definitionId);
  for (const cid of carriedContainerIds(ctx.sim, a)) {
    const c = ctx.sim.store.containers[cid]!;
    if (c.kind === 'list') {
      if (moveItem(ctx.sim.store, ctx.content, itemId, { containerId: cid }).ok) return 'stowed';
      continue;
    }
    const spot = findFreeSpot(ctx.sim.store, ctx.content, c, def, itemId);
    if (spot && moveItem(ctx.sim.store, ctx.content, itemId, { containerId: cid, x: spot.x, y: spot.y, rotation: spot.rotation }).ok) return 'stowed';
  }
  dropItem(ctx, a, itemId);
  return 'dropped';
}

export function containerItems(ctx: SimContext, containerId: string): ItemInstance[] {
  const c = ctx.sim.store.containers[containerId];
  if (!c) return [];
  return c.items.map((id) => ctx.sim.store.items[id]!).filter(Boolean);
}

/** Remove empty drop piles (keeps the active drop count bounded). */
export function pruneDrops(ctx: SimContext): void {
  for (const [id, c] of Object.entries(ctx.sim.containers)) {
    if (c.kind !== 'drop') continue;
    const sc = ctx.sim.store.containers[id];
    if (!sc || sc.items.length === 0) {
      delete ctx.sim.containers[id];
      delete ctx.sim.store.containers[id];
    }
  }
}
