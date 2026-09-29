/**
 * Raid threat tiers (TUNABLE). Enemy loadouts, numbers and skill follow story progress and the region, so the first
 * raids meet pistols, SMGs and pump shotguns without armor, and rifles, marksmen, armor and elites arrive later.
 *
 *   raid threat  = number of these main quests completed: Q02 (first haul), Q03 (outer route), Q07 (power restored)
 *   group threat = raid threat + (region loot tier − 2), clamped to 0…3 (farm/canal −1, checkpoint ±0, industrial and
 *                  the outer supply route +1)
 *
 * A raid without a threat value (older raid snapshots, tests building their own launch) keeps every loadout
 * unfiltered: all of this only applies when the launch carries a threat.
 */
export const THREAT_MAX = 3;

/** Main quests whose completion raises the raid threat by one tier each. */
export const THREAT_QUESTS = ['core.quest.q02_first_haul', 'core.quest.q03_remember_road', 'core.quest.q07_restore_power'] as const;

/** Highest armor tier an enemy wears at each group threat (0: none). */
export const ARMOR_TIER_CAP = [0, 1, 2, 4] as const;

/** Per-tier AI skill multipliers: aim error, reaction time and detection confirm time (tier 2 = the authored values). */
export const SKILL = [
  { aim: 1.45, reaction: 1.5, confirm: 1.3 },
  { aim: 1.2, reaction: 1.25, confirm: 1.15 },
  { aim: 1.0, reaction: 1.0, confirm: 1.0 },
  { aim: 0.9, reaction: 0.9, confirm: 1.0 },
] as const;

const clampTier = (t: number) => Math.max(0, Math.min(THREAT_MAX, Math.floor(t)));

/** Raid threat from the profile's completed quests. */
export function raidThreat(completed: (questId: string) => boolean): number {
  return clampTier(THREAT_QUESTS.filter((q) => completed(q)).length);
}

/** Threat of one spawn group: the raid threat shifted by its region's loot tier (tier 2 is neutral). */
export function groupThreat(raidThreat: number, regionLootTier: number): number {
  return clampTier(raidThreat + regionLootTier - 2);
}

/**
 * Entries allowed at this threat (`minThreat` ≤ threat). Never empty: when nothing qualifies, the entries with the
 * lowest `minThreat` stay. Without a threat the list is returned unchanged.
 */
export function eligibleAt<T extends { minThreat?: number }>(list: readonly T[], threat: number | undefined): T[] {
  if (threat === undefined) return [...list];
  const ok = list.filter((e) => (e.minThreat ?? 0) <= threat);
  if (ok.length > 0) return ok;
  const lowest = Math.min(...list.map((e) => e.minThreat ?? 0));
  return list.filter((e) => (e.minThreat ?? 0) === lowest);
}

/** Armor tier actually worn at this threat. */
export function cappedArmorTier(tier: number, threat: number | undefined): number {
  return threat === undefined ? tier : Math.min(tier, ARMOR_TIER_CAP[clampTier(threat)]!);
}

/** Skill multipliers of an enemy (no tier = the authored values). */
export function skillOf(tier: number | undefined): (typeof SKILL)[number] {
  return tier === undefined ? SKILL[2] : SKILL[clampTier(tier)]!;
}

/** Group size at this threat: the first tier fields one enemy fewer at most (never below the group minimum). */
export function groupCount(count: readonly [number, number], threat: number | undefined): [number, number] {
  if (threat === undefined || threat > 0) return [count[0], count[1]];
  return [count[0], Math.max(count[0], count[1] - 1)];
}
