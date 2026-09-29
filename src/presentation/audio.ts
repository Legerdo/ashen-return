import type { ContentRegistry } from '../content/registry';
import type { AudioBus } from '../content/types';
import { AUDIO_BUSES } from '../content/types';
import { SAMPLE_RATE, synthesize } from './synth';

/**
 * WebAudio engine with 8 buses (Master → Music/Weapons/Impacts/Footsteps/Ambience/UI/Voice).
 * Unlocked on the first user gesture (autoplay policy). Playback never influences AI hearing, which uses
 * simulation NoiseEvents only. Loops are keyed and idempotent, so hidden→visible never duplicates BGM.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private buses = new Map<AudioBus, GainNode>();
  private buffers = new Map<string, AudioBuffer[]>();
  private lastVariant = new Map<string, number>();
  private loops = new Map<string, { id: string; src: AudioBufferSourceNode; gain: GainNode }>();
  private volumes: Record<AudioBus, number>;
  unlocked = false;
  unlockFailed = false;
  private voiceBudget = 0;
  playCount = 0;

  constructor(
    private readonly content: ContentRegistry,
    volumes: Record<AudioBus, number>,
  ) {
    this.volumes = { ...volumes };
  }

  /** Call from a user gesture handler. Safe to call repeatedly. */
  unlock(): void {
    if (this.unlocked) {
      if (this.ctx?.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return;
    }
    try {
      const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctor) {
        this.unlockFailed = true;
        return;
      }
      this.ctx = new Ctor();
      const master = this.ctx.createGain();
      master.connect(this.ctx.destination);
      this.buses.set('Master', master);
      for (const b of AUDIO_BUSES) {
        if (b === 'Master') continue;
        const g = this.ctx.createGain();
        g.connect(master);
        this.buses.set(b, g);
      }
      this.applyVolumes();
      void this.ctx.resume();
      this.unlocked = true;
    } catch {
      this.unlockFailed = true;
    }
  }

  setVolumes(v: Record<AudioBus, number>): void {
    this.volumes = { ...v };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    for (const [b, g] of this.buses) g.gain.value = Math.max(0, Math.min(1, this.volumes[b] ?? 1));
  }

  setHidden(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  private buffer(id: string, variant: number): AudioBuffer | null {
    if (!this.ctx) return null;
    let list = this.buffers.get(id);
    if (!list) {
      list = [];
      this.buffers.set(id, list);
    }
    if (!list[variant]) {
      const pcm = synthesize(id, variant + 1);
      const b = this.ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
      b.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
      list[variant] = b;
    }
    return list[variant]!;
  }

  private busFor(id: string): GainNode | undefined {
    const def = this.content.audioEvents.get(id);
    return this.buses.get(def?.bus ?? 'UI');
  }

  /** Play a one-shot with variant rotation that avoids repeating the previous variant. */
  play(id: string, opts: { gain?: number; pan?: number; rate?: number } = {}): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (this.voiceBudget > 24) return;
    const def = this.content.audioEvents.get(id);
    const n = Math.max(1, def?.variants ?? 1);
    const last = this.lastVariant.get(id) ?? -1;
    let v = n === 1 ? 0 : (last + 1 + ((this.playCount * 7) % (n - 1))) % n;
    if (v === last && n > 1) v = (v + 1) % n;
    this.lastVariant.set(id, v);
    const b = this.buffer(id, v);
    const bus = this.busFor(id);
    if (!b || !bus) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = opts.rate ?? 1;
    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1.5, opts.gain ?? 1));
    let node: AudioNode = g;
    if (opts.pan !== undefined && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opts.pan));
      g.connect(p);
      node = p;
    }
    node.connect(bus);
    src.connect(g);
    this.voiceBudget++;
    src.onended = () => {
      this.voiceBudget = Math.max(0, this.voiceBudget - 1);
      src.disconnect();
      g.disconnect();
    };
    src.start();
    this.playCount++;
  }

  /** Spatialized one-shot relative to a listener (distance attenuation + stereo pan). */
  playAt(id: string, x: number, y: number, lx: number, ly: number, range = 40, base = 1): void {
    const d = Math.hypot(x - lx, y - ly);
    if (d > range) return;
    const gain = base * Math.max(0.05, 1 - d / range) ** 1.4;
    const pan = Math.max(-1, Math.min(1, (x - lx) / 14));
    this.play(id, { gain, pan });
  }

  loop(key: string, id: string, gain = 1): void {
    if (!this.ctx) return;
    const cur = this.loops.get(key);
    if (cur && cur.id === id) {
      cur.gain.gain.value = gain;
      return;
    }
    if (cur) this.stopLoop(key);
    const b = this.buffer(id, 0);
    const bus = this.busFor(id);
    if (!b || !bus) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(bus);
    src.start();
    this.loops.set(key, { id, src, gain: g });
  }

  stopLoop(key: string): void {
    const cur = this.loops.get(key);
    if (!cur) return;
    try {
      cur.src.stop();
    } catch {
      /* already stopped */
    }
    cur.src.disconnect();
    cur.gain.disconnect();
    this.loops.delete(key);
  }

  activeLoops(): string[] {
    return [...this.loops.keys()];
  }
}
