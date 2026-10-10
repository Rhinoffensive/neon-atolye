/** 2D vector helpers. Coordinates are millimetres, y axis points down (SVG convention). */
export interface Vec {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
/** z of the 3D cross product. In y-down coordinates a positive value is a right (clockwise) turn. */
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Vec, b: Vec): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const norm = (a: Vec): Vec => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};
export const heading = (a: Vec): number => Math.atan2(a.y, a.x);
export const fromAngle = (t: number): Vec => ({ x: Math.cos(t), y: Math.sin(t) });
export const rotate = (a: Vec, t: number): Vec => {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;

/** Closest point on segment ab to p; returns parameter t in [0,1] and distance. */
export function closestOnSegment(p: Vec, a: Vec, b: Vec): { t: number; d: number; q: Vec } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + abx * t, y: a.y + aby * t };
  return { t, d: Math.hypot(p.x - q.x, p.y - q.y), q };
}

/** Proper intersection of segments p1p2 and p3p4 (excluding collinear overlaps). */
export function segIntersect(
  p1: Vec,
  p2: Vec,
  p3: Vec,
  p4: Vec,
): { t: number; u: number; p: Vec } | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const ex = p3.x - p1.x;
  const ey = p3.y - p1.y;
  const t = (ex * d2y - ey * d2x) / den;
  const u = (ex * d1y - ey * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, p: { x: p1.x + d1x * t, y: p1.y + d1y * t } };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function growBounds(b: Bounds, p: Vec, pad = 0): void {
  if (p.x - pad < b.minX) b.minX = p.x - pad;
  if (p.y - pad < b.minY) b.minY = p.y - pad;
  if (p.x + pad > b.maxX) b.maxX = p.x + pad;
  if (p.y + pad > b.maxY) b.maxY = p.y + pad;
}

export function boundsOf(polys: Vec[][], pad = 0): Bounds {
  const b = emptyBounds();
  for (const pl of polys) for (const p of pl) growBounds(b, p, pad);
  return b;
}

export const boundsValid = (b: Bounds): boolean => Number.isFinite(b.minX) && b.maxX >= b.minX;
