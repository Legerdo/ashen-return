import type { ContainerTypeDef, GroundDef, MapDef } from './mapTypes';
import type {
  AudioEventDef,
  AudioPaletteDef,
  BuildingDef,
  ChapterDef,
  ContractTemplateDef,
  EnemyArchetypeDef,
  FacilityDef,
  HitboxProfile,
  ItemDef,
  KeyDef,
  LootTableDef,
  MarketDef,
  NoteDef,
  NpcDef,
  ObstacleProfile,
  PerkDef,
  QuestDef,
  QuestLineDef,
  RaidEventDef,
  RecipeDef,
  TimePhase,
  TimePhaseDef,
  TraderDef,
  TravelDestinationDef,
  Weather,
  WeatherDef,
} from './types';

/** A content pack is pure data. New weapons / regions / perks / buildings are added by registering a pack. */
export interface ContentPack {
  id: string;
  version: string;
  items?: ItemDef[];
  hitboxes?: HitboxProfile[];
  obstacles?: ObstacleProfile[];
  grounds?: GroundDef[];
  containerTypes?: ContainerTypeDef[];
  enemies?: EnemyArchetypeDef[];
  lootTables?: LootTableDef[];
  maps?: MapDef[];
  destinations?: TravelDestinationDef[];
  weather?: WeatherDef[];
  timePhases?: TimePhaseDef[];
  chapters?: ChapterDef[];
  questLines?: QuestLineDef[];
  quests?: QuestDef[];
  contracts?: ContractTemplateDef[];
  raidEvents?: RaidEventDef[];
  perks?: PerkDef[];
  buildings?: BuildingDef[];
  facilities?: FacilityDef[];
  traders?: TraderDef[];
  markets?: MarketDef[];
  recipes?: RecipeDef[];
  notes?: NoteDef[];
  keys?: KeyDef[];
  npcs?: NpcDef[];
  audioEvents?: AudioEventDef[];
  audioPalettes?: AudioPaletteDef[];
  strings?: Record<string, string>;
  /** Region packs may append obstacles/containers to an existing map by id. */
  mapPatches?: { mapId: string; apply: (m: MapDef) => void }[];
}

type Table<T extends { id: string }> = Map<string, T>;

export class ContentRegistry {
  readonly packs: string[] = [];
  readonly items: Table<ItemDef> = new Map();
  readonly hitboxes: Table<HitboxProfile> = new Map();
  readonly obstacleProfiles: Table<ObstacleProfile> = new Map();
  readonly grounds: Table<GroundDef> = new Map();
  readonly containerTypes: Table<ContainerTypeDef> = new Map();
  readonly enemies: Table<EnemyArchetypeDef> = new Map();
  readonly lootTables: Table<LootTableDef> = new Map();
  readonly maps: Table<MapDef> = new Map();
  readonly destinations: Table<TravelDestinationDef> = new Map();
  readonly weathers = new Map<Weather, WeatherDef>();
  readonly timePhases = new Map<TimePhase, TimePhaseDef>();
  readonly chapters: Table<ChapterDef> = new Map();
  readonly questLines: Table<QuestLineDef> = new Map();
  readonly quests: Table<QuestDef> = new Map();
  readonly contracts: Table<ContractTemplateDef> = new Map();
  readonly raidEvents: Table<RaidEventDef> = new Map();
  readonly perks: Table<PerkDef> = new Map();
  readonly buildings: Table<BuildingDef> = new Map();
  readonly facilities: Table<FacilityDef> = new Map();
  readonly traders: Table<TraderDef> = new Map();
  readonly markets: Table<MarketDef> = new Map();
  readonly recipes: Table<RecipeDef> = new Map();
  readonly notes: Table<NoteDef> = new Map();
  readonly keys: Table<KeyDef> = new Map();
  readonly npcs: Table<NpcDef> = new Map();
  readonly audioEvents: Table<AudioEventDef> = new Map();
  readonly audioPalettes: Table<AudioPaletteDef> = new Map();
  readonly strings = new Map<string, string>();
  readonly duplicates: string[] = [];

  register(pack: ContentPack): void {
    this.packs.push(`${pack.id}@${pack.version}`);
    const put = <T extends { id: string }>(table: Map<string, T>, list: T[] | undefined, kind: string) => {
      for (const d of list ?? []) {
        if (table.has(d.id)) this.duplicates.push(`${kind}:${d.id}`);
        table.set(d.id, d);
      }
    };
    put(this.items, pack.items, 'item');
    put(this.hitboxes, pack.hitboxes, 'hitbox');
    put(this.obstacleProfiles, pack.obstacles, 'obstacle');
    put(this.grounds, pack.grounds, 'ground');
    put(this.containerTypes, pack.containerTypes, 'containerType');
    put(this.enemies, pack.enemies, 'enemy');
    put(this.lootTables, pack.lootTables, 'loot');
    put(this.maps, pack.maps, 'map');
    put(this.destinations, pack.destinations, 'destination');
    for (const w of pack.weather ?? []) this.weathers.set(w.id, w);
    for (const t of pack.timePhases ?? []) this.timePhases.set(t.id, t);
    put(this.chapters, pack.chapters, 'chapter');
    put(this.questLines, pack.questLines, 'questLine');
    put(this.quests, pack.quests, 'quest');
    put(this.contracts, pack.contracts, 'contract');
    put(this.raidEvents, pack.raidEvents, 'raidEvent');
    put(this.perks, pack.perks, 'perk');
    put(this.buildings, pack.buildings, 'building');
    put(this.facilities, pack.facilities, 'facility');
    put(this.traders, pack.traders, 'trader');
    put(this.markets, pack.markets, 'market');
    put(this.recipes, pack.recipes, 'recipe');
    put(this.notes, pack.notes, 'note');
    put(this.keys, pack.keys, 'key');
    put(this.npcs, pack.npcs, 'npc');
    put(this.audioEvents, pack.audioEvents, 'audio');
    put(this.audioPalettes, pack.audioPalettes, 'audioPalette');
    for (const [k, v] of Object.entries(pack.strings ?? {})) {
      if (this.strings.has(k) && this.strings.get(k) !== v) this.duplicates.push(`string:${k}`);
      this.strings.set(k, v);
    }
    for (const patch of pack.mapPatches ?? []) {
      const m = this.maps.get(patch.mapId);
      if (m) patch.apply(m);
      else this.duplicates.push(`mapPatch:missing:${patch.mapId}`);
    }
  }

  private req<T>(table: Map<string, T>, id: string, kind: string): T {
    const v = table.get(id);
    if (!v) throw new Error(`unknown ${kind}: ${id}`);
    return v;
  }

  item(id: string): ItemDef {
    return this.req(this.items, id, 'item');
  }
  hasItem(id: string): boolean {
    return this.items.has(id);
  }
  hitbox(id: string): HitboxProfile {
    return this.req(this.hitboxes, id, 'hitbox');
  }
  obstacleProfile(id: string): ObstacleProfile {
    return this.req(this.obstacleProfiles, id, 'obstacle profile');
  }
  ground(id: string): GroundDef {
    return this.req(this.grounds, id, 'ground');
  }
  containerType(id: string): ContainerTypeDef {
    return this.req(this.containerTypes, id, 'container type');
  }
  enemy(id: string): EnemyArchetypeDef {
    return this.req(this.enemies, id, 'enemy');
  }
  loot(id: string): LootTableDef {
    return this.req(this.lootTables, id, 'loot table');
  }
  map(id: string): MapDef {
    return this.req(this.maps, id, 'map');
  }
  destination(id: string): TravelDestinationDef {
    return this.req(this.destinations, id, 'destination');
  }
  weather(id: Weather): WeatherDef {
    const w = this.weathers.get(id);
    if (!w) throw new Error(`unknown weather ${id}`);
    return w;
  }
  timePhase(id: TimePhase): TimePhaseDef {
    const t = this.timePhases.get(id);
    if (!t) throw new Error(`unknown time phase ${id}`);
    return t;
  }
  quest(id: string): QuestDef {
    return this.req(this.quests, id, 'quest');
  }
  perk(id: string): PerkDef {
    return this.req(this.perks, id, 'perk');
  }
  building(id: string): BuildingDef {
    return this.req(this.buildings, id, 'building');
  }
  facility(id: string): FacilityDef {
    return this.req(this.facilities, id, 'facility');
  }
  trader(id: string): TraderDef {
    return this.req(this.traders, id, 'trader');
  }
  recipe(id: string): RecipeDef {
    return this.req(this.recipes, id, 'recipe');
  }
  note(id: string): NoteDef {
    return this.req(this.notes, id, 'note');
  }
  key(id: string): KeyDef {
    return this.req(this.keys, id, 'key');
  }
  npc(id: string): NpcDef {
    return this.req(this.npcs, id, 'npc');
  }
  contract(id: string): ContractTemplateDef {
    return this.req(this.contracts, id, 'contract');
  }
  raidEvent(id: string): RaidEventDef {
    return this.req(this.raidEvents, id, 'raid event');
  }
  market(id: string): MarketDef {
    return this.req(this.markets, id, 'market');
  }

  /** Localized string lookup with {param} substitution. Missing keys render visibly as ⟦key⟧. */
  t(key: string, params?: Record<string, string | number>): string {
    let s = this.strings.get(key);
    if (s === undefined) return `⟦${key}⟧`;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  }
  has(key: string): boolean {
    return this.strings.has(key);
  }
}
