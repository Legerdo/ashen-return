import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { TUTORIAL_DOOR, TUTORIAL_EXIT, TUTORIAL_MOVE_SPOT, TUTORIAL_THROW_SPOT } from '../src/content/maps/tutorial';
import { SIM_DT } from '../src/core/clock';
import { validateStore } from '../src/inventory/store';
import { idleCommand, type PlayerCommand, type RaidOp } from '../src/world/command';
import { activeWeaponItem, allCarriedItemIds, type SimContext } from '../src/world/context';
import { stepSim } from '../src/world/sim';
import type { ActorState } from '../src/world/state';
import { CRATE_CID, createTutorialSim, TUTORIAL_STEPS, TutorialDirector, type TutorialStepId } from '../src/world/tutorial';

const content = createContent();

interface Run {
  ctx: SimContext;
  dir: TutorialDirector;
  pl: ActorState;
  done: TutorialStepId[];
  tick: (cmd?: Partial<PlayerCommand>, ops?: RaidOp[], panel?: string | null) => void;
  until: (pred: () => boolean, cmd: () => Partial<PlayerCommand>, max: number, what: string) => void;
  walkTo: (x: number, y: number) => void;
}

function run(startStep = 0): Run {
  const ctx = createTutorialSim(content, 'tutorial-test');
  const dir = new TutorialDirector(ctx, startStep);
  const pl = ctx.sim.actors.find((a) => a.kind === 'player')!;
  const done: TutorialStepId[] = [];
  const aimAt = (x: number, y: number, z = 1.1) => ({ x, y, z, actorId: null, viewDistPx: 999 });
  const r: Run = {
    ctx,
    dir,
    pl,
    done,
    tick: (cmd = {}, ops = [], panel = null) => {
      stepSim(ctx, { cmd: { ...idleCommand(), aim: aimAt(pl.x + 3, pl.y), ...cmd }, ops }, SIM_DT);
      const fx = ctx.sim.fx;
      ctx.sim.fx = [];
      const d = dir.update(SIM_DT, fx, panel);
      if (d) done.push(d);
    },
    until: (pred, cmd, max, what) => {
      for (let i = 0; i < max && !pred(); i++) r.tick(cmd());
      expect(pred(), what).toBe(true);
    },
    walkTo: (x, y) => {
      r.until(
        () => Math.hypot(pl.x - x, pl.y - y) < 0.25,
        () => {
          const dx = x - pl.x;
          const dy = y - pl.y;
          const d = Math.max(1e-6, Math.hypot(dx, dy));
          return { moveX: dx / d, moveY: dy / d, aim: aimAt(x, y) };
        },
        60 * 20,
        `walk to (${x}, ${y})`,
      );
    },
  };
  return r;
}

const aim = (x: number, y: number, z = 1.1) => ({ x, y, z, actorId: null, viewDistPx: 999 });

describe('tutorial course: training sim + director', () => {
  it('the course is a raid-rules training sim with an invulnerable player, a stocked crate, three targets and a free exit', () => {
    const { ctx, pl } = run();
    expect(ctx.sim.mode).toBe('raid');
    expect(ctx.sim.training).toBe(true);
    expect(pl.invulnerable).toBe(true);
    expect(activeWeaponItem(ctx, pl)!.item.definitionId).toBe('core.weapon.p9');
    const crate = ctx.sim.store.containers[CRATE_CID]!.items.map((id) => `${ctx.sim.store.items[id]!.definitionId}×${ctx.sim.store.items[id]!.quantity}`).sort();
    expect(crate).toEqual(['core.med.bandage×2', 'core.throw.smoke×1']);
    expect(ctx.sim.actors.filter((a) => a.kind === 'dummy').map((a) => a.id).sort()).toEqual(['dummy-far', 'dummy-melee', 'dummy-near']);
    expect(ctx.sim.exits[TUTORIAL_EXIT]).toEqual({ progress: 0, enabled: true });
    expect(ctx.sim.doors[TUTORIAL_DOOR]!.open).toBe(false);
    expect(validateStore(ctx.sim.store, content)).toEqual([]);
  });

  it('plays through all 15 lessons with ordinary commands, ending with a real 5 s extraction', () => {
    const r = run();
    const { ctx, pl, dir } = r;
    ctx.sim.debug.noSpread = true; // deterministic aimed shots at 19u (the E2E course uses real mouse input)
    const is = (id: TutorialStepId) => () => r.done.includes(id);
    // 1 move → marked spot.
    r.walkTo(TUTORIAL_MOVE_SPOT.x, TUTORIAL_MOVE_SPOT.y);
    r.tick();
    expect(r.done).toEqual(['move']);
    // 2 sprint (stamina stays full in training).
    r.until(is('sprint'), () => ({ moveX: -1, moveY: -0.3, sprint: true }), 120, 'sprint lesson');
    expect(pl.stamina).toBe(pl.staminaMax);
    // 2b dodge: two rolls (the second only after the short recovery); free in training.
    expect(dir.id).toBe('dodge');
    const y0 = pl.y;
    r.tick({ dodge: true, moveY: -1 });
    expect(pl.action?.type).toBe('dodge');
    expect(dir.progress).toBe(1);
    r.until(() => !pl.action, () => ({}), 60, 'first roll over');
    expect(y0 - pl.y).toBeGreaterThan(2.5);
    r.tick({ dodge: true, moveY: 1 });
    expect(dir.progress, 'no second roll during the recovery').toBe(1);
    r.until(is('dodge'), () => ({ dodge: true, moveY: 1 }), 60, 'dodge lesson');
    expect(pl.stamina).toBe(pl.staminaMax);
    r.until(() => !pl.action, () => ({}), 60, 'second roll over');
    // 3 crouch, then stand up again.
    r.tick({ crouchToggle: true });
    expect(r.done).toContain('crouch');
    r.tick({ crouchToggle: true });
    expect(pl.stance).toBe('stand');
    // 4 door (E).
    r.walkTo(13.4, 11);
    r.until(is('door'), () => ({ interact: true, aim: aim(15, 11) }), 30, 'door lesson');
    // 5 loot: open the crate, wait for the search, take all.
    r.walkTo(16.5, 11);
    r.walkTo(20, 7.3);
    r.tick({ interact: true, aim: aim(20, 6) });
    expect(ctx.sim.loot?.containerId).toBe(CRATE_CID);
    r.until(() => ctx.sim.containers[CRATE_CID]!.searched >= 2, () => ({ aim: aim(20, 6) }), 120, 'crate searched');
    r.tick({}, [{ op: 'takeAll' }]);
    r.tick();
    expect(r.done).toContain('loot');
    const band = allCarriedItemIds(ctx.sim, pl).find((id) => ctx.sim.store.items[id]!.definitionId === 'core.med.bandage')!;
    expect(pl.quickslots[0], 'bandage auto-assigned to quickslot 4').toBe(band);
    r.tick({}, [{ op: 'closeLoot' }]);
    // 6 inventory (Tab opens the inventory panel).
    r.tick({}, [], 'inventory');
    expect(r.done).toContain('inventory');
    // 7 shoot: three hits on the near target.
    r.walkTo(28.6, 9.6);
    const near = ctx.sim.actors.find((a) => a.id === 'dummy-near')!;
    for (let i = 0; i < 40 && !r.done.includes('shoot'); i++) {
      r.tick({ aim: aim(near.x, near.y), firePressed: true, fireHeld: true });
      for (let k = 0; k < 14; k++) r.tick({ aim: aim(near.x, near.y) });
    }
    expect(r.done).toContain('shoot');
    // 8 ADS: aimed hit on the far target.
    const far = ctx.sim.actors.find((a) => a.id === 'dummy-far')!;
    for (let k = 0; k < 60; k++) r.tick({ aim: aim(far.x, far.y), adsHeld: true });
    for (let i = 0; i < 30 && !r.done.includes('ads'); i++) {
      r.tick({ aim: aim(far.x, far.y), adsHeld: true, firePressed: true, fireHeld: true });
      for (let k = 0; k < 20; k++) r.tick({ aim: aim(far.x, far.y), adsHeld: true });
    }
    expect(r.done).toContain('ads');
    // 9 reload (R): one-shot swap from the training reserve.
    r.until(() => !pl.action, () => ({}), 120, 'idle before reload');
    r.tick({ reload: true });
    expect(pl.action?.type).toBe('reload');
    r.until(is('reload'), () => ({}), 180, 'reload lesson');
    // 10 melee (V) on the close target.
    const mel = ctx.sim.actors.find((a) => a.id === 'dummy-melee')!;
    r.walkTo(mel.x - 0.8, mel.y);
    r.until(is('melee'), () => ({ melee: true, aim: aim(mel.x, mel.y) }), 120, 'melee lesson');
    // 11 throw (G release) at the marked spot (step around the melee target first).
    r.walkTo(mel.x - 0.8, mel.y + 1.6);
    r.walkTo(36, 15.5);
    r.until(() => !pl.action, () => ({}), 120, 'idle before throw');
    r.tick({ throwPressed: true, aim: aim(TUTORIAL_THROW_SPOT.x, TUTORIAL_THROW_SPOT.y, 0) });
    r.until(is('throw'), () => ({ aim: aim(TUTORIAL_THROW_SPOT.x, TUTORIAL_THROW_SPOT.y, 0) }), 180, 'throw lesson');
    // 12 heal: the lesson starts bleeding; the bandage on quickslot 4 stops it.
    expect(dir.id).toBe('heal');
    expect(pl.status.bleeding).toBe(true);
    expect(pl.hp).toBeLessThanOrEqual(70);
    r.until(() => !pl.action, () => ({}), 120, 'idle before heal');
    r.tick({ quickslot: 0 });
    expect(pl.action?.type).toBe('heal');
    r.until(is('heal'), () => ({}), 60 * 8, 'heal lesson');
    // 13 map (M).
    r.tick({}, [], 'map');
    expect(r.done).toContain('map');
    // 14 extract: stand in the exit for 5 s.
    r.walkTo(46, 17);
    r.walkTo(52, 17);
    r.until(is('extract'), () => ({}), 60 * 7, 'extraction');
    expect(ctx.sim.outcome).toMatchObject({ kind: 'extracted', exitId: TUTORIAL_EXIT });
    expect(r.done).toEqual([...TUTORIAL_STEPS]);
    expect(dir.finished).toBe(true);
    expect(validateStore(ctx.sim.store, content)).toEqual([]);
  });

  it('resuming at a later lesson re-applies earlier world changes (door open, crate taken, quickslot set)', () => {
    const { ctx, pl, dir } = run(TUTORIAL_STEPS.indexOf('shoot'));
    expect(dir.id).toBe('shoot');
    expect(ctx.sim.doors[TUTORIAL_DOOR]!.open).toBe(true);
    expect(ctx.sim.store.containers[CRATE_CID]!.items).toEqual([]);
    const carried = allCarriedItemIds(ctx.sim, pl).map((id) => ctx.sim.store.items[id]!.definitionId);
    expect(carried).toContain('core.med.bandage');
    expect(carried).toContain('core.throw.smoke');
    expect(ctx.sim.store.items[pl.quickslots[0]!]!.definitionId).toBe('core.med.bandage');
    expect(validateStore(ctx.sim.store, content)).toEqual([]);
  });

  it('every lesson stays completable: a full gun is part-emptied for the reload lesson, a used-up smoke / bandage is replaced', () => {
    const r = run(TUTORIAL_STEPS.indexOf('reload'));
    const w = activeWeaponItem(r.ctx, r.pl)!.item;
    const mag = r.ctx.sim.store.items[w.weapon!.magazineId!]!;
    expect(mag.mag!.rounds.length).toBeLessThan(15);
    r.tick({ reload: true });
    expect(r.pl.action?.type).toBe('reload');

    const t = run(TUTORIAL_STEPS.indexOf('throw'));
    // The resumed course moved the crate's smoke into the bag; drop it to simulate having thrown it earlier.
    for (const id of allCarriedItemIds(t.ctx.sim, t.pl)) if (t.ctx.sim.store.items[id]?.definitionId === 'core.throw.smoke') delete t.ctx.sim.store.items[id];
    for (const c of Object.values(t.ctx.sim.store.containers)) c.items = c.items.filter((id) => t.ctx.sim.store.items[id]);
    const again = new TutorialDirector(t.ctx, TUTORIAL_STEPS.indexOf('throw'));
    expect(again.gifts).toEqual(['core.throw.smoke']);
    expect(allCarriedItemIds(t.ctx.sim, t.pl).some((id) => t.ctx.sim.store.items[id]!.definitionId === 'core.throw.smoke')).toBe(true);
  });
});
