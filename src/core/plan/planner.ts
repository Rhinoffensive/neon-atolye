import type {
  DesignStroke,
  Hole,
  Issue,
  Piece,
  PlanResult,
  PlanSettings,
  Severity,
  StockUse,
  StripProfile,
} from '../model/types';
import { type Vec, boundsOf, boundsValid, dist, add, mul, emptyBounds } from '../geom/vec';
import { polyLength, reversed } from '../geom/polyline';
import { DS, type Work, joinWorks, makeWork, splitWork } from './work';
import { processCorners, turnProfile } from './corners';
import { findCrossings, resolveCrossings } from './crossings';
import { Clearance, type PG, makePG, pgPoint, pgPolyline, pgTangent, sideSamples, faceSamples } from './clearance';
import { bendSteps } from './bends';
import { planWiring } from './wiring';

let issueSeq = 0;
const issue = (i: Omit<Issue, 'id'>): Issue => ({ id: `iss${++issueSeq}`, ...i });

const fmtMm = (mm: number) => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`);

/** Effective radius per base sample of a PG (window = +- strip width). */
function reffOf(g: PG): Float64Array {
  const k = Math.max(2, Math.round(g.prof.width / DS));
  return turnProfile(g.base, false, k).reff;
}

function splitLong(w: Work, maxLen: number): Work[] {
  const L = polyLength(w.pts);
  if (L <= maxLen) return [w];
  const m = Math.ceil(L / maxLen);
  const sList: number[] = [];
  for (let k = 1; k < m; k++) sList.push((L * k) / m);
  return splitWork(w, sList, 'split');
}

/**
 * Turn design centrelines into cuttable pieces: corners, crossings, clearances, whole cut units,
 * bending steps, holes, wiring and material use.
 */
export function planDesign(strokes: DesignStroke[], profilesList: StripProfile[], set: PlanSettings): PlanResult {
  const profiles = new Map(profilesList.map((p) => [p.id, p]));
  const fallback = profilesList[0];
  const profOf = (id: string) => profiles.get(id) ?? fallback;
  const issues: Issue[] = [];

  // 1. normalise + join touching strokes
  let works = joinWorks(
    strokes.filter((s) => s.pts.length > 0).map(makeWork),
    set.joinTolerance,
  );

  // 2. corners
  let fillets = 0;
  let cornerSplits = 0;
  // repeat: corners closer together than the detection window show up one at a time
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    works = works.flatMap((w) => {
      const r = processCorners(w, profOf(w.profileId), set);
      fillets += r.fillets;
      cornerSplits += r.splits.length;
      if (r.fillets || r.splits.length) changed = true;
      return r.works;
    });
    if (!changed) break;
  }

  // 3. crossings
  const widthOf = (w: Work) => profOf(w.profileId).width;
  const crossings = findCrossings(works, widthOf);
  works = resolveCrossings(works, crossings, widthOf);

  // 4. closed loops become a single piece opened at a seam; long pieces get split
  works = works.flatMap((w) => {
    if (w.closed) {
      const pts = w.pts.slice();
      return [{ ...w, pts, closed: false, startKind: 'seam' as const, endKind: 'seam' as const, loop: true }];
    }
    return [w];
  });
  works = works.flatMap((w) => splitLong(w, Math.min(set.maxPieceLength, profOf(w.profileId).maxRunMm)));
  works = works.filter((w) => polyLength(w.pts) > 0.2);

  const allPts = works.map((w) => w.pts);
  const dBounds = allPts.length ? boundsOf(allPts) : emptyBounds();
  const entry: Vec = set.entry ?? (boundsValid(dBounds)
    ? { x: (dBounds.minX + dBounds.maxX) / 2, y: dBounds.maxY + 40 }
    : { x: 0, y: 0 });

  // 5. feed end = end closer to the power entry (pieces are oriented feed-first)
  works = works.map((w) => {
    if (w.startKind !== 'seam' && dist(w.pts[0], entry) > dist(w.pts[w.pts.length - 1], entry))
      return { ...w, pts: reversed(w.pts), startKind: w.endKind, endKind: w.startKind };
    return w;
  });

  // 6. piece geometry; in 'lit' mode free ends grow so the light (not the cap) ends where drawn
  const pgs: PG[] = works.map((w, i) => makePG(i, w, profOf(w.profileId)));
  if (set.freeEndMode === 'lit') {
    for (const g of pgs) {
      const half = g.prof.ledPitch / 2;
      if (g.startFree) g.lo = -(g.prof.capFeed + half);
      if (g.endFree) g.hi = g.L0 + g.prof.capBlind + half;
    }
  }

  // 7. clearances: pull ends back where strips would touch (crossings, corners, T-joints, seams)
  const cl = new Clearance(pgs, set.clearance);
  const order: { gi: number; atStart: boolean; pri: number }[] = [];
  pgs.forEach((g) => {
    order.push({ gi: g.idx, atStart: true, pri: g.startKind === 'free' ? 1 : 0 });
    order.push({ gi: g.idx, atStart: false, pri: g.endKind === 'free' ? 1 : 0 });
  });
  order.sort((a, b) => a.pri - b.pri || a.gi - b.gi || Number(b.atStart) - Number(a.atStart));
  for (const o of order) {
    const g = pgs[o.gi];
    const trimmed = cl.trimEnd(o.gi, o.atStart, Math.max(20, 6 * g.prof.width + 4 * set.clearance));
    if (trimmed > 0) {
      if (o.atStart) {
        g.startFree = false;
        if (g.startKind === 'free') g.startKind = 'abut';
      } else {
        g.endFree = false;
        if (g.endKind === 'free') g.endKind = 'abut';
      }
    }
  }

  // 8. whole cut units
  const residuals = new Map<number, number>();
  const units = new Map<number, number>();
  for (const g of pgs) {
    const { cutUnit: u, capFeed, capBlind } = g.prof;
    const caps = capFeed + capBlind;
    const L = g.hi - g.lo;
    if (!g.startFree && !g.endFree) {
      let N = Math.floor((L - caps) / u + 1e-6);
      if (N < 1) {
        N = 1;
        issues.push(
          issue({
            severity: 'error',
            code: 'too-short',
            message: `Parça bir kesim biriminden (${u} mm) kısa kalıyor; yer yok.`,
            at: pgPoint(g, (g.lo + g.hi) / 2),
          }),
        );
      }
      const r = L - (N * u + caps);
      g.lo += r / 2;
      g.hi -= r / 2;
      units.set(g.idx, N);
      residuals.set(g.idx, -r);
      continue;
    }
    const reff = reffOf(g);
    const markPenalty = (lo: number, N: number) => {
      let c = 0;
      for (let k = 1; k < N; k++) {
        const s = lo + capFeed + k * u;
        if (s < 0 || s > g.L0) continue;
        const i = Math.min(reff.length - 1, Math.round(s / DS));
        if (reff[i] < g.prof.rMinWarn) c++;
      }
      return c;
    };
    const N0 = (L - caps) / u;
    const cands = [...new Set([Math.round(N0), Math.floor(N0), Math.ceil(N0)].map((n) => Math.max(1, n)))];
    const lo0 = g.lo;
    const hi0 = g.hi;
    let accepted = false;
    for (const N of cands) {
      const delta = N * u + caps - L; // + grow, - shrink
      let ratios: number[];
      if (g.startFree && g.endFree) ratios = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9, 0, 1];
      else ratios = [g.startFree ? 1 : 0];
      let bestRatio = ratios[0];
      if (ratios.length > 1) {
        let bestPen = Infinity;
        for (const r of ratios) {
          const pen = markPenalty(lo0 - delta * r, N);
          if (pen < bestPen) {
            bestPen = pen;
            bestRatio = r;
          }
        }
      }
      g.lo = lo0 - delta * bestRatio;
      g.hi = hi0 + delta * (1 - bestRatio);
      if (delta > 0) {
        const bad =
          (g.lo < lo0 && cl.conflictAtEnd(g.idx, true)) || (g.hi > hi0 && cl.conflictAtEnd(g.idx, false));
        if (bad && N !== cands[cands.length - 1]) {
          g.lo = lo0;
          g.hi = hi0;
          continue;
        }
      }
      units.set(g.idx, N);
      residuals.set(g.idx, delta);
      accepted = true;
      break;
    }
    if (!accepted) {
      g.lo = lo0;
      g.hi = hi0;
      units.set(g.idx, Math.max(1, Math.round(N0)));
      residuals.set(g.idx, 0);
    }
    if (g.lo < lo0) cl.addRange(g, g.lo, lo0);
    if (g.hi > hi0) cl.addRange(g, hi0, g.hi);
  }

  // 9. assemble pieces (numbered in reading order)
  const order2 = pgs
    .map((g) => {
      const pts = pgPolyline(g);
      const b = boundsOf([pts]);
      return { g, pts, row: Math.round((b.minY + b.maxY) / 2 / 120), x: b.minX };
    })
    .sort((a, b) => a.row - b.row || a.x - b.x);

  const pieces: Piece[] = [];
  const holes: Hole[] = [];
  order2.forEach(({ g, pts }, i) => {
    const p = g.prof;
    const N = units.get(g.idx) ?? 1;
    const length = g.hi - g.lo;
    const id = `p${i + 1}`;
    let hole: Vec;
    if (p.cableExit === 'bottom') hole = pgPoint(g, g.lo + p.capFeed / 2);
    else hole = add(pgPoint(g, g.lo), mul(pgTangent(g, g.lo), -5));
    holes.push({ id: `h${i + 1}`, pieceId: id, at: hole, diameter: p.cableExit === 'bottom' ? 5 : 6 });
    pieces.push({
      id,
      no: i + 1,
      profileId: p.id,
      strokeId: g.work.strokeId,
      itemId: g.work.itemId,
      pts,
      length,
      units: N,
      stripLength: N * p.cutUnit,
      capStart: p.capFeed,
      capEnd: p.capBlind,
      litStart: p.capFeed + p.ledPitch / 2,
      litEnd: length - p.capBlind - p.ledPitch / 2,
      startKind: g.startKind,
      endKind: g.endKind,
      loop: g.work.loop,
      residual: residuals.get(g.idx) ?? 0,
      bends: bendSteps(pts, p, N),
      hole,
    });
  });

  // 10. checks on the final geometry
  const finalCl = new Clearance(pgs, set.clearance);
  const pieceOfPg = new Map(order2.map(({ g }, i) => [g.idx, pieces[i]]));
  const conflictPts: { a: number; b: number; p: Vec }[] = [];
  for (const g of pgs) {
    const tests = [...sideSamples(g, g.lo, g.hi), ...faceSamples(g, true), ...faceSamples(g, false)];
    const selfEx = 3 * g.prof.width + set.clearance;
    for (const q of tests) {
      finalCl.hash.query(q.p, set.clearance * 0.75, (pp, tag) => {
        const o = pgs[tag.pi];
        if (tag.s < o.lo - 0.01 || tag.s > o.hi + 0.01) return;
        if (tag.pi === g.idx && Math.abs(tag.s - q.s) < selfEx) return;
        if (tag.pi < g.idx) return; // report each pair once
        conflictPts.push({ a: g.idx, b: tag.pi, p: { x: (pp.x + q.p.x) / 2, y: (pp.y + q.p.y) / 2 } });
      });
    }
  }
  const clusters: { a: number; b: number; p: Vec; n: number }[] = [];
  for (const c of conflictPts) {
    const hit = clusters.find((k) => k.a === c.a && k.b === c.b && dist(k.p, c.p) < 15);
    if (hit) {
      hit.p = { x: (hit.p.x * hit.n + c.p.x) / (hit.n + 1), y: (hit.p.y * hit.n + c.p.y) / (hit.n + 1) };
      hit.n++;
    } else clusters.push({ ...c, n: 1 });
  }
  for (const c of clusters) {
    const pa = pieceOfPg.get(c.a);
    const pb = pieceOfPg.get(c.b);
    issues.push(
      issue({
        severity: 'error',
        code: 'too-close',
        message:
          c.a === c.b
            ? `P${pa?.no}: şerit kendine çok yakın geçiyor (< ${set.clearance} mm boşluk).`
            : `P${pa?.no} ile P${pb?.no} birbirine çok yakın (< ${set.clearance} mm boşluk).`,
        at: c.p,
        pieceId: pa?.id,
      }),
    );
  }

  // tight bends on final pieces
  const hotspots: PlanResult['hotspots'] = [];
  let minR = Infinity;
  for (const pc of pieces) {
    const p = profOf(pc.profileId);
    const k = Math.max(2, Math.round(p.width / DS));
    const { reff } = turnProfile(pc.pts, false, k);
    let run: { i0: number; i1: number; minR: number } | null = null;
    let worstErr = Infinity;
    let worstWarn = Infinity;
    let errAt: Vec | undefined;
    let warnAt: Vec | undefined;
    const flush = () => {
      if (!run) return;
      const sev: Severity = run.minR < p.rMinHard ? 'error' : 'warn';
      const seg = pc.pts.slice(run.i0, run.i1 + 1);
      hotspots.push({ pts: seg, severity: sev, radius: run.minR });
      const mid = seg[Math.floor(seg.length / 2)];
      if (sev === 'error' && run.minR < worstErr) {
        worstErr = run.minR;
        errAt = mid;
      } else if (sev === 'warn' && run.minR < worstWarn) {
        worstWarn = run.minR;
        warnAt = mid;
      }
      run = null;
    };
    for (let i = 0; i < reff.length; i++) {
      // the cap region is rigid; ignore it
      if (reff[i] < minR && i * DS > pc.capStart && i * DS < pc.length - pc.capEnd) minR = reff[i];
      if (reff[i] < p.rMinWarn) {
        if (!run) run = { i0: i, i1: i, minR: reff[i] };
        run.i1 = i;
        run.minR = Math.min(run.minR, reff[i]);
      } else flush();
    }
    flush();
    if (Number.isFinite(worstErr))
      issues.push(
        issue({
          severity: 'error',
          code: 'tight-bend',
          message: `P${pc.no}: R${Math.round(worstErr)} büküm şeridin sınırının (R${p.rMinHard}) altında.`,
          at: errAt,
          pieceId: pc.id,
        }),
      );
    else if (Number.isFinite(worstWarn))
      issues.push(
        issue({
          severity: 'warn',
          code: 'tight-bend',
          message: `P${pc.no}: en sıkı büküm R${Math.round(worstWarn)} (önerilen ≥ R${p.rMinWarn}).`,
          at: warnAt,
          pieceId: pc.id,
        }),
      );
    const marksInBends = pc.bends.filter((b) => b.warning?.includes('işareti')).length;
    if (marksInBends)
      issues.push(
        issue({
          severity: 'info',
          code: 'bend-at-mark',
          message: `P${pc.no}: ${marksInBends} kesim işareti sıkı bükümün içinde kalıyor (lehim pedinde dikkatli bük).`,
          pieceId: pc.id,
        }),
      );
    if (pc.stripLength > p.maxRunMm)
      issues.push(
        issue({
          severity: 'warn',
          code: 'long-run',
          message: `P${pc.no}: ${fmtMm(pc.stripLength)} tek uçtan beslemek için uzun; iki uçtan besle.`,
          pieceId: pc.id,
        }),
      );
  }

  if (crossings.length)
    issues.push(
      issue({
        severity: 'info',
        code: 'cross',
        message: `${crossings.length} kesişim: alttaki çizgi kesildi, arkadan kabloyla bağlanacak.`,
      }),
    );
  if (cornerSplits || fillets)
    issues.push(
      issue({
        severity: 'info',
        code: 'corner-split',
        message: `${cornerSplits} keskin köşe kesildi, ${fillets} köşe R${Math.round(fallback.rMinHard)}–R${Math.round(fallback.rMinWarn)} ile yuvarlatıldı.`,
      }),
    );

  // stock
  const stock: StockUse[] = profilesList.map((p) => {
    const ps = pieces.filter((pc) => pc.profileId === p.id);
    return {
      profileId: p.id,
      usedMm: ps.reduce((a, pc) => a + pc.stripLength, 0),
      availableMm: p.stockMm,
      pieces: ps.length,
    };
  });
  for (const s of stock) {
    if (s.usedMm > s.availableMm)
      issues.push(
        issue({
          severity: 'error',
          code: 'stock',
          message: `${profOf(s.profileId).name}: ${fmtMm(s.usedMm)} gerekiyor, stokta ${fmtMm(s.availableMm)} var.`,
        }),
      );
  }
  if (!pieces.length)
    issues.push(issue({ severity: 'info', code: 'empty', message: 'Henüz çizgi yok: yazı ekle ya da çiz.' }));

  const { wires, power } = planWiring(entry, holes, pieces, profiles);

  // size hints
  let maxScale = Infinity;
  let maxReason = '';
  for (const s of stock) {
    if (!s.usedMm) continue;
    const k = s.availableMm / s.usedMm;
    if (k < maxScale) {
      maxScale = k;
      maxReason = `${profOf(s.profileId).name} stoğu (${fmtMm(s.availableMm)})`;
    }
  }
  const minScale = Number.isFinite(minR) ? fallback.rMinHard / minR : 0;

  const bounds = pieces.length ? boundsOf(pieces.map((p) => p.pts), fallback.width) : emptyBounds();
  return {
    pieces,
    holes,
    wires,
    entry,
    issues,
    stock,
    power,
    size: {
      minScale,
      minReason: Number.isFinite(minR) ? `en sıkı büküm R${Math.round(minR)}` : '',
      maxScale,
      maxReason,
    },
    bounds,
    hotspots,
  };
}
