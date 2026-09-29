import type { MapDef } from '../mapTypes';
import { MapBuilder } from './builder';

/** Q05 drill spots (shelter POIs): the turret zone behind the high wall, and the shooter spot behind the low cover. */
export const Q05_ZONE_POI = 'poi.q05_zone';
export const Q05_LOW_POI = 'poi.q05_low';

/**
 * 지하 대피소 (shelter hub) — 64×34u. North: living hall with NPCs and stations. South-west: construction zone.
 * South-east: ShootingRange2D (targets at 2/5/10/20/35u, moving/crouched targets, armor presets, materials,
 * overlapping targets, Q05 drill with a high wall and a low barricade).
 */
export function buildShelter(): MapDef {
  const b = new MapBuilder('core.map.shelter', 'map.shelter.name', 'base', 64, 34, 'concrete');
  const W = 'core.ob.wall_concrete';
  // Floors
  b.ground(1, 1, 62, 12, 'wood_floor');
  b.ground(1, 14, 20, 19, 'concrete');
  b.ground(22, 14, 41, 19, 'gravel');
  b.ground(22, 14, 4, 19, 'concrete');
  // Outer walls (north entrance gap at x 30–34 is the deploy stairwell).
  b.wallH(0, 64, 0, 1, W, 3, [[30, 34]]);
  b.wallH(0, 64, 33, 1, W, 3);
  b.wallV(0, 1, 33, 1, W, 3);
  b.wallV(63, 1, 33, 1, W, 3);
  b.box(W, 29, -1, 30, 1, 3);
  b.box(W, 34, -1, 35, 1, 3);
  // Separator between hall and lower wing with openings to the build zone and range.
  b.wallH(1, 63, 13, 1, W, 3, [[6, 10], [26, 34]]);
  b.wallV(21, 14, 33, 1, W, 3, [[15, 18]]);
  // Generator room (east of hall).
  b.wallV(51, 1, 13, 0.6, W, 3, [[8, 10]]);
  b.box('core.ob.machine', 55.5, 4.5, 59, 7.5, 1.6, { id: 'prop:generator' });
  // Hall furniture / stations.
  b.box('core.ob.counter', 5, 3, 11, 3.8, 0.95, { id: 'prop:mech_bench' });
  b.box('core.ob.shelf', 1.2, 1.2, 4, 1.8, 2.0);
  b.box('core.ob.counter', 15, 3, 21, 3.8, 0.95, { id: 'prop:med_cot' });
  b.box('core.ob.shelf', 22, 1.2, 25, 1.8, 2.0);
  b.box('core.ob.crate_metal', 25.4, 2.6, 27.4, 3.6, 1.0, { id: 'prop:stash' });
  b.box('core.ob.counter', 43, 3, 49, 3.8, 0.95, { id: 'prop:comms_desk' });
  b.box('core.ob.shelf', 37, 1.2, 40, 1.8, 2.0, { id: 'prop:board' });
  b.box('core.ob.shelf', 12, 10.8, 14, 11.6, 1.8, { id: 'prop:archive' });
  b.interact({ id: 'st.deploy', kind: 'station', x: 32, y: 1.6, radius: 1.2, stationId: 'deploy', labelKey: 'station.deploy' });
  b.interact({ id: 'st.stash', kind: 'station', x: 26.4, y: 4.1, radius: 0.7, stationId: 'stash', labelKey: 'station.stash' });
  b.interact({ id: 'st.workbench', kind: 'station', x: 9.5, y: 4.3, radius: 0.7, stationId: 'workbench', labelKey: 'station.workbench' });
  b.interact({ id: 'st.medical', kind: 'station', x: 19.5, y: 4.3, radius: 0.7, stationId: 'medical', labelKey: 'station.medical' });
  b.interact({ id: 'st.board', kind: 'station', x: 38.5, y: 2.4, radius: 0.8, stationId: 'board', labelKey: 'station.board' });
  b.interact({ id: 'st.market', kind: 'station', x: 48, y: 4.3, radius: 0.7, stationId: 'market', labelKey: 'station.market' });
  b.interact({ id: 'st.archive', kind: 'station', x: 13, y: 12.1, radius: 0.7, stationId: 'archive', labelKey: 'station.archive' });
  b.interact({ id: 'st.generator', kind: 'station', x: 57.2, y: 8.2, radius: 0.8, stationId: 'generator', labelKey: 'station.generator' });
  b.interact({ id: 'st.build', kind: 'station', x: 3.5, y: 15.2, radius: 0.7, stationId: 'build', labelKey: 'station.build' });
  b.box('core.ob.counter', 2.6, 14.1, 4.4, 14.6, 1.0, { id: 'prop:build_terminal' });
  // NPCs (actors stand behind their counters; interactables sit in front).
  b.m.npcSpots = [
    { npcId: 'core.npc.mechanic', x: 7.5, y: 2.4 },
    { npcId: 'core.npc.medic', x: 17.5, y: 2.4 },
    { npcId: 'core.npc.comms', x: 45.5, y: 2.4 },
  ];
  b.interact({ id: 'npc.mechanic', kind: 'npc', x: 7.5, y: 4.3, radius: 0.7, npcId: 'core.npc.mechanic', labelKey: 'npc.mechanic.talk' });
  b.interact({ id: 'npc.medic', kind: 'npc', x: 17.5, y: 4.3, radius: 0.7, npcId: 'core.npc.medic', labelKey: 'npc.medic.talk' });
  b.interact({ id: 'npc.comms', kind: 'npc', x: 45.5, y: 4.3, radius: 0.7, npcId: 'core.npc.comms', labelKey: 'npc.comms.talk' });
  b.light(8, 6, 7, 0xffd08a);
  b.light(18, 6, 7, 0xffe6c0);
  b.light(32, 6, 8, 0xffd08a);
  b.light(46, 6, 7, 0xa8d8ff);
  b.light(57, 7, 6, 0xffb070);
  b.light(12, 24, 9, 0xffe0b0);
  b.light(42, 24, 14, 0xfff0d0);
  // Construction zone (build grid 1u cells).
  b.m.buildZone = {
    x: 2,
    y: 15,
    w: 18,
    h: 17,
    reserved: [
      { x: 5, y: 14, w: 6, h: 3 },
      { x: 2, y: 14, w: 3, h: 3 },
    ],
    anchors: [
      { x: 8, y: 15.5 },
      { x: 3.5, y: 16.2 },
      { x: 20.5, y: 16.5 },
    ],
  };
  b.decor('grid', 2, 15, 0);
  // --- ShootingRange2D ---------------------------------------------------------------------------------
  // Shooter line at x = 24. Row A (y 17): distance targets 2/5/10/20/35u with terminal armor preset.
  const sx = 24;
  const dists = [2, 5, 10, 20, 35];
  dists.forEach((d, i) => b.rangeTarget({ id: `a${d}`, x: sx + d, y: 17, crouched: false, track: null, armor: 'preset', labelKey: `range.target.dist${i}` }));
  // Row B (y 20.2): low barricade (top 1.15u) right in front of the shooter spot for the low-cover drill.
  b.box('core.ob.sandbag', 25.0, 19.5, 25.5, 21.0, 1.15, { id: 'range:low_cover' });
  b.rangeTarget({ id: 'b_low', x: 30, y: 20.2, crouched: false, track: null, armor: 'none', labelKey: 'range.target.low' });
  b.rangeTarget({ id: 'b_crouch', x: 34, y: 20.2, crouched: true, track: null, armor: 'preset', labelKey: 'range.target.crouch' });
  // Row C (y 23): moving target at ~20u.
  b.rangeTarget({ id: 'c_move', x: 42, y: 23, crouched: false, track: { x0: 40, x1: 48, speed: 1.6 }, armor: 'preset', labelKey: 'range.target.moving' });
  // Row D (y 26): materials — glass, wood, steel plate, bush — each with a target behind.
  b.box('core.ob.glass', 29.9, 25.2, 30.1, 26.8, 2.0, { id: 'range:glass' });
  b.rangeTarget({ id: 'd_glass', x: 31.5, y: 26, crouched: false, track: null, armor: 'none', labelKey: 'range.target.glass' });
  b.box('core.ob.wall_wood', 34.9, 25.2, 35.1, 26.8, 2.2, { id: 'range:wood' });
  b.rangeTarget({ id: 'd_wood', x: 36.5, y: 26, crouched: false, track: null, armor: 'none', labelKey: 'range.target.wood' });
  b.box('core.ob.steel_plate', 39.9, 25.2, 40.1, 26.8, 2.0, { id: 'range:steel' });
  b.rangeTarget({ id: 'd_steel', x: 41.5, y: 26, crouched: false, track: null, armor: 'none', labelKey: 'range.target.steel' });
  b.bush(44.5, 25.1, 2.2, 1.8);
  b.rangeTarget({ id: 'd_bush', x: 48, y: 26, crouched: false, track: null, armor: 'none', labelKey: 'range.target.bush' });
  // Row E (y 29): two overlapping targets on the same line of fire.
  b.rangeTarget({ id: 'e_front', x: 38, y: 29, crouched: false, track: null, armor: 'none', labelKey: 'range.target.front' });
  b.rangeTarget({ id: 'e_back', x: 39.2, y: 29, crouched: false, track: null, armor: 'none', labelKey: 'range.target.back' });
  // High concrete wall (3u) — blocks everything.
  b.box(W, 50, 28.2, 50.6, 31.8, 3.0, { id: 'range:high_wall' });
  b.rangeTarget({ id: 'e_hidden', x: 52, y: 30, crouched: false, track: null, armor: 'none', labelKey: 'range.target.hidden' });
  // Q05 drill corner: the turret fires harmless training rounds at anyone inside the marked zone (drawn on the floor);
  // the whole zone lies in the high wall's shadow, so standing in it lets the wall block them.
  // The wall reaches past the zone's north edge and meets the south wall, so no spot in the zone is exposed.
  b.box(W, 27.0, 29.2, 27.6, 33.0, 3.0, { id: 'range:q05_wall', tags: ['q05_wall'] });
  b.m.turrets = [{ id: 'q05', x: 33.5, y: 31.5, zone: { x: 22, y: 29.6, w: 5, h: 3.4 } }];
  b.box('core.ob.machine', 33.1, 31.1, 33.9, 31.9, 1.2, { id: 'prop:turret' });
  b.poi(Q05_ZONE_POI, 'poi.q05_zone', 24.5, 31.3, 1.6, 'objective');
  // Q05 low-cover drill: stand right behind the low sandbag in front of the shooter line (muzzle rises over it).
  b.poi(Q05_LOW_POI, 'poi.q05_low', 24.5, 20.2, 0.8, 'objective');
  b.interact({ id: 'range.rack', kind: 'range', x: 23, y: 15.3, radius: 0.6, stationId: 'range_rack', labelKey: 'station.range_rack' });
  b.interact({ id: 'range.terminal', kind: 'range', x: 25.5, y: 15.3, radius: 0.6, stationId: 'range_terminal', labelKey: 'station.range_terminal' });
  b.box('core.ob.counter', 22.3, 14.1, 26.3, 14.6, 1.0, { id: 'prop:range_desk' });
  b.poi('poi.range', 'poi.range', 24, 20, 2.5, 'objective');
  b.region({ id: 'core.region.range', nameKey: 'region.range', rects: [{ x: 22, y: 14, w: 41, h: 19 }], ambience: 'shelter', lootTier: 0 });
  b.region({ id: 'core.region.shelter', nameKey: 'region.shelter', rects: [{ x: 0, y: 0, w: 64, h: 34 }], ambience: 'shelter', lootTier: 0 });
  b.spawn(32, 5);
  b.m.ambience = 'shelter';
  return b.build();
}
