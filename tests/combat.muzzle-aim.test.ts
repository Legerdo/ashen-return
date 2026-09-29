import { describe, expect, it } from 'vitest';
import { LOW_COVER, NEAR_ENTER_PX, NEAR_EXIT_PX, updateAim } from '../src/combat/aim';
import { newActor } from '../src/world/spawn';
import { aimCmd, arena, equip, settle, target, tick, world } from './helpers';

describe('A03 muzzle in wall and low-cover close shooting', () => {
  it('muzzle inside a high wall collides at the wall; target right behind is untouched', () => {
    const map = arena('test.a03a', 30, 10, (b) => {
      b.box('core.ob.wall_concrete', 3.4, 2, 4.0, 8, 3, { id: 'wall' });
    });
    const t = world(map, 3.05, 5);
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.ar556', 'core.ammo.556.ap');
    const tg = target(t, 4.8, 5, { hp: 500 });
    tick(t, aimCmd(4.8, 5, 1.0, {}, tg.id), 2);
    expect(t.player.aim.muzzleBlocked).toBe(true);
    tick(t, aimCmd(4.8, 5, 1.0, { firePressed: true, fireHeld: true }, tg.id));
    settle(t);
    expect(tg.hp).toBe(500);
    expect(t.ctx.sim.shotLog[0]!.firstHit).toBe('obstacle:wall');
  });
  it('low barricade (1.15u) within 0.35u: blocked at 1.0u, raised to 1.35u after ~0.18s then clears it', () => {
    const map = arena('test.a03b', 30, 10, (b) => {
      b.box('core.ob.sandbag', 3.0, 3.5, 3.5, 6.5, 1.15, { id: 'low' });
    });
    const t = world(map, 2.6, 5);
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj');
    const tg = target(t, 8, 5, { hp: 500 });
    tick(t, aimCmd(8, 5, 1.3, {}, tg.id), 1);
    expect(t.player.aim.lowCoverAhead).toBe(true);
    expect(t.player.handling.muzzleZ).toBeLessThan(LOW_COVER.raisedMuzzleZ);
    // Fire immediately: still low → hits barricade.
    tick(t, aimCmd(8, 5, 1.3, { firePressed: true, fireHeld: true }, tg.id));
    settle(t, 60, aimCmd(8, 5, 1.3, {}, tg.id));
    expect(tg.hp).toBe(500);
    // Wait for the raise (0.18s ≈ 11 ticks).
    tick(t, aimCmd(8, 5, 1.3, {}, tg.id), 12);
    expect(t.player.handling.muzzleZ).toBeCloseTo(LOW_COVER.raisedMuzzleZ, 6);
    tick(t, aimCmd(8, 5, 1.3, { firePressed: true, fireHeld: true }, tg.id));
    settle(t, 60, aimCmd(8, 5, 1.3, {}, tg.id));
    expect(tg.hp).toBeLessThan(500);
  });
  it('raise takes about 0.18s (not instant)', () => {
    const map = arena('test.a03c', 30, 10, (b) => b.box('core.ob.sandbag', 3.0, 3.5, 3.5, 6.5, 1.15));
    const t = world(map, 2.6, 5);
    equip(t, 'core.weapon.p9', 'core.ammo.9.fmj');
    let ticks = 0;
    while (t.player.handling.muzzleZ < LOW_COVER.raisedMuzzleZ - 1e-9 && ticks < 60) {
      tick(t, aimCmd(8, 5, 1.2));
      ticks++;
    }
    expect(ticks / 60).toBeGreaterThanOrEqual(0.16);
    expect(ticks / 60).toBeLessThanOrEqual(0.2);
  });
  it('crouched or facing a high wall: no raise', () => {
    const map = arena('test.a03d', 30, 10, (b) => {
      b.box('core.ob.sandbag', 3.0, 3.5, 3.5, 6.5, 1.15);
      b.box('core.ob.wall_concrete', 3.0, 0.5, 3.5, 2.5, 3);
    });
    const t = world(map, 2.6, 5);
    equip(t, 'core.weapon.p9', 'core.ammo.9.fmj');
    tick(t, aimCmd(8, 5, 1.2, { crouchToggle: true }));
    tick(t, aimCmd(8, 5, 1.2), 20);
    expect(t.player.handling.muzzleZ).toBeCloseTo(0.8, 6);
    const t2 = world(map, 2.6, 1.5);
    equip(t2, 'core.weapon.p9', 'core.ammo.9.fmj');
    tick(t2, aimCmd(8, 1.5, 1.2), 20);
    expect(t2.player.handling.muzzleZ).toBeCloseTo(1.0, 6);
  });
});

describe('A05 near-cursor stabilization: no NaN, no spin, no flip jitter', () => {
  function actor() {
    const a = newActor('p', 'player', 10, 10, 100, 'player');
    a.aim.dirX = 1;
    a.aim.dirY = 0;
    return a;
  }
  it('cursor exactly on the anchor keeps the last valid direction', () => {
    const a = actor();
    updateAim(a, { x: 10, y: 10, z: 1, actorId: null, viewDistPx: 0 });
    expect(Number.isFinite(a.aim.dirX) && Number.isFinite(a.aim.dirY)).toBe(true);
    expect(a.aim.dirX).toBe(1);
    expect(a.aim.dirY).toBe(0);
  });
  it('small circles inside 12px freeze the direction; NaN never appears', () => {
    const a = actor();
    for (let i = 0; i < 720; i++) {
      const th = (i / 360) * Math.PI * 2;
      const px = 5 * Math.cos(th);
      const py = 5 * Math.sin(th);
      updateAim(a, { x: 10 + px / 16, y: 10 + py / 16, z: 1, actorId: null, viewDistPx: Math.hypot(px, py) });
      expect(Number.isNaN(a.aim.dirX) || Number.isNaN(a.aim.dirY)).toBe(false);
      expect(a.aim.dirX).toBe(1);
    }
  });
  it('hysteresis: enters dead zone below 12px, resumes only above 18px', () => {
    const a = actor();
    updateAim(a, { x: 10, y: 11, z: 1, actorId: null, viewDistPx: NEAR_ENTER_PX - 1 });
    expect(a.aim.tracking).toBe(false);
    updateAim(a, { x: 10, y: 11, z: 1, actorId: null, viewDistPx: 15 });
    expect(a.aim.tracking).toBe(false);
    expect(a.aim.dirX).toBe(1);
    updateAim(a, { x: 10, y: 11, z: 1, actorId: null, viewDistPx: NEAR_EXIT_PX + 1 });
    expect(a.aim.tracking).toBe(true);
    expect(a.aim.dirY).toBeCloseTo(1, 6);
  });
  it('circular motion at 30px follows smoothly without 360° jumps', () => {
    const a = actor();
    let prev = Math.atan2(a.aim.dirY, a.aim.dirX);
    for (let i = 0; i <= 720; i++) {
      const th = (i / 360) * Math.PI * 2;
      updateAim(a, { x: 10 + (30 / 16) * Math.cos(th), y: 10 + (30 / 16) * Math.sin(th), z: 1, actorId: null, viewDistPx: 30 });
      const ang = Math.atan2(a.aim.dirY, a.aim.dirX);
      let d = Math.abs(ang - prev);
      if (d > Math.PI) d = Math.PI * 2 - d;
      expect(d).toBeLessThan(0.05);
      prev = ang;
    }
  });
  it('vertical cursor sweep across the anchor does not oscillate the facing', () => {
    const a = actor();
    let flips = 0;
    let last = a.aim.faceRight;
    for (let i = 0; i < 400; i++) {
      const dx = (i % 2 === 0 ? 1 : -1) * 0.05; // ±0.05u jitter around the anchor column
      const dy = i % 4 < 2 ? 3 : -3;
      updateAim(a, { x: 10 + dx, y: 10 + dy, z: 1, actorId: null, viewDistPx: 48 });
      if (a.aim.faceRight !== last) flips++;
      last = a.aim.faceRight;
    }
    expect(flips).toBe(0);
  });
});
