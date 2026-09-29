import type { EquipSlot, HitPart, PerkEffects, TimePhase, Weather } from '../content/types';
import type { IdCounterState } from '../core/ids';
import type { RngStreamsState } from '../core/rng';
import type { ItemStore } from '../inventory/store';

export type Stance = 'stand' | 'crouch';
export type ActorKind = 'player' | 'enemy' | 'dummy' | 'npc' | 'turret';
export type Team = 'player' | 'hostile' | 'neutral';
export type WeaponSlot = 'primary1' | 'primary2' | 'secondary' | 'melee';

export type ActionType = 'reload' | 'tubeReload' | 'refillMag' | 'heal' | 'melee' | 'throw' | 'switch' | 'loadMag' | 'unloadMag' | 'sprintStop' | 'dodge';

export interface ActionState {
  type: ActionType;
  start: number;
  duration: number;
  elapsed: number;
  weaponId?: string;
  newMagId?: string | null;
  oldMagId?: string | null;
  quick?: boolean;
  steps: string[];
  /** Tube / loose loading. */
  ammoDefId?: string;
  roundsDone?: number;
  roundsTarget?: number;
  nextCommitAt?: number;
  phase?: string;
  itemId?: string;
  healed?: number;
  toSlot?: WeaponSlot;
  throwTarget?: { x: number; y: number };
  throwItemDef?: string;
  meleeDone?: boolean;
  /** Training reserve reload (shelter / range / tutorial): fresh full magazine, the old one is discarded. */
  training?: boolean;
  magDefId?: string;
  /** Dodge roll: unit direction and the ground the roll covers (u). */
  dirX?: number;
  dirY?: number;
  dist?: number;
}

export interface WeaponHandling {
  nextShotTime: number;
  lastShotTime: number;
  bloom: number;
  recoilPitch: number;
  recoilYaw: number;
  shotIndex: number;
  /** ADS stabilization progress 0..1. */
  adsT: number;
  triggerHeld: boolean;
  semiBufferedUntil: number;
  muzzleZ: number;
  muzzleRaised: boolean;
  weaponId: string | null;
}

export interface AimState {
  dirX: number;
  dirY: number;
  /** false while cursor is inside the 12px dead zone (direction frozen) until it leaves 18px. */
  tracking: boolean;
  targetX: number;
  targetY: number;
  targetZ: number;
  targetActorId: string | null;
  muzzleBlocked: boolean;
  lowCoverAhead: boolean;
  faceRight: boolean;
}

export interface ActorStatus {
  bleeding: boolean;
  painkillerUntil: number;
  flashedUntil: number;
  lastHitTime: number;
}

export type AIMode = 'Idle' | 'Patrol' | 'Suspicious' | 'Investigate' | 'Combat' | 'Cover' | 'Reload' | 'Flank' | 'Search' | 'Return' | 'Dead';

export interface AIState {
  mode: AIMode;
  role: string;
  detection: number;
  targetId: string | null;
  lastSeenX: number;
  lastSeenY: number;
  lastSeenTime: number;
  lastHeardX: number;
  lastHeardY: number;
  lastHeardTime: number;
  investigateX: number;
  investigateY: number;
  path: { x: number; y: number }[];
  pathIndex: number;
  repathAt: number;
  goalX: number;
  goalY: number;
  coverX: number | null;
  coverY: number | null;
  nextDecisionAt: number;
  burstLeft: number;
  burstPauseUntil: number;
  telegraphUntil: number;
  telegraphing: boolean;
  shotsSinceRelocate: number;
  patrolIndex: number;
  patrol: { x: number; y: number }[];
  homeX: number;
  homeY: number;
  facing: number;
  stuckTime: number;
  lastPosX: number;
  lastPosY: number;
  reactionUntil: number;
  alertShared: boolean;
  phase: number;
  grenadesLeft: number;
  supportsCalled: number;
  modeSince: number;
  searchUntil: number;
  aimErrYaw: number;
  aimErrPitch: number;
  wantCrouch: boolean;
  /** Set once the enemy has fired its whole finite loadout (AI never picks up ammo): it stops re-engaging. */
  disarmed?: boolean;
  /** Skill tier 0–3 from the spawn group's threat (world/threat.ts SKILL); absent = the authored behavior values. */
  skill?: number;
}

export interface DummyState {
  homeX: number;
  homeY: number;
  respawnAt: number | null;
  track: { x0: number; x1: number; speed: number; dir: 1 | -1 } | null;
  preset: string;
  crouched: boolean;
}

export interface ActorState {
  id: string;
  kind: ActorKind;
  team: Team;
  archetypeId: string | null;
  x: number;
  y: number;
  px: number;
  py: number;
  floor: number;
  vx: number;
  vy: number;
  stance: Stance;
  sprinting: boolean;
  moving: boolean;
  hp: number;
  maxHp: number;
  stamina: number;
  staminaMax: number;
  staminaIdle: number;
  status: ActorStatus;
  activeSlot: WeaponSlot;
  quickslots: (string | null)[];
  action: ActionState | null;
  handling: WeaponHandling;
  aim: AimState;
  alive: boolean;
  deathTick: number | null;
  deathEventId: string | null;
  hitbox: string;
  ai: AIState | null;
  dummy: DummyState | null;
  footstepDist: number;
  radius: number;
  invulnerable: boolean;
  /** Dodge roll: attacks pass through the actor while sim.time < iframeUntil (see inIframes). */
  iframeUntil?: number;
  /** Dodge roll: earliest sim.time of the next roll (roll length + recovery). */
  dodgeReadyAt?: number;
}

export interface WorldContainerState {
  id: string;
  kind: 'world' | 'corpse' | 'drop' | 'deathbag' | 'event';
  typeId: string;
  x: number;
  y: number;
  floor: number;
  /** Items revealed so far (search progress never re-rolls). */
  searched: number;
  searchProgress: number;
  keyId: string | null;
  locked: boolean;
  actorId: string | null;
  nameKey: string;
  createdTick: number;
  opened: boolean;
}

export interface ProjectileState {
  id: string;
  shotId: string;
  pelletId: number;
  ownerId: string;
  team: Team;
  weaponDefId: string;
  ammoDefId: string;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  traveled: number;
  maxRange: number;
  effRange: number;
  minFactor: number;
  baseDamage: number;
  energy: number;
  carry: number;
  penetrations: number;
  hitActors: string[];
  alive: boolean;
  /** Seconds of the spawning tick remaining after the shot time (sub-tick precision). */
  pending: number;
  floor: number;
  tracer: number;
  born: number;
}

export interface ThrownState {
  id: string;
  ownerId: string;
  itemDefId: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  fuseAt: number;
  resting: boolean;
  floor: number;
}

export interface SmokeState {
  id: string;
  x: number;
  y: number;
  radius: number;
  until: number;
  floor: number;
}

export interface NoiseEvent {
  x: number;
  y: number;
  floor: number;
  loudness: number;
  radius: number;
  tag: string;
  sourceId: string;
  time: number;
}

export interface RaidEventState {
  id: string;
  defId: string;
  state: 'idle' | 'active' | 'success' | 'failed' | 'done';
  x: number;
  y: number;
  variant: string;
  startedAt: number;
  endsAt: number;
  data: Record<string, number | string | boolean>;
}

export interface KillRecord {
  actorId: string;
  archetypeId: string;
  role: string;
  weaponDefId: string | null;
  weaponTags: string[];
  part: HitPart | null;
  tick: number;
}

export interface RaidProgress {
  visited: string[];
  discovered: string[];
  interactions: string[];
  kills: KillRecord[];
  hitParts: { part: HitPart; context: string; tick: number; weaponDefId?: string | null }[];
  notesFound: string[];
  eventsCompleted: string[];
  retrieved: string[];
  custom: string[];
}

export interface RaidStats {
  shotsFired: number;
  hits: number;
  headshots: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  healed: number;
  containersSearched: number;
  distance: number;
}

export type RaidOutcome = { kind: 'extracted'; exitId: string; tick: number } | { kind: 'dead'; tick: number; cause: string } | { kind: 'abandoned'; tick: number };

export interface ShotLogEntry {
  shotId: string;
  pelletId: number;
  weaponId: string;
  ammoId: string;
  shotTime: number;
  origin: [number, number, number];
  aim: [number, number, number];
  spreadSeed: [number, number];
  firstHit: string;
  /** The barrel itself was inside a projectile blocker when fired (muzzle-in-wall). */
  barrelBlocked: boolean;
  part: HitPart | null;
  range: number;
  rawDamage: number;
  armorBefore: number | null;
  armorLoss: number;
  calculatedHPDamage: number;
  actualHPLoss: number;
}

export type SimEvent =
  | { t: 'shot'; actorId: string; weaponDefId: string; x: number; y: number; z: number; dirX: number; dirY: number; suppressed: boolean; team: Team }
  | { t: 'impact'; x: number; y: number; z: number; material: string; actor: boolean }
  | { t: 'penetrate'; x: number; y: number; z: number; material: string }
  | { t: 'hit'; actorId: string; part: HitPart; damage: number; armorHit: boolean; killed: boolean; x: number; y: number; z: number; byPlayer: boolean }
  | { t: 'death'; actorId: string; x: number; y: number }
  | { t: 'footstep'; actorId: string; x: number; y: number; material: string; loud: boolean }
  | { t: 'reload'; actorId: string; step: string }
  | { t: 'dryfire'; actorId: string }
  | { t: 'noise'; noise: NoiseEvent }
  | { t: 'explosion'; x: number; y: number; kind: string }
  | { t: 'smoke'; x: number; y: number; radius: number }
  | { t: 'melee'; actorId: string; hit: boolean; x: number; y: number; dirX: number; dirY: number; targetId: string | null }
  | { t: 'dodge'; actorId: string; x: number; y: number; dirX: number; dirY: number; material: string }
  | { t: 'door'; doorId: string; open: boolean }
  | { t: 'pickup'; itemDefId: string; qty: number }
  | { t: 'message'; key: string; params?: Record<string, string | number> }
  | { t: 'heal'; actorId: string; kind: string }
  | { t: 'alert'; actorId: string; mode: string }
  | { t: 'telegraph'; actorId: string; x: number; y: number; tx: number; ty: number; until: number }
  | { t: 'extracted'; exitId: string }
  | { t: 'died' }
  | { t: 'objective'; key: string }
  | { t: 'event'; eventId: string; state: string }
  | { t: 'flash'; x: number; y: number; intensity: number }
  | { t: 'ui'; kind: string; id: string }
  | { t: 'search'; containerId: string; revealed: number };

export interface InteractionPrompt {
  kind: 'door' | 'container' | 'interactable';
  id: string;
  labelKey: string;
  params?: Record<string, string | number>;
  blockedKey?: string;
  x: number;
  y: number;
}

export interface RangeState {
  preset: string;
  headHits: number;
  wallBlocks: number;
  lowCoverHits: number;
  reloads: number;
  turretNextAt: number;
}

export interface SimState {
  version: 1;
  mode: 'raid' | 'base';
  /**
   * Training sim (tutorial) running raid rules. Base sims (shelter / range) are always training: the player's stamina
   * never drains and reloads draw fresh full magazines from an unlimited training reserve (see isTraining).
   */
  training?: boolean;
  raidId: string;
  mapId: string;
  seed: string;
  /** Raid threat tier 0–3 the enemies were scaled to at raid creation (world/threat.ts); absent = unscaled. */
  threat?: number;
  /** Procedural layout seed (world/procgen.ts raidMap); absent = the authored map. Geometry is rebuilt from it. */
  layoutSeed?: string;
  tick: number;
  time: number;
  rng: RngStreamsState;
  ids: IdCounterState;
  env: { phase: TimePhase; weather: Weather };
  actors: ActorState[];
  store: ItemStore;
  containers: Record<string, WorldContainerState>;
  doors: Record<string, { open: boolean; locked: boolean }>;
  obstacleHp: Record<string, number>;
  projectiles: ProjectileState[];
  thrown: ThrownState[];
  smokes: SmokeState[];
  exits: Record<string, { progress: number; enabled: boolean }>;
  events: RaidEventState[];
  progress: RaidProgress;
  processedDeaths: string[];
  outcome: RaidOutcome | null;
  stats: RaidStats;
  shotLog: ShotLogEntry[];
  flags: Record<string, boolean>;
  registeredKeys: string[];
  /** Account credits at raid start (fee exits are charged at the extraction commit, not here). */
  credits: number;
  loadoutItemIds: string[];
  activeQuests: string[];
  perks: PerkEffects;
  notes: string[];
  deathBagContainerId: string | null;
  range: RangeState | null;
  lastCheckpointTime: number;
  /** Open loot session (player). */
  loot: { containerId: string } | null;
  /** Current interaction prompt for the HUD (recomputed every tick). */
  prompt: InteractionPrompt | null;
  /** Transient per-step outputs (not persisted). */
  fx: SimEvent[];
  noises: NoiseEvent[];
  debug: { god: boolean; infiniteAmmo: boolean; freezeAI: boolean; noSpread?: boolean };
}

/** Shelter, shooting range and tutorial: no stamina drain, unlimited training reserve for reloads. */
export function isTraining(sim: SimState): boolean {
  return sim.mode === 'base' || sim.training === true;
}

/** Dodge-roll invulnerability window: bullets, frag blasts and melee swings pass through the actor. */
export function inIframes(sim: SimState, a: ActorState): boolean {
  return a.iframeUntil !== undefined && sim.time + 1e-9 < a.iframeUntil;
}

export function eqContainerId(actorId: string, slot: EquipSlot): string {
  return `eq:${actorId}:${slot}`;
}
export function pocketContainerId(actorId: string): string {
  return `pk:${actorId}`;
}

export function emptyProgress(): RaidProgress {
  return { visited: [], discovered: [], interactions: [], kills: [], hitParts: [], notesFound: [], eventsCompleted: [], retrieved: [], custom: [] };
}

export function emptyStats(): RaidStats {
  return { shotsFired: 0, hits: 0, headshots: 0, kills: 0, damageDealt: 0, damageTaken: 0, healed: 0, containersSearched: 0, distance: 0 };
}
