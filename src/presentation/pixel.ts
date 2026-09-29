/**
 * Tiny pixel painter for procedural pixel-art textures (no external image assets).
 * Deterministic: noise uses a positional hash, never Math.random().
 */
export function hashXY(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function shade(color: number, f: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((color & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

export function mix(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

export class Px {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;

  constructor(w: number, h: number) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }

  set(x: number, y: number, c: number, a = 255): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    if (a >= 255) {
      this.data[i] = (c >> 16) & 255;
      this.data[i + 1] = (c >> 8) & 255;
      this.data[i + 2] = c & 255;
      this.data[i + 3] = 255;
      return;
    }
    const sa = a / 255;
    const da = this.data[i + 3]! / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    this.data[i] = (((c >> 16) & 255) * sa + this.data[i]! * da * (1 - sa)) / oa;
    this.data[i + 1] = (((c >> 8) & 255) * sa + this.data[i + 1]! * da * (1 - sa)) / oa;
    this.data[i + 2] = ((c & 255) * sa + this.data[i + 2]! * da * (1 - sa)) / oa;
    this.data[i + 3] = oa * 255;
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[(y * this.w + x) * 4 + 3]!;
  }

  rect(x: number, y: number, w: number, h: number, c: number, a = 255): this {
    for (let yy = Math.floor(y); yy < Math.floor(y + h); yy++) for (let xx = Math.floor(x); xx < Math.floor(x + w); xx++) this.set(xx, yy, c, a);
    return this;
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: number, a = 255): this {
    for (let yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++)
      for (let xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
        const dx = (xx + 0.5 - cx) / Math.max(0.5, rx);
        const dy = (yy + 0.5 - cy) / Math.max(0.5, ry);
        if (dx * dx + dy * dy <= 1) this.set(xx, yy, c, a);
      }
    return this;
  }

  line(x0: number, y0: number, x1: number, y1: number, c: number, a = 255): this {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const n = Math.max(dx, dy, 1);
    for (let i = 0; i <= n; i++) this.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c, a);
    return this;
  }

  /** Dither-noise fill over an area (texture detail). */
  noise(x: number, y: number, w: number, h: number, c: number, density: number, seed: number, a = 255): this {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (hashXY(xx, yy, seed) < density) this.set(xx, yy, c, a);
    return this;
  }

  /** Auto outline: dark pixels around opaque shapes (classic pixel-art look). */
  outline(c: number, a = 255): this {
    const src = new Uint8ClampedArray(this.data);
    const alpha = (x: number, y: number) => (x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : src[(y * this.w + x) * 4 + 3]!);
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (alpha(x, y) > 40) continue;
        if (alpha(x - 1, y) > 128 || alpha(x + 1, y) > 128 || alpha(x, y - 1) > 128 || alpha(x, y + 1) > 128) this.set(x, y, c, a);
      }
    return this;
  }

  blit(src: Px, dx: number, dy: number, flip = false): this {
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        const sx = flip ? src.w - 1 - x : x;
        const i = (y * src.w + sx) * 4;
        const a = src.data[i + 3]!;
        if (a === 0) continue;
        const c = (src.data[i]! << 16) | (src.data[i + 1]! << 8) | src.data[i + 2]!;
        this.set(dx + x, dy + y, c, a);
      }
    return this;
  }

  toCanvas(): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = this.w;
    cv.height = this.h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(this.w, this.h);
    img.data.set(this.data);
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  toDataURL(): string {
    return this.toCanvas().toDataURL('image/png');
  }
}
