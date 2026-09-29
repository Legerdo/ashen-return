/**
 * Deterministic, serializable RNG. Authoritative game state must never use Math.random().
 * sfc32 generator seeded through cyrb128 string hashing.
 */

export type RngStreamName = 'world' | 'loot' | 'enemy' | 'combat' | 'weather' | 'contract' | 'market' | 'cosmetic';
export const RNG_STREAMS: readonly RngStreamName[] = ['world', 'loot', 'enemy', 'combat', 'weather', 'contract', 'market', 'cosmetic'];

export type RngState = [number, number, number, number];

/** cyrb128: 128-bit string hash → four 32-bit words. */
export function cyrb128(str: string): RngState {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** Stable 32-bit hash of a string (first word of cyrb128). */
export function hash32(str: string): number {
  return cyrb128(str)[0];
}

export function deriveSeed(base: string, ...parts: (string | number)[]): string {
  return [base, ...parts].join('|');
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: RngState) {
    this.a = state[0] >>> 0;
    this.b = state[1] >>> 0;
    this.c = state[2] >>> 0;
    this.d = state[3] >>> 0;
    if ((this.a | this.b | this.c | this.d) === 0) this.d = 1;
  }

  static fromSeed(seed: string): Rng {
    const r = new Rng(cyrb128(seed));
    // Warm up to decorrelate similar seeds.
    for (let i = 0; i < 12; i++) r.nextU32();
    return r;
  }

  nextU32(): number {
    const t0 = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t0) | 0;
    return t0 >>> 0;
  }

  /** Uniform [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Inclusive integer range. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick on empty array');
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  weighted<T>(entries: readonly { weight: number; value: T }[]): T {
    let total = 0;
    for (const e of entries) total += Math.max(0, e.weight);
    if (total <= 0) throw new Error('Rng.weighted with zero total weight');
    let roll = this.next() * total;
    for (const e of entries) {
      roll -= Math.max(0, e.weight);
      if (roll < 0) return e.value;
    }
    return entries[entries.length - 1]!.value;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  }

  /** Approximately normal (sum of 3 uniforms), mean 0, sd ≈ 1. */
  gaussish(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }

  getState(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  setState(s: RngState): void {
    this.a = s[0] >>> 0;
    this.b = s[1] >>> 0;
    this.c = s[2] >>> 0;
    this.d = s[3] >>> 0;
  }
}

export type RngStreamsState = Record<RngStreamName, RngState>;

/** Independent named streams derived from a single seed so that e.g. cosmetic effects never shift loot rolls. */
export class RngStreams {
  readonly streams: Record<RngStreamName, Rng>;

  private constructor(streams: Record<RngStreamName, Rng>) {
    this.streams = streams;
  }

  static create(seed: string): RngStreams {
    const s = {} as Record<RngStreamName, Rng>;
    for (const name of RNG_STREAMS) s[name] = Rng.fromSeed(deriveSeed(seed, name));
    return new RngStreams(s);
  }

  static fromState(state: RngStreamsState): RngStreams {
    const s = {} as Record<RngStreamName, Rng>;
    for (const name of RNG_STREAMS) s[name] = new Rng(state[name]);
    return new RngStreams(s);
  }

  get(name: RngStreamName): Rng {
    return this.streams[name];
  }

  getState(): RngStreamsState {
    const out = {} as RngStreamsState;
    for (const name of RNG_STREAMS) out[name] = this.streams[name].getState();
    return out;
  }
}
