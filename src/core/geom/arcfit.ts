import { type Vec, sub, dist, wrapAngle, heading } from './vec';
import { cumLengths } from './polyline';

export interface FitElement {
  kind: 'line' | 'arc';
  /** arc length position along the input polyline where the element starts */
  s0: number;
  length: number;
  /** Infinity for lines */
  radius: number;
  /** signed sweep in radians; positive = right turn (y-down coordinates) */
  sweep: number;
}

function circumcircle(a: Vec, b: Vec, c: Vec): { c: Vec; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}

function lineDeviation(pts: Vec[], i: number, j: number): number {
  const A = pts[i];
  const B = pts[j];
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const l = Math.hypot(dx, dy) || 1e-12;
  let m = 0;
  for (let k = i + 1; k < j; k++) {
    const d = Math.abs((pts[k].x - A.x) * dy - (pts[k].y - A.y) * dx) / l;
    if (d > m) m = d;
  }
  return m;
}

/** Returns signed sweep if points i..j lie on a circle within tol, else null. */
function arcFit(pts: Vec[], i: number, j: number, tol: number): { r: number; sweep: number } | null {
  const m = (i + j) >> 1;
  const cc = circumcircle(pts[i], pts[m], pts[j]);
  if (!cc) return null;
  let sweep = 0;
  let prev = heading(sub(pts[i], cc.c));
  for (let k = i; k <= j; k++) {
    if (Math.abs(dist(pts[k], cc.c) - cc.r) > tol) return null;
    if (k > i) {
      const h = heading(sub(pts[k], cc.c));
      const dh = wrapAngle(h - prev);
      // all steps must turn the same way
      if (sweep !== 0 && Math.sign(dh) !== Math.sign(sweep) && Math.abs(dh) > 1e-6) return null;
      sweep += dh;
      prev = h;
    }
  }
  if (Math.abs(sweep) > 2 * Math.PI - 0.05) return null;
  // orientation of travel: angular velocity around centre has the sign of the turn in y-down coords
  return { r: cc.r, sweep };
}

/**
 * Greedy approximation of a polyline by straight lines and circular arcs, within `tol` mm.
 * Expects roughly uniform sampling (e.g. 0.5 mm).
 */
export function fitLinesArcs(pts: Vec[], tol = 0.5, maxRadius = 400): FitElement[] {
  const n = pts.length;
  if (n < 2) return [];
  const cum = cumLengths(pts);
  const fits = (i: number, j: number): boolean => {
    if (j - i < 2) return true;
    if (lineDeviation(pts, i, j) <= tol) return true;
    return arcFit(pts, i, j, tol) !== null;
  };
  const raw: FitElement[] = [];
  let i = 0;
  while (i < n - 1) {
    let good = Math.min(i + 2, n - 1);
    if (!fits(i, good)) good = i + 1;
    else {
      let step = 4;
      while (good + step <= n - 1 && fits(i, good + step)) {
        good += step;
        step *= 2;
      }
      let lo = good;
      let hi = Math.min(good + step, n - 1);
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (fits(i, mid)) lo = mid;
        else hi = mid;
      }
      if (hi > lo && fits(i, hi)) lo = hi;
      good = lo;
    }
    const length = cum[good] - cum[i];
    let el: FitElement;
    if (good - i < 2 || lineDeviation(pts, i, good) <= tol) {
      el = { kind: 'line', s0: cum[i], length, radius: Infinity, sweep: 0 };
    } else {
      const a = arcFit(pts, i, good, tol)!;
      el = a.r > maxRadius
        ? { kind: 'line', s0: cum[i], length, radius: Infinity, sweep: 0 }
        : { kind: 'arc', s0: cum[i], length, radius: a.r, sweep: a.sweep };
    }
    raw.push(el);
    i = good;
  }
  return mergeElements(raw, pts, cum);
}

function mergeElements(els: FitElement[], pts: Vec[], cum: number[]): FitElement[] {
  const out: FitElement[] = [];
  const dirAt = (s: number) => {
    // heading of the polyline at s (small chord)
    let k = 0;
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    return heading(sub(pts[Math.min(k + 1, pts.length - 1)], pts[k]));
  };
  for (const e of els) {
    const last = out[out.length - 1];
    if (last) {
      if (last.kind === 'line' && e.kind === 'line') {
        const turn = Math.abs(wrapAngle(dirAt(e.s0 + 0.1) - dirAt(last.s0 + 0.1)));
        if (turn < (3 * Math.PI) / 180) {
          last.length += e.length;
          continue;
        }
      }
      if (last.kind === 'arc' && e.kind === 'arc' && Math.sign(last.sweep) === Math.sign(e.sweep)) {
        const rr = Math.max(last.radius, e.radius) / Math.min(last.radius, e.radius);
        if (rr < 1.15) {
          const sweep = last.sweep + e.sweep;
          const length = last.length + e.length;
          out[out.length - 1] = { kind: 'arc', s0: last.s0, length, sweep, radius: length / Math.abs(sweep) };
          continue;
        }
      }
    }
    out.push({ ...e });
  }
  // absorb tiny elements (< 3 mm) into a neighbour
  const res: FitElement[] = [];
  for (let k = 0; k < out.length; k++) {
    const e = out[k];
    if (e.length < 3 && (res.length || k < out.length - 1)) {
      if (res.length) {
        const p = res[res.length - 1];
        p.length += e.length;
        if (p.kind === 'arc') p.sweep += e.sweep;
      } else {
        const nx = out[k + 1];
        nx.s0 = e.s0;
        nx.length += e.length;
        if (nx.kind === 'arc') nx.sweep += e.sweep;
      }
      continue;
    }
    res.push(e);
  }
  for (const e of res) if (e.kind === 'arc') e.radius = e.length / Math.max(1e-9, Math.abs(e.sweep));
  return res;
}

/** Total signed turn of the fitted elements (useful for tests). */
export const totalSweep = (els: FitElement[]): number => els.reduce((a, e) => a + e.sweep, 0);

/** Sign helper used by instruction text: 'R' for right turn in y-down coordinates. */
export const turnDir = (sweep: number): 'L' | 'R' => (sweep >= 0 ? 'R' : 'L');

