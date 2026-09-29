import { describe, expect, it } from 'vitest';
import { FixedStepClock } from '../src/core/clock';
import { cameraCenteredOn, clientToView, computeCanvasLayout, viewToClient, viewToWorld, worldToView } from '../src/core/coords';
import { stepSim } from '../src/world/sim';
import { aimCmd, arena, equip, world } from './helpers';

function fireFor(weapon: string, ammo: string, fps: number, seconds: number) {
  const map = arena('test.a04', 60, 10);
  const t = world(map, 2, 5);
  equip(t, weapon, ammo, 6);
  t.ctx.sim.debug.infiniteAmmo = true;
  const clock = new FixedStepClock();
  let first = true;
  const frames = Math.round(seconds * fps);
  for (let f = 0; f < frames; f++) {
    clock.advance(1 / fps, (dt) => {
      stepSim(t.ctx, { cmd: aimCmd(50, 5, 1.0, { fireHeld: true, firePressed: first }), ops: [] }, dt);
      first = false;
    });
  }
  const times = t.ctx.sim.shotLog.filter((s) => s.pelletId === 0).map((s) => Math.round(s.shotTime * 1e6) / 1e6);
  return { shots: t.ctx.sim.stats.shotsFired, times, ticks: clock.tick };
}

describe('A04 fire rate and projection are render-FPS independent', () => {
  it('SM9 (900 RPM) holds identical shot count and shot times at 30/60/144 fps', () => {
    const r30 = fireFor('core.weapon.sm9', 'core.ammo.9.fmj', 30, 1.0);
    const r60 = fireFor('core.weapon.sm9', 'core.ammo.9.fmj', 60, 1.0);
    const r144 = fireFor('core.weapon.sm9', 'core.ammo.9.fmj', 144, 1.0);
    expect(r30.ticks).toBe(r60.ticks);
    expect(r144.ticks).toBe(r60.ticks);
    expect(r30.shots).toBe(r60.shots);
    expect(r144.shots).toBe(r60.shots);
    expect(r30.times).toEqual(r60.times);
    expect(r144.times).toEqual(r60.times);
    // 900 RPM → 15 rounds/s; fixed-step 1s window holds 15 shots (first at t=0).
    expect(r60.shots).toBe(15);
  });
  it('LMG 750 RPM keeps sub-tick shot times (0.08s cadence, not rounded to ticks)', () => {
    const r = fireFor('core.weapon.lmg', 'core.ammo.556.fmj', 60, 1.0);
    for (let i = 1; i < r.times.length; i++) expect(r.times[i]! - r.times[i - 1]!).toBeCloseTo(0.08, 6);
    expect(r.shots).toBe(13);
  });
  it('projection round trip error ≤ 1 internal pixel across DPR and resize', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const [w, h] of [
        [1280, 720],
        [1920, 1080],
        [2560, 1440],
        [1366, 768],
        [800, 600],
      ] as const) {
        const lay = computeCanvasLayout(w, h, dpr);
        const rect = { left: lay.cssLeft, top: lay.cssTop, width: lay.cssWidth, height: lay.cssHeight };
        const cam = cameraCenteredOn(40.3, 22.7, 1);
        for (const [x, y, z] of [
          [40, 22, 0],
          [45.25, 20.1, 1.6],
          [35.9, 26.4, 1.0],
        ] as const) {
          const v = worldToView(cam, x, y, z);
          const c = viewToClient(rect, v.sx, v.sy);
          const back = clientToView(rect, c.clientX, c.clientY);
          expect(Math.abs(back.sx - v.sx)).toBeLessThanOrEqual(1);
          expect(Math.abs(back.sy - v.sy)).toBeLessThanOrEqual(1);
          const wpt = viewToWorld(cam, back.sx, back.sy, z);
          expect(Math.abs(wpt.x - x) * 16).toBeLessThanOrEqual(1);
          expect(Math.abs(wpt.y - y) * 16).toBeLessThanOrEqual(1);
        }
        if (lay.integer) expect(Number.isInteger(lay.scale)).toBe(true);
        // Canvas occupies an exact integer multiple of 640×360 device pixels.
        if (lay.integer) expect(Math.abs(lay.cssWidth * dpr - 640 * lay.scale)).toBeLessThan(1e-6);
      }
    }
  });
});
