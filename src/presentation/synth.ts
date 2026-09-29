/**
 * Procedural sound synthesis (pure functions → Float32Array mono PCM). No external audio assets.
 * Deterministic per (event, variant) so tests can check silence/clipping/variation.
 */
export const SAMPLE_RATE = 22050;

class Noise {
  private s: number;
  constructor(seed: number) {
    this.s = (seed * 2654435761) >>> 0 || 1;
  }
  next(): number {
    this.s ^= this.s << 13;
    this.s ^= this.s >>> 17;
    this.s ^= this.s << 5;
    return ((this.s >>> 0) / 4294967296) * 2 - 1;
  }
}

function buf(seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.round(seconds * SAMPLE_RATE)));
}

/** One-pole low-pass in place. */
function lowpass(x: Float32Array, cutoff: number): void {
  const rc = 1 / (2 * Math.PI * cutoff);
  const a = 1 / SAMPLE_RATE / (rc + 1 / SAMPLE_RATE);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i]! - y);
    x[i] = y;
  }
}

function highpass(x: Float32Array, cutoff: number): void {
  const rc = 1 / (2 * Math.PI * cutoff);
  const a = rc / (rc + 1 / SAMPLE_RATE);
  let prevX = 0;
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    y = a * (y + xi - prevX);
    prevX = xi;
    x[i] = y;
  }
}

function normalize(x: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i]! / m) * peak;
  return x;
}

function addNoiseBurst(out: Float32Array, start: number, dur: number, tau: number, gain: number, seed: number, cutoff: number, hp = 0): void {
  const n = new Noise(seed);
  const len = Math.round(dur * SAMPLE_RATE);
  const tmp = new Float32Array(len);
  for (let i = 0; i < len; i++) tmp[i] = n.next() * Math.exp(-i / SAMPLE_RATE / tau);
  lowpass(tmp, cutoff);
  if (hp > 0) highpass(tmp, hp);
  const s0 = Math.round(start * SAMPLE_RATE);
  for (let i = 0; i < len && s0 + i < out.length; i++) out[s0 + i] = out[s0 + i]! + tmp[i]! * gain;
}

function addTone(out: Float32Array, start: number, dur: number, f0: number, f1: number, tau: number, gain: number, shape: 'sine' | 'tri' | 'saw' = 'sine', vibrato = 0): void {
  const s0 = Math.round(start * SAMPLE_RATE);
  const len = Math.round(dur * SAMPLE_RATE);
  let ph = 0;
  for (let i = 0; i < len && s0 + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const f = f0 + (f1 - f0) * (i / len) + (vibrato ? Math.sin(t * 2 * Math.PI * 6) * vibrato : 0);
    ph += (2 * Math.PI * f) / SAMPLE_RATE;
    let v = Math.sin(ph);
    if (shape === 'tri') v = (2 / Math.PI) * Math.asin(Math.sin(ph));
    if (shape === 'saw') v = ((ph / Math.PI) % 2) - 1;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / tau);
    out[s0 + i] = out[s0 + i]! + v * env * gain;
  }
}

interface GunProfile {
  body: number;
  cutoff: number;
  thump: number;
  tail: number;
  crack: number;
  len: number;
}

const GUNS: Record<string, GunProfile> = {
  p9: { body: 0.045, cutoff: 3200, thump: 0.08, tail: 0.25, crack: 0.5, len: 0.45 },
  h45: { body: 0.06, cutoff: 2400, thump: 0.12, tail: 0.3, crack: 0.45, len: 0.5 },
  sm9: { body: 0.035, cutoff: 3600, thump: 0.06, tail: 0.2, crack: 0.45, len: 0.35 },
  sm45: { body: 0.045, cutoff: 2800, thump: 0.08, tail: 0.24, crack: 0.4, len: 0.4 },
  c556: { body: 0.05, cutoff: 4200, thump: 0.09, tail: 0.4, crack: 0.7, len: 0.6 },
  ar556: { body: 0.06, cutoff: 4000, thump: 0.1, tail: 0.45, crack: 0.75, len: 0.65 },
  ar762: { body: 0.075, cutoff: 3000, thump: 0.14, tail: 0.55, crack: 0.8, len: 0.75 },
  sgp: { body: 0.11, cutoff: 1900, thump: 0.18, tail: 0.6, crack: 0.3, len: 0.85 },
  sga: { body: 0.1, cutoff: 2100, thump: 0.16, tail: 0.55, crack: 0.3, len: 0.8 },
  dmr: { body: 0.09, cutoff: 3400, thump: 0.15, tail: 0.7, crack: 0.9, len: 0.9 },
  bolt: { body: 0.11, cutoff: 3000, thump: 0.2, tail: 0.9, crack: 1.0, len: 1.1 },
  lmg: { body: 0.065, cutoff: 3200, thump: 0.12, tail: 0.5, crack: 0.7, len: 0.7 },
};

export function synthGun(key: string, variant: number): Float32Array {
  const g = GUNS[key] ?? GUNS['p9']!;
  const k = 1 + (variant - 1) * 0.05;
  const out = buf(g.len);
  const seed = key.length * 1000 + variant * 77 + 13;
  // Mechanical transient (hammer / bolt), then pressure body, low thump and room tail.
  addNoiseBurst(out, 0, 0.012, 0.002, 0.6, seed + 1, 8000, 2000);
  addNoiseBurst(out, 0.001, g.body * 5, g.body * k, 1.0, seed + 2, g.cutoff * k);
  addNoiseBurst(out, 0, 0.02, 0.004, g.crack, seed + 3, 9000, 3000);
  addTone(out, 0, g.thump * 3, 110 * k, 38, g.thump, 0.9);
  addNoiseBurst(out, 0.02, g.len - 0.03, g.tail * 0.35, 0.18, seed + 4, 1400);
  return normalize(out, 0.9);
}

export function synthSuppressed(variant: number): Float32Array {
  const out = buf(0.3);
  addNoiseBurst(out, 0, 0.12, 0.025, 0.8, 900 + variant, 1600);
  addNoiseBurst(out, 0, 0.01, 0.002, 0.5, 950 + variant, 7000, 2500);
  addTone(out, 0, 0.15, 90, 50, 0.05, 0.5);
  return normalize(out, 0.55);
}

export function synthDry(variant: number): Float32Array {
  const out = buf(0.08);
  addNoiseBurst(out, 0, 0.02, 0.003, 1, 300 + variant, 6000, 1500);
  addTone(out, 0, 0.03, 2400 + variant * 100, 2000, 0.008, 0.4);
  return normalize(out, 0.45);
}

const IMPACT: Record<string, { cutoff: number; tau: number; tone: number; toneTau: number; len: number; hp: number }> = {
  concrete: { cutoff: 5000, tau: 0.02, tone: 0, toneTau: 0, len: 0.18, hp: 400 },
  wood: { cutoff: 1800, tau: 0.03, tone: 380, toneTau: 0.04, len: 0.2, hp: 100 },
  metal: { cutoff: 6000, tau: 0.01, tone: 2300, toneTau: 0.12, len: 0.35, hp: 800 },
  glass: { cutoff: 9000, tau: 0.04, tone: 4200, toneTau: 0.08, len: 0.35, hp: 2000 },
  dirt: { cutoff: 900, tau: 0.03, tone: 120, toneTau: 0.03, len: 0.18, hp: 50 },
  water: { cutoff: 2500, tau: 0.09, tone: 0, toneTau: 0, len: 0.35, hp: 300 },
  flesh: { cutoff: 700, tau: 0.03, tone: 90, toneTau: 0.04, len: 0.16, hp: 40 },
  vegetation: { cutoff: 4000, tau: 0.06, tone: 0, toneTau: 0, len: 0.25, hp: 1500 },
};

export function synthImpact(material: string, variant: number): Float32Array {
  const m = IMPACT[material] ?? IMPACT['concrete']!;
  const out = buf(m.len);
  addNoiseBurst(out, 0, m.len, m.tau * (1 + variant * 0.1), 1, 400 + variant * 31 + material.length, m.cutoff, m.hp);
  if (m.tone) addTone(out, 0, m.len, m.tone * (1 + variant * 0.04), m.tone * 0.9, m.toneTau, 0.6);
  return normalize(out, 0.7);
}

const STEPS: Record<string, { cutoff: number; tau: number; hp: number; len: number }> = {
  grass: { cutoff: 2500, tau: 0.03, hp: 800, len: 0.12 },
  dirt: { cutoff: 1500, tau: 0.025, hp: 150, len: 0.1 },
  mud: { cutoff: 900, tau: 0.06, hp: 80, len: 0.16 },
  water: { cutoff: 3000, tau: 0.07, hp: 400, len: 0.2 },
  concrete: { cutoff: 4000, tau: 0.012, hp: 500, len: 0.08 },
  wood: { cutoff: 1400, tau: 0.02, hp: 150, len: 0.1 },
  gravel: { cutoff: 5000, tau: 0.035, hp: 1200, len: 0.14 },
  metal: { cutoff: 5000, tau: 0.02, hp: 600, len: 0.14 },
  snow: { cutoff: 1800, tau: 0.04, hp: 600, len: 0.14 },
  foliage: { cutoff: 5000, tau: 0.08, hp: 1500, len: 0.25 },
};

export function synthStep(material: string, variant: number): Float32Array {
  const m = STEPS[material] ?? STEPS['dirt']!;
  const out = buf(m.len);
  addNoiseBurst(out, 0, m.len, m.tau * (1 + variant * 0.12), 1, 600 + variant * 17 + material.length * 3, m.cutoff * (1 - variant * 0.06), m.hp);
  if (material === 'metal') addTone(out, 0, m.len, 900 + variant * 60, 850, 0.03, 0.3);
  if (material === 'wood') addTone(out, 0, 0.06, 180, 150, 0.02, 0.4);
  return normalize(out, 0.5);
}

export function synthReload(step: string, variant: number): Float32Array {
  const out = buf(0.22);
  const s = 700 + variant * 13 + step.length * 5;
  switch (step) {
    case 'magOut':
      addNoiseBurst(out, 0, 0.05, 0.01, 0.8, s, 5000, 1500);
      addNoiseBurst(out, 0.05, 0.12, 0.04, 0.3, s + 1, 2500, 500);
      break;
    case 'magIn':
      addNoiseBurst(out, 0, 0.03, 0.006, 1, s, 6000, 1500);
      addTone(out, 0, 0.05, 1600, 1400, 0.012, 0.4);
      break;
    case 'chamber':
      addNoiseBurst(out, 0, 0.04, 0.008, 0.9, s, 6000, 1800);
      addNoiseBurst(out, 0.09, 0.04, 0.008, 1, s + 3, 7000, 2000);
      break;
    case 'shell':
      addNoiseBurst(out, 0, 0.04, 0.01, 0.8, s, 3500, 900);
      break;
    case 'pump':
      addNoiseBurst(out, 0, 0.06, 0.015, 0.9, s, 4000, 700);
      addNoiseBurst(out, 0.11, 0.06, 0.015, 1, s + 5, 4500, 800);
      break;
    default:
      addNoiseBurst(out, 0, 0.04, 0.01, 1, s, 5000, 1000);
  }
  return normalize(out, 0.5);
}

export function synthExplosion(kind: string, variant: number): Float32Array {
  if (kind === 'smoke') {
    const out = buf(1.2);
    addNoiseBurst(out, 0, 1.2, 0.5, 1, 1100 + variant, 3000, 800);
    return normalize(out, 0.4);
  }
  const out = buf(kind === 'flash' ? 1.0 : 1.6);
  addNoiseBurst(out, 0, 0.3, 0.06, 1, 1200 + variant, kind === 'flash' ? 9000 : 2500);
  addTone(out, 0, 1.2, 70 * (1 + variant * 0.05), 25, 0.35, 1.0);
  addNoiseBurst(out, 0.05, out.length / SAMPLE_RATE - 0.06, 0.45, 0.35, 1300 + variant, 700);
  if (kind === 'flash') addTone(out, 0.02, 0.9, 3200, 3100, 0.4, 0.25);
  return normalize(out, 0.95);
}

export function synthUi(kind: string, variant: number): Float32Array {
  const out = buf(0.5);
  const d = variant * 30;
  switch (kind) {
    case 'click':
      addTone(out, 0, 0.05, 1200 + d, 1100, 0.012, 0.8);
      break;
    case 'confirm':
      addTone(out, 0, 0.1, 660 + d, 660, 0.05, 0.6, 'tri');
      addTone(out, 0.08, 0.15, 990 + d, 990, 0.07, 0.6, 'tri');
      break;
    case 'error':
      addTone(out, 0, 0.18, 220 + d, 180, 0.08, 0.7, 'saw');
      break;
    case 'coin':
      addTone(out, 0, 0.12, 1568 + d, 1568, 0.05, 0.5);
      addTone(out, 0.07, 0.2, 2093 + d, 2093, 0.08, 0.5);
      break;
    case 'quest':
      [523, 659, 784, 1046].forEach((f, i) => addTone(out, i * 0.08, 0.25, f + d, f + d, 0.12, 0.45, 'tri'));
      break;
    case 'search':
      addNoiseBurst(out, 0, 0.2, 0.06, 0.8, 1500 + variant, 5000, 1500);
      break;
    case 'pickup':
      addNoiseBurst(out, 0, 0.06, 0.015, 0.7, 1600 + variant, 4000, 800);
      addTone(out, 0.02, 0.06, 880 + d, 990, 0.02, 0.3);
      break;
    case 'heal':
      // Bandage: soft cloth rustle followed by a short tape rip.
      addNoiseBurst(out, 0, 0.28, 0.09, 0.6, 1700 + variant, 2200, 300);
      addNoiseBurst(out, 0.2, 0.12, 0.03, 0.8, 1710 + variant, 7000, 2500);
      break;
    case 'swing':
      // Melee whoosh: a low, fast air burst.
      addNoiseBurst(out, 0, 0.16, 0.07, 1, 1800 + variant, 1400 + d, 200);
      break;
    default:
      addTone(out, 0, 0.05, 1000, 1000, 0.01, 0.5);
  }
  return normalize(out, 0.5);
}

export function synthVoice(kind: string, variant: number): Float32Array {
  const out = buf(0.6);
  const v = 1 + (variant - 1) * 0.07;
  if (kind === 'coo') {
    addTone(out, 0, 0.22, 420 * v, 330 * v, 0.09, 0.8, 'sine', 12);
    addTone(out, 0.24, 0.3, 380 * v, 300 * v, 0.12, 0.8, 'sine', 12);
  } else if (kind === 'caw') {
    addTone(out, 0, 0.25, 650 * v, 520 * v, 0.1, 0.7, 'saw');
    addNoiseBurst(out, 0, 0.25, 0.08, 0.3, 1700 + variant, 3000, 800);
  } else if (kind === 'hoot') {
    addTone(out, 0, 0.45, 340 * v, 300 * v, 0.2, 0.9, 'sine', 8);
  } else {
    addTone(out, 0, 0.18, 900 * v, 600 * v, 0.06, 0.7, 'tri');
  }
  return normalize(out, 0.6);
}

export function synthDoor(open: boolean, variant: number): Float32Array {
  const out = buf(0.5);
  addTone(out, 0, 0.35, open ? 300 : 500, open ? 520 : 280, 0.15, 0.25, 'saw');
  addNoiseBurst(out, open ? 0.3 : 0.25, 0.15, 0.03, 0.9, 1800 + variant, 1200, 80);
  return normalize(out, 0.5);
}

export function synthMachinePulse(variant: number): Float32Array {
  const out = buf(1.0);
  addTone(out, 0, 1.0, 55, 55, 0.6, 0.7, 'saw');
  addTone(out, 0, 1.0, 110 + variant * 3, 110, 0.5, 0.35, 'saw');
  addNoiseBurst(out, 0, 1.0, 0.4, 0.3, 1900 + variant, 800);
  return normalize(out, 0.6);
}

/** Loopable ambience beds (seamless by construction: amplitude modulation periods divide the loop length). */
export function synthAmbience(kind: string): Float32Array {
  const len = 4;
  const N = Math.round(len * SAMPLE_RATE);
  // Render past the loop end so the start can be crossfaded with the signal's own continuation (no click at the wrap).
  const fade = Math.round(0.05 * SAMPLE_RATE);
  const out = new Float32Array(N + fade);
  const n = new Noise(2000 + kind.length);
  let b = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const white = n.next();
    if (kind === 'wind') {
      b = 0.995 * b + 0.05 * white;
      out[i] = b * (0.6 + 0.4 * Math.sin((t * 2 * Math.PI) / len));
    } else if (kind === 'rain' || kind === 'storm') {
      b = 0.6 * b + 0.4 * white;
      out[i] = b * 0.7;
      if (kind === 'storm') out[i] = out[i]! + Math.sin(t * 2 * Math.PI * 40) * 0.2 * (0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / len));
    } else if (kind === 'shelter') {
      out[i] = Math.sin(t * 2 * Math.PI * 60) * 0.25 + Math.sin(t * 2 * Math.PI * 120) * 0.1 + white * 0.03;
    } else if (kind === 'night') {
      const chirp = Math.sin(t * 2 * Math.PI * 4) > 0.97 ? Math.sin(t * 2 * Math.PI * 4500) * 0.3 : 0;
      b = 0.99 * b + 0.02 * white;
      out[i] = chirp + b * 0.3;
    }
  }
  // Crossfade the loop start with the samples that follow the loop end: x[N-1] → x[0] then continues the signal.
  const loop = out.slice(0, N);
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    loop[i] = out[i]! * a + out[N + i]! * (1 - a);
  }
  return normalize(loop, 0.35);
}

/** Simple procedural music loops (pads). */
export function synthMusic(kind: string): Float32Array {
  const len = 16;
  const out = buf(len);
  // Raid: low minor pads. Shelter: warm major progression. Title: sparse, open fifths (distinct theme).
  const chords =
    kind === 'raid'
      ? [[110, 165, 220], [98, 147, 196], [110, 165, 220], [87, 131, 175]]
      : kind === 'title'
        ? [[147, 220, 294], [131, 196, 262], [165, 247, 330], [123, 185, 247]]
        : [[220, 262, 330], [175, 220, 262], [262, 330, 392], [196, 247, 294]];
  for (let c = 0; c < 4; c++) {
    for (const f of chords[c]!) {
      const s0 = Math.round(c * 4 * SAMPLE_RATE);
      let ph = 0;
      for (let i = 0; i < 4 * SAMPLE_RATE; i++) {
        const t = i / SAMPLE_RATE;
        ph += (2 * Math.PI * f) / SAMPLE_RATE;
        const env = Math.min(1, t / 1.2) * Math.min(1, (4 - t) / 1.2);
        out[s0 + i] = out[s0 + i]! + ((2 / Math.PI) * Math.asin(Math.sin(ph))) * env * (kind === 'raid' ? 0.12 : 0.16);
      }
    }
  }
  return normalize(out, kind === 'raid' ? 0.25 : 0.3);
}

/** Resolve an audio event id + variant to PCM. */
export function synthesize(id: string, variant: number): Float32Array {
  const [group, a = '', b = ''] = id.split('.');
  switch (group) {
    case 'gun':
      if (a === 'suppressed') return synthSuppressed(variant);
      if (a === 'dry') return synthDry(variant);
      return synthGun(a, variant);
    case 'impact':
      return synthImpact(a, variant);
    case 'step':
      return synthStep(a, variant);
    case 'reload':
      return synthReload(a, variant);
    case 'explosion':
      return synthExplosion(a, variant);
    case 'ui':
      return synthUi(a, variant);
    case 'voice':
      return synthVoice(a === 'alert' ? b : a, variant);
    case 'door':
      return synthDoor(a === 'open', variant);
    case 'heal':
      return synthUi('heal', variant);
    case 'melee':
      return synthUi('swing', variant);
    case 'machine':
      return synthMachinePulse(variant);
    case 'amb':
      return synthAmbience(a);
    case 'music':
      return synthMusic(a);
    default:
      return synthUi('click', variant);
  }
}
