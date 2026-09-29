import type { HitboxProfile, ObstacleProfile } from './types';

/**
 * Hit volumes are vertical cylinders around the actor's ground position. Decorative feathers, beak, weapon,
 * backpack and transparent sprite margins are intentionally outside every volume.
 * Standing heights are the spec's initial values: body 0.35 <= z < 1.40, head 1.40 <= z <= 1.80.
 */
export const HITBOX_PROFILES: HitboxProfile[] = [
  {
    id: 'core.hitbox.standing',
    volumes: [
      { part: 'head', z0: 1.4, z1: 1.8, radius: 0.24, forward: 0.04 },
      { part: 'body', z0: 0.35, z1: 1.4, radius: 0.3, forward: 0 },
      { part: 'limb', z0: 0.0, z1: 0.35, radius: 0.22, forward: 0 },
    ],
    eyeZ: 1.62,
    muzzleZ: 1.0,
    anchorZ: 1.25,
    height: 1.8,
  },
  {
    id: 'core.hitbox.crouched',
    volumes: [
      { part: 'head', z0: 0.85, z1: 1.15, radius: 0.24, forward: 0.06 },
      { part: 'body', z0: 0.25, z1: 0.85, radius: 0.32, forward: 0 },
      { part: 'limb', z0: 0.0, z1: 0.25, radius: 0.24, forward: 0 },
    ],
    eyeZ: 1.0,
    muzzleZ: 0.8,
    anchorZ: 0.9,
    height: 1.15,
  },
  {
    id: 'core.hitbox.large',
    volumes: [
      { part: 'head', z0: 1.4, z1: 1.8, radius: 0.27, forward: 0.04 },
      { part: 'body', z0: 0.35, z1: 1.4, radius: 0.35, forward: 0 },
      { part: 'limb', z0: 0.0, z1: 0.35, radius: 0.25, forward: 0 },
    ],
    eyeZ: 1.64,
    muzzleZ: 1.05,
    anchorZ: 1.28,
    height: 1.8,
  },
];

/** Material resistance TUNABLE: glass 10, wood 50, metal 250, concrete 1000. */
export const MATERIAL_RESISTANCE = { glass: 10, wood: 50, metal: 250, concrete: 1000, brick: 700, sandbag: 400, dirt: 300, vegetation: 0, fabric: 5, flesh: Infinity, water: Infinity } as const;

function ob(p: Partial<ObstacleProfile> & Pick<ObstacleProfile, 'id' | 'material' | 'render'>): ObstacleProfile {
  return {
    blocksMovement: true,
    blocksProjectile: true,
    blocksVision: true,
    blocksSound: true,
    penetrationResistance: MATERIAL_RESISTANCE[p.material],
    destructible: false,
    ...p,
  };
}

export const OBSTACLE_PROFILES: ObstacleProfile[] = [
  ob({ id: 'core.ob.wall_concrete', material: 'concrete', render: 'wall_concrete' }),
  ob({ id: 'core.ob.wall_brick', material: 'brick', render: 'wall_brick' }),
  ob({ id: 'core.ob.wall_wood', material: 'wood', render: 'wall_wood', blocksSound: false }),
  ob({ id: 'core.ob.wall_metal', material: 'metal', render: 'wall_metal', blocksSound: false }),
  ob({ id: 'core.ob.glass', material: 'glass', render: 'glass', blocksVision: false, blocksSound: false }),
  ob({ id: 'core.ob.fence_chain', material: 'metal', render: 'fence_chain', blocksProjectile: false, blocksVision: false, blocksSound: false }),
  ob({ id: 'core.ob.fence_wood', material: 'wood', render: 'fence_wood', blocksVision: false, blocksSound: false }),
  ob({ id: 'core.ob.sandbag', material: 'sandbag', render: 'sandbag', blocksSound: false }),
  ob({ id: 'core.ob.barrier', material: 'concrete', render: 'barrier', blocksSound: false }),
  ob({ id: 'core.ob.crate_wood', material: 'wood', render: 'crate_wood', penetrationResistance: 60, destructible: true, hp: 160, blocksSound: false }),
  ob({ id: 'core.ob.crate_metal', material: 'metal', render: 'crate_metal', blocksSound: false }),
  ob({ id: 'core.ob.car', material: 'metal', render: 'car', blocksSound: false }),
  ob({ id: 'core.ob.tree', material: 'wood', render: 'tree', penetrationResistance: 150, blocksSound: false }),
  ob({ id: 'core.ob.pine', material: 'wood', render: 'pine', penetrationResistance: 150, blocksSound: false }),
  ob({ id: 'core.ob.bush', material: 'vegetation', render: 'bush', blocksMovement: false, blocksProjectile: false, blocksVision: true, blocksSound: false, foliage: 0.9, moveMult: 0.8 }),
  ob({ id: 'core.ob.reeds', material: 'vegetation', render: 'reeds', blocksMovement: false, blocksProjectile: false, blocksVision: true, blocksSound: false, foliage: 1.0, moveMult: 0.75 }),
  ob({ id: 'core.ob.crops', material: 'vegetation', render: 'crops', blocksMovement: false, blocksProjectile: false, blocksVision: true, blocksSound: false, foliage: 0.6, moveMult: 0.85 }),
  ob({ id: 'core.ob.machine', material: 'metal', render: 'machine', blocksSound: false }),
  ob({ id: 'core.ob.pillar', material: 'concrete', render: 'pillar' }),
  ob({ id: 'core.ob.shelf', material: 'wood', render: 'shelf', blocksSound: false }),
  ob({ id: 'core.ob.counter', material: 'wood', render: 'counter', blocksSound: false }),
  ob({ id: 'core.ob.water_deep', material: 'water', render: 'none', blocksProjectile: false, blocksVision: false, blocksSound: false }),
  ob({ id: 'core.ob.container', material: 'metal', render: 'container' }),
  ob({ id: 'core.ob.hay', material: 'dirt', render: 'hay', destructible: true, hp: 220, blocksSound: false }),
  ob({ id: 'core.ob.steel_plate', material: 'metal', render: 'steel_plate', blocksSound: false }),
  ob({ id: 'core.ob.railcar', material: 'metal', render: 'railcar' }),
  ob({ id: 'core.ob.tank_leg', material: 'metal', render: 'tank_leg', blocksVision: false, blocksSound: false }),
  ob({ id: 'core.ob.bounds', material: 'concrete', render: 'none' }),
  ob({ id: 'core.ob.tent', material: 'fabric', render: 'tent', blocksProjectile: false, blocksSound: false }),
  ob({ id: 'core.ob.door_wood', material: 'wood', render: 'door_wood', blocksSound: false }),
  ob({ id: 'core.ob.door_metal', material: 'metal', render: 'door_metal' }),
  ob({ id: 'core.ob.building', material: 'concrete', render: 'building' }),
];
