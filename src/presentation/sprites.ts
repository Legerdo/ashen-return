import { Px, shade } from './pixel';

/**
 * Procedural anthropomorphic bird characters. Frame canvas 32×48, feet on row 46 (ground).
 * Vertical pixel rows map to z exactly (16 px per unit): head 1.40–1.80u ⇒ rows ~17–23, body 0.35–1.40u ⇒ rows ~24–40.
 * Beak, crests, wings and tails are decorative and intentionally lie outside the hit volumes.
 */
export const FRAME_W = 32;
export const FRAME_H = 48;
export const FEET_Y = 46;
/** roll0–3: the crouched body turned 0° / 90° / 180° / 270° clockwise around ROLL_PIVOT (dodge-roll tumble). */
export const FRAMES = { idle0: 0, idle1: 1, walk0: 2, walk1: 3, walk2: 4, walk3: 5, crouch0: 6, crouch1: 7, dead: 8, roll0: 9, roll1: 10, roll2: 11, roll3: 12 } as const;
export const FRAME_COUNT = 13;
/**
 * Tumble pivot of the roll frames (pixel-corner coordinates inside a frame): the crouched body's centre. Quarter turns
 * around a pixel corner map pixels 1:1, so the roll frames are lossless and need no runtime sprite rotation.
 */
export const ROLL_PIVOT = { x: 16, y: 36 } as const;

export type Hat = 'none' | 'cap' | 'helmet' | 'bandana' | 'hood' | 'goggles' | 'headset' | 'beret' | 'crest';

export interface BirdSpec {
  id: string;
  plumage: number;
  belly: number;
  beak: number;
  eye: number;
  jacket: number | null;
  trim: number;
  legs: number;
  hat: Hat;
  hatColor: number;
  scarf?: number;
  armband?: number;
  large?: boolean;
  dummy?: boolean;
}

export const BIRDS: BirdSpec[] = [
  { id: 'player', plumage: 0x3a3f4a, belly: 0x596070, beak: 0xd9a441, eye: 0xffffff, jacket: 0x5b6b4a, trim: 0x3e4a33, legs: 0xd9a441, hat: 'none', hatColor: 0, scarf: 0x3fb6a8 },
  { id: 'pigeon_sentry', plumage: 0x8a8f9a, belly: 0xb4acbc, beak: 0x4a4040, eye: 0xff8844, jacket: 0x4b5a3a, trim: 0x39442c, legs: 0xc06a6a, hat: 'cap', hatColor: 0x39402e, armband: 0xb03030 },
  { id: 'pigeon_flanker', plumage: 0x7e8390, belly: 0xa8a2b0, beak: 0x4a4040, eye: 0xff8844, jacket: 0x3e4a52, trim: 0x2e373d, legs: 0xc06a6a, hat: 'bandana', hatColor: 0x8a2a2a, armband: 0xb03030 },
  { id: 'pigeon_rusher', plumage: 0x6f737c, belly: 0x9c96a4, beak: 0x4a4040, eye: 0xff8844, jacket: 0x4a3e32, trim: 0x352c24, legs: 0xc06a6a, hat: 'helmet', hatColor: 0x4d5540, armband: 0xb03030 },
  { id: 'crow_marksman', plumage: 0x2e3036, belly: 0x44464e, beak: 0x3a3a3a, eye: 0xffd24a, jacket: 0x3b4632, trim: 0x2c3525, legs: 0x5a5a5a, hat: 'hood', hatColor: 0x4a5a3a, armband: 0xb03030 },
  { id: 'pigeon_support', plumage: 0x8a8f9a, belly: 0xb4acbc, beak: 0x4a4040, eye: 0xff8844, jacket: 0x2f3a4a, trim: 0x232b37, legs: 0xc06a6a, hat: 'helmet', hatColor: 0x3a4250, armband: 0xb03030 },
  { id: 'owl_boss', plumage: 0x6b5438, belly: 0xc9b28a, beak: 0x3a3028, eye: 0xffb000, jacket: 0x2a2e36, trim: 0xc8a040, legs: 0x8a7050, hat: 'beret', hatColor: 0x5a1a1a, large: true, armband: 0xb03030 },
  { id: 'hawk_elite', plumage: 0x5a4a3e, belly: 0xd8ccb4, beak: 0xe0b030, eye: 0xff3a2a, jacket: 0x1e2226, trim: 0xb02a2a, legs: 0xe0b030, hat: 'helmet', hatColor: 0x23282e, armband: 0xb03030 },
  { id: 'owl_mechanic', plumage: 0x8b6e4e, belly: 0xd8c6a2, beak: 0x3a3028, eye: 0xffc040, jacket: 0x3d5a7a, trim: 0x2c4258, legs: 0x8a7050, hat: 'goggles', hatColor: 0x2a2a2a },
  { id: 'egret_medic', plumage: 0xeeeeea, belly: 0xffffff, beak: 0xe0b020, eye: 0x202020, jacket: 0xd6dde0, trim: 0xb0b8bc, legs: 0x303030, hat: 'none', hatColor: 0, armband: 0xd03030 },
  { id: 'magpie_comms', plumage: 0x1e2230, belly: 0xf0f0f0, beak: 0x303030, eye: 0x202020, jacket: 0x6a4a7a, trim: 0x4c3458, legs: 0x303030, hat: 'headset', hatColor: 0x505050 },
  { id: 'dummy', plumage: 0xc8a070, belly: 0xb08858, beak: 0, eye: 0, jacket: null, trim: 0x8a6a40, legs: 0x8a6a40, hat: 'none', hatColor: 0, dummy: true },
];

const OUTLINE = 0x16141a;

function drawStanding(p: Px, s: BirdSpec, bob: number, legPhase: number): void {
  const cx = 16;
  const big = s.large ? 1 : 0;
  // Legs (0 → 0.35u: rows 40–46).
  const l1 = legPhase === 1 ? -1 : legPhase === 3 ? 1 : 0;
  const l2 = -l1;
  p.rect(cx - 3 + l1, 40, 1, 6, s.legs);
  p.rect(cx + 2 + l2, 40, 1, 6, s.legs);
  p.rect(cx - 4 + l1, 45, 3, 1, s.legs);
  p.rect(cx + 1 + l2, 45, 3, 1, s.legs);
  if (s.dummy) {
    p.rect(cx - 1, 38, 2, 8, 0x7a5a30);
    p.rect(cx - 5, 45, 10, 1, 0x6a4a28);
    // Torso board (body volume) and round head target.
    p.rect(cx - 5, 24, 10, 15, s.plumage);
    p.rect(cx - 3, 28, 6, 6, 0xd84a3a);
    p.rect(cx - 1, 30, 2, 2, 0xffffff);
    p.ellipse(cx, 20, 4, 3.6, s.belly);
    p.ellipse(cx, 20, 2, 1.8, 0xd84a3a);
    return;
  }
  const by = 32 + bob;
  // Tail (decorative).
  p.ellipse(cx - 6, by + 5, 2.5, 3, shade(s.plumage, 0.8));
  // Body (0.35 → 1.40u: rows 24–40).
  p.ellipse(cx, by, 5 + big, 8, s.plumage);
  p.ellipse(cx + 1, by + 1, 3.2 + big * 0.5, 5.5, s.belly);
  if (s.jacket !== null) {
    p.rect(cx - 5 - big, by - 5, 10 + big * 2, 9, s.jacket);
    p.rect(cx - 5 - big, by + 3, 10 + big * 2, 1, s.trim);
    p.rect(cx - 1, by - 5, 1, 9, s.trim);
    if (s.large) p.rect(cx + 3, by - 4, 2, 1, s.trim);
  }
  if (s.armband) p.rect(cx - 6 - big, by - 3, 2, 2, s.armband);
  // Wing/arm (decorative, overlaps body edge).
  p.ellipse(cx - 4 - big, by - 1, 2, 4, shade(s.plumage, 0.85));
  // Scarf.
  if (s.scarf) {
    p.rect(cx - 4, by - 8, 9, 2, s.scarf);
    p.rect(cx - 5, by - 7, 2, 4, shade(s.scarf, 0.8));
  }
  // Head (1.40 → 1.80u: rows ~17–24).
  const hy = 20 + bob;
  p.ellipse(cx + 1, hy, 4 + big * 0.5, 3.8, s.plumage);
  if (s.id === 'magpie_comms') p.ellipse(cx + 2, hy + 1, 2.5, 2, s.belly);
  if (s.id.startsWith('owl')) {
    p.ellipse(cx + 1, hy + 0.5, 3, 2.6, shade(s.belly, 0.95));
    p.set(cx - 2, hy - 4, s.plumage);
    p.set(cx + 4, hy - 4, s.plumage);
  }
  // Eye.
  p.set(cx + 3, hy - 1, s.eye);
  p.set(cx + 3, hy, OUTLINE);
  // Beak (decorative, extends past the head volume).
  p.rect(cx + 5, hy, 3, 1, s.beak);
  p.rect(cx + 5, hy + 1, 2, 1, shade(s.beak, 0.8));
  switch (s.hat) {
    case 'cap':
      p.rect(cx - 3, hy - 4, 8, 2, s.hatColor);
      p.rect(cx + 3, hy - 3, 4, 1, shade(s.hatColor, 0.8));
      break;
    case 'helmet':
      p.ellipse(cx + 1, hy - 2, 5, 3, s.hatColor);
      p.rect(cx - 4, hy - 1, 10, 1, shade(s.hatColor, 0.75));
      break;
    case 'bandana':
      p.rect(cx - 3, hy - 3, 8, 2, s.hatColor);
      p.rect(cx - 5, hy - 2, 2, 3, s.hatColor);
      break;
    case 'hood':
      p.ellipse(cx, hy - 1, 5, 4.5, s.hatColor);
      p.ellipse(cx + 2, hy + 0.5, 3, 2.5, s.plumage);
      p.set(cx + 3, hy, s.eye);
      break;
    case 'goggles':
      p.rect(cx - 3, hy - 3, 8, 1, s.hatColor);
      p.rect(cx + 1, hy - 4, 3, 2, 0x7ab8d8);
      break;
    case 'headset':
      p.rect(cx - 2, hy - 5, 6, 1, s.hatColor);
      p.rect(cx - 3, hy - 3, 2, 3, s.hatColor);
      p.set(cx + 3, hy + 2, s.hatColor);
      break;
    case 'beret':
      p.ellipse(cx, hy - 3, 5, 2, s.hatColor);
      p.set(cx + 3, hy - 3, s.trim);
      break;
    case 'crest':
      p.line(cx - 1, hy - 4, cx - 3, hy - 7, s.plumage);
      break;
  }
}

function drawCrouched(p: Px, s: BirdSpec, legPhase: number): void {
  const cx = 16;
  if (s.dummy) {
    p.rect(cx - 1, 42, 2, 4, 0x7a5a30);
    p.rect(cx - 5, 45, 10, 1, 0x6a4a28);
    p.rect(cx - 5, 33, 10, 9, s.plumage);
    p.rect(cx - 2, 36, 4, 3, 0xd84a3a);
    p.ellipse(cx, 29, 3.8, 3, s.belly);
    p.ellipse(cx, 29, 1.8, 1.4, 0xd84a3a);
    return;
  }
  const l = legPhase === 1 ? 1 : 0;
  p.rect(cx - 4 + l, 43, 3, 2, s.legs);
  p.rect(cx + 1 - l, 43, 3, 2, s.legs);
  p.rect(cx - 5 + l, 45, 4, 1, s.legs);
  p.rect(cx + 1 - l, 45, 4, 1, s.legs);
  // Body 0.25–0.85u (rows 32–42), head 0.85–1.15u (rows 28–32).
  p.ellipse(cx - 6, 41, 2.5, 2, shade(s.plumage, 0.8));
  p.ellipse(cx, 38, 6, 5, s.plumage);
  p.ellipse(cx + 1, 39, 4, 3, s.belly);
  if (s.jacket !== null) {
    p.rect(cx - 6, 35, 12, 5, s.jacket);
    p.rect(cx - 6, 39, 12, 1, s.trim);
  }
  if (s.scarf) p.rect(cx - 4, 33, 9, 2, s.scarf);
  p.ellipse(cx + 2, 30, 4, 3.4, s.plumage);
  p.set(cx + 4, 29, s.eye);
  p.set(cx + 4, 30, OUTLINE);
  p.rect(cx + 6, 30, 3, 1, s.beak);
  if (s.hat === 'helmet' || s.hat === 'cap' || s.hat === 'beret' || s.hat === 'hood' || s.hat === 'bandana') p.ellipse(cx + 2, 27.5, 4.5, 2, s.hatColor);
}

function drawDead(p: Px, s: BirdSpec): void {
  const cx = 16;
  if (s.dummy) {
    p.rect(cx - 10, 43, 20, 3, s.plumage);
    p.ellipse(cx + 11, 44, 3, 2, s.belly);
    return;
  }
  p.ellipse(cx, 43, 9, 3, s.plumage);
  if (s.jacket !== null) p.rect(cx - 5, 41, 9, 4, s.jacket);
  p.ellipse(cx + 9, 43, 3.5, 2.8, s.plumage);
  p.rect(cx + 12, 43, 2, 1, s.beak);
  p.line(cx - 8, 46, cx - 10, 45, s.legs);
  // Loose feathers.
  p.set(cx - 12, 41, s.plumage);
  p.set(cx + 4, 39, s.belly);
}

export function birdSheet(s: BirdSpec): Px {
  const sheet = new Px(FRAME_W * FRAME_COUNT, FRAME_H);
  const frames: Px[] = [];
  const mk = (fn: (p: Px) => void) => {
    const p = new Px(FRAME_W, FRAME_H);
    fn(p);
    p.outline(OUTLINE);
    frames.push(p);
  };
  mk((p) => drawStanding(p, s, 0, 0));
  mk((p) => drawStanding(p, s, 1, 0));
  for (let i = 0; i < 4; i++) mk((p) => drawStanding(p, s, i % 2 === 0 ? 0 : -1, i));
  mk((p) => drawCrouched(p, s, 0));
  mk((p) => drawCrouched(p, s, 1));
  mk((p) => drawDead(p, s));
  const crouched = frames[FRAMES.crouch0]!;
  for (let q = 0; q < 4; q++) frames.push(quarterTurn(crouched, q));
  frames.forEach((f, i) => sheet.blit(f, i * FRAME_W, 0));
  return sheet;
}

/** The frame turned q × 90° clockwise (screen coordinates) around ROLL_PIVOT; pixels leaving the frame are dropped. */
export function quarterTurn(src: Px, q: number): Px {
  const out = new Px(src.w, src.h);
  const { x: px, y: py } = ROLL_PIVOT;
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4;
      const a = src.data[i + 3]!;
      if (a === 0) continue;
      // Pixel centre offset from the pivot corner, turned clockwise q times: (dx, dy) → (−dy, dx).
      let dx = x + 0.5 - px;
      let dy = y + 0.5 - py;
      for (let k = 0; k < (q & 3); k++) [dx, dy] = [-dy, dx];
      const c = (src.data[i]! << 16) | (src.data[i + 1]! << 8) | src.data[i + 2]!;
      out.set(Math.floor(px + dx), Math.floor(py + dy), c, a);
    }
  return out;
}

/** Weapon sprites point right; origin (grip) at (2, 3). Length ≈ muzzleLength × 16 px. */
export interface WeaponSprite {
  px: Px;
  originX: number;
  originY: number;
  muzzleX: number;
}

export function weaponSprite(key: string): WeaponSprite {
  const metal = 0x2c2e33;
  const dark = 0x1b1c20;
  const wood = 0x7a5232;
  const poly = 0x3b3f36;
  let len = 14;
  const draw: ((p: Px) => void)[] = [];
  switch (key) {
    case 'p9':
    case 'h45':
      len = key === 'h45' ? 10 : 9;
      draw.push((p) => {
        p.rect(2, 1, len - 1, 2, key === 'h45' ? 0x55585e : metal);
        p.rect(2, 3, 3, 3, dark);
      });
      break;
    case 'sm9':
    case 'sm45':
      len = 12;
      draw.push((p) => {
        p.rect(1, 2, len, 2, metal);
        p.rect(4, 4, 2, 3, dark);
        p.rect(0, 2, 2, 2, poly);
        if (key === 'sm45') p.rect(7, 4, 2, 2, dark);
      });
      break;
    case 'c556':
    case 'ar556':
    case 'ar762':
      len = key === 'c556' ? 14 : 15;
      draw.push((p) => {
        p.rect(0, 2, 4, 2, key === 'ar762' ? wood : poly);
        p.rect(3, 1, len - 2, 3, metal);
        p.rect(len, 2, 3, 1, dark);
        p.rect(6, 4, 2, key === 'ar762' ? 3 : 3, dark);
        if (key === 'ar762') p.set(8, 6, dark);
        p.rect(4, 4, 1, 2, dark);
      });
      break;
    case 'sgp':
    case 'sga':
      len = 15;
      draw.push((p) => {
        p.rect(0, 2, 5, 2, wood);
        p.rect(4, 1, len - 3, 2, metal);
        p.rect(6, 3, 6, 1, key === 'sgp' ? wood : dark);
        if (key === 'sga') p.rect(8, 4, 2, 2, dark);
      });
      break;
    case 'dmr':
    case 'bolt':
      len = key === 'dmr' ? 18 : 19;
      draw.push((p) => {
        p.rect(0, 2, 5, 2, key === 'bolt' ? wood : poly);
        p.rect(4, 2, len - 3, 1, metal);
        p.rect(6, 0, 6, 1, dark);
        p.rect(8, 1, 1, 1, dark);
        if (key === 'dmr') p.rect(9, 3, 2, 2, dark);
        else p.set(11, 3, 0xaaaaaa);
      });
      break;
    case 'lmg':
      len = 17;
      draw.push((p) => {
        p.rect(0, 2, 4, 2, poly);
        p.rect(3, 1, len - 1, 3, metal);
        p.rect(6, 4, 4, 3, 0x4a4e3a);
        p.rect(len - 2, 4, 1, 3, dark);
      });
      break;
    default:
      draw.push((p) => p.rect(2, 2, len, 2, metal));
  }
  const px = new Px(len + 5, 8);
  for (const d of draw) d(px);
  return { px, originX: 2, originY: 3, muzzleX: len + 2 };
}

/** 3×5 bitmap digits for crisp damage numbers inside the 640×360 world. */
const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '.': ['000', '000', '000', '000', '010'],
  '+': ['000', '010', '111', '010', '000'],
  '-': ['000', '000', '111', '000', '000'],
  X: ['101', '101', '010', '101', '101'],
};

export function digitSheet(color: number): Px {
  const keys = Object.keys(DIGITS);
  const p = new Px(keys.length * 4 + 2, 7);
  keys.forEach((k, i) => {
    const rows = DIGITS[k]!;
    rows.forEach((row, y) => {
      for (let x = 0; x < 3; x++) if (row[x] === '1') p.set(1 + i * 4 + x, 1 + y, color);
    });
  });
  p.outline(0x101010);
  return p;
}
export const DIGIT_KEYS = Object.keys(DIGITS);

export function simpleDot(r: number, color: number, soft = false): Px {
  const s = Math.ceil(r * 2) + 2;
  const p = new Px(s, s);
  if (!soft) p.ellipse(s / 2, s / 2, r, r, color);
  else {
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const d = Math.hypot(x + 0.5 - s / 2, y + 0.5 - s / 2) / r;
        if (d < 1) p.set(x, y, color, Math.round(255 * (1 - d) * (1 - d)));
      }
  }
  return p;
}
