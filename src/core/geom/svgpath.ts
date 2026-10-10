import type { Vec } from './vec';

/** A flattened subpath: dense polyline plus whether it was closed with Z. */
export interface FlatSubpath {
  pts: Vec[];
  closed: boolean;
}

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Cursor over a path string; arc flags are read as single characters ("a1 1 0 011 1" is valid SVG). */
class Reader {
  i = 0;
  constructor(private s: string) {}
  private skip(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++;
  }
  done(): boolean {
    this.skip();
    return this.i >= this.s.length;
  }
  /** Returns a command letter if one is next, else null. */
  command(): string | null {
    this.skip();
    const c = this.s[this.i];
    if (c && /[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      this.i++;
      return c;
    }
    return null;
  }
  number(): number {
    this.skip();
    NUM_RE.lastIndex = this.i;
    const m = NUM_RE.exec(this.s);
    if (!m) throw new Error(`SVG path parse error at ${this.i}: "${this.s.slice(this.i, this.i + 12)}"`);
    this.i = NUM_RE.lastIndex;
    return parseFloat(m[0]);
  }
  flag(): number {
    this.skip();
    const c = this.s[this.i++];
    if (c !== '0' && c !== '1') throw new Error('SVG path: bad arc flag');
    return c === '1' ? 1 : 0;
  }
}

function cubicPoint(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Flatten a cubic with a step count derived from its control-polygon length. */
function flattenCubic(out: Vec[], p0: Vec, p1: Vec, p2: Vec, p3: Vec, step: number): void {
  const poly =
    Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const n = Math.max(2, Math.min(400, Math.ceil(poly / step)));
  for (let i = 1; i <= n; i++) out.push(cubicPoint(p0, p1, p2, p3, i / n));
}

function flattenArc(
  out: Vec[],
  p0: Vec,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: number,
  sweep: number,
  p1: Vec,
  step: number,
): void {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-9 || ry < 1e-9) {
    out.push(p1);
    return;
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cphi = Math.cos(phi);
  const sphi = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1p = cphi * dx + sphi * dy;
  const y1p = -sphi * dx + cphi * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cphi * cxp - sphi * cyp + (p0.x + p1.x) / 2;
  const cy = sphi * cxp + cphi * cyp + (p0.y + p1.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(2, Math.min(720, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / step)));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push({ x: cphi * ex - sphi * ey + cx, y: sphi * ex + cphi * ey + cy });
  }
}

/**
 * Parse an SVG path "d" string and flatten it into polylines.
 * `step` is the approximate chord length (in path units) for curves.
 */
export function flattenPath(d: string, step = 0.5): FlatSubpath[] {
  const r = new Reader(d);
  const result: FlatSubpath[] = [];
  let cur: Vec[] | null = null;
  let pos: Vec = { x: 0, y: 0 };
  let start: Vec = { x: 0, y: 0 };
  let lastCtrl: Vec | null = null;
  let lastQuad: Vec | null = null;
  let cmd = '';

  const flush = (closed: boolean) => {
    if (cur && cur.length > 1) result.push({ pts: cur, closed });
    cur = null;
  };
  const begin = (p: Vec) => {
    flush(false);
    cur = [p];
    start = p;
  };
  const num = () => r.number();

  while (!r.done()) {
    const c = r.command();
    if (c) {
      cmd = c;
      if (cmd === 'Z' || cmd === 'z') {
        if (cur) {
          const pts = cur as Vec[];
          const last = pts[pts.length - 1];
          if (Math.hypot(last.x - start.x, last.y - start.y) > 1e-9) pts.push(start);
          flush(true);
        }
        pos = start;
        lastCtrl = lastQuad = null;
        continue;
      }
    } else if (!cmd) {
      throw new Error('SVG path must start with a command');
    }
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    const base = rel ? pos : { x: 0, y: 0 };
    if (!cur && up !== 'M') begin(pos);
    switch (up) {
      case 'M': {
        const p = { x: base.x + num(), y: base.y + num() };
        begin(p);
        pos = p;
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit lineto
        lastCtrl = lastQuad = null;
        break;
      }
      case 'L': {
        const p = { x: base.x + num(), y: base.y + num() };
        cur!.push(p);
        pos = p;
        lastCtrl = lastQuad = null;
        break;
      }
      case 'H': {
        const p = { x: (rel ? pos.x : 0) + num(), y: pos.y };
        cur!.push(p);
        pos = p;
        lastCtrl = lastQuad = null;
        break;
      }
      case 'V': {
        const p = { x: pos.x, y: (rel ? pos.y : 0) + num() };
        cur!.push(p);
        pos = p;
        lastCtrl = lastQuad = null;
        break;
      }
      case 'C': {
        const c1 = { x: base.x + num(), y: base.y + num() };
        const c2 = { x: base.x + num(), y: base.y + num() };
        const p = { x: base.x + num(), y: base.y + num() };
        flattenCubic(cur!, pos, c1, c2, p, step);
        lastCtrl = c2;
        lastQuad = null;
        pos = p;
        break;
      }
      case 'S': {
        const c1 = lastCtrl ? { x: 2 * pos.x - lastCtrl.x, y: 2 * pos.y - lastCtrl.y } : pos;
        const c2 = { x: base.x + num(), y: base.y + num() };
        const p = { x: base.x + num(), y: base.y + num() };
        flattenCubic(cur!, pos, c1, c2, p, step);
        lastCtrl = c2;
        lastQuad = null;
        pos = p;
        break;
      }
      case 'Q': {
        const q = { x: base.x + num(), y: base.y + num() };
        const p = { x: base.x + num(), y: base.y + num() };
        const c1 = { x: pos.x + (2 / 3) * (q.x - pos.x), y: pos.y + (2 / 3) * (q.y - pos.y) };
        const c2 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) };
        flattenCubic(cur!, pos, c1, c2, p, step);
        lastQuad = q;
        lastCtrl = null;
        pos = p;
        break;
      }
      case 'T': {
        const q: Vec = lastQuad ? { x: 2 * pos.x - lastQuad.x, y: 2 * pos.y - lastQuad.y } : pos;
        const p = { x: base.x + num(), y: base.y + num() };
        const c1 = { x: pos.x + (2 / 3) * (q.x - pos.x), y: pos.y + (2 / 3) * (q.y - pos.y) };
        const c2 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) };
        flattenCubic(cur!, pos, c1, c2, p, step);
        lastQuad = q;
        lastCtrl = null;
        pos = p;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = r.flag();
        const sweep = r.flag();
        const p = { x: base.x + num(), y: base.y + num() };
        flattenArc(cur!, pos, rx, ry, rot, large, sweep, p, step);
        lastCtrl = lastQuad = null;
        pos = p;
        break;
      }
      default:
        throw new Error(`SVG path: unsupported command ${cmd}`);
    }
  }
  flush(false);
  return result;
}

/** Serialize a polyline as an SVG path string (with fixed precision). */
export function polylineToD(pts: Vec[], closed = false, prec = 2): string {
  if (pts.length === 0) return '';
  const f = (n: number) => +n.toFixed(prec);
  let s = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let k = 1; k < pts.length; k++) s += `L${f(pts[k].x)} ${f(pts[k].y)}`;
  return closed ? s + 'Z' : s;
}
