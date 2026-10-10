import type { Vec } from '../core/geom/vec';
import { cumLengths, pointAt, slice, tangentAt, rdp } from '../core/geom/polyline';

export function ptsToD(pts: Vec[], eps = 0.05): string {
  const p = eps > 0 ? rdp(pts, eps) : pts;
  if (!p.length) return '';
  let s = `M${p[0].x.toFixed(2)} ${p[0].y.toFixed(2)}`;
  for (let i = 1; i < p.length; i++) s += `L${p[i].x.toFixed(2)} ${p[i].y.toFixed(2)}`;
  return s;
}

export function subPts(pts: Vec[], s0: number, s1: number): Vec[] {
  return slice(pts, cumLengths(pts), s0, s1);
}

/** Point and unit normal at arc length s. */
export function frameAt(pts: Vec[], s: number, cum = cumLengths(pts)): { p: Vec; n: Vec; t: Vec } {
  const p = pointAt(pts, cum, s);
  const t = tangentAt(pts, cum, s, 1);
  return { p, t, n: { x: t.y, y: -t.x } };
}

export const fmtLen = (mm: number): string =>
  mm >= 1000 ? `${(mm / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m` : `${Math.round(mm)} mm`;

export const fmtCm = (mm: number): string => `${(mm / 10).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} cm`;

/** Mix a hex colour with black (k<1) or white (k>1 as 2-k) for UI shading. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (k <= 1) {
    r *= k;
    g *= k;
    b *= k;
  } else {
    const t = k - 1;
    r += (255 - r) * t;
    g += (255 - g) * t;
    b += (255 - b) * t;
  }
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
