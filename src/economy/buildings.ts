import type { ContentRegistry } from '../content/registry';
import type { InteractableDef, MapDef, ObstacleDef } from '../content/mapTypes';
import { allocId } from '../core/ids';
import { fail } from '../core/tx';
import { addContainer, consumeDef, countDef } from '../inventory/store';
import { homeContainers, SHELF, stashHeight, type PlacedBuilding, type ProfileState } from '../progression/profile';

/**
 * Base construction: placement is validated on a 1u grid inside the shelter build zone. A placement is rejected if it
 * leaves the zone, overlaps reserved cells (entrance/terminal) or another building, or cuts the walkable connection
 * between the zone entrance and any anchor/building access tile.
 */

export interface Footprint {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function footprintOf(content: ContentRegistry, b: { buildingId: string; x: number; y: number; rot: 0 | 1 }): Footprint {
  const d = content.building(b.buildingId);
  const w = b.rot === 1 ? d.footprint.h : d.footprint.w;
  const h = b.rot === 1 ? d.footprint.w : d.footprint.h;
  return { x: b.x, y: b.y, w, h };
}

function overlap(a: Footprint, b: Footprint): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function validatePlacement(p: ProfileState, content: ContentRegistry, map: MapDef, buildingId: string, x: number, y: number, rot: 0 | 1, ignoreGuid: string | null): string | null {
  const zone = map.buildZone;
  if (!zone) return 'build.err.no_zone';
  if (!Number.isInteger(x) || !Number.isInteger(y)) return 'build.err.grid';
  const fp = footprintOf(content, { buildingId, x, y, rot });
  if (fp.x < zone.x || fp.y < zone.y || fp.x + fp.w > zone.x + zone.w || fp.y + fp.h > zone.y + zone.h) return 'build.err.bounds';
  for (const r of zone.reserved) if (overlap(fp, r)) return 'build.err.reserved';
  const others = p.buildings.filter((b) => b.guid !== ignoreGuid);
  for (const o of others) if (overlap(fp, footprintOf(content, o))) return 'build.err.overlap';
  // Connectivity: flood fill over free zone cells from the entrance anchor.
  const all = [...others.map((o) => footprintOf(content, o)), fp];
  const W = zone.w;
  const H = zone.h;
  const blocked = new Uint8Array(W * H);
  for (const f of all) for (let yy = f.y; yy < f.y + f.h; yy++) for (let xx = f.x; xx < f.x + f.w; xx++) blocked[(yy - zone.y) * W + (xx - zone.x)] = 1;
  const inZone = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < W && cy < H;
  const start = { x: Math.floor(zone.anchors[0]!.x) - zone.x, y: Math.max(0, Math.floor(zone.anchors[0]!.y) - zone.y) };
  if (!inZone(start.x, start.y) || blocked[start.y * W + start.x]) return 'build.err.blocks_path';
  const seen = new Uint8Array(W * H);
  const q = [start];
  seen[start.y * W + start.x] = 1;
  while (q.length) {
    const c = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx;
      const ny = c.y + dy;
      if (!inZone(nx, ny) || seen[ny * W + nx] || blocked[ny * W + nx]) continue;
      seen[ny * W + nx] = 1;
      q.push({ x: nx, y: ny });
    }
  }
  for (const a of zone.anchors) {
    const ax = Math.floor(a.x) - zone.x;
    const ay = Math.floor(a.y) - zone.y;
    if (inZone(ax, ay) && !seen[ay * W + ax]) return 'build.err.blocks_path';
  }
  // Every building needs at least one reachable neighbouring cell (its access side).
  for (const f of all) {
    let access = false;
    for (let yy = f.y - 1; yy <= f.y + f.h && !access; yy++)
      for (let xx = f.x - 1; xx <= f.x + f.w && !access; xx++) {
        const cx = xx - zone.x;
        const cy = yy - zone.y;
        const edge = yy === f.y - 1 || yy === f.y + f.h || xx === f.x - 1 || xx === f.x + f.w;
        if (!edge || !inZone(cx, cy)) continue;
        if (seen[cy * W + cx]) access = true;
      }
    if (!access) return 'build.err.blocks_path';
  }
  return null;
}

export function buildingCost(p: ProfileState, buildingId: string, content: ContentRegistry): { credits: number; items: { itemId: string; qty: number }[] } {
  const d = content.building(buildingId);
  // Q06 reward: the first workbench module is installed at the mechanic's expense.
  if (buildingId === 'core.building.workbench_module' && p.flags['workbench_unlocked'] && !p.flags['free_workbench_used']) return { credits: 0, items: [] };
  return d.cost;
}

export function placeBuilding(p: ProfileState, content: ContentRegistry, map: MapDef, buildingId: string, x: number, y: number, rot: 0 | 1): PlacedBuilding {
  const d = content.building(buildingId);
  if (d.unlockFlag && !p.flags[d.unlockFlag]) fail('build.err.locked');
  if (p.buildings.some((b) => b.buildingId === buildingId)) fail('build.err.duplicate');
  const err = validatePlacement(p, content, map, buildingId, x, y, rot, null);
  if (err) fail(err);
  const cost = buildingCost(p, buildingId, content);
  if (p.currency < cost.credits) fail('trade.err.money');
  for (const c of cost.items) if (countDef(p.store, c.itemId, homeContainers(p)) < c.qty) fail('build.err.materials');
  p.currency -= cost.credits;
  for (const c of cost.items) if (!consumeDef(p.store, c.itemId, c.qty, homeContainers(p))) fail('build.err.materials');
  if (buildingId === 'core.building.workbench_module' && cost.credits === 0) p.flags['free_workbench_used'] = true;
  const b: PlacedBuilding = { guid: allocId(p.ids, 'bld'), buildingId, x, y, rot };
  p.buildings.push(b);
  p.flags[`building:${buildingId}`] = true;
  if (d.effects.includes('storage:shelf')) addContainer(p.store, { id: SHELF, kind: 'grid', w: 6, h: 4 });
  return b;
}

export function moveBuilding(p: ProfileState, content: ContentRegistry, map: MapDef, guid: string, x: number, y: number, rot: 0 | 1): void {
  const b = p.buildings.find((o) => o.guid === guid);
  if (!b) fail('build.err.no_building');
  const err = validatePlacement(p, content, map, b!.buildingId, x, y, rot, guid);
  if (err) fail(err);
  b!.x = x;
  b!.y = y;
  b!.rot = rot;
}

export function upgradeFacility(p: ProfileState, content: ContentRegistry, facilityId: string): void {
  const f = content.facility(facilityId);
  if ((p.facilities[facilityId] ?? 0) > 0) fail('facility.err.done');
  if (f.requiresFlag && !p.flags[f.requiresFlag]) fail('facility.err.locked');
  if (f.requiresBuilding && !p.buildings.some((b) => b.buildingId === f.requiresBuilding)) fail('facility.err.building');
  if (p.currency < f.cost) fail('trade.err.money');
  p.currency -= f.cost;
  p.facilities[facilityId] = 1;
  if (f.effects['stashHeight']) {
    const st = p.store.containers['stash'];
    if (st) st.h = stashHeight(p);
  }
}

/** Solid obstacles for placed buildings in the shelter geometry. */
export function buildingObstacles(p: ProfileState, content: ContentRegistry): ObstacleDef[] {
  return p.buildings.map((b) => {
    const f = footprintOf(content, b);
    const d = content.building(b.buildingId);
    return { id: `bld:${b.guid}`, profile: d.sprite === 'shelf' ? 'core.ob.shelf' : 'core.ob.machine', x0: f.x + 0.05, y0: f.y + 0.05, x1: f.x + f.w - 0.05, y1: f.y + f.h - 0.05, z0: 0, z1: d.sprite === 'shelf' ? 1.8 : 1.3, floor: 0, tags: ['building', b.buildingId] };
  });
}

/** Station interactables at each building's south face. */
export function buildingInteractables(p: ProfileState, content: ContentRegistry): InteractableDef[] {
  return p.buildings.map((b) => {
    const f = footprintOf(content, b);
    const d = content.building(b.buildingId);
    const station = d.effects.includes('storage:shelf') ? 'shelf' : d.effects.includes('station:workbench_full') ? 'workbench' : d.effects.includes('station:medical_full') ? 'medical' : 'power';
    return { id: `bld.${b.guid}`, kind: 'station', x: f.x + f.w / 2, y: f.y + f.h + 0.3, radius: 0.9, floor: 0, stationId: station, labelKey: d.nameKey };
  });
}
