import { describe, expect, it } from 'vitest';
import { actorEntry, collectCandidates, sortCandidates, type ActorShape, type Candidate } from '../src/combat/ballistics';
import { createContent } from '../src/content/core';
import { aimCmd, arena, equip, settle, target, tick, world } from './helpers';

const content = createContent();
const standing = content.hitbox('core.hitbox.standing');

function shape(x: number, y: number, profile = standing): ActorShape {
  return { id: 'T', team: 'hostile', x, y, facingX: -1, facingY: 0, profile, floor: 0 };
}

describe('A01 head/body boundaries, decorative margins, armor part independence', () => {
  const T = shape(10, 5);
  const ray = (z: number, y = 5) => actorEntry(T, { x: 0, y, z }, { x: 20, y: 0, z: 0 });
  it('z just below 1.40 is body, 1.40 and 1.80 are head, above 1.80 misses', () => {
    expect(ray(1.3999)?.part).toBe('body');
    expect(ray(1.4)?.part).toBe('head');
    expect(ray(1.8)?.part).toBe('head');
    expect(ray(1.8001)).toBeNull();
  });
  it('body lower boundary 0.35 and limb below', () => {
    expect(ray(0.35)?.part).toBe('body');
    expect(ray(0.3499)?.part).toBe('limb');
  });
  it('decorative margin outside the volumes never hits (wing/feathers at 0.32u offset, crest above head)', () => {
    expect(ray(1.0, 5 + 0.31)).toBeNull();
    expect(ray(1.6, 5 + 0.25)).toBeNull();
    expect(ray(1.95)).toBeNull();
  });
  it('crouched profile lowers the head volume', () => {
    const C = shape(10, 5, content.hitbox('core.hitbox.crouched'));
    expect(actorEntry(C, { x: 0, y: 5, z: 1.0 }, { x: 20, y: 0, z: 0 })?.part).toBe('head');
    expect(actorEntry(C, { x: 0, y: 5, z: 1.3 }, { x: 20, y: 0, z: 0 })).toBeNull();
  });
  it('helmet protects only the head, vest only the body', () => {
    const map = arena('test.a01', 30, 10);
    const run = (z: number, opts: { vest?: number; helmet?: number }) => {
      const t = world(map, 2, 5);
      t.ctx.sim.debug.noSpread = true;
      equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj');
      const tg = target(t, 10, 5, { ...opts, hp: 500 });
      tick(t, aimCmd(10, 5, z, {}, tg.id));
      tick(t, aimCmd(10, 5, z, { firePressed: true, fireHeld: true }, tg.id));
      settle(t);
      const eq = (slot: string) => {
        const id = t.ctx.sim.store.containers[`eq:${tg.id}:${slot}`]!.items[0];
        return id ? t.ctx.sim.store.items[id]!.durability : null;
      };
      return { lost: 500 - tg.hp, vest: eq('vest'), helmet: eq('helmet') };
    };
    const helmetBody = run(1.0, { helmet: 2 });
    expect(helmetBody.lost).toBeCloseTo(30, 6);
    expect(helmetBody.helmet).toBe(55);
    const vestHead = run(1.6, { vest: 2 });
    expect(vestHead.lost).toBeCloseTo(60, 6);
    expect(vestHead.vest).toBe(80);
    const helmetHead = run(1.6, { helmet: 2 });
    expect(helmetHead.lost).toBeCloseTo(21.75, 6);
    expect(helmetHead.helmet).toBeCloseTo(55 - 52.5, 6);
  });
});

describe('A02 continuous collision, candidate ordering, penetration', () => {
  it('260u/s bolt round cannot tunnel through a thin target (4.3u per tick)', () => {
    const map = arena('test.a02a', 80, 10);
    const t = world(map, 2, 5);
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.bolt', 'core.ammo.762d.fmj');
    const tg = target(t, 40, 5, { hp: 500 });
    tick(t, aimCmd(40, 5, 1.0, {}, tg.id));
    tick(t, aimCmd(40, 5, 1.0, { firePressed: true, fireHeld: true }, tg.id));
    settle(t);
    expect(500 - tg.hp).toBeGreaterThan(70);
    expect(t.ctx.sim.shotLog[0]!.firstHit).toBe(`actor:${tg.id}`);
  });
  it('minimum t wins regardless of candidate insertion order', () => {
    const cands: Candidate[] = [
      { kind: 'ground', t: 0.9, key: 'g' },
      { kind: 'actor', t: 0.4, key: 'a:B', actorId: 'B', part: 'body' },
      { kind: 'actor', t: 0.2, key: 'a:A', actorId: 'A', part: 'head' },
    ];
    for (let i = 0; i < 6; i++) {
      const shuffled = [...cands].sort(() => (i % 2 === 0 ? 1 : -1));
      const sorted = sortCandidates(shuffled);
      expect(sorted.map((c) => c.key)).toEqual(['a:A', 'a:B', 'g']);
    }
  });
  it('an obstacle registered later but nearer is hit first', () => {
    const map = arena('test.a02b', 40, 10, (b) => {
      b.box('core.ob.wall_concrete', 20, 3, 21, 7, 3, { id: 'far' });
      b.box('core.ob.wall_concrete', 10, 3, 11, 7, 3, { id: 'near' });
    });
    const t = world(map, 2, 5);
    const list = collectCandidates({ x: 2, y: 5, z: 1 }, { x: 30, y: 0, z: 0 }, 0, t.ctx.geo, t.ctx.sim, [], 'player', []);
    const obs = list.filter((c) => c.kind === 'obstacle') as Extract<Candidate, { kind: 'obstacle' }>[];
    expect(obs[0]!.ob.id).toBe('near');
  });
  it('overlapping targets: the front target absorbs a non-penetrating round', () => {
    const map = arena('test.a02c', 40, 10);
    const t = world(map, 2, 5);
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.dmr', 'core.ammo.762d.ap');
    const front = target(t, 12, 5, { hp: 500, id: 'front' });
    const back = target(t, 13.2, 5, { hp: 500, id: 'back' });
    tick(t, aimCmd(12, 5, 1.0, {}, front.id));
    tick(t, aimCmd(12, 5, 1.0, { firePressed: true, fireHeld: true }, front.id));
    settle(t);
    expect(front.hp).toBeLessThan(500);
    expect(back.hp).toBe(500);
  });
  it('max two environment penetrations; concrete stops everything', () => {
    const map = arena('test.a02d', 40, 10, (b) => {
      b.box('core.ob.glass', 8, 3, 8.1, 7, 2.5, { id: 'g1' });
      b.box('core.ob.glass', 10, 3, 10.1, 7, 2.5, { id: 'g2' });
      b.box('core.ob.glass', 12, 3, 12.1, 7, 2.5, { id: 'g3' });
      b.box('core.ob.wall_concrete', 20, 3, 20.3, 7, 3, { id: 'c' });
    });
    const t = world(map, 2, 5);
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.ar556', 'core.ammo.556.ap');
    const behind = target(t, 15, 5, { hp: 500 });
    tick(t, aimCmd(15, 5, 1.0, {}, behind.id));
    tick(t, aimCmd(15, 5, 1.0, { firePressed: true, fireHeld: true }, behind.id));
    settle(t);
    expect(behind.hp).toBe(500);
    expect(t.ctx.sim.shotLog[0]!.firstHit).toBe('obstacle:g3');
    const t2 = world(map, 2, 5);
    t2.ctx.sim.debug.noSpread = true;
    equip(t2, 'core.weapon.bolt', 'core.ammo.762d.ap');
    const past = target(t2, 22, 5, { hp: 500 });
    tick(t2, aimCmd(22, 5, 1.0));
    tick(t2, aimCmd(22, 5, 1.0, { firePressed: true, fireHeld: true }));
    settle(t2);
    expect(past.hp).toBe(500);
  });
  it('a pellet never damages the same body twice', () => {
    const map = arena('test.a02e', 30, 10);
    const t = world(map, 2, 5);
    t.ctx.sim.debug.noSpread = true;
    equip(t, 'core.weapon.p9', 'core.ammo.9.fmj');
    const tg = target(t, 8, 5, { hp: 500 });
    tick(t, aimCmd(8, 5, 1.0, {}, tg.id));
    tick(t, aimCmd(8, 5, 1.0, { firePressed: true, fireHeld: true }, tg.id));
    settle(t);
    expect(500 - tg.hp).toBeCloseTo(24, 6);
  });
});
