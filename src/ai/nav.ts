import type { WorldGeometry } from '../world/geometry';

/**
 * Grid navigation (0.5u cells). Cells are blocked when a static movement blocker overlaps the cell inflated by the
 * agent radius. Door cells are passable only through a door predicate so locked doors stay closed for AI.
 */
export const NAV_CELL = 0.5;
const SQRT2 = Math.SQRT2;

export class NavGrid {
  readonly w: number;
  readonly h: number;
  readonly blocked: Uint8Array;
  readonly door: Int32Array;
  readonly doorIds: string[] = [];
  private readonly g: Float32Array;
  private readonly f: Float32Array;
  private readonly came: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint32Array;
  private gen = 1;

  constructor(geo: WorldGeometry, radius = 0.3) {
    this.w = Math.ceil(geo.map.width / NAV_CELL);
    this.h = Math.ceil(geo.map.height / NAV_CELL);
    const n = this.w * this.h;
    this.blocked = new Uint8Array(n);
    this.door = new Int32Array(n).fill(-1);
    const doorIndex = new Map<string, number>();
    for (let cy = 0; cy < this.h; cy++)
      for (let cx = 0; cx < this.w; cx++) {
        const x0 = cx * NAV_CELL - radius + 0.05;
        const y0 = cy * NAV_CELL - radius + 0.05;
        const r = geo.staticBlocked(x0, y0, x0 + NAV_CELL + 2 * radius - 0.1, y0 + NAV_CELL + 2 * radius - 0.1, 0);
        const i = cy * this.w + cx;
        if (r.blocked) this.blocked[i] = 1;
        else if (r.door) {
          let di = doorIndex.get(r.door);
          if (di === undefined) {
            di = this.doorIds.length;
            this.doorIds.push(r.door);
            doorIndex.set(r.door, di);
          }
          this.door[i] = di;
        }
      }
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  cellOf(x: number, y: number): [number, number] {
    return [Math.max(0, Math.min(this.w - 1, Math.floor(x / NAV_CELL))), Math.max(0, Math.min(this.h - 1, Math.floor(y / NAV_CELL)))];
  }

  center(cx: number, cy: number): { x: number; y: number } {
    return { x: (cx + 0.5) * NAV_CELL, y: (cy + 0.5) * NAV_CELL };
  }

  passable(i: number, doorOk: (doorId: string) => boolean): boolean {
    if (this.blocked[i]) return false;
    const d = this.door[i]!;
    if (d >= 0 && !doorOk(this.doorIds[d]!)) return false;
    return true;
  }

  walkableAt(x: number, y: number, doorOk: (doorId: string) => boolean = () => true): boolean {
    const [cx, cy] = this.cellOf(x, y);
    return this.passable(cy * this.w + cx, doorOk);
  }

  nearestWalkable(x: number, y: number, maxR = 4, doorOk: (d: string) => boolean = () => true): { x: number; y: number } | null {
    const [cx, cy] = this.cellOf(x, y);
    const maxC = Math.ceil(maxR / NAV_CELL);
    for (let r = 0; r <= maxC; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          if (this.passable(ny * this.w + nx, doorOk)) return this.center(nx, ny);
        }
    return null;
  }

  /** Straight walkability using supercover sampling along the segment. */
  lineWalkable(ax: number, ay: number, bx: number, by: number, doorOk: (d: string) => boolean): boolean {
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(d / (NAV_CELL * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.walkableAt(ax + (bx - ax) * t, ay + (by - ay) * t, doorOk)) return false;
    }
    return true;
  }

  findPath(sx: number, sy: number, tx: number, ty: number, doorOk: (doorId: string) => boolean, maxExpand = 9000): { x: number; y: number }[] | null {
    let [scx, scy] = this.cellOf(sx, sy);
    let [tcx, tcy] = this.cellOf(tx, ty);
    if (!this.passable(scy * this.w + scx, doorOk)) {
      const n = this.nearestWalkable(sx, sy, 2, doorOk);
      if (!n) return null;
      [scx, scy] = this.cellOf(n.x, n.y);
    }
    if (!this.passable(tcy * this.w + tcx, doorOk)) {
      const n = this.nearestWalkable(tx, ty, 3, doorOk);
      if (!n) return null;
      [tcx, tcy] = this.cellOf(n.x, n.y);
    }
    const start = scy * this.w + scx;
    const goal = tcy * this.w + tcx;
    if (start === goal) return [{ x: tx, y: ty }];
    this.gen++;
    if (this.gen >= 0xfffffff0) {
      this.stamp.fill(0);
      this.closed.fill(0);
      this.gen = 1;
    }
    const gen = this.gen;
    const heap: number[] = [];
    const push = (i: number) => {
      heap.push(i);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (this.f[heap[p]!]! <= this.f[heap[c]!]!) break;
        [heap[p], heap[c]] = [heap[c]!, heap[p]!];
        c = p;
      }
    };
    const pop = (): number => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = 2 * c + 1;
          const r = l + 1;
          let m = c;
          if (l < heap.length && this.f[heap[l]!]! < this.f[heap[m]!]!) m = l;
          if (r < heap.length && this.f[heap[r]!]! < this.f[heap[m]!]!) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c]!, heap[m]!];
          c = m;
        }
      }
      return top;
    };
    const hfn = (i: number) => {
      const x = i % this.w;
      const y = (i - x) / this.w;
      const dx = Math.abs(x - tcx);
      const dy = Math.abs(y - tcy);
      return (dx + dy + (SQRT2 - 2) * Math.min(dx, dy)) * 1.001;
    };
    this.g[start] = 0;
    this.f[start] = hfn(start);
    this.came[start] = -1;
    this.stamp[start] = gen;
    push(start);
    let expanded = 0;
    let found = false;
    while (heap.length > 0) {
      const cur = pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      if (cur === goal) {
        found = true;
        break;
      }
      if (++expanded > maxExpand) break;
      const cx = cur % this.w;
      const cy = (cur - cx) / this.w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const ni = ny * this.w + nx;
          if (!this.passable(ni, doorOk)) continue;
          if (dx !== 0 && dy !== 0) {
            // No corner cutting.
            if (!this.passable(cy * this.w + nx, doorOk) || !this.passable(ny * this.w + cx, doorOk)) continue;
          }
          const ng = this.g[cur]! + (dx !== 0 && dy !== 0 ? SQRT2 : 1);
          if (this.stamp[ni] === gen && ng >= this.g[ni]!) continue;
          this.stamp[ni] = gen;
          this.g[ni] = ng;
          this.f[ni] = ng + hfn(ni);
          this.came[ni] = cur;
          push(ni);
        }
    }
    if (!found) return null;
    const cells: number[] = [];
    for (let c = goal; c !== -1; c = this.came[c]!) cells.push(c);
    cells.reverse();
    const pts = cells.map((c) => this.center(c % this.w, Math.floor(c / this.w)));
    pts[pts.length - 1] = { x: tx, y: ty };
    // String pulling.
    const out: { x: number; y: number }[] = [];
    let anchor = { x: sx, y: sy };
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.lineWalkable(anchor.x, anchor.y, pts[j]!.x, pts[j]!.y, doorOk)) j--;
      out.push(pts[j]!);
      anchor = pts[j]!;
      i = j + 1;
    }
    return out;
  }
}

const cache = new WeakMap<WorldGeometry, NavGrid>();
export function navFor(geo: WorldGeometry): NavGrid {
  let n = cache.get(geo);
  if (!n) {
    n = new NavGrid(geo);
    cache.set(geo, n);
  }
  return n;
}
