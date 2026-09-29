import type { ContentPack } from './registry';
import type { RaidEventDef } from './types';
import { BUILDINGS, CHAPTER, CONTRACTS, FACILITIES, KEYS, MARKETS, NOTES, PERKS, progressionStrings, QUEST_LINES, QUESTS, RECIPES, TRADERS } from './progressionContent';
import { buildQuarantineMain } from './maps/quarantineMain';
import { buildOuterSupply } from './maps/outerSupply';
import { AUDIO_EVENTS, AUDIO_PALETTES, audioStrings } from './audioContent';
import { mapStrings } from './maps/mapStrings';

export const RAID_EVENTS: RaidEventDef[] = [
  { id: 'core.event.pump_restart', nameKey: 'event.pump.name', descKey: 'event.pump.desc', mapIds: ['core.map.quarantine_main'], chance: 0.55, weatherMult: { Storm: 1.5, Rain: 1.2 } },
  { id: 'core.event.emergency_signal', nameKey: 'event.signal.name', descKey: 'event.signal.desc', mapIds: ['core.map.quarantine_main', 'core.map.outer_supply_route'], chance: 0.5, weatherMult: { Storm: 0.8 } },
  { id: 'core.event.moving_supply', nameKey: 'event.convoy.name', descKey: 'event.convoy.desc', mapIds: ['core.map.outer_supply_route', 'core.map.quarantine_main'], chance: 0.45, weatherMult: { Storm: 0.6, Rain: 0.85 } },
];

/** Chapter 1 content beyond the combat core (maps, quests, economy, lore, audio). */
export function extraCorePack(): ContentPack {
  return {
    id: 'core.chapter1',
    version: '1.0.0',
    raidEvents: RAID_EVENTS,
    maps: [buildQuarantineMain(), buildOuterSupply()],
    chapters: [CHAPTER],
    questLines: QUEST_LINES,
    quests: QUESTS,
    traders: TRADERS,
    markets: MARKETS,
    perks: PERKS,
    buildings: BUILDINGS,
    facilities: FACILITIES,
    recipes: RECIPES,
    contracts: CONTRACTS,
    notes: NOTES,
    keys: KEYS,
    audioEvents: AUDIO_EVENTS,
    audioPalettes: AUDIO_PALETTES,
    strings: {
      ...progressionStrings,
      ...audioStrings,
      ...mapStrings,
      'event.pump.name': '정전된 펌프',
      'event.pump.desc': '수로의 배수 펌프를 60~90초 동안 재가동한다. 소음이 적을 부른다.',
      'event.signal.name': '비상 신호',
      'event.signal.desc': '어딘가에서 붉은 신호탄이 올랐다. 구조 물자일까, 함정일까.',
      'event.convoy.name': '이동 보급품',
      'event.convoy.desc': '호위를 붙인 보급 수레가 정해진 경로를 오간다.',
    },
  };
}
