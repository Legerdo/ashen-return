import type { MapDef } from '../mapTypes';
import { MapBuilder } from './builder';

/**
 * 외곽 보급로 (core.map.outer_supply_route) — 64×80u, unlocked by Q03.
 *   South 폐선 화물역 (freight station: rail lines, freight cars, platform, station office, closed cargo warehouse interior)
 *   North 침엽림 보급창 (conifer forest depot: dense pines, fenced compound, tents, watchtower, supply truck exit)
 * Longer sightlines, fewer exits, more ammo/parts/keys/market clues, more night/storm.
 */
export function buildOuterSupply(): MapDef {
  const b = new MapBuilder('core.map.outer_supply_route', 'map.outer_supply_route.name', 'raid', 64, 80, 'forest');
  const BRK = 'core.ob.wall_brick';
  const MET = 'core.ob.wall_metal';
  const WOOD = 'core.ob.wall_wood';

  b.region({ id: 'core.region.conifer_depot', nameKey: 'region.conifer_depot', rects: [{ x: 0, y: 0, w: 64, h: 40 }], ambience: 'forest', lootTier: 3 });
  b.region({ id: 'core.region.freight_station', nameKey: 'region.freight_station', rects: [{ x: 0, y: 40, w: 64, h: 40 }], ambience: 'station', lootTier: 3 });

  // Ground
  b.ground(0, 40, 64, 40, 'gravel');
  b.ground(20, 40, 8, 40, 'rail');
  b.ground(20, 30, 8, 10, 'rail');
  b.ground(29, 44, 4, 28, 'concrete');
  b.ground(36, 50, 20, 18, 'concrete');
  b.ground(6, 48, 12, 10, 'wood_floor');
  b.ground(30, 8, 26, 22, 'dirt');
  b.groundPath([[42, 30], [42, 40], [34, 46], [30, 50]], 2.4, 'dirt');
  b.groundPath([[42, 8], [48, 6]], 2.6, 'gravel');
  for (const [cx, cy, r] of [[8, 12, 4], [14, 26, 3], [58, 18, 3.5], [24, 20, 2.5], [60, 34, 3]] as [number, number, number][]) b.groundCircle(cx, cy, r, 'snow');

  // ---------------------------------------------------------------- freight station
  // Freight cars on the two tracks (long metal cover with gaps between cars).
  for (const [x, y] of [[21, 44], [25, 52], [21, 60], [25, 68], [21, 72.5]] as [number, number][]) b.box('core.ob.railcar', x + 0.2, y, x + 2.2, y + 6, 2.6, { variant: y });
  b.box('core.ob.counter', 29.2, 44, 29.5, 72, 0.9);
  for (const [lx, ly] of [[31, 50], [31, 66]] as [number, number][]) b.light(lx, ly, 7);
  b.box('core.ob.crate_wood', 30.4, 56, 31.6, 57, 1.0);
  b.box('core.ob.crate_wood', 31, 62, 32.2, 63, 1.0);
  b.container('platform_crate', 'core.ct.crate', 31.2, 59.5, 'core.loot.freight');
  // Station building with the station master's office.
  b.room(6, 48, 18, 58, 0.35, BRK, 2.8, [{ side: 'e', at: 51, width: 1.6, id: 'door.station' }, { side: 's', at: 10, width: 1.5, id: 'door.station_back' }], [{ side: 'n', at: 9, width: 2 }, { side: 'e', at: 55, width: 1.5 }]);
  b.interior({ id: 'core.interior.station', nameKey: 'interior.station', regionId: 'core.region.freight_station', rect: { x: 6, y: 48, w: 12, h: 10 }, roof: 'tile' });
  b.wallV(12, 48.35, 57.65, 0.2, WOOD, 2.8, [[52, 53.5]]);
  b.container('station_drawer', 'core.ct.drawer', 8, 49.4, 'core.loot.office', { keyItem: 'core.keyitem.cargo_office' });
  b.container('station_locker', 'core.ct.locker', 16.6, 56.4, 'core.loot.medical');
  b.interact({ id: 'note.station_board', kind: 'note', x: 14.5, y: 49.2, radius: 0.4, noteId: 'core.note.station_board', labelKey: 'note.read' });
  b.box('core.ob.shelf', 13.9, 48.4, 15.1, 48.8, 1.8, { id: 'prop:note.station_board' });
  b.light(12, 60, 6);
  // Closed cargo warehouse (required interior) with a locked office.
  b.room(36, 50, 56, 68, 0.35, MET, 3.2, [
    { side: 'w', at: 58, width: 2, id: 'door.cargo_west' },
    { side: 'n', at: 44, width: 3, id: 'door.cargo_north', profile: 'core.ob.door_metal' },
    { side: 's', at: 47, width: 2, id: 'door.cargo_south' },
  ]);
  b.interior({ id: 'core.interior.cargo_warehouse', nameKey: 'interior.cargo_warehouse', regionId: 'core.region.freight_station', rect: { x: 36, y: 50, w: 20, h: 18 }, roof: 'metal' });
  for (let y = 53; y <= 63; y += 5) b.box('core.ob.shelf', 38.5, y, 47, y + 0.8, 2.2);
  b.wallV(50, 50.35, 56, 0.25, WOOD, 3.2, [[53, 54.5]]);
  b.wallH(50, 55.65, 56, 0.25, WOOD, 3.2);
  b.door('door.cargo_office', 49.95, 53, 50.3, 54.5, 'core.ob.door_wood', 2.3, { keyId: 'core.key.cargo_office' });
  b.container('cargo_office_safe', 'core.ct.weapon', 53, 51.2, 'core.loot.military');
  b.container('cargo_office_drawer', 'core.ct.drawer', 54.4, 54.6, 'core.loot.valuables');
  b.container('cargo_crate1', 'core.ct.crate', 40, 55.6, 'core.loot.freight');
  b.container('cargo_crate2', 'core.ct.crate', 44, 60.6, 'core.loot.freight');
  b.container('cargo_ammo', 'core.ct.ammo', 52, 66.6, 'core.loot.ammo');
  b.container('cargo_supply', 'core.ct.supply', 41, 66.2, 'core.loot.military');
  b.interact({ id: 'note.radio_transcript', kind: 'note', x: 51.8, y: 60.4, radius: 0.4, noteId: 'core.note.radio_transcript', labelKey: 'note.read' });
  b.box('core.ob.counter', 51.2, 60.5, 52.4, 61.1, 0.9, { id: 'prop:note.radio_transcript' });
  b.light(46, 58, 8, 0xc8d8ff);
  // Yard clutter
  b.box('core.ob.container', 4, 64, 10, 66.4, 2.6, { variant: 1 });
  b.box('core.ob.container', 58, 44, 60.4, 50, 2.6, { variant: 3 });
  b.box('core.ob.barrier', 34, 72, 38, 72.6, 1.0);
  b.box('core.ob.sandbag', 12, 70, 14.5, 70.6, 1.15);
  b.container('yard_scrap', 'core.ct.scrap', 8, 70, 'core.loot.scrap');
  b.container('yard_toolbox_s', 'core.ct.toolbox', 60, 60, 'core.loot.tools');
  for (const [tx, ty] of [[2, 44], [4, 76], [60, 76], [58, 70], [14, 78], [34, 78]] as [number, number][]) b.tree(tx, ty, 'pine', tx + ty);
  b.poi('poi.freight_station', 'poi.freight_station', 24, 60, 8, 'area');

  // ---------------------------------------------------------------- conifer depot
  // Depot compound fence with south gate and a small east gap.
  b.wallH(30, 56, 8, 0.25, 'core.ob.fence_chain', 2.4, [[40, 44]]);
  b.wallH(30, 56, 30, 0.25, 'core.ob.fence_chain', 2.4, [[40, 44]]);
  b.wallV(30, 8.25, 30, 0.25, 'core.ob.fence_chain', 2.4, [[18, 20]]);
  b.wallV(55.75, 8.25, 30, 0.25, 'core.ob.fence_chain', 2.4, [[22, 24]]);
  b.light(40, 31, 6);
  b.light(44, 31, 6);
  for (const [x, y] of [[33, 11], [33, 19], [47, 22], [36, 25]] as [number, number][]) b.box('core.ob.tent', x, y, x + 4, y + 3, 1.8);
  b.box('core.ob.crate_metal', 40, 14, 41.4, 15.2, 1.2);
  b.box('core.ob.crate_metal', 46, 16, 47.4, 17.2, 1.2);
  b.box('core.ob.sandbag', 38, 26.5, 41, 27.1, 1.15);
  b.box('core.ob.sandbag', 45, 12, 45.6, 14.5, 1.15);
  b.container('depot_supply1', 'core.ct.supply', 42, 18.5, 'core.loot.military');
  b.container('depot_ammo', 'core.ct.ammo', 50, 14, 'core.loot.ammo');
  b.container('depot_weapons', 'core.ct.weapon', 35, 16.5, 'core.loot.weapons');
  b.container('depot_medcab', 'core.ct.medcab', 49, 26.4, 'core.loot.medical');
  b.interact({ id: 'note.depot_manifest', kind: 'note', x: 43.6, y: 21.2, radius: 0.4, noteId: 'core.note.depot_manifest', labelKey: 'note.read' });
  b.box('core.ob.counter', 43, 21.3, 44.2, 21.9, 0.9, { id: 'prop:note.depot_manifest' });
  // Watchtower (marksman) in the depot's NE corner.
  for (const [lx, ly] of [[51.3, 9.3], [53.7, 9.3], [51.3, 11.7], [53.7, 11.7]] as [number, number][]) b.box('core.ob.tank_leg', lx - 0.15, ly - 0.15, lx + 0.15, ly + 0.15, 4.2);
  b.decor('watchtower', 52.5, 10.5, 1);
  b.light(52.5, 12, 6);
  // Supply truck (conditional exit: bring fuel) north of the depot.
  b.box('core.ob.car', 44, 3.6, 49, 6.2, 1.8, { variant: 3, id: 'prop:supply_truck' });
  b.decor('truck', 46.5, 5, 0);
  b.poi('poi.depot', 'poi.depot', 43, 19, 8, 'area');
  // Dense conifer forest (hand-placed stands) with snow clearings.
  const pines: [number, number][] = [
    [3, 3], [6, 7], [2, 11], [9, 4], [12, 9], [5, 16], [10, 14], [15, 3], [18, 8], [16, 14], [20, 4], [24, 9], [22, 14], [26, 3],
    [3, 22], [7, 20], [11, 23], [4, 30], [9, 32], [15, 30], [18, 24], [21, 28], [25, 25], [13, 36], [6, 37], [26, 34], [17, 37],
    [59, 3], [62, 8], [58, 12], [61, 22], [58, 27], [62, 30], [57, 36], [61, 38], [34, 35], [37, 38], [50, 35], [53, 38], [46, 36],
    [28, 18], [27, 30], [31, 4], [36, 3], [52, 3], [56, 6],
  ];
  pines.forEach(([x, y], i) => b.tree(x, y, 'pine', i));
  for (const [bx, by, bw, bh] of [[8, 18, 2.5, 2], [14, 20, 2, 2], [20, 34, 3, 2], [4, 26, 2, 2.5], [58, 16, 2, 2], [52, 32, 3, 1.6], [24, 38, 2.4, 1.6], [34, 32, 2.5, 1.5]] as [number, number, number, number][]) b.bush(bx, by, bw, bh);
  b.container('forest_cache', 'core.ct.crate', 12, 27, 'core.loot.valuables');
  b.container('forest_toolbox', 'core.ct.toolbox', 60.5, 25, 'core.loot.tools');
  b.poi('poi.forest_cache', 'poi.forest_cache', 12, 27, 4, 'landmark');

  // ---------------------------------------------------------------- enemies
  b.enemies({ id: 'depot_guard', regionId: 'core.region.conifer_depot', archetypes: [{ id: 'core.enemy.sentry', weight: 2 }, { id: 'core.enemy.support', weight: 1 }], count: [2, 3], chance: 1, points: [{ x: 42, y: 24 }, { x: 38, y: 13 }, { x: 50, y: 20 }, { x: 44, y: 10 }], patrol: [{ x: 32, y: 28 }, { x: 54, y: 28 }, { x: 54, y: 10 }, { x: 32, y: 10 }] });
  b.enemies({ id: 'depot_tower', regionId: 'core.region.conifer_depot', archetypes: [{ id: 'core.enemy.marksman', weight: 1 }], count: [1, 1], chance: 0.9, points: [{ x: 52.5, y: 13 }], patrol: [] });
  b.enemies({ id: 'forest_marksman', regionId: 'core.region.conifer_depot', archetypes: [{ id: 'core.enemy.marksman', weight: 1 }], count: [1, 1], chance: 0.6, points: [{ x: 16, y: 18 }, { x: 22, y: 30 }], patrol: [] });
  b.enemies({ id: 'forest_patrol', regionId: 'core.region.conifer_depot', archetypes: [{ id: 'core.enemy.flanker', weight: 2 }, { id: 'core.enemy.sentry', weight: 1 }], count: [1, 2], chance: 0.9, points: [{ x: 20, y: 18 }, { x: 10, y: 34 }], patrol: [{ x: 8, y: 26 }, { x: 26, y: 20 }, { x: 20, y: 36 }] });
  // Elites (minThreat 3) only join once the raid threat reaches tier 3 here (world/threat.ts).
  b.enemies({ id: 'station_patrol', regionId: 'core.region.freight_station', archetypes: [{ id: 'core.enemy.flanker', weight: 2 }, { id: 'core.enemy.sentry', weight: 2 }, { id: 'core.enemy.elite', weight: 1 }], count: [2, 3], chance: 1, points: [{ x: 18.5, y: 50 }, { x: 30, y: 64 }, { x: 14, y: 62 }, { x: 34, y: 48 }], patrol: [{ x: 18.5, y: 44 }, { x: 18.5, y: 74 }, { x: 33, y: 74 }, { x: 33, y: 44 }] });
  b.enemies({ id: 'warehouse_rusher', regionId: 'core.region.freight_station', archetypes: [{ id: 'core.enemy.rusher', weight: 2 }, { id: 'core.enemy.sentry', weight: 1 }, { id: 'core.enemy.elite', weight: 1 }], count: [1, 2], chance: 0.9, points: [{ x: 48, y: 58 }, { x: 40, y: 62 }, { x: 53, y: 64 }], patrol: [] });

  // ---------------------------------------------------------------- exits, spawns, events
  b.exit({ id: 'exit.rail_tunnel', nameKey: 'exit.rail_tunnel', x: 20, y: 77, w: 8, h: 3, condition: { type: 'free' } });
  b.exit({ id: 'exit.supply_truck', nameKey: 'exit.supply_truck', x: 43, y: 6.6, w: 6, h: 1.6, condition: { type: 'item', itemId: 'core.mat.fuel', consume: true, hintKey: 'exit.hint.fuel' } });
  for (const [x, y] of [[3, 7], [10, 38], [60, 32], [59, 12]] as [number, number][]) b.spawn(x, y);
  b.spots('signal', [{ x: 12, y: 36 }, { x: 58, y: 42 }, { x: 30, y: 76 }]);
  b.spots('signal_ambush', [{ x: 4, y: 40 }, { x: 20, y: 32 }, { x: 62, y: 52 }, { x: 50, y: 38 }, { x: 40, y: 78 }, { x: 14, y: 72 }]);
  for (const s of b.m.eventSpots['signal']!) b.container(`signal_${s.x}_${s.y}`, 'core.ct.flare_crate', s.x, s.y, 'core.loot.signal_rescue', { eventId: 'core.event.emergency_signal' });
  b.spots('convoy', [{ x: 18.5, y: 44 }, { x: 18.5, y: 75 }]);
  b.container('convoy_cart', 'core.ct.cart', 18.5, 44, 'core.loot.cart', { eventId: 'core.event.moving_supply' });

  // ---------------------------------------------------------------- procedural layer (world/procgen.ts)
  // Seeded per raid over this fixed layout: extra start points along the forest edges, pine / ruin clusters in the
  // woods, freight clutter in the station yards, loot caches, jittered enemy anchors and snow / dirt patches.
  b.m.procgen = {
    spawnZones: [
      { x: 1, y: 1.2, w: 10, h: 11 },
      { x: 0.8, y: 14, w: 2.8, h: 24 },
      { x: 60.4, y: 4, w: 2.8, h: 34 },
      { x: 12, y: 0.8, w: 18, h: 2.4 },
    ],
    spawnCount: [2, 4],
    clusterZones: [
      { rect: { x: 2, y: 2, w: 26, h: 36 }, theme: 'forest', count: [4, 6] },
      { rect: { x: 56.5, y: 2, w: 6.5, h: 37 }, theme: 'forest', count: [1, 2] },
      { rect: { x: 30, y: 31, w: 26, h: 8 }, theme: 'forest', count: [1, 2] },
      { rect: { x: 1, y: 59, w: 18, h: 19 }, theme: 'freight', count: [2, 3] },
      { rect: { x: 30, y: 69, w: 32, h: 9 }, theme: 'freight', count: [2, 3] },
      { rect: { x: 57, y: 40, w: 6, h: 28 }, theme: 'freight', count: [1, 1] },
    ],
    cacheCount: [2, 3],
    patches: [
      { rect: { x: 0, y: 0, w: 64, h: 40 }, on: ['forest'], paint: ['snow', 'dirt'], count: [3, 5], radius: [1.5, 3] },
      { rect: { x: 0, y: 40, w: 64, h: 40 }, on: ['gravel'], paint: ['dirt', 'concrete'], count: [2, 4], radius: [1.5, 2.5] },
    ],
    enemyJitter: 1,
  };
  b.m.ambience = 'forest';
  return b.build();
}
