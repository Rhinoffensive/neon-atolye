import { type Vec, segIntersect, sub, norm, dot } from '../geom/vec';
import { cumLengths } from '../geom/polyline';
import { DS, type Work, splitWork } from './work';

export interface Crossing {
  a: number;
  sa: number;
  b: number;
  sb: number;
  p: Vec;
  /** acute angle between the two lines, radians */
  angle: number;
}

/** All places where centrelines cross (strip cannot pass over itself on the board). */
export function findCrossings(works: Work[], widthOf: (w: Work) => number): Crossing[] {
  const cell = 5;
  const grid = new Map<string, [number, number][]>();
  works.forEach((w, wi) => {
    for (let si = 0; si < w.pts.length - 1; si++) {
      const p = w.pts[si];
      const q = w.pts[si + 1];
      const x0 = Math.floor(Math.min(p.x, q.x) / cell);
      const x1 = Math.floor(Math.max(p.x, q.x) / cell);
      const y0 = Math.floor(Math.min(p.y, q.y) / cell);
      const y1 = Math.floor(Math.max(p.y, q.y) / cell);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const key = `${x},${y}`;
          let arr = grid.get(key);
          if (!arr) grid.set(key, (arr = []));
          arr.push([wi, si]);
        }
    }
  });
  const cums = works.map((w) => cumLengths(w.pts));
  const seen = new Set<string>();
  const found: Crossing[] = [];
  for (const arr of grid.values()) {
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        let [wa, sa] = arr[x];
        let [wb, sb] = arr[y];
        if (wa > wb || (wa === wb && sa > sb)) [wa, sa, wb, sb] = [wb, sb, wa, sa];
        const key = `${wa}:${sa}:${wb}:${sb}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (wa === wb) {
          const W = works[wa];
          const nseg = W.pts.length - 1;
          let gap = Math.abs(sa - sb);
          if (W.closed) gap = Math.min(gap, nseg - gap);
          if (gap * DS < 3 * widthOf(W)) continue;
        }
        const A = works[wa].pts;
        const B = works[wb].pts;
        const hit = segIntersect(A[sa], A[sa + 1], B[sb], B[sb + 1]);
        if (!hit) continue;
        const da = norm(sub(A[sa + 1], A[sa]));
        const db = norm(sub(B[sb + 1], B[sb]));
        const angle = Math.acos(Math.min(1, Math.abs(dot(da, db))));
        found.push({
          a: wa,
          sa: cums[wa][sa] + hit.t * (cums[wa][sa + 1] - cums[wa][sa]),
          b: wb,
          sb: cums[wb][sb] + hit.u * (cums[wb][sb + 1] - cums[wb][sb]),
          p: hit.p,
          angle,
        });
      }
    }
  }
  // merge duplicates (segment endpoints shared by two cells); a crossing right at an open end is a
  // T-joint / touch, which the clearance pass resolves by pulling that end back
  const nearEnd = (wi: number, s: number) => {
    if (works[wi].closed) return false;
    const L = cums[wi][cums[wi].length - 1];
    const m = 2 * widthOf(works[wi]);
    return s < m || s > L - m;
  };
  const out: Crossing[] = [];
  for (const c of found) {
    if (nearEnd(c.a, c.sa) || nearEnd(c.b, c.sb)) continue;
    if (out.some((o) => o.a === c.a && o.b === c.b && Math.abs(o.sa - c.sa) < 2 && Math.abs(o.sb - c.sb) < 2)) continue;
    out.push(c);
  }
  return out;
}

/**
 * Break one of the two lines at each crossing. The clearance pass later pulls the new ends
 * back so the continuous strip passes through the gap.
 */
export function resolveCrossings(works: Work[], crossings: Crossing[], widthOf: (w: Work) => number): Work[] {
  const lengths = works.map((w) => cumLengths(w.pts).at(-1)!);
  const cuts = new Map<number, number[]>();
  /** free length around s on work wi before hitting an end or an existing cut */
  const room = (wi: number, s: number): number => {
    const L = lengths[wi];
    const list = cuts.get(wi) ?? [];
    if (works[wi].closed) {
      if (!list.length) return L / 2;
      let m = Infinity;
      for (const c of list) {
        const d = Math.abs(c - s);
        m = Math.min(m, d, L - d);
      }
      return m;
    }
    let left = s;
    let right = L - s;
    for (const c of list) {
      if (c <= s) left = Math.min(left, s - c);
      else right = Math.min(right, c - s);
    }
    return Math.min(left, right);
  };
  // crossings with little room on either strand are decided first
  const ordered = [...crossings].sort(
    (x, y) => Math.max(room(x.a, x.sa), room(x.b, x.sb)) - Math.max(room(y.a, y.sa), room(y.b, y.sb)),
  );
  for (const c of ordered) {
    const ra = room(c.a, c.sa);
    const rb = room(c.b, c.sb);
    let wi: number;
    let s: number;
    if (Math.abs(ra - rb) > 2) {
      [wi, s] = ra > rb ? [c.a, c.sa] : [c.b, c.sb];
    } else if (c.a === c.b) {
      wi = c.a;
      s = Math.max(c.sa, c.sb); // second pass over the same spot goes "under"
    } else {
      [wi, s] = lengths[c.a] <= lengths[c.b] ? [c.a, c.sa] : [c.b, c.sb];
    }
    const arr = cuts.get(wi) ?? [];
    arr.push(s);
    cuts.set(wi, arr);
  }
  const out: Work[] = [];
  works.forEach((w, i) => {
    const sList = cuts.get(i);
    if (!sList) out.push(w);
    else out.push(...splitWork(w, sList, 'cross', 2 * widthOf(w), [], 2 * widthOf(w)));
  });
  return out;
}
