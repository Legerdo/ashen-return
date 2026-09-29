import type { ExitDef, InteriorDef, RegionDef } from './types';

export interface ObstacleDef {
  id: string;
  profile: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z0: number;
  z1: number;
  floor: number;
  variant?: number;
  tags?: string[];
}

export interface DoorDef {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z1: number;
  profile: string;
  keyId: string | null;
  powerFlag: string | null;
  startOpen: boolean;
  floor: number;
}

export interface ContainerTypeDef {
  id: string;
  nameKey: string;
  gridW: number;
  gridH: number;
  sprite: string;
  /** Solid prop footprint (u) and height. */
  w: number;
  h: number;
  z1: number;
  obstacleProfile: string | null;
}

export interface ContainerSpawnDef {
  id: string;
  type: string;
  x: number;
  y: number;
  lootTable: string;
  keyId: string | null;
  /** Quest/story items that are always placed while the quest needs them (seed can never remove them). */
  questItems?: { questId: string; itemId: string; qty: number; unlessFlag?: string }[];
  /** Key item placed until its key is registered. */
  keyItem?: string;
  /** Only exists when a raid event spawns it. */
  eventId?: string;
  /** Guaranteed extra items (e.g. scrap piles). */
  guaranteed?: { itemId: string; qty: number }[];
}

export interface PoiDef {
  id: string;
  nameKey: string;
  x: number;
  y: number;
  radius: number;
  kind: 'landmark' | 'area' | 'objective';
}

export interface SpawnGroupDef {
  id: string;
  regionId: string;
  archetypes: { id: string; weight: number }[];
  count: [number, number];
  chance: number;
  points: { x: number; y: number }[];
  patrol: { x: number; y: number }[];
  requiresQuest?: string;
  requiresFlag?: string;
  unlessFlag?: string;
  boss?: boolean;
}

export type InteractableKind = 'note' | 'event' | 'station' | 'npc' | 'switch' | 'range';

export interface InteractableDef {
  id: string;
  kind: InteractableKind;
  x: number;
  y: number;
  radius: number;
  floor: number;
  noteId?: string;
  eventId?: string;
  stationId?: string;
  npcId?: string;
  tag?: string;
  labelKey: string;
}

export interface LightDef {
  x: number;
  y: number;
  radius: number;
  color: number;
}

export interface DecorDef {
  kind: string;
  x: number;
  y: number;
  variant: number;
}

export interface MapDef {
  id: string;
  nameKey: string;
  /** 'tutorial': the first-run controls course (raid rules in a training sim; never a deploy destination). */
  kind: 'raid' | 'base' | 'tutorial';
  width: number;
  height: number;
  groundPalette: string[];
  ground: number[];
  regions: RegionDef[];
  interiors: InteriorDef[];
  obstacles: ObstacleDef[];
  doors: DoorDef[];
  containers: ContainerSpawnDef[];
  pois: PoiDef[];
  playerSpawns: { x: number; y: number }[];
  enemyGroups: SpawnGroupDef[];
  exits: ExitDef[];
  interactables: InteractableDef[];
  lights: LightDef[];
  decor: DecorDef[];
  eventSpots: Record<string, { x: number; y: number }[]>;
  ambience: string;
  /** Build-zone rect for base construction (base maps only). */
  buildZone?: { x: number; y: number; w: number; h: number; reserved: { x: number; y: number; w: number; h: number }[]; anchors: { x: number; y: number }[] };
  /** Shooting range targets (base maps only). */
  rangeTargets?: RangeTargetDef[];
  /** Training turret positions (base Q05 drill). */
  turrets?: { id: string; x: number; y: number; zone: { x: number; y: number; w: number; h: number } }[];
  npcSpots?: { npcId: string; x: number; y: number }[];
  /** Optional procedural layer over the authored layout (raid maps; see world/procgen.ts). */
  procgen?: ProcgenDef;
}

export interface MapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Style of a procedural cover / ruin cluster (which props it is built from). */
export type ProcTheme = 'farm' | 'meadow' | 'canal' | 'checkpoint' | 'yard' | 'rail' | 'forest' | 'freight';

/**
 * Seeded variation drawn over an authored raid map. The authored structure (buildings, roads, water, doors, exits,
 * quest / key containers, boss arena) never changes; each raid seed adds start points, cover clusters, loot caches,
 * extra enemy anchors and ground patches in the listed open areas.
 */
export interface ProcgenDef {
  /** Extra player start candidates are drawn inside these edge zones. */
  spawnZones: MapRect[];
  spawnCount: [number, number];
  /** Cover / ruin clusters: where, in which style, how many. */
  clusterZones: { rect: MapRect; theme: ProcTheme; count: [number, number] }[];
  /** Extra loot caches (a container behind a little cover) spread over the cluster zones. */
  cacheCount: [number, number];
  /** Ground variation: `on` grounds inside `rect` repainted with one of `paint` in round patches. */
  patches: { rect: MapRect; on: string[]; paint: string[]; count: [number, number]; radius: [number, number] }[];
  /** Extra jittered enemy anchor points per authored (non-boss) point. */
  enemyJitter: number;
}

export interface RangeTargetDef {
  id: string;
  x: number;
  y: number;
  crouched: boolean;
  track: { x0: number; x1: number; speed: number } | null;
  /** 'preset' uses the terminal-selected armor, 'none' is always unarmored. */
  armor: 'preset' | 'none';
  labelKey: string;
}

/** Ground tile semantics. */
export interface GroundDef {
  id: string;
  moveMult: number;
  noiseMult: number;
  footstep: string;
  color: number;
}
