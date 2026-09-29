import type { ContentRegistry } from '../content/registry';
import type { EquipSlot, HitboxProfile, ItemDef } from '../content/types';
import { RngStreams } from '../core/rng';
import { bagContainerId, type ItemInstance } from '../inventory/store';
import type { ActorShape } from '../combat/ballistics';
import type { WorldGeometry } from './geometry';
import { eqContainerId, inIframes, pocketContainerId, type ActorState, type SimState, type WeaponSlot } from './state';

/** Live simulation context: serializable state + non-serialized helpers rebuilt from definitions. */
export interface SimContext {
  sim: SimState;
  content: ContentRegistry;
  geo: WorldGeometry;
  rng: RngStreams;
}

export function makeContext(sim: SimState, content: ContentRegistry, geo: WorldGeometry): SimContext {
  return { sim, content, geo, rng: RngStreams.fromState(sim.rng) };
}

export function syncRng(ctx: SimContext): void {
  ctx.sim.rng = ctx.rng.getState();
}

export function actorById(sim: SimState, id: string): ActorState | undefined {
  return sim.actors.find((a) => a.id === id);
}

export function player(sim: SimState): ActorState {
  const p = sim.actors.find((a) => a.kind === 'player');
  if (!p) throw new Error('no player actor');
  return p;
}

export function equippedId(sim: SimState, actorId: string, slot: EquipSlot): string | null {
  const c = sim.store.containers[eqContainerId(actorId, slot)];
  return c && c.items.length > 0 ? c.items[0]! : null;
}

export function equippedItem(sim: SimState, actorId: string, slot: EquipSlot): ItemInstance | null {
  const id = equippedId(sim, actorId, slot);
  return id ? (sim.store.items[id] ?? null) : null;
}

export function activeWeaponItem(ctx: SimContext, a: ActorState): { item: ItemInstance; def: ItemDef } | null {
  const it = equippedItem(ctx.sim, a.id, a.activeSlot);
  if (!it) return null;
  const def = ctx.content.item(it.definitionId);
  if (def.kind !== 'weapon') return null;
  return { item: it, def };
}

export function meleeItem(ctx: SimContext, a: ActorState): { item: ItemInstance; def: ItemDef } | null {
  const it = equippedItem(ctx.sim, a.id, 'melee');
  if (!it) return null;
  return { item: it, def: ctx.content.item(it.definitionId) };
}

/** Containers an actor can draw magazines/ammo/meds from. */
export function carriedContainerIds(sim: SimState, a: ActorState): string[] {
  const out: string[] = [];
  const bag = equippedId(sim, a.id, 'backpack');
  if (bag && sim.store.containers[bagContainerId(bag)]) out.push(bagContainerId(bag));
  if (sim.store.containers[pocketContainerId(a.id)]) out.push(pocketContainerId(a.id));
  return out;
}

/** Every item an actor carries (equipment + descendants + bag/pocket contents). */
export function allCarriedItemIds(sim: SimState, a: ActorState): string[] {
  const roots: string[] = [];
  for (const slot of ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'] as EquipSlot[]) {
    const id = equippedId(sim, a.id, slot);
    if (id) roots.push(id);
  }
  const pk = sim.store.containers[pocketContainerId(a.id)];
  if (pk) roots.push(...pk.items);
  const out: string[] = [];
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    const it = sim.store.items[id];
    if (!it) continue;
    out.push(id);
    stack.push(...it.containedItems);
    const bag = sim.store.containers[bagContainerId(id)];
    if (bag) stack.push(...bag.items);
  }
  return out;
}

export function hitboxOf(content: ContentRegistry, a: ActorState): HitboxProfile {
  return content.hitbox(a.stance === 'crouch' ? 'core.hitbox.crouched' : a.hitbox);
}

export function shapeOf(content: ContentRegistry, a: ActorState): ActorShape {
  return { id: a.id, team: a.team, x: a.x, y: a.y, facingX: a.aim.dirX, facingY: a.aim.dirY, profile: hitboxOf(content, a), floor: a.floor };
}

/** Bullet targets this tick. A rolling actor inside its invulnerability window is left out, so rounds fly past. */
export function aliveShapes(ctx: SimContext): ActorShape[] {
  const out: ActorShape[] = [];
  for (const a of ctx.sim.actors) if (a.alive && a.kind !== 'npc' && !inIframes(ctx.sim, a)) out.push(shapeOf(ctx.content, a));
  return out;
}

export function weaponSlotOrder(): WeaponSlot[] {
  return ['primary1', 'primary2', 'secondary', 'melee'];
}
