import { type Vec, dist, sub, norm, add, mul, heading, wrapAngle, cross, dot } from './vec';

export function cumLengths(pts: Vec[]): number[] {
  const c = new Array<number>(pts.length);
  c[0] = 0;
  for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + dist(pts[i - 1], pts[i]);
  return c;
}

export function polyLength(pts: Vec[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

/** Index i such that cum[i] <= s < cum[i+1] (clamped). */
export function segIndexAt(cum: number[], s: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  if (s <= 0) return 0;
  if (s >= cum[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function pointAt(pts: Vec[], cum: number[], s: number): Vec {
  if (pts.length === 1) return pts[0];
  const i = segIndexAt(cum, s);
  const seg = cum[i + 1] - cum[i];
  const t = seg > 1e-12 ? Math.max(0, Math.min(1, (s - cum[i]) / seg)) : 0;
  return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
}

/** Unit tangent at s using a chord of +-h (clamped to the ends). */
export function tangentAt(pts: Vec[], cum: number[], s: number, h = 1): Vec {
  const L = cum[cum.length - 1];
  const a = pointAt(pts, cum, Math.max(0, s - h));
  const b = pointAt(pts, cum, Math.min(L, s + h));
  return norm(sub(b, a));
}

/** Uniformly resample (spacing ~ds, endpoints kept). */
export function resample(pts: Vec[], ds: number): Vec[] {
  if (pts.length < 2) return pts.slice();
  const cum = cumLengths(pts);
  const L = cum[cum.length - 1];
  if (L < 1e-9) return [pts[0]];
  const n = Math.max(1, Math.round(L / ds));
  const out: Vec[] = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const s = (L * k) / n;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 1e-12 ? Math.max(0, Math.min(1, (s - cum[j]) / seg)) : 0;
    out.push({ x: pts[j].x + (pts[j + 1].x - pts[j].x) * t, y: pts[j].y + (pts[j + 1].y - pts[j].y) * t });
  }
  return out;
}

/** Portion of the polyline between arc lengths s0 < s1. */
export function slice(pts: Vec[], cum: number[], s0: number, s1: number): Vec[] {
  const L = cum[cum.length - 1];
  s0 = Math.max(0, s0);
  s1 = Math.min(L, s1);
  if (s1 <= s0) return [pointAt(pts, cum, s0)];
  const out: Vec[] = [pointAt(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] > s0 + 1e-9 && cum[i] < s1 - 1e-9) out.push(pts[i]);
  }
  out.push(pointAt(pts, cum, s1));
  return out;
}

/**
 * Extend (positive) or trim (negative) both ends. Extensions are straight along the end tangent,
 * which is how a strip end naturally continues.
 */
export function adjustEnds(pts: Vec[], dStart: number, dEnd: number): Vec[] {
  let cum = cumLengths(pts);
  const L = cum[cum.length - 1];
  const s0 = dStart < 0 ? -dStart : 0;
  const s1 = dEnd < 0 ? L + dEnd : L;
  let out = s0 > 0 || s1 < L ? slice(pts, cum, s0, Math.max(s0 + 1e-6, s1)) : pts.slice();
  cum = cumLengths(out);
  if (dStart > 0 && out.length >= 2) {
    const t = tangentAt(out, cum, 0, Math.min(2, cum[cum.length - 1]));
    out = [add(out[0], mul(t, -dStart)), ...out];
  }
  if (dEnd > 0 && out.length >= 2) {
    const c2 = cumLengths(out);
    const Lc = c2[c2.length - 1];
    const t = tangentAt(out, c2, Lc, Math.min(2, Lc));
    out = [...out, add(out[out.length - 1], mul(t, dEnd))];
  }
  return out;
}

export function reversed(pts: Vec[]): Vec[] {
  return pts.slice().reverse();
}

/** Centripetal Catmull-Rom through the given vertices, sampled at ~ds spacing. */
export function catmullRom(pts: Vec[], ds: number, closed = false): Vec[] {
  const n = pts.length;
  if (n < 3) return resample(pts, ds);
  const P = (i: number): Vec => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return add(pts[0], sub(pts[0], pts[1]));
    if (i >= n) return add(pts[n - 1], sub(pts[n - 1], pts[n - 2]));
    return pts[i];
  };
  const out: Vec[] = [pts[0]];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const t01 = Math.pow(Math.max(dist(p0, p1), 1e-6), 0.5);
    const t12 = Math.pow(Math.max(dist(p1, p2), 1e-6), 0.5);
    const t23 = Math.pow(Math.max(dist(p2, p3), 1e-6), 0.5);
    // Tangents (Barry-Goldman form, converted to Hermite)
    const m1 = add(
      sub(mul(sub(p1, p0), 1 / t01), mul(sub(p2, p0), 1 / (t01 + t12))),
      mul(sub(p2, p1), 1 / t12),
    );
    const m2 = add(
      sub(mul(sub(p2, p1), 1 / t12), mul(sub(p3, p1), 1 / (t12 + t23))),
      mul(sub(p3, p2), 1 / t23),
    );
    const M1 = mul(m1, t12);
    const M2 = mul(m2, t12);
    const segLen = dist(p1, p2);
    const steps = Math.max(1, Math.ceil(segLen / ds));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      out.push({
        x: h00 * p1.x + h10 * M1.x + h01 * p2.x + h11 * M2.x,
        y: h00 * p1.y + h10 * M1.y + h01 * p2.y + h11 * M2.y,
      });
    }
  }
  return out;
}

/** Turning angle at an interior vertex (radians, signed; positive = right turn in y-down). */
export function vertexTurn(a: Vec, b: Vec, c: Vec): number {
  const u = sub(b, a);
  const w = sub(c, b);
  return Math.atan2(cross(u, w), dot(u, w));
}

/**
 * Smooth a sparse polyline (e.g. a single-line font glyph) with Catmull-Rom while keeping
 * intentional corners (vertex turns above `cornerDeg`) sharp.
 */
export function smoothKeepCorners(pts: Vec[], cornerDeg: number, ds: number, closed = false): Vec[] {
  const clean: Vec[] = [];
  for (const p of pts) if (!clean.length || dist(clean[clean.length - 1], p) > 1e-6) clean.push(p);
  if (clean.length < 3) return resample(clean, ds);
  const lim = (cornerDeg * Math.PI) / 180;
  const n = clean.length;
  const isCorner = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n - 1; i++) isCorner[i] = Math.abs(vertexTurn(clean[i - 1], clean[i], clean[i + 1])) > lim;
  if (closed && n > 3) {
    const t = Math.abs(vertexTurn(clean[n - 2], clean[0], clean[1]));
    if (t > lim) isCorner[0] = isCorner[n - 1] = true;
  }
  const hasCorner = isCorner.some(Boolean);
  if (closed && !hasCorner) {
    const ring = clean.slice(0, n - 1); // last == first
    return catmullRom(ring, ds, true);
  }
  const out: Vec[] = [];
  let runStart = 0;
  for (let i = 1; i < n; i++) {
    if (isCorner[i] || i === n - 1) {
      const run = clean.slice(runStart, i + 1);
      const sm = catmullRom(run, ds, false);
      if (out.length) sm.shift();
      out.push(...sm);
      runStart = i;
    }
  }
  return out;
}

/**
 * Unwrapped heading per vertex of a (roughly uniformly sampled) polyline.
 * Vertex heading = average of adjacent segment headings.
 */
export function unwrappedHeadings(pts: Vec[]): number[] {
  const n = pts.length;
  const seg: number[] = [];
  for (let i = 0; i < n - 1; i++) seg.push(heading(sub(pts[i + 1], pts[i])));
  for (let i = 1; i < seg.length; i++) seg[i] = seg[i - 1] + wrapAngle(seg[i] - seg[i - 1]);
  const h = new Array<number>(n);
  if (seg.length === 0) return [0];
  h[0] = seg[0];
  h[n - 1] = seg[seg.length - 1];
  for (let i = 1; i < n - 1; i++) h[i] = (seg[i - 1] + seg[i]) / 2;
  return h;
}

/** Ramer-Douglas-Peucker simplification. */
export function rdp(pts: Vec[], eps: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    const A = pts[a];
    const B = pts[b];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const l = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / l;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Offset a polyline sideways by d (positive = left of travel direction in y-down coords). */
export function offsetPolyline(pts: Vec[], d: number): Vec[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const t = norm(sub(b, a));
    // left normal in y-down screen coordinates is (t.y, -t.x)
    out.push({ x: pts[i].x + t.y * d, y: pts[i].y - t.x * d });
  }
  return out;
}
