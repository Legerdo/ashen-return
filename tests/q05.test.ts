import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { Q05_LOW_POI, Q05_ZONE_POI } from '../src/content/maps/shelter';
import { SIM_DT } from '../src/core/clock';
import { rectContains } from '../src/core/math';
import { rangeDrillGuides, shelterGuides } from '../src/progression/guidance';
import { newProfile } from '../src/progression/profile';
import { applyQuestEvent } from '../src/progression/quests';
import { createBaseSim, turretMuzzle } from '../src/world/range';
import { stepSim } from '../src/world/sim';
import { aimCmd } from './helpers';

/** Q05 (optional cover drill) through the real shelter sim: what the objectives ask for is where the markers point. */

const content = createContent();
const Q05 = 'core.quest.q05_cover';
const shelter = content.map('core.map.shelter');
const zone = shelter.turrets![0]!.zone;
const poi = (id: string) => shelter.pois.find((p) => p.id === id)!;

describe('Q05 cover drill', () => {
  it('the objective text names the marked zone and the low-cover spot; drill markers exist only for unfinished drill objectives', () => {
    const q = content.quest(Q05);
    expect(content.t(q.objectives.find((o) => o.id === 'wall')!.descKey)).toContain('엄폐 훈련 구역');
    expect(content.t(q.objectives.find((o) => o.id === 'low')!.descKey)).toContain('모래주머니');
    expect(rectContains(zone, poi(Q05_ZONE_POI).x, poi(Q05_ZONE_POI).y), 'zone marker inside the turret zone').toBe(true);
    const p = newProfile(content, 1, 'Q05', 'q05-guides', 0);
    expect(rangeDrillGuides(p, content), 'not active yet').toEqual([]);
    p.quests[Q05] = { status: 'active', progress: {} };
    expect(rangeDrillGuides(p, content).map((g) => g.placeId)).toEqual([Q05_ZONE_POI, Q05_LOW_POI]);
    // Optional drills never enter the always-on shelter guidance.
    expect(shelterGuides(p, content).some((g) => g.questId === Q05)).toBe(false);
    applyQuestEvent(p, content, { type: 'Custom', target: 'range_wall_block', amount: 3 });
    expect(rangeDrillGuides(p, content).map((g) => g.placeId)).toEqual([Q05_LOW_POI]);
    applyQuestEvent(p, content, { type: 'Custom', target: 'range_low_cover', amount: 1 });
    expect(rangeDrillGuides(p, content)).toEqual([]);
    expect(p.quests[Q05]!.status).toBe('ready');
  });

  it('anywhere inside the marked zone the high wall shadows the turret: its rounds are blocked and counted', () => {
    const ctx = createBaseSim(content, { seed: 'q05', flags: {}, perks: {}, weaponDefId: 'core.weapon.p9', extraObstacles: [] });
    const turret = shelter.turrets![0]!;
    // The barrel clears the turret's own machine prop: aimed away from the zone, nothing stops the round early.
    const free = turretMuzzle(turret, turret.x + 5, turret.y - 5);
    expect(ctx.geo.projectileClear(ctx.sim, free, { x: turret.x + 4, y: turret.y - 4, z: free.z }, 0), 'muzzle outside the turret prop').toBe(true);
    // Every standing body point in the zone (inset by the body radius) is behind the high wall as seen from the barrel.
    for (let x = zone.x + 0.3; x <= zone.x + zone.w - 0.3 + 1e-9; x += (zone.w - 0.6) / 6)
      for (let y = zone.y + 0.3; y <= zone.y + zone.h - 0.3 + 1e-9; y += (zone.h - 0.6) / 4)
        for (const z of [0.6, 1.1, 1.5]) {
          const m = turretMuzzle(turret, x, y);
          expect(ctx.geo.projectileClear(ctx.sim, m, { x, y, z }, 0), `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z})`).toBe(false);
          // …and it is the high wall that stops it (the drill's point): the same line without the wall is open.
          expect(ctx.geo.projectileClear(ctx.sim, m, { x: 27.9, y: m.y + ((y - m.y) * (m.x - 27.9)) / (m.x - x), z: m.z }, 0), 'open up to the wall').toBe(true);
        }
    const pl = ctx.sim.actors.find((a) => a.kind === 'player')!;
    const at = poi(Q05_ZONE_POI);
    pl.x = pl.px = at.x;
    pl.y = pl.py = at.y;
    const hp = pl.hp;
    let hitsOnPlayer = 0;
    const impacts: string[] = [];
    for (let i = 0; i < 60 * 5; i++) {
      stepSim(ctx, { cmd: aimCmd(at.x + 3, at.y, 1.1), ops: [] }, SIM_DT);
      hitsOnPlayer += ctx.sim.fx.filter((f) => f.t === 'hit' && f.actorId === pl.id).length;
      for (const f of ctx.sim.fx) if (f.t === 'impact') impacts.push(`${f.material}@${f.x.toFixed(1)}`);
      ctx.sim.fx = [];
    }
    // One round every 1.2 s: 5 rounds in 5 s, every one stopped by the high wall's east face (x = 27.6).
    expect(ctx.sim.range!.wallBlocks, 'rounds blocked by the wall within 5 s in the zone').toBe(5);
    expect(impacts).toEqual(Array.from({ length: 5 }, () => 'concrete@27.6'));
    expect(hitsOnPlayer).toBe(0);
    expect(pl.hp).toBe(hp);
  });

  it('from the low-cover spot the muzzle rises over the sandbag and a target hit counts as a low-cover hit', () => {
    const ctx = createBaseSim(content, { seed: 'q05-low', flags: {}, perks: {}, weaponDefId: 'core.weapon.p9', extraObstacles: [] });
    ctx.sim.debug.noSpread = true;
    const pl = ctx.sim.actors.find((a) => a.kind === 'player')!;
    const at = poi(Q05_LOW_POI);
    pl.x = pl.px = at.x;
    pl.y = pl.py = at.y;
    const tgt = ctx.sim.actors.find((a) => a.id === 'dummy-b_low')!;
    const aim = aimCmd(tgt.x, tgt.y, 1.3, {}, tgt.id);
    for (let i = 0; i < 40; i++) stepSim(ctx, { cmd: aim, ops: [] }, SIM_DT);
    expect(pl.aim.lowCoverAhead, 'low cover right ahead of the spot').toBe(true);
    expect(pl.handling.muzzleRaised).toBe(true);
    stepSim(ctx, { cmd: { ...aim, fireHeld: true, firePressed: true }, ops: [] }, SIM_DT);
    for (let i = 0; i < 30; i++) stepSim(ctx, { cmd: aim, ops: [] }, SIM_DT);
    expect(ctx.sim.range!.lowCoverHits).toBe(1);
  });
});
