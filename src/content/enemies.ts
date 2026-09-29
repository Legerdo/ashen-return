import type { BehaviorProfile, EnemyArchetypeDef, NpcDef } from './types';

const base: BehaviorProfile = {
  fovDeg: 100,
  detectRange: 18,
  confirmMin: 0.35,
  confirmMax: 0.8,
  memorySec: 4,
  reactionSec: 0.35,
  aimErrorDeg: 2.2,
  burst: [2, 3],
  burstPause: [0.5, 0.9],
  preferredRange: [6, 16],
  coverSeekRadius: 7,
  flankTendency: 0.1,
  telegraphSec: 0,
  relocateAfterShots: 99,
  headAimChance: 0.12,
  moveSpeedMult: 1,
};

export const ENEMIES: EnemyArchetypeDef[] = [
  {
    id: 'core.enemy.sentry',
    nameKey: 'enemy.sentry',
    role: 'sentry',
    hp: 80,
    weapons: [
      { itemId: 'core.weapon.p9', weight: 5, ammoId: 'core.ammo.9.fmj', spareMags: [1, 2], looseRounds: [0, 15] },
      // TUNABLE: no rifles before threat tier 2 (world/threat.ts).
      { itemId: 'core.weapon.c556', weight: 4, ammoId: 'core.ammo.556.fmj', spareMags: [1, 2], looseRounds: [0, 20], minThreat: 2 },
    ],
    vest: [
      { tier: 0, weight: 5 },
      { tier: 1, weight: 4 },
    ],
    helmet: [
      { tier: 0, weight: 6 },
      { tier: 1, weight: 3 },
    ],
    behavior: { ...base },
    lootTable: 'core.loot.pocket_basic',
    exp: 20,
    sprite: 'pigeon_sentry',
    voice: 'coo',
  },
  {
    id: 'core.enemy.flanker',
    nameKey: 'enemy.flanker',
    role: 'flanker',
    hp: 90,
    weapons: [
      { itemId: 'core.weapon.sm9', weight: 6, ammoId: 'core.ammo.9.fmj', spareMags: [2, 2], looseRounds: [0, 20] },
      { itemId: 'core.weapon.sm45', weight: 3, ammoId: 'core.ammo.45.fmj', spareMags: [1, 2], looseRounds: [0, 16], minThreat: 1 },
    ],
    vest: [{ tier: 1, weight: 1 }],
    helmet: [
      { tier: 0, weight: 3 },
      { tier: 1, weight: 1 },
    ],
    behavior: { ...base, fovDeg: 110, aimErrorDeg: 2.8, burst: [4, 7], burstPause: [0.35, 0.7], preferredRange: [5, 10], coverSeekRadius: 5, flankTendency: 0.8, headAimChance: 0.08, moveSpeedMult: 1.1 },
    lootTable: 'core.loot.pocket_basic',
    exp: 25,
    sprite: 'pigeon_flanker',
    voice: 'coo',
  },
  {
    id: 'core.enemy.rusher',
    nameKey: 'enemy.rusher',
    role: 'rusher',
    hp: 100,
    weapons: [
      { itemId: 'core.weapon.sgp', weight: 5, ammoId: 'core.ammo.12g.buck', spareMags: [0, 0], looseRounds: [8, 14] },
      { itemId: 'core.weapon.sga', weight: 2, ammoId: 'core.ammo.12g.buck', spareMags: [1, 1], looseRounds: [0, 8], minThreat: 2 },
    ],
    vest: [
      { tier: 1, weight: 3 },
      { tier: 2, weight: 2 },
    ],
    helmet: [
      { tier: 0, weight: 2 },
      { tier: 1, weight: 2 },
    ],
    behavior: { ...base, detectRange: 16, aimErrorDeg: 3.0, burst: [1, 2], burstPause: [0.6, 1.0], preferredRange: [3, 6], coverSeekRadius: 6, headAimChance: 0.05, moveSpeedMult: 1.05 },
    lootTable: 'core.loot.pocket_basic',
    exp: 30,
    sprite: 'pigeon_rusher',
    voice: 'coo',
  },
  {
    id: 'core.enemy.marksman',
    nameKey: 'enemy.marksman',
    role: 'marksman',
    hp: 80,
    weapons: [{ itemId: 'core.weapon.dmr', weight: 1, ammoId: 'core.ammo.762d.fmj', spareMags: [1, 1], looseRounds: [5, 10] }],
    vest: [
      { tier: 0, weight: 3 },
      { tier: 1, weight: 2 },
    ],
    helmet: [
      { tier: 0, weight: 3 },
      { tier: 1, weight: 1 },
    ],
    behavior: { ...base, fovDeg: 80, detectRange: 26, confirmMin: 0.5, confirmMax: 1.0, memorySec: 6, aimErrorDeg: 1.1, burst: [1, 1], burstPause: [1.6, 2.4], preferredRange: [14, 26], coverSeekRadius: 5, telegraphSec: 0.8, relocateAfterShots: 2, headAimChance: 0.25, moveSpeedMult: 0.9 },
    lootTable: 'core.loot.pocket_marksman',
    exp: 35,
    sprite: 'crow_marksman',
    voice: 'caw',
    // TUNABLE: long-range DMR fire only from threat tier 2 (world/threat.ts).
    minThreat: 2,
  },
  {
    id: 'core.enemy.support',
    nameKey: 'enemy.support',
    role: 'support',
    hp: 90,
    weapons: [{ itemId: 'core.weapon.ar556', weight: 1, ammoId: 'core.ammo.556.fmj', spareMags: [2, 2], looseRounds: [0, 20] }],
    vest: [{ tier: 2, weight: 1 }],
    helmet: [{ tier: 1, weight: 1 }],
    behavior: { ...base, aimErrorDeg: 2.4, burst: [3, 4] },
    lootTable: 'core.loot.pocket_basic',
    exp: 30,
    sprite: 'pigeon_support',
    voice: 'coo',
    // Rifle squad support: spawn groups from threat tier 2 (the commander's called support is never gated).
    minThreat: 2,
  },
  {
    id: 'core.enemy.boss',
    nameKey: 'enemy.boss',
    role: 'boss',
    hp: 400,
    weapons: [{ itemId: 'core.weapon.ar762', weight: 1, ammoId: 'core.ammo.762r.fmj', spareMags: [4, 4], looseRounds: [25, 25] }],
    vest: [{ tier: 3, weight: 1 }],
    helmet: [{ tier: 2, weight: 1 }],
    behavior: { ...base, fovDeg: 120, detectRange: 22, confirmMin: 0.3, confirmMax: 0.6, memorySec: 8, reactionSec: 0.3, aimErrorDeg: 1.6, burst: [3, 4], burstPause: [1.2, 1.6], preferredRange: [8, 16], coverSeekRadius: 8, telegraphSec: 0.6, relocateAfterShots: 8, headAimChance: 0.15 },
    lootTable: 'core.loot.pocket_boss',
    exp: 500,
    sprite: 'owl_boss',
    voice: 'hoot',
    // TUNABLE: rolls out of the line of fire on ~30 % of incoming volleys, at most once per 3.5 s.
    dodge: { chance: 0.3, cooldown: 3.5 },
  },
  {
    // Late-game assault leader: only in raids at threat tier 3 (see world/threat.ts). Rolls like the player does.
    id: 'core.enemy.elite',
    nameKey: 'enemy.elite',
    role: 'flanker',
    hp: 110,
    weapons: [
      { itemId: 'core.weapon.sm45', weight: 3, ammoId: 'core.ammo.45.fmj', spareMags: [2, 2], looseRounds: [0, 16] },
      { itemId: 'core.weapon.ar556', weight: 2, ammoId: 'core.ammo.556.fmj', spareMags: [2, 2], looseRounds: [0, 20] },
    ],
    vest: [{ tier: 2, weight: 1 }],
    helmet: [
      { tier: 1, weight: 1 },
      { tier: 2, weight: 1 },
    ],
    behavior: { ...base, fovDeg: 115, detectRange: 20, confirmMin: 0.3, confirmMax: 0.65, memorySec: 6, reactionSec: 0.3, aimErrorDeg: 2.0, burst: [3, 5], burstPause: [0.45, 0.8], preferredRange: [6, 12], coverSeekRadius: 6, flankTendency: 0.7, headAimChance: 0.12, moveSpeedMult: 1.1 },
    lootTable: 'core.loot.pocket_marksman',
    exp: 60,
    sprite: 'hawk_elite',
    voice: 'caw',
    minThreat: 3,
    // TUNABLE: rolls on ~25 % of incoming volleys, at most once per 4 s.
    dodge: { chance: 0.25, cooldown: 4 },
  },
];

export const NPCS: NpcDef[] = [
  { id: 'core.npc.mechanic', nameKey: 'npc.mechanic.name', roleKey: 'npc.mechanic.role', traderId: 'core.trader.mechanic', sprite: 'owl_mechanic', greetingKeys: ['npc.mechanic.greet1', 'npc.mechanic.greet2'] },
  { id: 'core.npc.medic', nameKey: 'npc.medic.name', roleKey: 'npc.medic.role', traderId: 'core.trader.medic', sprite: 'egret_medic', greetingKeys: ['npc.medic.greet1', 'npc.medic.greet2'] },
  { id: 'core.npc.comms', nameKey: 'npc.comms.name', roleKey: 'npc.comms.role', traderId: 'core.trader.comms', sprite: 'magpie_comms', greetingKeys: ['npc.comms.greet1', 'npc.comms.greet2'] },
];
