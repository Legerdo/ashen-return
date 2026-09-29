import { EQUIP_SLOTS } from '../content/types';
import { addContainer, instantiate, moveItem, placeNew } from '../inventory/store';
import { equippedId, type SimContext } from './context';
import { pocketContainerId, type ActorState, type WorldContainerState } from './state';

export const CIPHER_MODULE = 'core.quest.cipher_module';

/**
 * Death transfer runs exactly once per deathEventId. Enemy corpses keep the real weapon (with its magazine,
 * chamber, attachments, durability) and armor instances — nothing is re-rolled.
 */
export function processDeath(ctx: SimContext, a: ActorState, cause: string): void {
  const sim = ctx.sim;
  const deathId = `death:${sim.raidId}:${a.id}`;
  if (sim.processedDeaths.includes(deathId)) return;
  sim.processedDeaths.push(deathId);
  a.deathEventId = deathId;
  a.sprinting = false;
  sim.fx.push({ t: 'death', actorId: a.id, x: a.x, y: a.y });
  if (a.kind === 'player') {
    if (!sim.outcome) sim.outcome = { kind: 'dead', tick: sim.tick, cause };
    sim.fx.push({ t: 'died' });
    return;
  }
  if (a.kind === 'dummy') {
    if (a.dummy) a.dummy.respawnAt = sim.time + 2;
    return;
  }
  if (a.kind !== 'enemy') return;
  const cid = `corpse:${a.id}`;
  addContainer(sim.store, { id: cid, kind: 'list', w: 0, h: 0 });
  for (const slot of EQUIP_SLOTS) {
    const id = equippedId(sim, a.id, slot);
    if (id) moveItem(sim.store, ctx.content, id, { containerId: cid }, { allowNonEmptyBag: true });
  }
  const pk = sim.store.containers[pocketContainerId(a.id)];
  if (pk) for (const id of [...pk.items]) moveItem(sim.store, ctx.content, id, { containerId: cid }, { allowNonEmptyBag: true });
  const arch = a.archetypeId ? ctx.content.enemy(a.archetypeId) : null;
  if (arch?.role === 'boss' && sim.activeQuests.includes('core.quest.q08_last_signal') && !sim.flags['cipher_generated']) {
    const inst = instantiate(ctx.content, sim.ids, CIPHER_MODULE, { questTags: ['q08'] });
    placeNew(sim.store, ctx.content, inst, { containerId: cid });
    sim.flags['cipher_generated'] = true;
  }
  const wc: WorldContainerState = {
    id: cid,
    kind: 'corpse',
    typeId: 'corpse',
    x: a.x,
    y: a.y,
    floor: a.floor,
    searched: 0,
    searchProgress: 0,
    keyId: null,
    locked: false,
    actorId: a.id,
    nameKey: arch?.nameKey ?? 'world.corpse',
    createdTick: sim.tick,
    opened: false,
  };
  sim.containers[cid] = wc;
}
