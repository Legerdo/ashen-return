import { hitboxOf, allCarriedItemIds, type SimContext } from './context';
import type { ActorState, InteractionPrompt } from './state';
import { interactEvent } from './events';
import { FOOTSTEP } from './movement';

export const INTERACT_RANGE = 1.5;

interface Candidate {
  prompt: InteractionPrompt;
  dist: number;
  score: number;
  run: () => void;
}

/** Does the actor hold an access right (registered) or a physical key item for keyId? */
export function hasKey(ctx: SimContext, a: ActorState, keyId: string): boolean {
  if (ctx.sim.registeredKeys.includes(keyId)) return true;
  for (const id of allCarriedItemIds(ctx.sim, a)) {
    const it = ctx.sim.store.items[id];
    if (it && ctx.content.item(it.definitionId).keyId === keyId) return true;
  }
  return false;
}

function losClear(ctx: SimContext, a: ActorState, x: number, y: number, ignore: string[]): boolean {
  const prof = hitboxOf(ctx.content, a);
  const from = { x: a.x, y: a.y, z: Math.min(prof.eyeZ, 1.0) };
  const to = { x, y, z: 0.9 };
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  for (const o of ctx.geo.query(from.x, from.y, to.x, to.y)) {
    if (o.floor !== a.floor || !o.profile.blocksVision || o.profile.foliage || ignore.includes(o.id) || !ctx.geo.isActive(o, ctx.sim)) continue;
    // Stop slightly before the target so a prop's own footprint does not hide it.
    const b = o.box;
    const len = Math.hypot(d.x, d.y);
    if (len < 0.05) continue;
    const endT = Math.max(0, 1 - 0.45 / len);
    const hit = lineBoxSeg(from, d, b, endT);
    if (hit) return false;
  }
  return true;
}

function lineBoxSeg(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, b: { x0: number; y0: number; x1: number; y1: number; z0: number; z1: number }, tMax: number): boolean {
  let tmin = 0;
  let tmax = tMax;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, b.x0, b.x1],
    [o.y, d.y, b.y0, b.y1],
    [o.z, d.z, b.z0, b.z1],
  ];
  for (const [oa, da, lo, hi] of axes) {
    if (Math.abs(da) < 1e-9) {
      if (oa < lo || oa > hi) return false;
    } else {
      let t1 = (lo - oa) / da;
      let t2 = (hi - oa) / da;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

function collect(ctx: SimContext, a: ActorState): Candidate[] {
  const sim = ctx.sim;
  const out: Candidate[] = [];
  const consider = (x: number, y: number, radius: number, prompt: InteractionPrompt, run: () => void, ignore: string[]) => {
    const dist = Math.hypot(x - a.x, y - a.y) - radius;
    if (dist > INTERACT_RANGE) return;
    if (!losClear(ctx, a, x, y, ignore)) return;
    const dx = x - a.x;
    const dy = y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const facing = (dx * a.aim.dirX + dy * a.aim.dirY) / l;
    out.push({ prompt, dist, score: dist - facing * 0.4, run });
  };
  for (const d of ctx.geo.map.doors) {
    if (d.floor !== a.floor) continue;
    const st = sim.doors[d.id];
    if (!st) continue;
    const cx = (d.x0 + d.x1) / 2;
    const cy = (d.y0 + d.y1) / 2;
    let blockedKey: string | undefined;
    if (!st.open && st.locked) {
      if (d.powerFlag && !sim.flags[d.powerFlag]) blockedKey = 'prompt.door.no_power';
      else if (d.keyId && !hasKey(ctx, a, d.keyId)) blockedKey = 'prompt.door.locked';
    }
    consider(cx, cy, 0.2, { kind: 'door', id: d.id, labelKey: st.open ? 'prompt.door.close' : 'prompt.door.open', ...(blockedKey ? { blockedKey } : {}), x: cx, y: cy }, () => toggleDoor(ctx, a, d.id), [`door:${d.id}`]);
  }
  for (const c of Object.values(sim.containers)) {
    if (c.floor !== a.floor) continue;
    const sc = sim.store.containers[c.id];
    if (!sc) continue;
    if (c.kind === 'drop' && sc.items.length === 0) continue;
    let blockedKey: string | undefined;
    if (c.locked && c.keyId && !hasKey(ctx, a, c.keyId)) blockedKey = 'prompt.container.locked';
    if (c.locked && !c.keyId) blockedKey = 'prompt.container.sealed';
    const label = c.kind === 'corpse' ? 'prompt.corpse' : c.kind === 'drop' ? 'prompt.drop' : 'prompt.container';
    const propId = `prop:${c.id.replace(/^ct:/, '')}`;
    consider(c.x, c.y, c.kind === 'world' || c.kind === 'event' ? 0.5 : 0.2, { kind: 'container', id: c.id, labelKey: label, params: { name: c.nameKey }, ...(blockedKey ? { blockedKey } : {}), x: c.x, y: c.y }, () => openContainer(ctx, a, c.id), [propId]);
  }
  for (const it of ctx.geo.map.interactables) {
    if (it.floor !== a.floor) continue;
    if (it.kind === 'note' && it.noteId && sim.progress.notesFound.includes(it.noteId) && sim.mode === 'raid') continue;
    if (it.kind === 'event') {
      const ev = sim.events.find((e) => e.id === it.eventId);
      if (!ev || ev.state !== 'idle') continue;
    }
    consider(it.x, it.y, it.radius, { kind: 'interactable', id: it.id, labelKey: it.labelKey, x: it.x, y: it.y }, () => runInteractable(ctx, a, it.id), [`prop:${it.id}`]);
  }
  return out;
}

/** Recompute the HUD prompt (cheap, local). */
export function updatePrompt(ctx: SimContext, a: ActorState): void {
  const c = collect(ctx, a);
  c.sort((x, y) => x.score - y.score);
  ctx.sim.prompt = c[0]?.prompt ?? null;
}

export function interact(ctx: SimContext, a: ActorState): boolean {
  const c = collect(ctx, a);
  if (c.length === 0) return false;
  c.sort((x, y) => x.score - y.score);
  const best = c[0]!;
  if (best.prompt.blockedKey) {
    ctx.sim.fx.push({ t: 'message', key: best.prompt.blockedKey });
    return false;
  }
  best.run();
  return true;
}

export function toggleDoor(ctx: SimContext, a: ActorState, doorId: string): void {
  const sim = ctx.sim;
  const st = sim.doors[doorId];
  const d = ctx.geo.map.doors.find((x) => x.id === doorId);
  if (!st || !d) return;
  if (!st.open && st.locked) {
    if (d.powerFlag && !sim.flags[d.powerFlag]) return;
    if (d.keyId && !hasKey(ctx, a, d.keyId)) return;
    st.locked = false;
  }
  if (st.open) {
    // Do not close on top of someone standing in the doorway.
    for (const o of sim.actors) {
      if (!o.alive) continue;
      if (o.x + o.radius > d.x0 && o.x - o.radius < d.x1 && o.y + o.radius > d.y0 && o.y - o.radius < d.y1) return;
    }
  }
  st.open = !st.open;
  sim.noises.push({ x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2, floor: d.floor, loudness: 0.5, radius: FOOTSTEP.door, tag: 'door', sourceId: a.id, time: sim.time });
  sim.fx.push({ t: 'door', doorId, open: st.open });
}

export function openContainer(ctx: SimContext, a: ActorState, containerId: string): void {
  const sim = ctx.sim;
  const c = sim.containers[containerId];
  if (!c) return;
  if (c.locked) {
    if (!c.keyId || !hasKey(ctx, a, c.keyId)) return;
    c.locked = false;
  }
  if (!c.opened) {
    c.opened = true;
    if (c.kind === 'world' || c.kind === 'event') sim.stats.containersSearched++;
  }
  sim.loot = { containerId };
  sim.fx.push({ t: 'ui', kind: 'loot', id: containerId });
  if (c.kind === 'event') {
    const ev = sim.events.find((e) => e.data['containerId'] === containerId);
    if (ev && ev.state !== 'success' && ev.state !== 'done') {
      ev.state = 'success';
      if (!sim.progress.eventsCompleted.includes(ev.defId)) sim.progress.eventsCompleted.push(ev.defId);
      sim.fx.push({ t: 'event', eventId: ev.id, state: 'success' });
    }
  }
}

function runInteractable(ctx: SimContext, a: ActorState, id: string): void {
  const sim = ctx.sim;
  const it = ctx.geo.interactable(id);
  if (!it) return;
  const tag = it.tag ?? it.id;
  if (!sim.progress.interactions.includes(tag)) sim.progress.interactions.push(tag);
  switch (it.kind) {
    case 'note':
      if (it.noteId) {
        if (!sim.progress.notesFound.includes(it.noteId)) sim.progress.notesFound.push(it.noteId);
        sim.fx.push({ t: 'ui', kind: 'note', id: it.noteId });
      }
      break;
    case 'event':
      interactEvent(ctx, a, it.eventId ?? '');
      break;
    case 'station':
    case 'npc':
    case 'range':
    case 'switch':
      sim.fx.push({ t: 'ui', kind: it.kind, id: it.stationId ?? it.npcId ?? it.id });
      break;
  }
}
