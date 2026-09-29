import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { Rng } from '../src/core/rng';
import { newProfile, type ProfileState } from '../src/progression/profile';
import { refreshQuests } from '../src/progression/quests';
import { prepareDeploy } from '../src/progression/raidFlow';
import { activeWeaponItem, equippedItem } from '../src/world/context';
import { createRaidSim, spawnEnemy } from '../src/world/spawn';
import type { ActorState, AIMode, SimState } from '../src/world/state';
import { ARMOR_TIER_CAP, eligibleAt, groupCount, groupThreat, raidThreat, SKILL, THREAT_QUESTS } from '../src/world/threat';
import { arena, tick, world } from './helpers';

/**
 * Difficulty by progression (world/threat.ts): the first raids meet pistols / SMGs / pump shotguns without armor and
 * with slower, less accurate enemies; rifles, marksmen, armor and elites arrive with story progress and harder
 * regions. Every raid here is a real prepareDeploy() → createRaidSim() launch.
 */

const content = createContent();
const MAIN = 'core.dest.quarantine_main';
const OUTER = 'core.dest.outer_supply_route';
const RIFLES = new Set(['core.weapon.c556', 'core.weapon.ar556', 'core.weapon.ar762', 'core.weapon.dmr', 'core.weapon.bolt', 'core.weapon.lmg']);
const EARLY_WEAPONS = new Set(['core.weapon.p9', 'core.weapon.sm9', 'core.weapon.sgp']);

function complete(p: ProfileState, questId: string): void {
  const q = content.quest(questId);
  p.quests[questId] = { status: 'completed', progress: {} };
  for (const f of q.rewards.flags ?? []) p.flags[f] = true;
}

/** Profile at a main-line stage: 0 = only Q01 done, 1 = +Q02, 2 = +Q03, 3 = +Q06/Q07 (Q08 active). */
function profileAt(stage: number, seed: string): ProfileState {
  const p = newProfile(content, 1, 'threat', seed, 0);
  complete(p, 'core.quest.q01_ready');
  if (stage >= 1) complete(p, 'core.quest.q02_first_haul');
  if (stage >= 2) complete(p, 'core.quest.q03_remember_road');
  if (stage >= 3) {
    complete(p, 'core.quest.q06_scrap');
    complete(p, 'core.quest.q07_restore_power');
  }
  refreshQuests(p, content);
  if (stage >= 3) p.quests['core.quest.q08_last_signal'] = { status: 'active', progress: {} };
  return p;
}

function raid(stage: number, dest: string, seed: string): SimState {
  const launch = prepareDeploy(profileAt(stage, seed), content, dest, 0);
  expect(launch.threat).toBe(stage);
  return createRaidSim(content, launch).sim;
}

const enemies = (sim: SimState) => sim.actors.filter((a) => a.kind === 'enemy');
const armorTier = (sim: SimState, a: ActorState, slot: 'vest' | 'helmet') => {
  const it = equippedItem(sim, a.id, slot);
  return it ? content.item(it.definitionId).armor!.tier : 0;
};
const weaponOf = (sim: SimState, a: ActorState) => activeWeaponItem({ sim, content, geo: null as never, rng: null as never }, a)!.item.definitionId;

describe('raid threat tiers', () => {
  it('raid threat counts Q02 / Q03 / Q07; group threat shifts it by the region loot tier; pools never empty', () => {
    expect(THREAT_QUESTS).toEqual(['core.quest.q02_first_haul', 'core.quest.q03_remember_road', 'core.quest.q07_restore_power']);
    for (let s = 0; s <= 3; s++) expect(prepareDeploy(profileAt(s, `tier-${s}`), content, MAIN, 0).threat).toBe(s);
    expect(raidThreat(() => false)).toBe(0);
    expect(raidThreat(() => true)).toBe(3);
    // farm / canal (loot tier 1) −1, checkpoint (2) ±0, industrial / outer route (3) +1, clamped to 0…3.
    expect([1, 2, 3].map((lt) => groupThreat(0, lt))).toEqual([0, 0, 1]);
    expect([1, 2, 3].map((lt) => groupThreat(3, lt))).toEqual([2, 3, 3]);
    expect(groupCount([2, 3], 0)).toEqual([2, 2]);
    expect(groupCount([1, 1], 0)).toEqual([1, 1]);
    expect(groupCount([2, 3], 1)).toEqual([2, 3]);
    expect(groupCount([2, 3], undefined)).toEqual([2, 3]);
    expect(eligibleAt([{ minThreat: 2, id: 'a' }, { minThreat: 3, id: 'b' }], 0).map((e) => e.id)).toEqual(['a']);
    expect(eligibleAt([{ id: 'x' }, { minThreat: 2, id: 'y' }], undefined).map((e) => e.id)).toEqual(['x', 'y']);
    expect(ARMOR_TIER_CAP[0]).toBe(0);
    expect(SKILL[0].aim).toBeGreaterThan(SKILL[2].aim);
    expect(SKILL[2]).toEqual({ aim: 1, reaction: 1, confirm: 1 });
  });

  it('first raids (30 seeds): pistols, SMGs and pump shotguns only, no marksman / support / elite, no armor outside the industrial zone', () => {
    const seen = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < 30; i++) {
      const sim = raid(0, MAIN, `first-${i}`);
      const list = enemies(sim);
      expect(list.length, `seed ${i}: armed enemies to fight`).toBeGreaterThan(4);
      for (const e of list) {
        total++;
        const w = weaponOf(sim, e);
        seen.set(w, (seen.get(w) ?? 0) + 1);
        expect(['core.enemy.marksman', 'core.enemy.support', 'core.enemy.elite', 'core.enemy.boss'], `${e.archetypeId}`).not.toContain(e.archetypeId);
        expect(RIFLES.has(w), `${e.archetypeId} with ${w}`).toBe(false);
        expect(e.ai!.skill).toBeDefined();
        const skill = e.ai!.skill!;
        expect(skill).toBeLessThanOrEqual(1);
        if (skill === 0) expect(EARLY_WEAPONS.has(w), `${w} at tier 0`).toBe(true);
        expect(armorTier(sim, e, 'vest')).toBeLessThanOrEqual(ARMOR_TIER_CAP[skill]!);
        expect(armorTier(sim, e, 'helmet')).toBeLessThanOrEqual(ARMOR_TIER_CAP[skill]!);
      }
    }
    console.info(`[threat] tier-0 raids: ${total} enemies, weapons ${[...seen].map(([k, v]) => `${k.split('.').pop()}×${v}`).join(', ')}`);
  });

  it('later tiers bring rifles, marksmen, armor and (tier 3) elites; the commander fights at full skill', () => {
    const count = (stage: number, dest: string, n: number) => {
      const c = { rifle: 0, marksman: 0, elite: 0, armored: 0, enemies: 0, bossSkill: -1 };
      for (let i = 0; i < n; i++) {
        const sim = raid(stage, dest, `late-${stage}-${dest}-${i}`);
        for (const e of enemies(sim)) {
          c.enemies++;
          if (RIFLES.has(weaponOf(sim, e))) c.rifle++;
          if (e.archetypeId === 'core.enemy.marksman') c.marksman++;
          if (e.archetypeId === 'core.enemy.elite') c.elite++;
          if (armorTier(sim, e, 'vest') >= 2) c.armored++;
          if (e.archetypeId === 'core.enemy.boss') c.bossSkill = e.ai!.skill ?? -1;
        }
      }
      return c;
    };
    const t1 = count(1, MAIN, 20);
    const t2 = count(2, MAIN, 20);
    const t3 = count(3, MAIN, 20);
    const outer = count(2, OUTER, 20);
    console.info(`[threat] per 20 raids: tier1 ${JSON.stringify(t1)} tier2 ${JSON.stringify(t2)} tier3 ${JSON.stringify(t3)} outer@2 ${JSON.stringify(outer)}`);
    expect(t1.elite).toBe(0);
    expect(t2.rifle).toBeGreaterThan(t1.rifle);
    expect(t2.marksman).toBeGreaterThan(0);
    expect(t3.elite).toBeGreaterThan(0);
    expect(t3.armored).toBeGreaterThan(t1.armored);
    expect(outer.elite, 'the outer route is a tier harder than the main zone').toBeGreaterThan(0);
    expect(t3.bossSkill, 'Q08 commander spawns at tier 3').toBe(3);
  });

  it('a raid launched without a threat (older snapshots, test launches) keeps the authored loadouts and skill', () => {
    const t = world(arena('threat.legacy', 20, 10), 2, 5);
    const legacy = spawnEnemy(t.content, t.ctx.sim, 'core.enemy.sentry', 10, 5, Rng.fromSeed('threat-legacy'));
    expect(legacy.ai!.skill).toBeUndefined();
    // Same seed with a threat: the same number of random draws, only the pools / caps / skill change.
    const scaled = spawnEnemy(t.content, t.ctx.sim, 'core.enemy.sentry', 12, 5, Rng.fromSeed('threat-legacy'), { threat: 0 });
    expect(scaled.ai!.skill).toBe(0);
    expect(scaled.aim.dirX).toBeCloseTo(legacy.aim.dirX, 12);
    expect(armorTier(t.ctx.sim, scaled, 'vest')).toBe(0);
    expect(armorTier(t.ctx.sim, scaled, 'helmet')).toBe(0);
  });

  it('a tier-0 enemy needs longer to confirm and answer than the authored (tier-2) one', () => {
    const COMBAT: AIMode[] = ['Combat', 'Cover', 'Flank', 'Reload'];
    const firstShot = (threat: number | undefined): { combat: number; shot: number } => {
      const t = world(arena(`threat.skill.${threat}`, 30, 10), 18, 5);
      t.player.hp = t.player.maxHp = 1e5;
      // Seed a08-3 rolls a P9 for the sentry with or without the threat filter.
      const e = spawnEnemy(t.content, t.ctx.sim, 'core.enemy.sentry', 5, 5, Rng.fromSeed('a08-3'), threat === undefined ? {} : { threat });
      expect(activeWeaponItem(t.ctx, e)!.item.definitionId).toBe('core.weapon.p9');
      const ang = Math.atan2(0, 13);
      e.aim.dirX = Math.cos(ang);
      e.aim.dirY = Math.sin(ang);
      e.ai!.facing = ang;
      e.ai!.nextDecisionAt = 1e9;
      let combat = -1;
      for (let i = 1; i <= 600; i++) {
        tick(t, null);
        if (combat < 0 && COMBAT.includes(e.ai!.mode)) combat = i;
        if (t.ctx.sim.fx.some((f) => f.t === 'shot' && f.actorId === e.id)) return { combat, shot: i };
      }
      return { combat, shot: -1 };
    };
    const base = firstShot(undefined);
    const easy = firstShot(0);
    expect(base.shot).toBeGreaterThan(0);
    expect(easy.combat).toBeGreaterThan(base.combat);
    expect(easy.shot).toBeGreaterThan(base.shot);
  });
});
