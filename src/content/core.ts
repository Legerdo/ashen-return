import { HITBOX_PROFILES, OBSTACLE_PROFILES } from './combatProfiles';
import { CONTAINER_TYPES, containerStrings } from './containerTypes';
import { ENEMIES, NPCS } from './enemies';
import { GROUNDS } from './grounds';
import { ALL_ITEMS, itemStrings } from './items';
import { LOOT_TABLES } from './loot';
import { buildShelter } from './maps/shelter';
import { buildTutorial } from './maps/tutorial';
import { ContentRegistry, type ContentPack } from './registry';
import { DESTINATIONS, TIME_PHASES, WEATHERS } from './world';
import { KO_UI } from '../ui/i18n/ko';
import { extraCorePack } from './corePack2';

export const CONTENT_VERSION = 'core-1.0.0';

export function buildCorePack(): ContentPack {
  return {
    id: 'core',
    version: CONTENT_VERSION,
    items: ALL_ITEMS,
    hitboxes: HITBOX_PROFILES,
    obstacles: OBSTACLE_PROFILES,
    grounds: GROUNDS,
    containerTypes: CONTAINER_TYPES,
    enemies: ENEMIES,
    npcs: NPCS,
    lootTables: LOOT_TABLES,
    maps: [buildShelter(), buildTutorial()],
    destinations: DESTINATIONS,
    weather: WEATHERS,
    timePhases: TIME_PHASES,
    strings: { ...KO_UI, ...itemStrings, ...containerStrings },
  };
}

let cached: ContentRegistry | null = null;

/** Build (or reuse) the registry with the core packs plus optional extension packs. */
export function createContent(extra: ContentPack[] = []): ContentRegistry {
  if (extra.length === 0 && cached) return cached;
  const reg = new ContentRegistry();
  reg.register(buildCorePack());
  reg.register(extraCorePack());
  for (const p of extra) reg.register(p);
  if (extra.length === 0) cached = reg;
  return reg;
}
