export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const EPS = 1e-9;
export const DEG = Math.PI / 180;

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function approach(cur: number, target: number, maxDelta: number): number {
  if (cur < target) return Math.min(target, cur + maxDelta);
  return Math.max(target, cur - maxDelta);
}
export function len2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
export function dist2(a: Vec2, b: Vec2): number {
  return len2(a.x - b.x, a.y - b.y);
}
export function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x,
    dy = a.y - b.y,
    dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
export function norm2(x: number, y: number): Vec2 {
  const l = len2(x, y);
  if (!(l > EPS) || !Number.isFinite(l)) return { x: 0, y: 0 };
  return { x: x / l, y: y / l };
}
export function norm3(v: Vec3): Vec3 {
  const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (!(l > EPS) || !Number.isFinite(l)) return { x: 0, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
export function isFiniteVec(v: Vec2 | Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && (!('z' in v) || Number.isFinite(v.z));
}
/** Wrap angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r <= -Math.PI) r += Math.PI * 2;
  if (r > Math.PI) r -= Math.PI * 2;
  return r;
}
export function angleDiff(a: number, b: number): number {
  return wrapAngle(a - b);
}

/** Axis-aligned 3D box (ground footprint + height range). */
export interface Box3 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z0: number;
  z1: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * Slab test of the infinite line p(t) = o + d t against a box. Returns [tEnter, tExit] (may be negative) or null.
 * Using the infinite line lets callers compute true pass-through thickness even when the segment ends inside.
 */
export function lineBox3(o: Vec3, d: Vec3, b: Box3): [number, number] | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, b.x0, b.x1],
    [o.y, d.y, b.y0, b.y1],
    [o.z, d.z, b.z0, b.z1],
  ];
  for (const [oa, da, lo, hi] of axes) {
    if (Math.abs(da) < EPS) {
      if (oa < lo || oa > hi) return null;
    } else {
      let t1 = (lo - oa) / da;
      let t2 = (hi - oa) / da;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return [tmin, tmax];
}

/**
 * Infinite line vs vertical cylinder (center cx,cy radius r, z in [z0,z1]). Returns [tEnter, tExit] or null.
 */
export function lineCylinder(o: Vec3, d: Vec3, cx: number, cy: number, r: number, z0: number, z1: number, topInclusive = true): [number, number] | null {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const a = d.x * d.x + d.y * d.y;
  let tmin: number;
  let tmax: number;
  if (a < EPS) {
    if (ox * ox + oy * oy > r * r) return null;
    tmin = -Infinity;
    tmax = Infinity;
  } else {
    const bq = 2 * (ox * d.x + oy * d.y);
    const c = ox * ox + oy * oy - r * r;
    const disc = bq * bq - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    tmin = (-bq - sq) / (2 * a);
    tmax = (-bq + sq) / (2 * a);
  }
  if (Math.abs(d.z) < EPS) {
    // Half-open [z0, z1) unless this is the top-most volume (so z = 1.40 exactly is head, not body).
    if (o.z < z0 || o.z > z1 || (!topInclusive && o.z >= z1)) return null;
  } else {
    let tz1 = (z0 - o.z) / d.z;
    let tz2 = (z1 - o.z) / d.z;
    if (tz1 > tz2) {
      const tmp = tz1;
      tz1 = tz2;
      tz2 = tmp;
    }
    tmin = Math.max(tmin, tz1);
    tmax = Math.min(tmax, tz2);
  }
  if (tmin > tmax) return null;
  return [tmin, tmax];
}

/** 2D segment vs rect intersection test (for LOS on footprints). Returns entry t in [0,1] or null. */
export function segRect2(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): [number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  let tmin = 0;
  let tmax = 1;
  if (Math.abs(dx) < EPS) {
    if (ax < x0 || ax > x1) return null;
  } else {
    let t1 = (x0 - ax) / dx;
    let t2 = (x1 - ax) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (Math.abs(dy) < EPS) {
    if (ay < y0 || ay > y1) return null;
  } else {
    let t1 = (y0 - ay) / dy;
    let t2 = (y1 - ay) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return [tmin, tmax];
}

/** Circle vs AABB overlap; returns push-out vector (min translation) or null. */
export function circleRectPush(cx: number, cy: number, r: number, x0: number, y0: number, x1: number, y1: number): Vec2 | null {
  const nx = clamp(cx, x0, x1);
  const ny = clamp(cy, y0, y1);
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > EPS) {
    const d = Math.sqrt(d2);
    return { x: (dx / d) * (r - d), y: (dy / d) * (r - d) };
  }
  // Center inside the rect: push out along the smallest axis.
  const left = cx - x0 + r;
  const right = x1 - cx + r;
  const up = cy - y0 + r;
  const down = y1 - cy + r;
  const m = Math.min(left, right, up, down);
  if (m === left) return { x: -left, y: 0 };
  if (m === right) return { x: right, y: 0 };
  if (m === up) return { x: 0, y: -up };
  return { x: 0, y: down };
}

export function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > EPS ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp01(t);
  return len2(px - (ax + dx * t), py - (ay + dy * t));
}

export function round(v: number, digits = 3): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}
