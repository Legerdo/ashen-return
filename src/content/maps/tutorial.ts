import type { MapDef } from '../mapTypes';
import { MapBuilder } from './builder';

export const TUTORIAL_MAP_ID = 'core.map.tutorial';
export const TUTORIAL_DOOR = 'tut.door';
/** Map container id (the sim container is `ct:<id>`). */
export const TUTORIAL_CRATE = 'tut_crate';
export const TUTORIAL_EXIT = 'exit.tutorial';
/** Throw practice spot (ground patch in the yard). */
export const TUTORIAL_THROW_SPOT = { x: 40, y: 16 } as const;
/** First waypoint of the movement lesson. */
export const TUTORIAL_MOVE_SPOT = { x: 9, y: 16 } as const;

/**
 * 기초 훈련 (first-run controls course) — 56×22u, west → east:
 *   room A (spawn; move / sprint / dodge roll / crouch behind a sandbag wall) → wooden door (E) → supply room (crate: search,
 *   take all, inventory) → yard (targets at 6u / 19u for fire + ADS, a close target for melee, a throw spot) →
 *   free exit pad (hold 5 s). Runs under raid rules in a training sim (no stamina drain, unlimited reload reserve).
 */
export function buildTutorial(): MapDef {
  const b = new MapBuilder(TUTORIAL_MAP_ID, 'map.tutorial.name', 'tutorial', 56, 22, 'concrete');
  const W = 'core.ob.wall_concrete';
  b.ground(1, 1, 13, 20, 'wood_floor');
  b.ground(15, 1, 10, 20, 'tile');
  b.ground(26, 1, 29, 20, 'gravel');
  b.ground(49, 13, 6, 8, 'asphalt');
  b.groundCircle(TUTORIAL_THROW_SPOT.x, TUTORIAL_THROW_SPOT.y, 1.6, 'dirt');
  // Outer walls.
  b.wallH(0, 56, 0, 1, W, 3);
  b.wallH(0, 56, 21, 1, W, 3);
  b.wallV(0, 1, 21, 1, W, 3);
  b.wallV(55, 1, 21, 1, W, 3);
  // Room A | supply room: a wooden door to open with E.
  b.wallV(14, 1, 21, 1, W, 3, [[9.5, 12.5]]);
  b.door(TUTORIAL_DOOR, 14.4, 9.5, 14.6, 12.5, 'core.ob.door_wood', 2.3);
  // Supply room | yard: a wide opening.
  b.wallV(25, 1, 21, 1, W, 3, [[4, 18]]);
  // Room A props: a low sandbag wall to crouch behind, shelves.
  b.box('core.ob.sandbag', 7.5, 7.2, 11.5, 7.8, 1.15, { id: 'tut:sandbag' });
  b.box('core.ob.shelf', 1.2, 1.2, 4, 1.8, 2.0);
  b.box('core.ob.shelf', 1.2, 19.2, 4, 19.8, 2.0);
  // Supply room: the crate holds exactly what the later lessons need (bandages for healing, a smoke grenade).
  b.container(TUTORIAL_CRATE, 'core.ct.supply', 20, 6, 'core.loot.tutorial', {
    guaranteed: [
      { itemId: 'core.med.bandage', qty: 2 },
      { itemId: 'core.throw.smoke', qty: 1 },
    ],
  });
  b.box('core.ob.shelf', 22, 19.2, 24.6, 19.8, 2.0);
  // Yard: shooting bench, a near and a far target (fire, then aimed fire), a close target for melee.
  b.box('core.ob.counter', 27.3, 4.5, 27.9, 8.5, 1.0, { id: 'tut:bench' });
  b.rangeTarget({ id: 'near', x: 34, y: 6.5, crouched: false, track: null, armor: 'none', labelKey: 'tutorial.target.near' });
  b.rangeTarget({ id: 'far', x: 47, y: 5.5, crouched: false, track: null, armor: 'none', labelKey: 'tutorial.target.far' });
  b.rangeTarget({ id: 'melee', x: 31, y: 15, crouched: false, track: null, armor: 'none', labelKey: 'tutorial.target.melee' });
  b.box('core.ob.sandbag', 43.5, 12.6, 46.5, 13.2, 1.15, { id: 'tut:yard_cover' });
  b.exit({ id: TUTORIAL_EXIT, nameKey: 'exit.tutorial', x: 50, y: 14, w: 4, h: 6, condition: { type: 'free' } });
  b.light(7, 10, 8, 0xffd08a);
  b.light(20, 10, 8, 0xffe6c0);
  b.light(36, 10, 12, 0xfff0d0);
  b.light(52, 17, 6, 0xb0ffc0);
  b.region({ id: 'core.region.tutorial', nameKey: 'region.tutorial', rects: [{ x: 0, y: 0, w: 56, h: 22 }], ambience: 'shelter', lootTier: 0 });
  b.spawn(5, 11);
  b.m.ambience = 'shelter';
  return b.build();
}
