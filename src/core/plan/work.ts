import type { DesignStroke, EndKind } from '../model/types';
import { type Vec, dist } from '../geom/vec';
import { cumLengths, polyLength, resample, slice, reversed } from '../geom/polyline';

/** Sample spacing used throughout the planner (mm). */
export const DS = 0.5;

/** A centreline being processed by the planner. Closed loops store pts[last] == pts[0]. */
export interface Work {
  id: string;
  strokeId: string;
  itemId: string;
  profileId: string;
  pts: Vec[];
  closed: boolean;
  startKind: EndKind;
  endKind: EndKind;
  /** came from a closed letter that was opened at a seam */
  loop: boolean;
}

let seq = 0;
export const workId = () => `w${++seq}`;

function dedupe(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 1e-6) out.push(p);
  return out;
}

export function makeWork(st: DesignStroke): Work {
  let pts = dedupe(st.pts);
  const L = polyLength(pts);
  if (L < 0.3) {
    const c = pts[0] ?? { x: 0, y: 0 };
    pts = [
      { x: c.x - 0.15, y: c.y },
      { x: c.x + 0.15, y: c.y },
    ];
  } else {
    pts = resample(pts, DS);
  }
  const closed = st.closed && L > 6;
  if (closed && dist(pts[0], pts[pts.length - 1]) > 1e-6) pts.push({ ...pts[0] });
  return {
    id: workId(),
    strokeId: st.id,
    itemId: st.itemId,
    profileId: st.profileId,
    pts,
    closed,
    startKind: 'free',
    endKind: 'free',
    loop: false,
  };
}

/**
 * Join open strokes whose endpoints touch (script letters, hand-drawn segments), then
 * close strokes whose two ends meet.
 */
export function joinWorks(works: Work[], tol: number): Work[] {
  const list = works.slice();
  for (;;) {
    let best: { d: number; a: number; b: number; ae: 0 | 1; be: 0 | 1 } | null = null;
    for (let a = 0; a < list.length; a++) {
      const A = list[a];
      if (A.closed) continue;
      for (let b = a + 1; b < list.length; b++) {
        const B = list[b];
        if (B.closed || B.profileId !== A.profileId) continue;
        const ends: [0 | 1, 0 | 1][] = [
          [1, 0],
          [1, 1],
          [0, 0],
          [0, 1],
        ];
        for (const [ae, be] of ends) {
          const pa = ae ? A.pts[A.pts.length - 1] : A.pts[0];
          const pb = be ? B.pts[B.pts.length - 1] : B.pts[0];
          const d = dist(pa, pb);
          if (d < tol && (!best || d < best.d)) best = { d, a, b, ae, be };
        }
      }
    }
    if (!best) break;
    const A = list[best.a];
    const B = list[best.b];
    const a = best.ae ? A.pts : reversed(A.pts);
    const b = best.be ? reversed(B.pts) : B.pts;
    const joined = resample([...a, ...b.slice(dist(a[a.length - 1], b[0]) < 1e-6 ? 1 : 0)], DS);
    list[best.a] = { ...A, pts: joined, strokeId: A.strokeId };
    list.splice(best.b, 1);
  }
  for (const w of list) {
    if (!w.closed && w.pts.length > 4 && dist(w.pts[0], w.pts[w.pts.length - 1]) < tol && polyLength(w.pts) > 8 * tol) {
      const pts = w.pts.slice();
      pts[pts.length - 1] = { ...pts[0] };
      w.pts = resample(pts, DS);
      w.pts[w.pts.length - 1] = { ...w.pts[0] };
      w.closed = true;
    }
  }
  return list;
}

/** Rotate a closed loop so it starts at arc length s. Result is an open polyline with first == last point. */
export function rotateLoop(pts: Vec[], s: number): Vec[] {
  const cum = cumLengths(pts);
  const L = cum[cum.length - 1];
  s = ((s % L) + L) % L;
  if (s < 1e-6 || L - s < 1e-6) return pts.slice();
  const a = slice(pts, cum, s, L);
  const b = slice(pts, cum, 0, s);
  return [...a, ...b.slice(1)];
}

/**
 * Split a work at the given arc lengths. Closed works are first opened at the first split.
 * Fragments shorter than `minFrag` that touch a new cut are dropped.
 */
export function splitWork(
  w: Work,
  sList: number[],
  kind: 'corner' | 'cross' | 'split' | 'seam',
  minFrag = 0.5,
  remove: [number, number][] = [],
  /** drop fragments shorter than this when neither end is free (nothing buildable fits) */
  minConstrained = 0,
): Work[] {
  if (!sList.length) return [w];
  let pts = w.pts;
  let cum = cumLengths(pts);
  let L = cum[cum.length - 1];
  let cuts = [...new Set(sList.map((s) => Math.round(s * 1000) / 1000))].sort((x, y) => x - y);
  let startKind = w.startKind;
  let endKind = w.endKind;
  let s0 = 0;
  const L0 = L;
  if (w.closed) {
    s0 = cuts[0];
    pts = rotateLoop(pts, s0);
    cum = cumLengths(pts);
    L = cum[cum.length - 1];
    cuts = cuts.slice(1).map((s) => (((s - s0) % L) + L) % L).sort((x, y) => x - y);
    startKind = endKind = kind;
  }
  const bounds = [0, ...cuts.filter((s) => s > 1e-6 && s < L - 1e-6), L];
  const out: Work[] = [];
  const removed = (mid: number) => {
    const orig = w.closed ? (mid + s0) % L0 : mid;
    return remove.some(([a, b]) => orig > a && orig < b);
  };
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (b - a < minFrag || removed((a + b) / 2)) continue;
    const sk = i === 0 ? startKind : kind;
    const ek = i === bounds.length - 2 ? endKind : kind;
    if (b - a < minConstrained && sk !== 'free' && ek !== 'free') continue;
    out.push({
      ...w,
      id: workId(),
      pts: resample(slice(pts, cum, a, b), DS),
      closed: false,
      startKind: sk,
      endKind: ek,
      loop: w.loop || w.closed,
    });
  }
  return out;
}
