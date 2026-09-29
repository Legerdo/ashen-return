import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIO_EVENTS, AUDIO_PALETTES } from '../src/content/audioContent';
import { createContent } from '../src/content/core';
import { AUDIO_BUSES } from '../src/content/types';
import { Rng } from '../src/core/rng';
import { newProfile } from '../src/progression/profile';
import { refreshQuests } from '../src/progression/quests';
import { prepareDeploy } from '../src/progression/raidFlow';
import { soundCueFor, type SoundCue } from '../src/presentation/soundDirector';
import { SAMPLE_RATE, synthesize } from '../src/presentation/synth';
import type { SimContext } from '../src/world/context';
import { createRaidSim, spawnEnemy } from '../src/world/spawn';
import type { SimEvent } from '../src/world/state';
import { aimCmd, arena, equip, tick, world } from './helpers';

/**
 * Procedural audio: every AudioEventDef × variant is rendered through synthesize() exactly like AudioEngine does
 * (AudioEngine.buffer(id, v) calls synthesize(id, v + 1) for v = 0…variants-1, so synth variants are 1-based).
 * AudioEngine itself needs WebAudio and is never instantiated here; soundCueFor() is the pure sim→cue mapping.
 */

const content = createContent();
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** RMS floor for "not silent": 0.01 ≈ −40 dBFS (the quietest real buffer is ~0.037). */
const RMS_FLOOR = 0.01;
/** Loops shorter than this would repeat audibly (ambience beds are 4 s, music pads 16 s). */
const MIN_LOOP_SECONDS = 2;
/** Two variants must differ by at least 5 % of the louder variant's RMS to count as a different take. */
const MIN_VARIANT_DIFF = 0.05;
const REPEATED_FAMILIES = ['gun.', 'impact.', 'step.', 'reload.', 'voice.', 'door.', 'explosion.', 'ui.'];

const isLoop = (id: string): boolean => id.startsWith('amb.') || id.startsWith('music.');

interface Rendered {
  id: string;
  variant: number;
  pcm: Float32Array;
  peak: number;
  rms: number;
  finite: boolean;
  sum: string;
}

/** FNV-1a over the raw float bytes (plus length): equal checksums ⇔ bit-identical buffers (for our purposes). */
function checksum(x: Float32Array): string {
  const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${x.length}:${h.toString(16)}`;
}

function render(id: string, variant: number): Rendered {
  const pcm = synthesize(id, variant);
  let peak = 0;
  let sq = 0;
  let finite = true;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]!;
    if (!Number.isFinite(v)) finite = false;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sq += v * v;
  }
  return { id, variant, pcm, peak, rms: Math.sqrt(sq / Math.max(1, pcm.length)), finite, sum: checksum(pcm) };
}

let cache: Rendered[] | null = null;
/** Every registered event × every variant (1…variants), rendered once. */
function renderAll(): Rendered[] {
  if (!cache) {
    cache = [];
    for (const e of content.audioEvents.values()) for (let v = 1; v <= e.variants; v++) cache.push(render(e.id, v));
  }
  return cache;
}

const variantsOf = (id: string): Rendered[] => renderAll().filter((r) => r.id === id);

/** RMS of (a − b) over the common length, relative to the louder buffer's RMS. */
function relativeDifference(a: Rendered, b: Rendered): number {
  if (a.pcm.length !== b.pcm.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.pcm.length; i++) d += (a.pcm[i]! - b.pcm[i]!) ** 2;
  return Math.sqrt(d / a.pcm.length) / Math.max(a.rms, b.rms, 1e-12);
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const srcText = (rel: string): string => readFileSync(join(SRC_DIR, rel), 'utf8');
const quoted = (expr: string): string[] => [...expr.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

// --- synthesis ------------------------------------------------------------------------------------------------------

describe('procedural synthesis of every audio event', () => {
  it('the registry holds exactly AUDIO_EVENTS (unique ids, integer variants ≥ 1)', () => {
    expect([...content.audioEvents.keys()]).toEqual(AUDIO_EVENTS.map((e) => e.id));
    expect(new Set(AUDIO_EVENTS.map((e) => e.id)).size).toBe(AUDIO_EVENTS.length);
    for (const e of AUDIO_EVENTS) expect(Number.isInteger(e.variants) && e.variants >= 1, e.id).toBe(true);
  });

  it('every event × variant is non-empty, finite, unclipped (peak ≤ 1.0) and not silent (RMS above the floor)', () => {
    const all = renderAll();
    const problems: string[] = [];
    for (const r of all) {
      const at = `${r.id}#${r.variant}`;
      if (!(r.pcm instanceof Float32Array) || r.pcm.length === 0) problems.push(`${at}: empty buffer`);
      if (!r.finite) problems.push(`${at}: NaN/Infinity samples`);
      if (r.peak > 1.0) problems.push(`${at}: clipping, peak ${r.peak}`);
      if (!(r.rms >= RMS_FLOOR)) problems.push(`${at}: silent, RMS ${r.rms}`);
    }
    expect(problems).toEqual([]);
    const expected = AUDIO_EVENTS.reduce((n, e) => n + e.variants, 0);
    expect(all).toHaveLength(expected);
    const minRms = all.reduce((m, r) => (r.rms < m.rms ? r : m));
    const maxPeak = all.reduce((m, r) => (r.peak > m.peak ? r : m));
    const seconds = all.reduce((s, r) => s + r.pcm.length, 0) / SAMPLE_RATE;
    console.info(
      `[audio] ${content.audioEvents.size} events × variants = ${all.length} buffers (${seconds.toFixed(1)} s @ ${SAMPLE_RATE} Hz); ` +
        `min RMS ${minRms.rms.toFixed(4)} (${minRms.id}#${minRms.variant}, floor ${RMS_FLOOR}); max peak ${maxPeak.peak.toFixed(3)} (${maxPeak.id}#${maxPeak.variant})`,
    );
  });

  it('loops (amb.*, music.*) are single-variant beds of non-trivial length', () => {
    const loops = renderAll().filter((r) => isLoop(r.id));
    expect(loops.length).toBeGreaterThanOrEqual(8);
    for (const r of loops) {
      expect(content.audioEvents.get(r.id)!.variants, r.id).toBe(1);
      expect(r.pcm.length / SAMPLE_RATE, r.id).toBeGreaterThanOrEqual(MIN_LOOP_SECONDS);
    }
    console.info(`[audio] loops: ${loops.map((r) => `${r.id}=${(r.pcm.length / SAMPLE_RATE).toFixed(1)}s`).join(', ')}`);
  });

  it('loops are seamless: the wrap-around step x[N−1]→x[0] is no larger than the largest step inside the loop', () => {
    // synth.ts documents the beds as "Loopable … seamless by construction" with a crossfade at the loop point. A wrap
    // step larger than every one of the ~88k interior steps is a discontinuity → an audible click on every repeat.
    const rows = renderAll()
      .filter((r) => isLoop(r.id))
      .map((r) => {
        const x = r.pcm;
        let maxStep = 0;
        for (let i = 0; i + 1 < x.length; i++) maxStep = Math.max(maxStep, Math.abs(x[i + 1]! - x[i]!));
        return { id: r.id, wrap: Math.abs(x[0]! - x[x.length - 1]!), maxStep };
      });
    console.info(`[audio] loop seams (wrap step / largest interior step): ${rows.map((s) => `${s.id} ${s.wrap.toFixed(4)}/${s.maxStep.toFixed(4)}`).join(', ')}`);
    expect(rows.filter((s) => s.wrap > s.maxStep).map((s) => `${s.id}: wrap step ${s.wrap.toFixed(4)} > largest interior step ${s.maxStep.toFixed(4)}`)).toEqual([]);
  });

  it('events with ≥3 variants render ≥3 mutually different buffers (checksums and ≥5 % RMS difference)', () => {
    const problems: string[] = [];
    let pairs = 0;
    let minDiff = { v: Infinity, at: '' };
    for (const e of content.audioEvents.values()) {
      if (e.variants < 3) continue;
      const vs = variantsOf(e.id);
      if (new Set(vs.map((r) => r.sum)).size !== vs.length) problems.push(`${e.id}: identical variants (${vs.map((r) => r.sum).join(', ')})`);
      for (let i = 0; i < vs.length; i++)
        for (let j = i + 1; j < vs.length; j++) {
          pairs++;
          const d = relativeDifference(vs[i]!, vs[j]!);
          if (d < minDiff.v) minDiff = { v: d, at: `${e.id}#${i + 1}/#${j + 1}` };
          if (!(d >= MIN_VARIANT_DIFF)) problems.push(`${e.id}: variants ${i + 1} and ${j + 1} differ by only ${(d * 100).toFixed(2)} %`);
        }
    }
    expect(problems).toEqual([]);
    console.info(`[audio] variant pairs compared: ${pairs}; smallest relative difference ${minDiff.v.toFixed(3)} (${minDiff.at})`);
  });

  it('weapons and materials are distinguishable: 12 distinct gunshots, distinct impacts and footsteps per material', () => {
    for (const fam of ['gun.', 'impact.', 'step.']) {
      const ids = [...content.audioEvents.keys()].filter((id) => id.startsWith(fam) && id !== 'gun.dry' && id !== 'gun.suppressed');
      const sums = ids.map((id) => variantsOf(id)[0]!.sum);
      expect(new Set(sums).size, fam).toBe(ids.length);
    }
    const guns = items('weapon').map((d) => `gun.${d.weapon!.soundProfile}`);
    expect(guns).toHaveLength(12);
    for (const g of guns) expect(content.audioEvents.has(g), g).toBe(true);
  });

  it('every bus is a real mixer bus other than Master; every repeated family and every one-shot has ≥3 variants', () => {
    const problems: string[] = [];
    for (const e of content.audioEvents.values()) {
      if (!AUDIO_BUSES.includes(e.bus)) problems.push(`${e.id}: unknown bus ${e.bus}`);
      if (e.bus === 'Master') problems.push(`${e.id}: routed straight to Master`);
      if (!isLoop(e.id) && e.variants < 3) problems.push(`${e.id}: one-shot with ${e.variants} variants`);
    }
    for (const fam of REPEATED_FAMILIES) {
      const members = [...content.audioEvents.values()].filter((e) => e.id.startsWith(fam));
      if (members.length === 0) problems.push(`${fam}* has no events`);
      for (const e of members) if (e.variants < 3) problems.push(`${e.id}: ${e.variants} variants`);
    }
    expect(problems).toEqual([]);
  });

  it('synthesis is deterministic: same id + variant → bit-identical samples, independent of call order', () => {
    const first = renderAll();
    let compared = 0;
    for (const r of [...first].reverse()) {
      const again = synthesize(r.id, r.variant);
      expect(again.length, `${r.id}#${r.variant}`).toBe(r.pcm.length);
      let same = true;
      for (let i = 0; i < again.length; i++) if (again[i] !== r.pcm[i]) same = false;
      expect(same, `${r.id}#${r.variant}`).toBe(true);
      expect(checksum(again)).toBe(r.sum);
      compared++;
    }
    expect(compared).toBe(first.length);
  });
});

// --- sim event → cue mapping ------------------------------------------------------------------------------------------

function items(kind: string) {
  return [...content.items.values()].filter((d) => d.kind === kind);
}

/** A real Chapter 1 raid (newProfile → Q01 done → prepareDeploy → createRaidSim) plus one enemy per archetype. */
function raidContext(): { ctx: SimContext; enemies: string[] } {
  const p = newProfile(content, 1, 'audio', 'audio-cues', 0);
  const q01 = content.quest('core.quest.q01_ready');
  p.quests[q01.id] = { status: 'completed', progress: {} };
  for (const f of q01.rewards.flags ?? []) p.flags[f] = true;
  refreshQuests(p, content);
  const { ctx } = createRaidSim(content, prepareDeploy(p, content, 'core.dest.quarantine_main', 0));
  const enemies = [...content.enemies.values()].map((a, i) => spawnEnemy(content, ctx.sim, a.id, 40 + i, 40, Rng.fromSeed(`audio|${a.id}`)).id);
  return { ctx, enemies };
}

describe('soundCueFor: simulation events → audio cues', () => {
  it('for an exhaustive set of representative SimEvents every cue exists and sound-producing events are never silent', () => {
    const { ctx, enemies } = raidContext();
    const P = 'player';
    const E = enemies[0]!;
    const at = { x: 40, y: 40, z: 1.1 };
    // Domains are taken from the registry / the emitting source, not hard-coded.
    const impactMaterials = new Set<string>([...content.obstacleProfiles.values()].map((o) => o.material));
    for (const g of content.grounds.values()) impactMaterials.add(g.footstep); // combatResolve.hitGround uses ground.footstep
    for (const m of quoted([...srcText('world/combatResolve.ts').matchAll(/material: ('[^']+')/g)].map((x) => x[1]).join(' '))) impactMaterials.add(m);
    const stepMaterials = new Set<string>([...content.grounds.values()].map((g) => g.footstep));
    for (const m of quoted(/t: 'footstep',[^}]*material: ([^,}]+)/.exec(srcText('world/sim.ts'))?.[1] ?? '')) stepMaterials.add(m);
    const reloadSteps = new Set(quoted([...srcText('combat/reload.ts').matchAll(/t: 'reload', actorId: [^,]+, step: ([^}]+)\}/g)].map((x) => x[1]).join(' ')));
    const explosionKinds = new Set(items('throwable').map((d) => d.throwable!.type));
    const healKinds = new Set<string>([...items('medical').map((d) => d.medical!.type), ...quoted([...srcText('world/medical.ts').matchAll(/t: 'heal', actorId: [^,]+, kind: ([^}]+)\}/g)].map((x) => x[1]).join(' '))]);
    const eventStates = quoted(/interface RaidEventState \{[^}]*?state: ([^;]+);/.exec(srcText('world/state.ts'))?.[1] ?? '');
    expect(reloadSteps.size).toBeGreaterThanOrEqual(5);
    expect(stepMaterials.has('foliage')).toBe(true);
    expect(impactMaterials.has('debris')).toBe(true);
    expect(eventStates).toContain('active');

    /** Events that must produce a cue (sound feedback), and events that may map to null. */
    const audible: SimEvent[] = [];
    const other: SimEvent[] = [];
    for (const w of items('weapon'))
      for (const suppressed of [false, true])
        for (const actorId of [P, E]) audible.push({ t: 'shot', actorId, weaponDefId: w.id, ...at, dirX: 1, dirY: 0, suppressed, team: actorId === P ? 'player' : 'hostile' });
    audible.push({ t: 'dryfire', actorId: P });
    other.push({ t: 'dryfire', actorId: E });
    for (const material of impactMaterials) audible.push({ t: 'impact', ...at, material, actor: false }, { t: 'penetrate', ...at, material });
    audible.push({ t: 'impact', ...at, material: 'flesh', actor: true });
    audible.push({ t: 'hit', actorId: P, part: 'body', damage: 12, armorHit: false, killed: false, ...at, byPlayer: false });
    other.push({ t: 'hit', actorId: P, part: 'head', damage: 0, armorHit: true, killed: false, ...at, byPlayer: false }, { t: 'hit', actorId: E, part: 'head', damage: 50, armorHit: false, killed: true, ...at, byPlayer: true });
    for (const material of stepMaterials) for (const loud of [false, true]) for (const actorId of [P, E]) audible.push({ t: 'footstep', actorId, x: at.x, y: at.y, material, loud });
    for (const step of reloadSteps) for (const actorId of [P, E]) audible.push({ t: 'reload', actorId, step });
    for (const kind of explosionKinds) audible.push({ t: 'explosion', x: at.x, y: at.y, kind });
    audible.push({ t: 'smoke', x: at.x, y: at.y, radius: 2.6 });
    audible.push({ t: 'melee', actorId: P, hit: false, x: at.x, y: at.y, dirX: 1, dirY: 0, targetId: null }, { t: 'melee', actorId: E, hit: true, x: at.x, y: at.y, dirX: -1, dirY: 0, targetId: P });
    for (const d of ctx.geo.map.doors) for (const open of [true, false]) audible.push({ t: 'door', doorId: d.id, open });
    audible.push({ t: 'pickup', itemDefId: 'core.med.bandage', qty: 1 }, { t: 'search', containerId: 'ct:farm_relief', revealed: 1 });
    for (const kind of healKinds) {
      audible.push({ t: 'heal', actorId: P, kind });
      other.push({ t: 'heal', actorId: E, kind });
    }
    for (const id of enemies) audible.push({ t: 'alert', actorId: id, mode: 'Combat' });
    for (const state of eventStates) (['active', 'success'].includes(state) ? audible : other).push({ t: 'event', eventId: 'ev-test', state });
    audible.push({ t: 'extracted', exitId: 'exit.west_drain' });
    other.push(
      { t: 'death', actorId: E, x: at.x, y: at.y },
      { t: 'noise', noise: { x: at.x, y: at.y, floor: 0, loudness: 1, radius: 10, tag: 'gunshot', sourceId: E, time: 0 } },
      { t: 'message', key: 'reload.full' },
      { t: 'telegraph', actorId: E, x: at.x, y: at.y, tx: 0, ty: 0, until: 1 },
      { t: 'died' },
      { t: 'objective', key: 'poi.red_pump' },
      { t: 'flash', x: at.x, y: at.y, intensity: 1 },
      { t: 'ui', kind: 'loot', id: 'ct:farm_relief' },
    );

    const problems: string[] = [];
    const ids = new Set<string>();
    const check = (e: SimEvent, cue: SoundCue | null, mustSound: boolean) => {
      const what = JSON.stringify(e);
      if (!cue) {
        if (mustSound) problems.push(`silent: ${what}`);
        return;
      }
      ids.add(cue.id);
      if (!content.audioEvents.has(cue.id)) problems.push(`unknown cue ${cue.id} for ${what}`);
      if (!(Number.isFinite(cue.gain) && cue.gain > 0 && Number.isFinite(cue.range) && cue.range >= 0)) problems.push(`bad gain/range for ${what}`);
      if ((cue.x === null) !== (cue.y === null)) problems.push(`half-positional cue for ${what}`);
    };
    for (const e of audible) check(e, soundCueFor(ctx, e), true);
    for (const e of other) check(e, soundCueFor(ctx, e), false);
    expect(problems).toEqual([]);

    // Gunshots are specific per weapon (no fallback), footsteps specific per material.
    const shotIds = items('weapon').map((w) => soundCueFor(ctx, { t: 'shot', actorId: E, weaponDefId: w.id, ...at, dirX: 1, dirY: 0, suppressed: false, team: 'hostile' })!.id);
    expect(new Set(shotIds).size).toBe(items('weapon').length);
    for (const m of stepMaterials) expect(soundCueFor(ctx, { t: 'footstep', actorId: E, x: at.x, y: at.y, material: m, loud: false })!.id).toBe(`step.${m}`);
    console.info(`[cues] synthetic SimEvents: ${audible.length} audible + ${other.length} other → ${ids.size} distinct cue ids, all registered (${[...ids].sort().join(', ')})`);
  });

  it('a live arena firefight (real stepSim fx, enemies of every archetype) only produces registered cues', () => {
    const map = arena('audio.cues.firefight', 44, 16, (b) => {
      b.box('core.ob.wall_wood', 26, 2, 26.3, 6, 2.6, { id: 'wood' });
      b.box('core.ob.sandbag', 26, 10, 26.6, 13, 1.15, { id: 'sandbag' });
      b.box('core.ob.crate_metal', 18, 12, 19.4, 13.2, 1.2, { id: 'crate' });
    });
    const t = world(map, 4, 8);
    t.player.hp = t.player.maxHp = 1e6;
    equip(t, 'core.weapon.ar556', 'core.ammo.556.fmj', 3, 60);
    const foes = [...content.enemies.values()].map((a, i) => spawnEnemy(t.content, t.ctx.sim, a.id, 34 + (i % 3) * 3, 3 + i * 2, Rng.fromSeed(`audio-fight|${a.id}`)));
    const counts = new Map<string, number>();
    const unknown: string[] = [];
    let fxSeen = 0;
    for (let i = 0; i < 60 * 20; i++) {
      const target = foes.find((f) => f.alive) ?? foes[0]!;
      const phase = Math.floor(i / 90) % 2 === 0 ? 1 : -1;
      tick(t, aimCmd(target.x, target.y, 1.2, { moveY: i % 180 < 150 ? phase : 0, fireHeld: i % 40 < 20, firePressed: i % 40 === 0, reload: i % 240 === 200, melee: i % 300 === 150 }));
      const fx = t.ctx.sim.fx;
      t.ctx.sim.fx = [];
      for (const e of fx) {
        fxSeen++;
        const cue = soundCueFor(t.ctx, e);
        if (!cue) continue;
        counts.set(cue.id, (counts.get(cue.id) ?? 0) + 1);
        if (!content.audioEvents.has(cue.id)) unknown.push(`${cue.id} (from ${e.t})`);
      }
    }
    expect(unknown).toEqual([]);
    const families = new Set([...counts.keys()].map((id) => id.split('.')[0]!));
    for (const fam of ['gun', 'impact', 'step', 'reload']) expect(families.has(fam), `${fam}.* cue from the live sim`).toBe(true);
    console.info(`[cues] live firefight: ${fxSeen} fx → ${[...counts.values()].reduce((a, b) => a + b, 0)} cues, ${counts.size} distinct ids (${[...counts].sort().map(([k, v]) => `${k}×${v}`).join(', ')})`);
  });

  it('ids the game plays directly (play/loop literals, weather ambience, palettes) are registered', () => {
    const played = new Set<string>();
    for (const f of tsFiles(SRC_DIR)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\.play\(([^)\n]*)\)/g)) for (const q of quoted(m[1]!)) if (q.includes('.')) played.add(q);
      for (const m of src.matchAll(/\.loop\(\s*'[^']*'\s*,([^\n]*)\)/g)) for (const q of quoted(m[1]!)) if (q.includes('.')) played.add(q);
    }
    for (const w of content.weathers.values()) played.add(`amb.${w.ambience}`); // app.ts startRaidAudio: `amb.${w.ambience}`
    for (const p of AUDIO_PALETTES) {
      for (const a of p.ambience) played.add(a);
      if (p.music) played.add(p.music);
    }
    expect(played.size).toBeGreaterThanOrEqual(8);
    expect([...played].filter((id) => !content.audioEvents.has(id))).toEqual([]);
    console.info(`[cues] directly played ids: ${[...played].sort().join(', ')}`);
  });
});
