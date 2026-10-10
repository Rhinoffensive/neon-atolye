import type { PlanSettings, StripProfile } from '../model/types';
import { type Vec, dist, sub, norm, add, mul, dot } from '../geom/vec';
import { unwrappedHeadings, cumLengths } from '../geom/polyline';
import { DS, type Work, rotateLoop, splitWork } from './work';

/**
 * Turn (radians) measured over a window of +-k samples around every core sample,
 * plus the effective bend radius span/|turn|.
 */
export function turnProfile(pts: Vec[], closed: boolean, k: number): { turn: Float64Array; reff: Float64Array } {
  const ring = closed ? pts.slice(0, -1) : pts;
  const n = ring.length;
  const turn = new Float64Array(n);
  const reff = new Float64Array(n);
  if (n < 3) {
    reff.fill(Infinity);
    return { turn, reff };
  }
  if (closed) {
    const K = Math.min(k, n - 1);
    const ext = [...ring.slice(n - K), ...ring, ...ring.slice(0, K + 1)];
    const h = unwrappedHeadings(ext);
    for (let i = 0; i < n; i++) {
      const a = K + i - K;
      const b = K + i + K;
      turn[i] = h[b] - h[a];
      reff[i] = Math.abs(turn[i]) > 1e-9 ? (2 * K * DS) / Math.abs(turn[i]) : Infinity;
    }
  } else {
    const h = unwrappedHeadings(ring);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - k);
      const b = Math.min(n - 1, i + k);
      turn[i] = h[b] - h[a];
      const span = (b - a) * DS;
      reff[i] = Math.abs(turn[i]) > 1e-9 && span > 0 ? span / Math.abs(turn[i]) : Infinity;
    }
  }
  return { turn, reff };
}

interface Decision {
  i: number;
  kind: 'fillet' | 'split';
  t: number; // half span in samples (fillet)
}

/** Cubic Bezier approximating a circular arc tangent to d1 at p1 and d2 at p2. */
function filletCurve(p1: Vec, d1: Vec, p2: Vec, d2: Vec): Vec[] {
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
  const chord = dist(p1, p2);
  if (theta < 1e-3) return [p2];
  const R = chord / (2 * Math.sin(theta / 2));
  const h = (4 / 3) * Math.tan(theta / 4) * R;
  const c1 = add(p1, mul(d1, h));
  const c2 = sub(p2, mul(d2, h));
  const steps = Math.max(2, Math.ceil((R * theta) / DS));
  const out: Vec[] = [];
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const mt = 1 - t;
    out.push({
      x: mt * mt * mt * p1.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p2.x,
      y: mt * mt * mt * p1.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p2.y,
    });
  }
  return out;
}

export interface CornerResult {
  works: Work[];
  fillets: number;
  splits: Vec[];
}

/**
 * Find sharp corners. Gentle corners are rounded to a bendable radius (if that does not move
 * the line more than maxFilletDeviation); sharp ones are cut into separate pieces.
 */
export function processCorners(w: Work, prof: StripProfile, set: PlanSettings): CornerResult {
  const k = Math.max(2, Math.round(prof.width / DS));
  const k2 = Math.max(1, Math.round(k / 2));
  let pts = w.pts;
  const closed = w.closed;
  if (closed) {
    const { turn } = turnProfile(pts, true, k);
    const lim = (set.cornerAngle * Math.PI) / 360;
    let seam = 0;
    if (Math.abs(turn[0]) >= lim) {
      let best = Infinity;
      for (let i = 0; i < turn.length; i++)
        if (Math.abs(turn[i]) < best) {
          best = Math.abs(turn[i]);
          seam = i;
        }
    }
    if (seam) pts = rotateLoop(pts, seam * DS);
  }
  const ring = closed ? pts.slice(0, -1) : pts;
  const n = ring.length;
  if (n < 2 * k + 2) return { works: [{ ...w, pts }], fillets: 0, splits: [] };
  const T = turnProfile(pts, closed, k).turn;
  const T2 = turnProfile(pts, closed, k2).turn;
  const H = closed ? null : unwrappedHeadings(ring);
  const cornerRad = (set.cornerAngle * Math.PI) / 180;

  // local (per-sample) heading change; a corner is a spike of it inside a high-turn region
  const Hl = closed ? unwrappedHeadings([ring[n - 1], ...ring, ring[0]]).slice(1, n + 1) : unwrappedHeadings(ring);
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    local[i] = Math.abs(Hl[b] - Hl[a]);
  }
  // corners = peaks of the narrow-window turn that are not just part of a tight arc
  const cand: number[] = [];
  const thr = 0.8 * cornerRad;
  let r0 = -1;
  const closeRun = (a: number, b: number) => {
    // the corner sits where the per-sample heading change peaks
    let c = a;
    let best = -1;
    for (let i = a; i <= b; i++) {
      const v = local[Math.max(0, i - 1)] + local[i] + local[Math.min(n - 1, i + 1)];
      if (v > best) {
        best = v;
        c = i;
      }
    }
    if (Math.abs(T[c]) >= cornerRad && Math.abs(T2[c]) >= 0.7 * Math.abs(T[c])) cand.push(c);
  };
  for (let i = 0; i < n; i++) {
    const hot = Math.abs(T2[i]) >= thr;
    if (hot && r0 < 0) r0 = i;
    if ((!hot || i === n - 1) && r0 >= 0) {
      closeRun(r0, hot ? i : i - 1);
      r0 = -1;
    }
  }
  if (!cand.length) return { works: [{ ...w, pts }], fillets: 0, splits: [] };

  // total turn of each corner over a wider window, limited by neighbouring corners
  const Kc = Math.min(3 * k, n - 1);
  const ringH = closed ? unwrappedHeadings([...ring.slice(n - Kc), ...ring, ...ring.slice(0, Kc + 1)]) : H!;
  const off = closed ? Kc : 0;
  const decisions: Decision[] = [];
  let lastEnd = -Infinity;
  cand.forEach((i, ci) => {
    const prev = ci > 0 ? cand[ci - 1] : -Infinity;
    const next = ci < cand.length - 1 ? cand[ci + 1] : Infinity;
    const kl = Math.min(Kc || 3 * k, Math.max(k, Math.min(3 * k, Math.floor((i - prev) / 2))));
    const kr = Math.min(Kc || 3 * k, Math.max(k, Math.min(3 * k, Math.floor((next - i) / 2))));
    const a = closed ? off + i - kl : Math.max(0, i - kl);
    const b = closed ? off + i + kr : Math.min(n - 1, i + kr);
    const tau = Math.abs(ringH[b] - ringH[a]);
    let decision: Decision = { i, kind: 'split', t: 0 };
    if (tau <= (150 * Math.PI) / 180) {
      const f = 1 / Math.cos(tau / 2) - 1;
      const rAllowed = f > 1e-9 ? set.maxFilletDeviation / f : Infinity;
      const R = Math.min(prof.rMinWarn, rAllowed);
      if (R >= prof.rMinHard) {
        const t = Math.ceil((R * Math.tan(tau / 2)) / DS);
        const fits = i - t >= 1 && i + t <= n - 2 && i - t > lastEnd + 2 && i + t < next - k;
        if (fits) decision = { i, kind: 'fillet', t };
      }
    }
    if (decision.kind === 'fillet') lastEnd = i + decision.t;
    else lastEnd = i;
    decisions.push(decision);
  });

  // rebuild polyline applying fillets in order, recording split positions (arc length)
  const out: Vec[] = [];
  const splitS: number[] = [];
  const removeRanges: [number, number][] = [];
  const splitPts: Vec[] = [];
  let cursor = 0;
  let fillets = 0;
  let acc = 0;
  const push = (p: Vec) => {
    if (out.length) acc += dist(out[out.length - 1], p);
    out.push(p);
  };
  for (const d of decisions) {
    if (d.kind === 'split') {
      // cut out the rounded tip of the corner so no tight hook stays on either piece end
      const kMax = 1 / prof.rMinHard;
      const curv = (j: number) => {
        const a = Math.max(0, j - 2);
        const b = Math.min(n - 1, j + 2);
        return b > a ? Math.abs(Hl[b] - Hl[a]) / ((b - a) * DS) : 0;
      };
      let jl = d.i;
      while (jl > cursor && d.i - jl < k && curv(jl - 1) > kMax) jl--;
      let jr = d.i;
      while (jr < n - 1 && jr - d.i < k && curv(jr + 1) > kMax) jr++;
      jl = Math.max(jl, cursor);
      for (; cursor <= jl; cursor++) push(ring[cursor]);
      const sA = acc;
      for (; cursor <= jr; cursor++) push(ring[cursor]);
      const sB = acc;
      if (sB - sA > 0.1) {
        splitS.push(sA, sB);
        removeRanges.push([sA, sB]);
      } else splitS.push(sA);
      splitPts.push(ring[d.i]);
    } else {
      const i1 = d.i - d.t;
      const i2 = d.i + d.t;
      for (; cursor <= i1; cursor++) push(ring[cursor]);
      const p1 = ring[i1];
      const p2 = ring[i2];
      const d1 = norm(sub(p1, ring[Math.max(0, i1 - 2)]));
      const d2 = norm(sub(ring[Math.min(n - 1, i2 + 2)], p2));
      for (const q of filletCurve(p1, d1, p2, d2)) push(q);
      cursor = i2 + 1;
      fillets++;
    }
  }
  for (; cursor < n; cursor++) push(ring[cursor]);
  if (closed) push({ ...out[0] });

  const base: Work = { ...w, pts: out, closed };
  if (!splitS.length) return { works: [base], fillets, splits: [] };
  // keep splits away from the arc-length end of closed rings
  const L = cumLengths(out).at(-1)!;
  const sList = splitS.map((s) => Math.min(Math.max(s, 0), L));
  return {
    works: splitWork(base, sList, 'corner', 0.5, removeRanges, 2 * prof.width),
    fillets,
    splits: splitPts,
  };
}
