import type { StripProfile, EndKind } from '../model/types';
import { type Vec, add, mul, dist } from '../geom/vec';
import { cumLengths, pointAt, tangentAt } from '../geom/polyline';
import { PointHash } from '../geom/spatial';
import { DS, type Work } from './work';

/**
 * Piece geometry during planning. The physical strip occupies arc lengths [lo, hi] of `base`;
 * values outside [0, L0] are straight extensions along the end tangents.
 */
export interface PG {
  idx: number;
  work: Work;
  prof: StripProfile;
  base: Vec[];
  cum: number[];
  L0: number;
  lo: number;
  hi: number;
  startKind: EndKind;
  endKind: EndKind;
  /** end may still move freely (not trimmed against another strip) */
  startFree: boolean;
  endFree: boolean;
  t0: Vec;
  t1: Vec;
}

export function makePG(idx: number, work: Work, prof: StripProfile): PG {
  const cum = cumLengths(work.pts);
  const L0 = cum[cum.length - 1];
  const h = Math.min(2, L0);
  return {
    idx,
    work,
    prof,
    base: work.pts,
    cum,
    L0,
    lo: 0,
    hi: L0,
    startKind: work.startKind,
    endKind: work.endKind,
    startFree: work.startKind === 'free',
    endFree: work.endKind === 'free',
    t0: tangentAt(work.pts, cum, 0, h),
    t1: tangentAt(work.pts, cum, L0, h),
  };
}

export function pgPoint(g: PG, s: number): Vec {
  if (s < 0) return add(g.base[0], mul(g.t0, s));
  if (s > g.L0) return add(g.base[g.base.length - 1], mul(g.t1, s - g.L0));
  return pointAt(g.base, g.cum, s);
}

export function pgTangent(g: PG, s: number): Vec {
  if (s <= 0) return g.t0;
  if (s >= g.L0) return g.t1;
  return tangentAt(g.base, g.cum, s, 1);
}

/** Polyline of the current physical footprint centreline. */
export function pgPolyline(g: PG): Vec[] {
  const n = Math.max(1, Math.round((g.hi - g.lo) / DS));
  const out: Vec[] = [];
  for (let k = 0; k <= n; k++) out.push(pgPoint(g, g.lo + ((g.hi - g.lo) * k) / n));
  return out;
}

interface Sample {
  p: Vec;
  s: number;
}

export function sideSamples(g: PG, s0: number, s1: number): Sample[] {
  const hw = g.prof.width / 2;
  const out: Sample[] = [];
  const n = Math.max(1, Math.ceil((s1 - s0) / DS));
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const c = pgPoint(g, s);
    const t = pgTangent(g, s);
    out.push({ p: { x: c.x + t.y * hw, y: c.y - t.x * hw }, s });
    out.push({ p: { x: c.x - t.y * hw, y: c.y + t.x * hw }, s });
  }
  return out;
}

export function faceSamples(g: PG, atStart: boolean): Sample[] {
  const hw = g.prof.width / 2;
  const s = atStart ? g.lo : g.hi;
  const c = pgPoint(g, s);
  const t = pgTangent(g, s);
  const out: Sample[] = [];
  const n = Math.max(2, Math.ceil((2 * hw) / DS));
  for (let k = 0; k <= n; k++) {
    const f = -hw + (2 * hw * k) / n;
    out.push({ p: { x: c.x + t.y * f, y: c.y - t.x * f }, s });
  }
  return out;
}

type Tag = { pi: number; s: number };

/** Keeps strip bodies at least `gap` apart by pulling piece ends back. */
export class Clearance {
  hash = new PointHash<Tag>(2.5);
  constructor(
    public pgs: PG[],
    public gap: number,
  ) {
    for (const g of pgs) this.addRange(g, g.lo, g.hi);
  }

  addRange(g: PG, s0: number, s1: number): void {
    if (s1 <= s0) return;
    for (const sm of sideSamples(g, s0, s1)) this.hash.insert(sm.p, { pi: g.idx, s: sm.s });
  }

  private selfExclusion(g: PG): number {
    return 3 * g.prof.width + this.gap;
  }

  /** True if the end region of piece gi is closer than `gap` to any other strip body. */
  conflictAtEnd(gi: number, atStart: boolean): boolean {
    const g = this.pgs[gi];
    const reach = g.prof.width + this.gap + 1;
    const r0 = atStart ? g.lo : Math.max(g.lo, g.hi - reach);
    const r1 = atStart ? Math.min(g.hi, g.lo + reach) : g.hi;
    const tests = [...sideSamples(g, r0, r1), ...faceSamples(g, atStart)];
    return this.testPoints(g, tests, atStart ? 'start' : 'end');
  }

  testPoints(g: PG, tests: Sample[], skipFace: 'start' | 'end' | null, gap = this.gap): boolean {
    const r = gap * 0.999;
    const selfEx = this.selfExclusion(g);
    for (const q of tests) {
      let hit = false;
      this.hash.query(q.p, r, (_p, tag) => {
        if (hit) return;
        const o = this.pgs[tag.pi];
        if (tag.s < o.lo - 0.01 || tag.s > o.hi + 0.01) return;
        if (tag.pi === g.idx && Math.abs(tag.s - q.s) < selfEx) return;
        hit = true;
      });
      if (hit) return true;
    }
    // end faces are not in the hash (they move when pieces are trimmed)
    const tip = tests.length ? tests[0].p : null;
    if (!tip) return false;
    for (const o of this.pgs) {
      for (const atStart of [true, false]) {
        if (o.idx === g.idx && skipFace === (atStart ? 'start' : 'end')) continue;
        const so = atStart ? o.lo : o.hi;
        const fc = pgPoint(o, so);
        if (dist(fc, tip) > o.prof.width + g.prof.width + 3 * this.gap + 12) continue;
        const face = faceSamples(o, atStart);
        for (const q of tests) {
          if (o.idx === g.idx && Math.abs(so - q.s) < selfEx) continue;
          for (const f of face) if (dist(f.p, q.p) < r) return true;
        }
      }
    }
    return false;
  }

  /**
   * Pull an end back until it clears all other strips. Returns trimmed mm, 0 if it was clear,
   * or -1 if it could not be resolved within maxTrim (geometry restored).
   */
  trimEnd(gi: number, atStart: boolean, maxTrim: number): number {
    const g = this.pgs[gi];
    if (!this.conflictAtEnd(gi, atStart)) return 0;
    const orig = atStart ? g.lo : g.hi;
    const set = (d: number) => {
      if (atStart) g.lo = orig + d;
      else g.hi = orig - d;
    };
    const limit = Math.min(maxTrim, g.hi - g.lo - 1);
    let clearAt = -1;
    for (let d = 1; d <= limit; d += 1) {
      set(d);
      if (!this.conflictAtEnd(gi, atStart)) {
        clearAt = d;
        break;
      }
    }
    if (clearAt < 0) {
      set(0);
      return -1;
    }
    // refine within the last millimetre
    let lo = clearAt - 1;
    let hi = clearAt;
    for (let it = 0; it < 4; it++) {
      const mid = (lo + hi) / 2;
      set(mid);
      if (this.conflictAtEnd(gi, atStart)) lo = mid;
      else hi = mid;
    }
    set(hi);
    return hi;
  }
}
