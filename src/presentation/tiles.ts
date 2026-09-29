import type { GroundDef, MapDef } from '../content/mapTypes';
import { hashXY, mix, Px, shade } from './pixel';

const T = 16;

/** Render a whole map's ground layer into one canvas (static; drawn once per map load). */
export function renderGround(map: MapDef, grounds: GroundDef[]): HTMLCanvasElement {
  const W = map.width * T;
  const H = map.height * T;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const put = (x: number, y: number, c: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    d[i] = (c >> 16) & 255;
    d[i + 1] = (c >> 8) & 255;
    d[i + 2] = c & 255;
    d[i + 3] = 255;
  };
  for (let ty = 0; ty < map.height; ty++)
    for (let tx = 0; tx < map.width; tx++) {
      const g = grounds[map.ground[ty * map.width + tx] ?? 0]!;
      const id = g.id;
      const base = g.color;
      for (let py = 0; py < T; py++)
        for (let px = 0; px < T; px++) {
          const x = tx * T + px;
          const y = ty * T + py;
          const n = hashXY(x, y, 7);
          let c = base;
          switch (id) {
            case 'grass':
            case 'grass_dry':
            case 'forest':
              c = n < 0.12 ? shade(base, 1.18) : n < 0.22 ? shade(base, 0.86) : base;
              if (hashXY(x, y >> 1, 3) < 0.04) c = shade(base, 1.3);
              break;
            case 'dirt':
            case 'field':
              c = n < 0.15 ? shade(base, 0.85) : n < 0.2 ? shade(base, 1.15) : base;
              if (id === 'field' && (y % 6 === 0 || y % 6 === 1)) c = shade(base, 0.82);
              break;
            case 'mud':
              c = n < 0.25 ? shade(base, 0.8) : n > 0.95 ? shade(base, 1.3) : base;
              break;
            case 'water': {
              const wave = Math.sin((x + y * 0.5) * 0.35) + Math.sin(y * 0.7 + x * 0.1);
              c = wave > 1.4 ? shade(base, 1.35) : wave < -1.2 ? shade(base, 0.8) : base;
              break;
            }
            case 'asphalt':
              c = n < 0.18 ? shade(base, 1.18) : n < 0.24 ? shade(base, 0.82) : base;
              break;
            case 'concrete':
            case 'tile':
              c = n < 0.1 ? shade(base, 0.92) : base;
              if (px === 0 || py === 0) c = shade(base, id === 'tile' ? 0.78 : 0.92);
              break;
            case 'wood_floor':
              c = py % 4 === 0 ? shade(base, 0.78) : n < 0.08 ? shade(base, 1.12) : base;
              if (py % 4 !== 0 && (px + (Math.floor(py / 4) % 2) * 8) % 16 === 0) c = shade(base, 0.8);
              break;
            case 'gravel':
            case 'rail':
              c = n < 0.3 ? shade(base, 1.2) : n < 0.5 ? shade(base, 0.8) : base;
              break;
            case 'metal':
              c = (px + py) % 4 === 0 ? shade(base, 1.2) : base;
              if (px === 0 || py === 0) c = shade(base, 0.7);
              break;
            case 'snow':
              c = n < 0.1 ? shade(base, 0.92) : base;
              break;
          }
          put(x, y, c);
        }
      if (id === 'rail') {
        // Ties and two rails running vertically in each rail tile.
        for (let py = 0; py < T; py += 4) for (let px = 2; px < 14; px++) put(tx * T + px, ty * T + py, 0x5a4230);
        for (let py = 0; py < T; py++) {
          put(tx * T + 4, ty * T + py, 0x9a9aa0);
          put(tx * T + 11, ty * T + py, 0x9a9aa0);
        }
      }
    }
  // Painted floor marking: a yellow/black hazard border around each turret drill zone (shooting range, Q05).
  for (const t of map.turrets ?? []) {
    const z = t.zone;
    const x0 = Math.round(z.x * T);
    const y0 = Math.round(z.y * T);
    const x1 = Math.round((z.x + z.w) * T) - 1;
    const y1 = Math.round((z.y + z.h) * T) - 1;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (Math.min(x - x0, x1 - x, y - y0, y1 - y) > 2) continue;
        put(x, y, ((x + y) >> 2) % 2 === 0 ? 0xe0b830 : 0x2a2a2a);
      }
  }
  // Road markings: dashed center lines on long asphalt runs (vertical and horizontal).
  ctx.putImageData(img, 0, 0);
  return cv;
}

export interface ObstacleArt {
  top: number;
  front: number;
  pattern: (p: Px, x: number, y: number, w: number, h: number, isTop: boolean, variant: number) => void;
  alpha?: number;
}

const concrete: ObstacleArt = {
  top: 0x8c8c88,
  front: 0x6c6c68,
  pattern: (p, x, y, w, h, isTop, v) => {
    p.noise(x, y, w, h, isTop ? 0x9a9a96 : 0x5e5e5a, 0.08, 11 + v);
    if (!isTop) for (let xx = x + 15; xx < x + w; xx += 16) p.rect(xx, y, 1, h, 0x5a5a56);
  },
};

export const OBSTACLE_ART: Record<string, ObstacleArt> = {
  wall_concrete: concrete,
  pillar: concrete,
  building: concrete,
  wall_brick: {
    top: 0x7a5244,
    front: 0x8a4a38,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return void p.noise(x, y, w, h, 0x6a4236, 0.1, 5);
      for (let yy = y; yy < y + h; yy += 4) {
        p.rect(x, yy, w, 1, 0x5a3024);
        const off = ((yy - y) / 4) % 2 === 0 ? 0 : 4;
        for (let xx = x + off; xx < x + w; xx += 8) p.rect(xx, yy, 1, 4, 0x5a3024);
      }
    },
  },
  wall_wood: {
    top: 0x8a6a44,
    front: 0x7a5a36,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let xx = x; xx < x + w; xx += 4) p.rect(xx, y, 1, h, 0x5a3e22);
      p.noise(x, y, w, h, 0x6a4a2a, 0.08, 9);
    },
  },
  wall_metal: {
    top: 0x6a7078,
    front: 0x5a6068,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let xx = x; xx < x + w; xx += 3) p.rect(xx, y, 1, h, 0x4a5058);
      p.noise(x, y, w, h, 0x7a5a3a, 0.05, 13);
    },
  },
  glass: {
    top: 0xb8e2f0,
    front: 0x9fd4e8,
    alpha: 120,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      p.line(x + 1, y + h - 2, x + Math.min(w, h) - 2, y + 1, 0xffffff, 160);
    },
  },
  fence_chain: {
    top: 0x8a9098,
    front: 0x8a9098,
    alpha: 110,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let i = -h; i < w; i += 3) {
        p.line(x + i, y, x + i + h, y + h, 0x9aa0a8, 150);
      }
      for (let xx = x; xx < x + w; xx += 16) p.rect(xx, y, 1, h, 0x5a6068);
    },
  },
  fence_wood: {
    top: 0x7a5a36,
    front: 0x8a6a44,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let xx = x; xx < x + w; xx += 4) p.rect(xx + 3, y + 2, 1, h - 2, 0x000000, 0);
      p.rect(x, y + 3, w, 1, 0x5a3e22);
      p.rect(x, y + h - 4, w, 1, 0x5a3e22);
    },
  },
  sandbag: {
    top: 0xb09a6a,
    front: 0xa08a5a,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let yy = y; yy < y + h; yy += 4) {
        const off = ((yy - y) / 4) % 2 === 0 ? 0 : 3;
        for (let xx = x + off; xx < x + w; xx += 6) p.rect(xx, yy, 1, 4, 0x7a6a42);
        p.rect(x, yy, w, 1, 0x7a6a42);
      }
    },
  },
  barrier: {
    top: 0xa0a09a,
    front: 0x8a8a84,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let xx = x; xx < x + w; xx += 8) p.rect(xx, y + 2, 4, 2, 0xd8b040);
    },
  },
  crate_wood: {
    top: 0x9a7448,
    front: 0x8a643a,
    pattern: (p, x, y, w, h, isTop) => {
      p.rect(x, y, w, 1, 0x5a3e22);
      p.rect(x, y + h - 1, w, 1, 0x5a3e22);
      if (!isTop) p.line(x, y, x + w - 1, y + h - 1, 0x6a4a2a);
    },
  },
  crate_metal: {
    top: 0x5a6448,
    front: 0x4a543a,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let xx = x + 2; xx < x + w; xx += 5) p.rect(xx, y, 1, h, 0x3a4430);
      p.rect(x, y + 1, w, 1, 0x6a7458);
    },
  },
  car: {
    top: 0x8a3a30,
    front: 0x7a3228,
    pattern: (p, x, y, w, h, isTop, v) => {
      const body = [0x8a3a30, 0x3a5a8a, 0xb0b0a8, 0x4a6a3a][v % 4]!;
      p.rect(x, y, w, h, isTop ? shade(body, 1.05) : shade(body, 0.85));
      if (isTop) {
        p.rect(x + Math.floor(w * 0.25), y + 2, Math.floor(w * 0.5), Math.max(1, h - 4), 0x2a3a4a);
      } else {
        p.rect(x + 3, y + 1, w - 6, Math.max(1, Math.floor(h * 0.35)), 0x2a3a4a);
        p.rect(x + 2, y + h - 3, 5, 3, 0x141414);
        p.rect(x + w - 7, y + h - 3, 5, 3, 0x141414);
        p.noise(x, y, w, h, 0x6a4028, 0.06, 21 + v);
      }
    },
  },
  tree: {
    top: 0x5a4028,
    front: 0x5a4028,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let yy = y; yy < y + h; yy += 3) p.rect(x, yy, w, 1, 0x4a3420);
    },
  },
  pine: {
    top: 0x4a3420,
    front: 0x4a3420,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let yy = y; yy < y + h; yy += 2) p.rect(x + ((yy / 2) % 2), yy, 1, 1, 0x3a2818);
    },
  },
  bush: {
    top: 0x3e6a32,
    front: 0x345a2a,
    alpha: 235,
    pattern: (p, x, y, w, h, _isTop, v) => {
      p.noise(x, y, w, h, 0x4e7a40, 0.3, 31 + v);
      p.noise(x, y, w, h, 0x28481f, 0.2, 37 + v);
    },
  },
  reeds: {
    top: 0x8a9a4a,
    front: 0x7a8a3e,
    alpha: 225,
    pattern: (p, x, y, w, h, _isTop, v) => {
      for (let xx = x; xx < x + w; xx += 2) {
        const hh = Math.floor(h * (0.6 + 0.4 * hashXY(xx, v, 5)));
        p.rect(xx, y + h - hh, 1, hh, hashXY(xx, 3, v) < 0.5 ? 0x9aaa56 : 0x6a7a36);
        if (hashXY(xx, 9, v) < 0.3) p.rect(xx, y + h - hh - 2, 1, 2, 0x6a4a2a);
      }
    },
  },
  crops: {
    top: 0x6a8a3a,
    front: 0x5a7a30,
    alpha: 230,
    pattern: (p, x, y, w, h) => {
      for (let yy = y; yy < y + h; yy += 3) p.rect(x, yy, w, 1, 0x8aa040);
      p.noise(x, y, w, h, 0xb8a040, 0.08, 41);
    },
  },
  machine: {
    top: 0x6a6e74,
    front: 0x55595f,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return void p.rect(x + 2, y + 2, Math.max(1, w - 4), Math.max(1, h - 4), 0x5a5e64);
      p.rect(x + 2, y + 2, Math.max(1, w - 4), Math.max(1, Math.floor(h / 2)), 0x44484e);
      p.set(x + 3, y + 3, 0x40d060);
      p.set(x + 5, y + 3, 0xd04040);
    },
  },
  shelf: {
    top: 0x6a4a2e,
    front: 0x5a3e24,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let yy = y + 3; yy < y + h; yy += 7) p.rect(x, yy, w, 1, 0x3a2814);
      p.noise(x, y, w, h, 0x8a6a4a, 0.06, 51);
    },
  },
  counter: {
    top: 0x8a6a48,
    front: 0x6a4e32,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) p.rect(x, y, w, 1, 0xa08058);
      else p.rect(x, y, w, 1, 0x4a3420);
    },
  },
  container: {
    top: 0x7a3a2a,
    front: 0x6a3222,
    pattern: (p, x, y, w, h, isTop, v) => {
      const c = [0x7a3a2a, 0x2a5a7a, 0x3a6a3a, 0x8a7a2a][v % 4]!;
      p.rect(x, y, w, h, isTop ? shade(c, 1.1) : c);
      if (!isTop) for (let xx = x + 1; xx < x + w; xx += 3) p.rect(xx, y, 1, h, shade(c, 0.8));
    },
  },
  hay: {
    top: 0xc8a850,
    front: 0xb89840,
    pattern: (p, x, y, w, h) => {
      p.noise(x, y, w, h, 0xe0c060, 0.2, 61);
      p.rect(x + Math.floor(w / 3), y, 1, h, 0x8a7030);
    },
  },
  steel_plate: {
    top: 0x4a4e54,
    front: 0x3a3e44,
    pattern: (p, x, y, w, h) => {
      p.set(x + 1, y + 1, 0x8a8e94);
      p.set(x + w - 2, y + h - 2, 0x8a8e94);
    },
  },
  railcar: {
    top: 0x6a4a32,
    front: 0x5a3e2a,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      for (let xx = x + 4; xx < x + w; xx += 8) p.rect(xx, y, 1, h, 0x4a3020);
      p.rect(x, y + h - 3, w, 3, 0x2a2a2a);
    },
  },
  tank_leg: {
    top: 0x6a7078,
    front: 0x5a6068,
    pattern: () => {},
  },
  tent: {
    top: 0x5a6a42,
    front: 0x4a5a36,
    pattern: (p, x, y, w, h, isTop) => {
      if (!isTop) p.line(x, y + h - 1, x + Math.floor(w / 2), y, 0x3a4a28);
    },
  },
  door_wood: {
    top: 0x7a5232,
    front: 0x8a6038,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      p.rect(x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2), 0x9a6c40);
      p.set(x + w - 3, y + Math.floor(h / 2), 0xe0c060);
    },
  },
  door_metal: {
    top: 0x5a6068,
    front: 0x4a5058,
    pattern: (p, x, y, w, h, isTop) => {
      if (isTop) return;
      p.rect(x + 1, y + 1, Math.max(1, w - 2), 1, 0x6a7078);
      p.set(x + w - 3, y + Math.floor(h / 2), 0xc0c0c0);
    },
  },
};

/**
 * Box obstacle texture in the oblique projection: top face (depth rows) above the front face (height rows).
 * Width/depth/height in pixels. `front` false renders only the top strip (used for inner slices).
 */
export function obstacleTexture(render: string, w: number, depth: number, height: number, variant: number, front: boolean): Px {
  const art = OBSTACLE_ART[render] ?? concrete;
  const fh = front ? height : 0;
  const p = new Px(w, depth + fh);
  const a = art.alpha ?? 255;
  p.rect(0, 0, w, depth, art.top, a);
  art.pattern(p, 0, 0, w, depth, true, variant);
  if (fh > 0) {
    p.rect(0, depth, w, fh, art.front, a);
    art.pattern(p, 0, depth, w, fh, false, variant);
    // Ground contact shadow line and top edge highlight.
    p.rect(0, depth + fh - 1, w, 1, shade(art.front, 0.7), a);
    p.rect(0, depth, w, 1, mix(art.front, 0xffffff, 0.12), a);
  }
  return p;
}

export function canopyTexture(kind: string, variant: number): Px {
  if (kind === 'canopy_pine') {
    const p = new Px(28, 44);
    const c1 = variant % 2 ? 0x2a4a2e : 0x2e5234;
    for (let i = 0; i < 4; i++) {
      const w = 8 + i * 5;
      const y = 4 + i * 9;
      for (let yy = 0; yy < 12; yy++) {
        const ww = Math.round((w * yy) / 12);
        p.rect(14 - ww / 2, y + yy, ww, 1, yy % 3 === 0 ? shade(c1, 1.2) : c1);
      }
    }
    p.outline(0x142418);
    return p;
  }
  const p = new Px(36, 30);
  const c = [0x3e6a34, 0x4a7236, 0x55703a][variant % 3]!;
  p.ellipse(18, 16, 16, 12, c);
  p.ellipse(12, 11, 8, 6, shade(c, 1.15));
  p.ellipse(24, 19, 8, 6, shade(c, 0.85));
  p.noise(2, 2, 32, 26, shade(c, 1.3), 0.06, 71 + variant);
  p.outline(0x1e3418);
  return p;
}

export function roofTexture(w: number, h: number, style: string): Px {
  const p = new Px(w, h);
  const base = style === 'metal' ? 0x5a5e66 : style === 'tile' ? 0x7a4034 : 0x6a5a4a;
  p.rect(0, 0, w, h, base);
  for (let y = 0; y < h; y += 4) p.rect(0, y, w, 1, shade(base, 0.82));
  p.noise(0, 0, w, h, shade(base, 1.15), 0.05, 81);
  p.rect(0, 0, w, 2, shade(base, 1.2));
  p.rect(0, h - 2, w, 2, shade(base, 0.7));
  return p;
}
