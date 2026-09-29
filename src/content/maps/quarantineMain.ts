import type { MapDef } from '../mapTypes';
import { MapBuilder } from './builder';

const Q02 = 'core.quest.q02_first_haul';
const Q07 = 'core.quest.q07_restore_power';

/**
 * 격리구역 본토 (core.map.quarantine_main) — 96×96u, hand-authored.
 *   SW 버려진 농장 (farm, short/medium sightlines, food/medical/basic mats, tilted water tower, farm warehouse interior)
 *   Centre 수풀 수로 (reed canal: reeds, mud, shallow water with a deep channel; red drainage pump + pump room interior)
 *   SE 무너진 검문소 (checkpoint: concrete/cars, long road sightlines and flanks, ammo/gear)
 *   N  폐쇄 산업 시설 (industrial: indoor/outdoor, doors and high walls, advanced parts, control room interior + boss)
 */
export function buildQuarantineMain(): MapDef {
  const b = new MapBuilder('core.map.quarantine_main', 'map.quarantine_main.name', 'raid', 96, 96, 'grass');
  const CON = 'core.ob.wall_concrete';
  const BRK = 'core.ob.wall_brick';
  const WOOD = 'core.ob.wall_wood';
  const MET = 'core.ob.wall_metal';

  // ---------------------------------------------------------------- regions
  b.region({ id: 'core.region.farm', nameKey: 'region.farm', rects: [{ x: 0, y: 50, w: 42, h: 46 }, { x: 0, y: 22, w: 40, h: 28 }], ambience: 'farm', lootTier: 1 });
  b.region({ id: 'core.region.canal', nameKey: 'region.canal', rects: [{ x: 40, y: 0, w: 26, h: 50 }, { x: 42, y: 50, w: 16, h: 22 }], ambience: 'canal', lootTier: 1 });
  b.region({ id: 'core.region.checkpoint', nameKey: 'region.checkpoint', rects: [{ x: 58, y: 50, w: 38, h: 46 }, { x: 42, y: 72, w: 16, h: 24 }], ambience: 'checkpoint', lootTier: 2 });
  b.region({ id: 'core.region.industrial', nameKey: 'region.industrial', rects: [{ x: 66, y: 0, w: 30, h: 50 }, { x: 0, y: 0, w: 40, h: 22 }], ambience: 'industrial', lootTier: 3 });

  // ---------------------------------------------------------------- ground
  b.ground(0, 0, 40, 22, 'grass_dry');
  b.ground(2, 6, 36, 2, 'rail');
  b.ground(0, 50, 42, 46, 'grass');
  b.ground(4, 84, 20, 10, 'field');
  b.ground(58, 0, 38, 46, 'gravel');
  b.ground(64, 6, 28, 24, 'concrete');
  b.ground(58, 50, 38, 46, 'grass_dry');
  // Roads
  b.ground(70, 30, 6, 66, 'asphalt');
  b.ground(56, 70, 40, 5, 'asphalt');
  b.groundPath([[12, 95], [12, 70], [30, 72], [42, 72], [46, 72]], 2.2, 'dirt');
  b.groundPath([[30, 72], [31, 70]], 3, 'dirt');
  b.groundPath([[12, 70], [8, 50], [4, 44], [1, 43]], 1.8, 'dirt');
  b.groundPath([[20, 22], [30, 30], [44, 21]], 1.6, 'dirt');
  // Canal: banks, shallow water, deep channel, south pond
  b.ground(44, 0, 12, 60, 'mud');
  b.ground(46, 0, 8, 58, 'water');
  b.groundCircle(51, 62, 5.5, 'water');
  b.groundCircle(51, 62, 7, 'mud');
  b.groundCircle(51, 62, 5.5, 'water');
  b.ground(46, 20, 8, 2, 'wood_floor');
  b.ground(46, 33, 8, 2, 'gravel');
  b.ground(44, 48, 12, 3, 'asphalt');
  b.ground(56, 48, 14, 3, 'asphalt');
  b.ground(42, 70, 16, 5, 'asphalt');
  // Deep channel (movement blocker) with crossings at the footbridge (y 20–22), ford (33–35) and road bridge (48–51).
  for (const [y0, y1] of [
    [0, 20],
    [22, 33],
    [35, 48],
    [51, 58],
  ] as [number, number][]) b.box('core.ob.water_deep', 49.2, y0, 50.8, y1, 0.2);
  b.box('core.ob.fence_wood', 46, 19.8, 54, 20, 1.0);
  b.box('core.ob.fence_wood', 46, 22, 54, 22.2, 1.0);
  b.box('core.ob.barrier', 44, 47.6, 56, 48, 1.0);
  b.box('core.ob.barrier', 44, 51, 56, 51.4, 1.0);

  // ---------------------------------------------------------------- canal: reeds, red pump, pump room
  const reedPatches: [number, number, number, number][] = [
    [44.2, 2, 2, 5], [53.8, 6, 2, 4], [44.3, 11, 1.6, 6], [54, 14, 1.8, 5], [46.5, 25, 2.5, 3], [51.5, 27, 2.2, 4],
    [44.4, 29, 1.6, 3], [54.2, 26, 1.6, 5], [46.4, 40, 2.6, 4], [44.3, 42, 1.5, 5], [52.4, 43, 1.6, 4], [44.4, 53, 1.6, 4],
    [53.8, 53, 1.8, 4], [47, 58, 3, 2], [54, 60, 2, 3], [45, 64, 2.5, 2.5], [51, 67, 3, 2], [46.6, 8, 2.2, 3], [51.2, 11, 2.2, 3],
  ];
  for (const [x, y, w, h] of reedPatches) b.reeds(x, y, w, h);
  // Red drainage pump (landmark) standing in the east shallows.
  b.box('core.ob.machine', 52.6, 36.8, 54.4, 39.2, 1.8, { id: 'prop:red_pump', variant: 1 });
  b.decor('red_pump', 53.5, 38, 0);
  b.poi('poi.red_pump', 'poi.red_pump', 53, 38, 4.5, 'landmark');
  b.interact({ id: 'ev.pump_console', kind: 'event', x: 55.3, y: 38, radius: 0.5, eventId: 'core.event.pump_restart', labelKey: 'event.pump.interact' });
  b.box('core.ob.counter', 55.6, 37.5, 56.2, 38.5, 1.1, { id: 'prop:ev.pump_console' });
  b.spots('pump', [{ x: 53.5, y: 38 }]);
  b.spots('pump_investigators', [{ x: 62, y: 28 }, { x: 60, y: 47 }]);
  // Pump room interior (brick, west door, inner locked cage).
  b.room(56.5, 31, 64.5, 42, 0.4, BRK, 2.8, [{ side: 'w', at: 36, width: 1.5, id: 'door.pump_room' }, { side: 's', at: 61, width: 1.4, id: 'door.pump_back' }]);
  b.interior({ id: 'core.interior.pump_room', nameKey: 'interior.pump_room', regionId: 'core.region.canal', rect: { x: 56.5, y: 31, w: 8, h: 11 }, roof: 'metal' });
  b.box('core.ob.machine', 57.6, 32, 60, 33.8, 1.6);
  b.box('core.ob.machine', 61, 32, 63.6, 33.2, 1.4);
  b.box('core.ob.fence_chain', 60.6, 37.6, 64.1, 37.8, 2.2);
  b.wallV(60.6, 37.8, 41.6, 0.2, 'core.ob.fence_chain', 2.2, [[38.4, 39.8]]);
  b.door('door.pump_cage', 60.55, 38.4, 60.85, 39.8, 'core.ob.door_metal', 2.2, { keyId: 'core.key.pump_cage' });
  b.container('pump_cage_box', 'core.ct.toolbox', 62.6, 40, 'core.loot.tools', { guaranteed: [{ itemId: 'core.mat.part', qty: 1 }, { itemId: 'core.mat.wire', qty: 2 }] });
  b.container('pump_parts', 'core.ct.crate', 57.8, 35, 'core.loot.tools', { questItems: [{ questId: Q07, itemId: 'core.mat.power_unit', qty: 1 }] });
  b.container('pump_event_crate', 'core.ct.pump_crate', 58, 40.5, 'core.loot.pump_crate', { eventId: 'core.event.pump_restart' });
  b.container('pump_locker', 'core.ct.locker', 63.4, 35, 'core.loot.medical');
  b.interact({ id: 'note.patrol_orders', kind: 'note', x: 58, y: 44, radius: 0.4, noteId: 'core.note.patrol_orders', labelKey: 'note.read' });
  b.box('core.ob.counter', 57.6, 44.1, 58.4, 44.6, 0.9, { id: 'prop:note.patrol_orders' });
  b.light(55.5, 36, 6, 0xff8060);
  b.bush(58, 25, 2, 1.5);
  b.bush(56.2, 45.5, 2, 1.2);

  // ---------------------------------------------------------------- farm (SW)
  // Farmhouse
  b.room(6, 58, 18, 68, 0.3, WOOD, 2.6, [{ side: 's', at: 11, width: 1.5, id: 'door.farmhouse' }], [{ side: 'e', at: 61, width: 2 }, { side: 'w', at: 62, width: 2 }]);
  b.interior({ id: 'core.interior.farmhouse', nameKey: 'interior.farmhouse', regionId: 'core.region.farm', rect: { x: 6, y: 58, w: 12, h: 10 }, roof: 'tile' });
  b.ground(6, 58, 12, 10, 'wood_floor');
  b.box('core.ob.counter', 7, 58.6, 12, 59.3, 0.95);
  b.box('core.ob.shelf', 14, 58.4, 17.5, 59, 2.0);
  b.wallH(6.3, 17.7, 63.2, 0.2, WOOD, 2.6, [[8.5, 10], [14, 15.5]]);
  b.container('farm_fridge', 'core.ct.fridge', 8.5, 60.2, 'core.loot.fridge');
  b.container('farm_drawer', 'core.ct.drawer', 15.8, 60.2, 'core.loot.valuables');
  b.container('farm_kitchen_crate', 'core.ct.crate', 10, 66.4, 'core.loot.farm_food');
  b.interact({ id: 'note.farm_diary', kind: 'note', x: 14, y: 64.4, radius: 0.4, noteId: 'core.note.farm_diary', labelKey: 'note.read' });
  b.box('core.ob.counter', 13.4, 64.5, 14.6, 65.1, 0.8, { id: 'prop:note.farm_diary' });
  b.light(12, 69, 5);
  // Farm warehouse (required interior) with locked back room.
  b.room(24, 56, 40, 70, 0.3, MET, 3.0, [{ side: 's', at: 29, width: 3, id: 'door.warehouse_main', startOpen: true }, { side: 'w', at: 60, width: 1.5, id: 'door.warehouse_side' }]);
  b.interior({ id: 'core.interior.farm_warehouse', nameKey: 'interior.farm_warehouse', regionId: 'core.region.farm', rect: { x: 24, y: 56, w: 16, h: 14 }, roof: 'metal' });
  b.ground(24, 56, 16, 14, 'concrete');
  b.wallV(34, 56.3, 62, 0.25, WOOD, 3.0, [[58.8, 60.2]]);
  b.wallH(34, 39.7, 62, 0.25, WOOD, 3.0);
  b.door('door.farm_backroom', 33.95, 58.8, 34.3, 60.2, 'core.ob.door_wood', 2.3, { keyId: 'core.key.farm_backroom' });
  b.container('farm_backroom_weapons', 'core.ct.weapon', 37, 57.4, 'core.loot.weapons');
  b.container('farm_backroom_drawer', 'core.ct.drawer', 38.6, 60.6, 'core.loot.valuables');
  b.container('farm_relief', 'core.ct.relief', 28, 60, 'core.loot.relief', { questItems: [{ questId: Q02, itemId: 'core.quest.relief_package', qty: 1 }] });
  b.container('farm_wh_crate1', 'core.ct.crate', 26, 64, 'core.loot.farm_food');
  b.container('farm_wh_toolbox', 'core.ct.toolbox', 38, 67.2, 'core.loot.tools');
  b.container('scrap_farm', 'core.ct.scrap', 26.4, 67.4, 'core.loot.scrap', { guaranteed: [{ itemId: 'core.mat.scrap', qty: 2 }] });
  b.box('core.ob.shelf', 31, 63.6, 33.5, 64.2, 2.0);
  b.box('core.ob.crate_wood', 30.5, 66, 31.5, 67, 1.0);
  b.box('core.ob.hay', 35, 64.5, 36.6, 65.6, 1.1);
  b.light(32, 71, 6);
  // Barn
  b.room(4, 76, 12, 82, 0.3, WOOD, 2.6, [{ side: 'e', at: 78, width: 1.8, id: 'door.barn', startOpen: true }]);
  b.interior({ id: 'core.interior.barn', nameKey: 'interior.barn', regionId: 'core.region.farm', rect: { x: 4, y: 76, w: 8, h: 6 }, roof: 'wood' });
  b.container('barn_crate', 'core.ct.crate', 6, 79.5, 'core.loot.farm_food');
  b.box('core.ob.hay', 8.8, 77, 10.8, 78, 1.1);
  // Tilted water tower (landmark) with a toolbox hiding the back-room key.
  for (const [lx, ly] of [
    [32.6, 80.6],
    [35.4, 80.6],
    [32.6, 83.4],
    [35.4, 83.4],
  ] as [number, number][]) b.box('core.ob.tank_leg', lx - 0.15, ly - 0.15, lx + 0.15, ly + 0.15, 4.5);
  b.decor('water_tower', 34, 82, 0);
  b.poi('poi.water_tower', 'poi.water_tower', 34, 82, 4.5, 'landmark');
  b.container('farm_tower_box', 'core.ct.toolbox', 34, 85, 'core.loot.tools', { keyItem: 'core.keyitem.farm_backroom' });
  // Fields, orchard, fences, hay
  for (let y = 85; y < 93; y += 2) b.crops(4, y, 18, 1.1);
  for (const [tx, ty] of [
    [20, 74], [23, 77.5], [26.5, 74.5], [29.5, 78], [20.5, 80], [24, 82], [38, 77], [40, 83], [3, 70], [2, 88], [26, 90], [36, 92],
  ] as [number, number][]) b.tree(tx, ty, 'tree', Math.round(tx + ty));
  b.wallH(2, 22, 72.2, 0.2, 'core.ob.fence_wood', 1.0, [[11, 13.5], [17, 18]]);
  b.box('core.ob.hay', 20, 70, 21.6, 71.1, 1.1);
  b.box('core.ob.hay', 38, 72.5, 39.6, 73.6, 1.1);
  b.box('core.ob.car', 16.5, 70.5, 18.5, 73, 1.4, { variant: 3 });
  b.container('farm_car_trunk', 'core.ct.crate', 19.6, 74.2, 'core.loot.farm_food');
  // North meadow & ruined shed
  b.room(10, 30, 17, 36, 0.35, BRK, 2.4, [{ side: 's', at: 12.5, width: 1.6, open: true }, { side: 'e', at: 32, width: 2, open: true }]);
  b.interior({ id: 'core.interior.shed', nameKey: 'interior.shed', regionId: 'core.region.farm', rect: { x: 10, y: 30, w: 7, h: 6 }, roof: 'wood' });
  b.container('shed_toolbox', 'core.ct.toolbox', 11.5, 31.4, 'core.loot.tools');
  b.container('meadow_crate', 'core.ct.crate', 15.4, 34.6, 'core.loot.farm_food');
  for (const [bx, by, bw, bh] of [
    [4, 26, 3, 2], [20, 28, 2.5, 2], [26, 36, 3, 2], [33, 26, 2, 3], [6, 40, 2.5, 2], [22, 44, 3, 1.8], [30, 46, 2, 2], [36, 38, 2.5, 2],
  ] as [number, number, number, number][]) b.bush(bx, by, bw, bh);
  for (const [tx, ty] of [[8, 24], [24, 25], [18, 40], [34, 32], [28, 42], [12, 47], [38, 46], [2, 34]] as [number, number][]) b.tree(tx, ty, 'tree', tx * 3 + ty);
  b.box('core.ob.car', 26, 33, 28.4, 34.6, 1.4, { variant: 1 });

  // ---------------------------------------------------------------- checkpoint (SE)
  b.room(78, 56, 90, 66, 0.5, CON, 3.0, [{ side: 's', at: 82, width: 2, id: 'door.checkpoint', startOpen: true }, { side: 'n', at: 80, width: 4, open: true }, { side: 'e', at: 60, width: 3, open: true }]);
  b.interior({ id: 'core.interior.checkpoint', nameKey: 'interior.checkpoint', regionId: 'core.region.checkpoint', rect: { x: 78, y: 56, w: 12, h: 10 }, roof: 'concrete' });
  b.ground(78, 56, 12, 10, 'tile');
  b.box('core.ob.counter', 79, 60, 83, 60.8, 1.0);
  b.container('cp_filing', 'core.ct.filing', 84.8, 57.2, 'core.loot.office', { keyItem: 'core.keyitem.pump_cage' });
  b.container('cp_ammo', 'core.ct.ammo', 80, 64.8, 'core.loot.ammo');
  b.container('cp_military', 'core.ct.supply', 87.4, 63.8, 'core.loot.military');
  b.interact({ id: 'note.checkpoint_log', kind: 'note', x: 84, y: 62.4, radius: 0.4, noteId: 'core.note.checkpoint_log', labelKey: 'note.read' });
  b.box('core.ob.counter', 83.4, 62.5, 84.6, 63.1, 0.9, { id: 'prop:note.checkpoint_log' });
  b.room(65.5, 59.5, 69, 63, 0.3, CON, 2.6, [{ side: 'e', at: 60.5, width: 1.2, open: true }], [{ side: 'w', at: 60.5, width: 1.6 }]);
  b.container('booth_drawer', 'core.ct.drawer', 67.2, 60.5, 'core.loot.office');
  // Barriers / sandbags / wrecks along the roads (long sightlines with flanking cover).
  b.box('core.ob.barrier', 70, 64, 72.2, 64.6, 1.0);
  b.box('core.ob.barrier', 73.8, 64, 76, 64.6, 1.0);
  b.box('core.ob.sandbag', 76.6, 58.5, 77.2, 61, 1.15);
  b.box('core.ob.sandbag', 68.5, 67.5, 71, 68.1, 1.15);
  b.box('core.ob.barrier', 62, 69.2, 64.2, 69.8, 1.0);
  b.box('core.ob.barrier', 86, 75.2, 88.2, 75.8, 1.0);
  for (const [cx, cy, v] of [
    [71.5, 79, 0], [74.2, 56.5, 1], [63.5, 72, 2], [88, 72.2, 3], [73.8, 88, 2], [60, 71.8, 1], [80.5, 71.5, 0],
  ] as [number, number, number][]) b.box('core.ob.car', cx, cy, cx + 2.2, cy + 1.5, 1.4, { variant: v });
  b.container('car_trunk_cp', 'core.ct.crate', 72.6, 81.2, 'core.loot.ammo');
  b.container('scrap_cp', 'core.ct.scrap', 86, 58.6 + 10, 'core.loot.scrap', { guaranteed: [{ itemId: 'core.mat.scrap', qty: 2 }] });
  // Watchtower (marksman perch) and field clutter.
  for (const [lx, ly] of [
    [91.3, 52.3],
    [93.7, 52.3],
    [91.3, 54.7],
    [93.7, 54.7],
  ] as [number, number][]) b.box('core.ob.tank_leg', lx - 0.15, ly - 0.15, lx + 0.15, ly + 0.15, 4.2);
  b.decor('watchtower', 92.5, 53.5, 0);
  b.poi('poi.watchtower', 'poi.watchtower', 92.5, 53.5, 4, 'landmark');
  b.container('tower_ammo', 'core.ct.ammo', 92.5, 56.4, 'core.loot.ammo');
  for (const [bx, by, bw, bh] of [[60, 58, 3, 2], [62, 84, 3, 2], [84, 82, 3, 2.5], [90, 88, 2.5, 2], [58, 90, 3, 2], [80, 92, 2, 2]] as [number, number, number, number][]) b.bush(bx, by, bw, bh);
  for (const [tx, ty] of [[62, 54], [86, 52], [60, 64], [66, 86], [90, 80], [78, 86], [94, 94], [56, 94]] as [number, number][]) b.tree(tx, ty, 'tree', tx + ty * 2);
  b.light(72, 60, 7);
  b.light(72, 68, 7);
  b.light(84, 70, 7);
  b.light(84, 55, 6);

  // ---------------------------------------------------------------- industrial (N)
  // Compound fence east of the pump room; main gate on the N–S road, side gap on the west fence.
  b.wallH(66, 96, 46, 0.25, 'core.ob.fence_chain', 2.4, [[70, 76]]);
  b.wallV(66, 30, 46, 0.25, 'core.ob.fence_chain', 2.4, [[34, 37]]);
  b.box(CON, 69.4, 45.4, 70, 47, 3);
  b.box(CON, 76, 45.4, 76.6, 47, 3);
  b.light(70, 44.5, 6);
  b.light(76, 44.5, 6);
  // Yard containers (stacked metal boxes) for long outdoor lanes.
  b.box('core.ob.container', 68.5, 36, 70.9, 42, 2.6, { variant: 0 });
  b.box('core.ob.container', 77, 40, 83, 42.4, 2.6, { variant: 1 });
  b.box('core.ob.container', 86, 33, 88.4, 39, 2.6, { variant: 2 });
  b.box('core.ob.container', 89, 42.6, 95, 45, 2.6, { variant: 3 });
  b.box('core.ob.crate_metal', 80, 35, 81.4, 36.2, 1.2);
  b.box('core.ob.crate_metal', 72, 33, 73.4, 34.2, 1.2);
  b.box('core.ob.sandbag', 74, 37, 76.5, 37.6, 1.15);
  b.container('yard_military', 'core.ct.supply', 83.5, 37, 'core.loot.military');
  b.container('yard_toolbox', 'core.ct.toolbox', 68, 44.5, 'core.loot.tools');
  b.poi('poi.industrial_yard', 'poi.industrial_yard', 80, 38, 6, 'area');
  // Factory hall (south door aligned with the road).
  b.room(67, 6, 93, 30, 0.5, BRK, 3.2, [
    { side: 's', at: 72, width: 3, id: 'door.hall_main', profile: 'core.ob.door_metal' },
    { side: 'w', at: 22, width: 1.5, id: 'door.hall_west' },
    { side: 'e', at: 14, width: 1.5, id: 'door.hall_east', profile: 'core.ob.door_metal' },
  ]);
  b.interior({ id: 'core.interior.factory_hall', nameKey: 'interior.factory_hall', regionId: 'core.region.industrial', rect: { x: 67, y: 6, w: 26, h: 24 }, roof: 'metal' });
  for (const [mx, my, mw, mh] of [
    [69, 20, 3, 2], [69, 25.5, 3, 2], [88.5, 20, 3, 2], [88.5, 25.5, 3, 2], [76, 22.5, 2, 3], [84, 22.5, 2, 3],
  ] as [number, number, number, number][]) b.box('core.ob.machine', mx, my, mx + mw, my + mh, 1.6);
  for (const [px, py] of [[70.5, 10], [89.5, 10], [70.5, 16], [89.5, 16], [80, 25]] as [number, number][]) b.box('core.ob.pillar', px - 0.5, py - 0.5, px + 0.5, py + 0.5, 3.2);
  b.container('hall_parts', 'core.ct.crate', 70.5, 28.4, 'core.loot.tools', { questItems: [{ questId: Q07, itemId: 'core.mat.power_unit', qty: 1 }], guaranteed: [{ itemId: 'core.mat.part', qty: 1 }] });
  b.container('hall_locker', 'core.ct.locker', 91.8, 27.4, 'core.loot.military');
  b.container('hall_ammo', 'core.ct.ammo', 82, 28.6, 'core.loot.ammo');
  b.interact({ id: 'note.engineer_memo', kind: 'note', x: 77, y: 27.4, radius: 0.4, noteId: 'core.note.engineer_memo', labelKey: 'note.read' });
  b.box('core.ob.counter', 76.4, 27.5, 77.6, 28.1, 0.9, { id: 'prop:note.engineer_memo' });
  b.light(73, 21, 6);
  b.light(87, 21, 6);
  // Control room (required interior, boss arena). Electric locks open only after power is restored (Q07).
  // Two high fixed covers (pillars), low destructible crates, left/right flank lanes, east escape door.
  b.room(73, 7, 87, 18, 0.5, CON, 3.2, [
    { side: 's', at: 79, width: 2, id: 'door.control_main', profile: 'core.ob.door_metal', powerFlag: 'power_restored' },
    { side: 'e', at: 11, width: 1.5, id: 'door.control_escape', profile: 'core.ob.door_metal', powerFlag: 'power_restored' },
  ]);
  b.interior({ id: 'core.interior.control_room', nameKey: 'interior.control_room', regionId: 'core.region.industrial', rect: { x: 73, y: 7, w: 14, h: 11 }, roof: 'concrete' });
  b.ground(73, 7, 14, 11, 'tile');
  b.box('core.ob.pillar', 76.4, 11, 77.6, 12.2, 3.2);
  b.box('core.ob.pillar', 82.4, 11, 83.6, 12.2, 3.2);
  b.box('core.ob.crate_wood', 79.2, 14.6, 80.6, 15.6, 1.0);
  b.box('core.ob.crate_wood', 74.6, 15.4, 76, 16.4, 1.0);
  b.box('core.ob.crate_wood', 84, 15.4, 85.4, 16.4, 1.0);
  b.box('core.ob.counter', 78, 8, 82, 8.8, 1.0);
  b.container('control_filing', 'core.ct.filing', 74.4, 8.2, 'core.loot.office');
  b.interact({ id: 'note.commander_letter', kind: 'note', x: 85.6, y: 8.8, radius: 0.4, noteId: 'core.note.commander_letter', labelKey: 'note.read' });
  b.box('core.ob.counter', 85, 8.1, 86.2, 8.6, 0.9, { id: 'prop:note.commander_letter' });
  b.spots('boss_cover', [{ x: 77, y: 10 }, { x: 83, y: 10 }, { x: 80, y: 9.6 }]);
  b.spots('boss_flank', [{ x: 75, y: 13.5 }, { x: 85.5, y: 13.5 }]);
  b.spots('boss_support', [{ x: 74.5, y: 9.5 }, { x: 85.5, y: 9.8 }]);
  b.light(80, 12, 7, 0xa8c8ff);
  b.enemies({ id: 'boss', regionId: 'core.region.industrial', archetypes: [{ id: 'core.enemy.boss', weight: 1 }], count: [1, 1], chance: 1, points: [{ x: 80, y: 10.5 }], patrol: [], boss: true });
  // Freight elevator (conditional: power) behind the hall.
  b.box(CON, 84, 0.6, 92, 1, 3);
  b.box('core.ob.machine', 92, 1, 93, 4.5, 2.2);
  b.decor('elevator', 88.5, 2.5, 0);
  // NW storage yard with rail spur.
  for (const [rx, ry] of [[6, 4.6], [16, 4.6], [28, 4.6]] as [number, number][]) b.box('core.ob.railcar', rx, ry, rx + 6, ry + 2, 2.4, { variant: rx });
  b.room(2, 12, 12, 20, 0.3, MET, 2.8, [{ side: 's', at: 5, width: 2.5, open: true }]);
  b.interior({ id: 'core.interior.storage_shed', nameKey: 'interior.storage_shed', regionId: 'core.region.industrial', rect: { x: 2, y: 12, w: 10, h: 8 }, roof: 'metal' });
  b.container('storage_toolbox', 'core.ct.toolbox', 8, 13.6, 'core.loot.tools', { guaranteed: [{ itemId: 'core.mat.part', qty: 1 }] });
  b.container('scrap_storage', 'core.ct.scrap', 4.4, 16, 'core.loot.scrap', { guaranteed: [{ itemId: 'core.mat.scrap', qty: 2 }] });
  b.container('storage_crate', 'core.ct.crate', 22, 12, 'core.loot.farm_food');
  b.container('storage_weapons', 'core.ct.weapon', 30, 16, 'core.loot.weapons');
  b.box('core.ob.container', 18, 14, 20.4, 20, 2.6, { variant: 2 });
  b.box('core.ob.crate_metal', 26, 18, 27.4, 19.2, 1.2);
  for (const [tx, ty] of [[36, 2], [38, 14], [14, 2], [2, 20]] as [number, number][]) b.tree(tx, ty, 'tree', tx);

  // ---------------------------------------------------------------- enemies (seeded composition, hand-placed anchors)
  b.enemies({ id: 'farm_patrol', regionId: 'core.region.farm', archetypes: [{ id: 'core.enemy.sentry', weight: 4 }, { id: 'core.enemy.flanker', weight: 1 }], count: [2, 3], chance: 1, points: [{ x: 14, y: 70.5 }, { x: 22, y: 69 }, { x: 36, y: 72 }, { x: 8, y: 74 }], patrol: [{ x: 12, y: 70.5 }, { x: 30, y: 72.5 }, { x: 36, y: 66 }, { x: 22, y: 76 }] });
  b.enemies({ id: 'farm_warehouse', regionId: 'core.region.farm', archetypes: [{ id: 'core.enemy.sentry', weight: 2 }, { id: 'core.enemy.rusher', weight: 1 }], count: [1, 2], chance: 0.85, points: [{ x: 30, y: 62 }, { x: 36, y: 66 }, { x: 27, y: 58 }], patrol: [] });
  b.enemies({ id: 'meadow', regionId: 'core.region.farm', archetypes: [{ id: 'core.enemy.flanker', weight: 1 }, { id: 'core.enemy.sentry', weight: 2 }], count: [1, 2], chance: 0.75, points: [{ x: 14, y: 38 }, { x: 24, y: 32 }, { x: 30, y: 40 }], patrol: [{ x: 14, y: 38 }, { x: 30, y: 30 }, { x: 34, y: 44 }] });
  b.enemies({ id: 'canal_patrol', regionId: 'core.region.canal', archetypes: [{ id: 'core.enemy.flanker', weight: 2 }, { id: 'core.enemy.sentry', weight: 1 }], count: [2, 2], chance: 1, points: [{ x: 45, y: 30 }, { x: 55, y: 22 }, { x: 45, y: 45 }], patrol: [{ x: 45, y: 44 }, { x: 45, y: 26 }, { x: 55, y: 21 }, { x: 55, y: 44 }] });
  b.enemies({ id: 'pump_guard', regionId: 'core.region.canal', archetypes: [{ id: 'core.enemy.rusher', weight: 2 }, { id: 'core.enemy.sentry', weight: 1 }], count: [1, 1], chance: 0.8, points: [{ x: 60, y: 36 }, { x: 62, y: 39 }], patrol: [] });
  // Elites (minThreat 3) only join these groups once the raid threat reaches tier 3 there (world/threat.ts).
  b.enemies({ id: 'checkpoint_main', regionId: 'core.region.checkpoint', archetypes: [{ id: 'core.enemy.sentry', weight: 3 }, { id: 'core.enemy.rusher', weight: 1 }, { id: 'core.enemy.elite', weight: 1 }], count: [2, 3], chance: 1, points: [{ x: 82, y: 58.5 }, { x: 86, y: 62 }, { x: 75, y: 62 }, { x: 80, y: 68 }], patrol: [] });
  b.enemies({ id: 'checkpoint_tower', regionId: 'core.region.checkpoint', archetypes: [{ id: 'core.enemy.marksman', weight: 1 }], count: [1, 1], chance: 0.8, points: [{ x: 92.5, y: 57.5 }], patrol: [] });
  b.enemies({ id: 'road_patrol', regionId: 'core.region.checkpoint', archetypes: [{ id: 'core.enemy.flanker', weight: 1 }, { id: 'core.enemy.sentry', weight: 1 }], count: [1, 2], chance: 0.9, points: [{ x: 64, y: 76.5 }, { x: 88, y: 77 }], patrol: [{ x: 60, y: 76.6 }, { x: 90, y: 76.6 }] });
  b.enemies({ id: 'yard', regionId: 'core.region.industrial', archetypes: [{ id: 'core.enemy.sentry', weight: 2 }, { id: 'core.enemy.flanker', weight: 1 }, { id: 'core.enemy.marksman', weight: 1 }, { id: 'core.enemy.elite', weight: 1 }], count: [2, 3], chance: 1, points: [{ x: 76, y: 39 }, { x: 84, y: 44 }, { x: 70, y: 32.5 }, { x: 92, y: 37 }], patrol: [{ x: 68, y: 44 }, { x: 92, y: 44 }, { x: 92, y: 32 }, { x: 70, y: 32 }] });
  b.enemies({ id: 'hall', regionId: 'core.region.industrial', archetypes: [{ id: 'core.enemy.sentry', weight: 2 }, { id: 'core.enemy.rusher', weight: 1 }, { id: 'core.enemy.flanker', weight: 1 }, { id: 'core.enemy.elite', weight: 1 }], count: [2, 3], chance: 1, points: [{ x: 73, y: 20 }, { x: 87, y: 19 }, { x: 80, y: 28 }, { x: 69, y: 12 }], patrol: [{ x: 73, y: 27 }, { x: 90, y: 27 }] });
  b.enemies({ id: 'storage', regionId: 'core.region.industrial', archetypes: [{ id: 'core.enemy.sentry', weight: 2 }, { id: 'core.enemy.flanker', weight: 1 }], count: [1, 2], chance: 0.8, points: [{ x: 10, y: 10 }, { x: 24, y: 16 }, { x: 34, y: 10 }], patrol: [{ x: 6, y: 10 }, { x: 36, y: 10 }] });

  // ---------------------------------------------------------------- exits
  b.exit({ id: 'exit.west_drain', nameKey: 'exit.west_drain', x: 0, y: 40, w: 3, h: 6, condition: { type: 'free' } });
  b.exit({ id: 'exit.east_road', nameKey: 'exit.east_road', x: 93, y: 70, w: 3, h: 5, condition: { type: 'free' } });
  b.exit({ id: 'exit.checkpoint_barrier', nameKey: 'exit.checkpoint_barrier', x: 70, y: 93, w: 6, h: 3, condition: { type: 'fee', credits: 300, hintKey: 'exit.hint.fee' } });
  b.exit({ id: 'exit.freight_elevator', nameKey: 'exit.freight_elevator', x: 86, y: 1.2, w: 5, h: 3, condition: { type: 'flag', flag: 'power_restored', hintKey: 'exit.hint.power' } });

  // ---------------------------------------------------------------- spawns, events
  for (const [x, y] of [[8, 93], [18, 94.5], [28, 94], [40, 90], [62, 93]] as [number, number][]) b.spawn(x, y);
  b.spots('signal', [{ x: 20, y: 40 }, { x: 62, y: 60 }, { x: 46, y: 12 }, { x: 86, y: 88 }]);
  b.spots('signal_ambush', [{ x: 26, y: 30 }, { x: 14, y: 46 }, { x: 68, y: 56 }, { x: 56, y: 66 }, { x: 40, y: 8 }, { x: 52, y: 17 }, { x: 80, y: 84 }, { x: 92, y: 92 }]);
  for (const s of b.m.eventSpots['signal']!) b.container(`signal_${s.x}_${s.y}`, 'core.ct.flare_crate', s.x, s.y, 'core.loot.signal_rescue', { eventId: 'core.event.emergency_signal' });
  b.spots('convoy', [{ x: 60, y: 72.5 }, { x: 91, y: 72.5 }]);
  b.container('convoy_cart', 'core.ct.cart', 60, 72.5, 'core.loot.cart', { eventId: 'core.event.moving_supply' });
  b.poi('poi.farmhouse', 'poi.farmhouse', 12, 63, 5, 'area');
  b.poi('poi.checkpoint', 'poi.checkpoint', 84, 61, 6, 'area');
  b.poi('poi.factory', 'poi.factory', 78, 18, 8, 'area');

  // ---------------------------------------------------------------- procedural layer (world/procgen.ts)
  // Seeded per raid over this fixed layout: extra start points on the south / west / south-east edges, cover
  // clusters and loot caches in the open fields and yards, jittered enemy anchors and ground patches.
  b.m.procgen = {
    spawnZones: [
      { x: 3, y: 90.5, w: 63, h: 4.5 },
      { x: 0.8, y: 76, w: 2.8, h: 16 },
      { x: 56, y: 90.5, w: 12, h: 4.5 },
    ],
    spawnCount: [3, 5],
    clusterZones: [
      { rect: { x: 2, y: 73, w: 42, h: 16 }, theme: 'farm', count: [3, 5] },
      { rect: { x: 2, y: 23, w: 38, h: 27 }, theme: 'meadow', count: [3, 5] },
      { rect: { x: 56, y: 2, w: 10, h: 28 }, theme: 'canal', count: [1, 3] },
      { rect: { x: 56, y: 76, w: 39, h: 16 }, theme: 'checkpoint', count: [3, 5] },
      { rect: { x: 56, y: 50, w: 13, h: 19 }, theme: 'checkpoint', count: [1, 2] },
      { rect: { x: 67, y: 31, w: 28, h: 14 }, theme: 'yard', count: [2, 3] },
      { rect: { x: 2, y: 8, w: 38, h: 13 }, theme: 'rail', count: [2, 3] },
    ],
    cacheCount: [2, 4],
    patches: [
      { rect: { x: 0, y: 22, w: 42, h: 74 }, on: ['grass'], paint: ['grass_dry', 'dirt', 'mud'], count: [4, 7], radius: [1.5, 3.5] },
      { rect: { x: 56, y: 50, w: 40, h: 46 }, on: ['grass_dry'], paint: ['dirt', 'grass', 'gravel'], count: [3, 5], radius: [1.5, 3] },
      { rect: { x: 58, y: 0, w: 38, h: 46 }, on: ['gravel'], paint: ['dirt', 'concrete'], count: [2, 4], radius: [1.5, 2.5] },
      { rect: { x: 0, y: 0, w: 40, h: 22 }, on: ['grass_dry'], paint: ['dirt', 'gravel'], count: [2, 3], radius: [1.5, 3] },
    ],
    enemyJitter: 1,
  };
  b.m.ambience = 'wind';
  return b.build();
}
