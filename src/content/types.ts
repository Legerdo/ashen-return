/**
 * Content definition types. Long-lived ids are stable strings (e.g. core.weapon.ar556), never array indices.
 * All numeric values here are TUNABLE starting points unless the spec marks them LOCKED.
 */

export type Caliber = '9' | '45' | '556' | '762r' | '762d' | '12g';
export type WeaponClass = 'pistol' | 'smg' | 'carbine' | 'ar' | 'shotgun' | 'dmr' | 'bolt' | 'lmg';
export type FireMode = 'auto' | 'semi' | 'pump' | 'bolt';
export type HitPart = 'head' | 'body' | 'limb';
export type AttachmentSlot = 'muzzle' | 'grip' | 'stock';
export type ArmorSlot = 'helmet' | 'vest';
export type EquipSlot = 'primary1' | 'primary2' | 'secondary' | 'melee' | 'helmet' | 'vest' | 'backpack' | 'accessory';
export const EQUIP_SLOTS: readonly EquipSlot[] = ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'];

export type ItemKind =
  | 'weapon'
  | 'ammo'
  | 'magazine'
  | 'attachment'
  | 'armor'
  | 'medical'
  | 'throwable'
  | 'melee'
  | 'backpack'
  | 'accessory'
  | 'material'
  | 'valuable'
  | 'quest'
  | 'key'
  | 'tool';

export type Material = 'concrete' | 'brick' | 'wood' | 'metal' | 'glass' | 'vegetation' | 'sandbag' | 'fabric' | 'flesh' | 'dirt' | 'water';

export interface WeaponSpec {
  class: WeaponClass;
  caliber: Caliber;
  damage: number;
  pellets: number;
  rpm: number;
  /** Detachable magazine family; null for tube-fed weapons. */
  magazineFamily: string | null;
  /** Standard magazine / tube capacity. */
  capacity: number;
  reloadTactical: number;
  reloadEmpty: number;
  tube?: { open: number; perRound: number; close: number; chamber: number };
  effectiveRange: number;
  maxRange: number;
  minRangeFactor: number;
  modes: FireMode[];
  precisionSpreadDeg: number;
  recoilDeg: number;
  stabilizeSec: number;
  adsMove: number;
  muzzleVelocity: number;
  bloomPerShot: number;
  gunshotRadius: number;
  attachmentSlots: AttachmentSlot[];
  /** Distance from aim anchor to muzzle along the aim direction (u). */
  muzzleLength: number;
  /** Swap time (s). */
  equipTime: number;
  soundProfile: string;
}

export interface AmmoSpec {
  caliber: Caliber;
  variant: 'fmj' | 'ap' | 'hp' | 'buck' | 'slug';
  fleshMult: number;
  penetration: number;
  armorDamage: number;
  envEnergy: number;
  headMult: number;
  bleedChance: number;
  /** Slug-style overrides. */
  pelletsOverride?: number;
  damageOverride?: number;
  spreadOverrideDeg?: number;
  rangeOverride?: { effective: number; max: number; minFactor: number };
  velocityMult?: number;
  tracer: number;
}

export interface MagazineSpec {
  family: string;
  caliber: Caliber;
  capacity: number;
  reloadMult: number;
}

export interface AttachmentSpec {
  slot: AttachmentSlot;
  noiseMult: number;
  recoilMult: number;
  adsTimeMult: number;
  adsMoveSpreadMult: number;
}

export interface ArmorSpec {
  slot: ArmorSlot;
  tier: number;
  rating: number;
  maxDurability: number;
}

export interface MedicalSpec {
  type: 'bandage' | 'firstaid' | 'painkiller';
  useTime: number;
  /** First-aid heal pool. */
  pool?: number;
  healPerSec?: number;
  painkillerDuration?: number;
}

export interface ThrowableSpec {
  type: 'frag' | 'smoke' | 'flash';
  fuse: number;
  throwSpeed: number;
  damage?: number;
  innerRadius?: number;
  outerRadius?: number;
  smokeDuration?: number;
  smokeRadius?: number;
  flashRadius?: number;
  noiseRadius: number;
}

export interface MeleeSpec {
  damage: number;
  cycle: number;
  reach: number;
  stamina: number;
  penetration: number;
  bleedChance: number;
}

export interface ItemDef {
  id: string;
  kind: ItemKind;
  nameKey: string;
  descKey: string;
  size: { w: number; h: number };
  stackMax: number;
  weightKg: number;
  basePrice: number;
  tags: string[];
  icon: string;
  /** Sale/dismantle value forced to 0 (bankrupt relief kit etc.). */
  noValue?: boolean;
  weapon?: WeaponSpec;
  ammo?: AmmoSpec;
  magazine?: MagazineSpec;
  attachment?: AttachmentSpec;
  armor?: ArmorSpec;
  medical?: MedicalSpec;
  throwable?: ThrowableSpec;
  melee?: MeleeSpec;
  backpack?: { w: number; h: number };
  accessory?: { nightVision?: number; searchSpeed?: number };
  keyId?: string;
  dismantle?: { itemId: string; qty: number }[];
  /** Round weight for ammo stacks (per round, kg). */
  unitWeightKg?: number;
}

export interface HitVolume {
  part: HitPart;
  z0: number;
  z1: number;
  radius: number;
  /** Forward offset along facing (u). */
  forward: number;
}

export interface HitboxProfile {
  id: string;
  volumes: HitVolume[];
  eyeZ: number;
  muzzleZ: number;
  /** Aim anchor (shoulder) height. */
  anchorZ: number;
  height: number;
}

export interface ObstacleProfile {
  id: string;
  blocksMovement: boolean;
  blocksProjectile: boolean;
  blocksVision: boolean;
  blocksSound: boolean;
  material: Material;
  /** Penetration resistance per unit thickness; Infinity = never. */
  penetrationResistance: number;
  destructible: boolean;
  hp?: number;
  /** Vegetation: vision density per unit traversed (1 = opaque after 1u). */
  foliage?: number;
  moveMult?: number;
  render: string;
}

export interface EnemyArchetypeDef {
  id: string;
  nameKey: string;
  role: 'sentry' | 'flanker' | 'rusher' | 'marksman' | 'boss' | 'support';
  hp: number;
  /**
   * Weapon pool. `minThreat` (0–3, default 0) keeps an entry out of spawn groups below that threat tier (see
   * world/threat.ts); it only filters when the raid has a threat, and never filters the pool down to nothing.
   */
  weapons: { itemId: string; weight: number; ammoId: string; spareMags: [number, number]; looseRounds: [number, number]; minThreat?: number }[];
  /** Armor pools; the tier worn is capped by the group threat (world/threat.ts ARMOR_TIER_CAP). */
  vest: { tier: number; weight: number }[];
  helmet: { tier: number; weight: number }[];
  behavior: BehaviorProfile;
  lootTable: string;
  exp: number;
  sprite: string;
  voice: string;
  /** Lowest raid threat tier this archetype appears at in spawn groups (default 0). */
  minThreat?: number;
  /** Evasive dodge roll (bosses / elites): chance per incoming player shot or hit, and minimum seconds between rolls. */
  dodge?: { chance: number; cooldown: number };
}

export interface BehaviorProfile {
  fovDeg: number;
  detectRange: number;
  confirmMin: number;
  confirmMax: number;
  memorySec: number;
  reactionSec: number;
  aimErrorDeg: number;
  burst: [number, number];
  burstPause: [number, number];
  preferredRange: [number, number];
  coverSeekRadius: number;
  flankTendency: number;
  telegraphSec: number;
  relocateAfterShots: number;
  headAimChance: number;
  moveSpeedMult: number;
}

export interface LootTableDef {
  id: string;
  rolls: [number, number];
  entries: { itemId: string; weight: number; qty: [number, number]; minTrust?: number }[];
  /** Guaranteed entries (always added). */
  guaranteed?: { itemId: string; qty: [number, number] }[];
}

export type TimePhase = 'Day' | 'Dusk' | 'Night';
export type Weather = 'Clear' | 'Cloudy' | 'Rain' | 'Storm';

export interface WeatherDef {
  id: Weather;
  nameKey: string;
  vision: number;
  aiVision: number;
  sound: number;
  ambience: string;
}

export interface TimePhaseDef {
  id: TimePhase;
  nameKey: string;
  vision: number;
  aiVision: number;
  darkness: number;
}

export type ExitCondition =
  | { type: 'free' }
  | { type: 'flag'; flag: string; hintKey: string }
  | { type: 'item'; itemId: string; consume: boolean; hintKey: string }
  | { type: 'fee'; credits: number; hintKey: string };

export interface ExitDef {
  id: string;
  nameKey: string;
  x: number;
  y: number;
  w: number;
  h: number;
  condition: ExitCondition;
}

export interface RegionDef {
  id: string;
  nameKey: string;
  rects: { x: number; y: number; w: number; h: number }[];
  ambience: string;
  lootTier: number;
}

export interface InteriorDef {
  id: string;
  nameKey: string;
  regionId: string;
  rect: { x: number; y: number; w: number; h: number };
  roof: string;
}

export interface TravelDestinationDef {
  id: string;
  mapId: string;
  nameKey: string;
  descKey: string;
  unlockFlag: string | null;
  risk: number;
  cost: number;
  durationHintKey: string;
  timeWeights: Record<TimePhase, number>;
  weatherWeights: Record<Weather, number>;
}

export type ObjectiveType =
  | 'Visit'
  | 'Discover'
  | 'Interact'
  | 'Kill'
  | 'KillWithWeaponTag'
  | 'HitPart'
  | 'Retrieve'
  | 'ExtractWith'
  | 'Deliver'
  | 'Craft'
  | 'Repair'
  | 'Survive'
  | 'UseExit'
  | 'WorldFlag'
  | 'CustomValidated';

export interface ObjectiveDef {
  id: string;
  type: ObjectiveType;
  descKey: string;
  count: number;
  /** Target id: poi id, interaction tag, archetype role, item id, recipe id, map id, exit id, flag, custom key. */
  target?: string;
  weaponTag?: string;
  part?: string;
  npcId?: string;
  mapId?: string;
  context?: string;
  optional?: boolean;
}

export interface RewardDef {
  credits?: number;
  exp?: number;
  items?: { itemId: string; qty: number }[];
  trust?: { traderId: string; amount: number }[];
  flags?: string[];
  perkPoints?: number;
}

export interface QuestDef {
  id: string;
  lineId: string;
  nameKey: string;
  descKey: string;
  giver: string;
  requires: string[];
  requiresFlags?: string[];
  optional?: boolean;
  objectives: ObjectiveDef[];
  rewards: RewardDef;
  /** Items consumed at submission (Deliver objectives consume their own items). */
  completeDialogKey: string;
  act: number;
}

export interface QuestLineDef {
  id: string;
  nameKey: string;
  quests: string[];
}

export interface ChapterDef {
  id: string;
  nameKey: string;
  acts: { id: number; nameKey: string; descKey: string }[];
  mainLine: string[];
  finalQuest: string;
}

export interface ContractTemplateDef {
  id: string;
  nameKey: string;
  descKey: string;
  type: 'supply' | 'recon' | 'hunt' | 'precision' | 'retrieve' | 'support';
  giver: string;
  minLevel: number;
  rewardCredits: [number, number];
  rewardExp: [number, number];
  trust: number;
}

export interface RaidEventDef {
  id: string;
  nameKey: string;
  descKey: string;
  mapIds: string[];
  chance: number;
  weatherMult: Partial<Record<Weather, number>>;
}

export interface PerkDef {
  id: string;
  line: 'survival' | 'carry' | 'combat';
  nameKey: string;
  descKey: string;
  level: number;
  cost: number;
  requires: string[];
  effects: PerkEffects;
}

export interface PerkEffects {
  staminaMax?: number;
  healTimeMult?: number;
  bandageTimeMult?: number;
  bleedRateMult?: number;
  carryKg?: number;
  searchSpeedMult?: number;
  mapInfo?: boolean;
  stabilizeMult?: number;
  repairMult?: number;
  reloadMult?: number;
  recoilRecoveryMult?: number;
  swapTimeMult?: number;
}

export interface BuildingDef {
  id: string;
  nameKey: string;
  descKey: string;
  footprint: { w: number; h: number };
  cost: { credits: number; items: { itemId: string; qty: number }[] };
  unlockFlag: string | null;
  effects: string[];
  sprite: string;
  /** If true the building blocks movement over its footprint (all do in P1). */
  solid: boolean;
}

export interface FacilityDef {
  id: string;
  nameKey: string;
  descKey: string;
  cost: number;
  requiresBuilding: string | null;
  requiresFlag: string | null;
  effects: Record<string, number>;
}

export interface TraderDef {
  id: string;
  nameKey: string;
  roleKey: string;
  /** priceMult: per-line buy price multiplier (e.g. repair kits, so repairs can never turn a profit). */
  stock: { itemId: string; qty: number; minTrust: number; requiresFlag?: string; always?: boolean; priceMult?: number }[];
  buysKinds: ItemKind[];
}

export interface MarketDef {
  id: string;
  nameKey: string;
  unlockFlag: string;
  pool: { itemId: string; weight: number; qty: [number, number]; priceMult: number }[];
  slots: number;
}

export interface RecipeDef {
  id: string;
  nameKey: string;
  station: 'workbench' | 'medical';
  inputs: { itemId: string; qty: number }[];
  fee: number;
  time: number;
  output: { itemId: string; qty: number };
  requiresFlag: string | null;
  requiresBuilding: string | null;
}

export interface NoteDef {
  id: string;
  titleKey: string;
  bodyKey: string;
  mapId: string;
  x: number;
  y: number;
}

export interface KeyDef {
  id: string;
  nameKey: string;
  itemId: string;
  doorIds: string[];
  containerIds: string[];
}

export interface AudioEventDef {
  id: string;
  bus: AudioBus;
  variants: number;
  captionKey?: string;
}

export type AudioBus = 'Master' | 'Music' | 'Weapons' | 'Impacts' | 'Footsteps' | 'Ambience' | 'UI' | 'Voice';
export const AUDIO_BUSES: readonly AudioBus[] = ['Master', 'Music', 'Weapons', 'Impacts', 'Footsteps', 'Ambience', 'UI', 'Voice'];

export interface AudioPaletteDef {
  id: string;
  ambience: string[];
  music: string | null;
}

export interface NpcDef {
  id: string;
  nameKey: string;
  roleKey: string;
  traderId: string;
  sprite: string;
  greetingKeys: string[];
}

export interface ContentManifest {
  id: string;
  version: string;
  packs: string[];
}
