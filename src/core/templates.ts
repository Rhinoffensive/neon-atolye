/**
 * Ready-made neon line drawings. Coordinates are millimetres (y down) at the default size; every
 * template is drawn for 6 mm strip: bends >= R12, strands >= 8 mm apart, pieces >= one cut unit.
 * Each part becomes one path item in its own colour; parts of a template move/scale together.
 */

export interface TemplatePart {
  name: string;
  color: string;
  d: string;
}

export interface NeonTemplate {
  id: string;
  name: string;
  emoji: string;
  parts: TemplatePart[];
}

type Pt = [number, number];
const RAD = Math.PI / 180;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pt = (p: Pt) => `${r2(p[0])} ${r2(p[1])}`;
const polar = (cx: number, cy: number, r: number, deg: number): Pt => [cx + r * Math.cos(deg * RAD), cy + r * Math.sin(deg * RAD)];

/** Closed circle; the strip's seam sits at `seamDeg` (0 = right, 90 = bottom). */
function circle(cx: number, cy: number, r: number, seamDeg = 90): string {
  const a = polar(cx, cy, r, seamDeg);
  const b = polar(cx, cy, r, seamDeg + 180);
  return `M${pt(a)}A${r} ${r} 0 1 1 ${pt(b)}A${r} ${r} 0 1 1 ${pt(a)}Z`;
}

/** Arc from angle a0 to a1 (degrees; increasing = clockwise on screen). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const sweep = a1 > a0 ? 1 : 0;
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${pt(polar(cx, cy, r, a0))}A${r} ${r} 0 ${large} ${sweep} ${pt(polar(cx, cy, r, a1))}`;
}

function poly(points: Pt[], closed = false): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${pt(p)}`).join('') + (closed ? 'Z' : '');
}

/** Catmull-Rom spline through the points, written as cubic Beziers. */
function smooth(points: Pt[], closed = false): string {
  const n = points.length;
  const P = (i: number): Pt => {
    if (closed) return points[((i % n) + n) % n];
    if (i < 0) return [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]];
    if (i >= n) return [2 * points[n - 1][0] - points[n - 2][0], 2 * points[n - 1][1] - points[n - 2][1]];
    return points[i];
  };
  let d = `M${pt(points[0])}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return closed ? d + 'Z' : d;
}

/**
 * Polygon with every corner rounded (radius per corner, 0 = keep the corner sharp so the strip is
 * cut there). Neighbouring fillets share an edge, so they shrink together if they would overlap.
 * Closed shapes start mid-edge (that is where the strip's seam goes).
 */
function rounded(points: Pt[], radius: number | number[], closed = true): string {
  const n = points.length;
  const rad = (i: number) => (Array.isArray(radius) ? radius[i % radius.length] : radius);
  const idx = (i: number) => ((i % n) + n) % n;
  const len = (i: number, j: number) => Math.hypot(points[j][0] - points[i][0], points[j][1] - points[i][1]);
  const isCorner = (i: number) => closed || (i > 0 && i < n - 1);
  const theta: number[] = [];
  const want: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!isCorner(i)) {
      theta.push(0);
      want.push(0);
      continue;
    }
    const a = points[idx(i - 1)];
    const b = points[i];
    const c = points[idx(i + 1)];
    const ux = a[0] - b[0];
    const uy = a[1] - b[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const th = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))));
    theta.push(th);
    want.push(rad(i) > 0 ? rad(i) / Math.tan(th / 2) : 0);
  }
  // shrink fillets that would not fit on their edges
  const scale = want.map(() => 1);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = idx(i + 1);
    const need = want[i] + want[j];
    const room = 0.98 * len(i, j);
    if (need > room) {
      const k = room / need;
      scale[i] = Math.min(scale[i], k);
      scale[j] = Math.min(scale[j], k);
    }
  }
  const corner = (i: number) => {
    const b = points[i];
    if (want[i] <= 0) return `L${pt(b)}`;
    const a = points[idx(i - 1)];
    const c = points[idx(i + 1)];
    const t = want[i] * scale[i];
    const r = t * Math.tan(theta[i] / 2);
    const lu = len(i, idx(i - 1));
    const lv = len(i, idx(i + 1));
    const pin: Pt = [b[0] + ((a[0] - b[0]) / lu) * t, b[1] + ((a[1] - b[1]) / lu) * t];
    const pout: Pt = [b[0] + ((c[0] - b[0]) / lv) * t, b[1] + ((c[1] - b[1]) / lv) * t];
    // right turn (clockwise on screen) -> sweep 1
    const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    return `L${pt(pin)}A${r2(r)} ${r2(r)} 0 0 ${turn > 0 ? 1 : 0} ${pt(pout)}`;
  };
  if (closed) {
    const mid: Pt = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
    let d = `M${pt(mid)}`;
    for (let k = 1; k <= n; k++) d += corner(k % n);
    return `${d}L${pt(mid)}Z`;
  }
  let d = `M${pt(points[0])}`;
  for (let i = 1; i < n - 1; i++) d += corner(i);
  return `${d}L${pt(points[n - 1])}`;
}

/** Closed ellipse as a dense polyline; the seam sits at `seamDeg` of the unrotated ellipse. */
function ellipse(cx: number, cy: number, rx: number, ry: number, rotDeg: number, seamDeg = 0, n = 96): string {
  const c = Math.cos(rotDeg * RAD);
  const s = Math.sin(rotDeg * RAD);
  const pts: Pt[] = [];
  for (let k = 0; k <= n; k++) {
    const t = (seamDeg + (360 * k) / n) * RAD;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return poly(pts.slice(0, -1), true);
}

function star(cx: number, cy: number, outer: number, inner: number, tipR: number, innerR: number): string {
  const pts: Pt[] = [];
  for (let i = 0; i < 10; i++) pts.push(polar(cx, cy, i % 2 ? inner : outer, -90 + i * 36));
  return rounded(pts, [tipR, innerR]);
}

const C = {
  yellow: '#ffb31a',
  red: '#ff2a3a',
  pink: '#ff3fb4',
  ice: '#3aa0ff',
  green: '#2dff6a',
  white: '#e8f4ff',
  warm: '#ffd9a0',
  orange: '#ff6a1a',
  purple: '#a64dff',
};

const face = circle(150, 150, 140, 90);

export const TEMPLATES: NeonTemplate[] = [
  {
    id: 'smile',
    name: 'Gülen yüz',
    emoji: '🙂',
    parts: [
      {
        name: 'Yüz',
        color: C.yellow,
        d: face + poly([[105, 92], [105, 140]]) + poly([[195, 92], [195, 140]]) + arc(150, 140, 82, 25, 155),
      },
    ],
  },
  {
    id: 'wink',
    name: 'Göz kırpan',
    emoji: '😉',
    parts: [
      {
        name: 'Yüz',
        color: C.yellow,
        d: face + poly([[105, 92], [105, 140]]) + arc(195, 134, 26, 200, 340) + arc(150, 140, 82, 20, 150),
      },
    ],
  },
  {
    id: 'cool',
    name: 'Havalı',
    emoji: '😎',
    parts: [
      { name: 'Yüz', color: C.yellow, d: face + arc(150, 150, 85, 35, 145) },
      {
        name: 'Gözlük',
        color: C.ice,
        d:
          poly([[24, 100], [276, 100]]) +
          smooth([[58, 100], [64, 128], [86, 150], [112, 150], [132, 130], [138, 100]]) +
          smooth([[162, 100], [168, 130], [188, 150], [214, 150], [236, 128], [242, 100]]),
      },
    ],
  },
  {
    id: 'heart',
    name: 'Kalp',
    emoji: '❤️',
    parts: [
      {
        name: 'Kalp',
        color: C.red,
        d: 'M140 250C90 210 34.6 158.2 20 100A60 60 0 0 1 140 70A60 60 0 0 1 260 100C245.4 158.2 190 210 140 250Z',
      },
    ],
  },
  {
    id: 'star',
    name: 'Yıldız',
    emoji: '⭐',
    parts: [{ name: 'Yıldız', color: C.yellow, d: star(155, 160, 150, 62, 14, 16) }],
  },
  {
    id: 'bolt',
    name: 'Şimşek',
    emoji: '⚡',
    parts: [
      {
        name: 'Şimşek',
        color: C.yellow,
        // the bottom tip is too sharp to bend: it stays a corner and the strip is cut there
        d: rounded(
          [
            [170, 10],
            [60, 190],
            [150, 190],
            [110, 330],
            [250, 130],
            [160, 130],
            [210, 10],
          ],
          [16, 15, 16, 0, 15, 16, 15],
        ),
      },
    ],
  },
  {
    id: 'beer',
    name: 'Bira',
    emoji: '🍺',
    parts: [
      {
        name: 'Bardak',
        color: C.yellow,
        d:
          'M40 95L52 300A22 22 0 0 0 74 322L186 322A22 22 0 0 0 208 300L220 95' +
          'M219 135L234 135A28 28 0 0 1 262 163L262 234A28 28 0 0 1 234 262L211 262',
      },
      {
        name: 'Köpük',
        color: C.warm,
        d:
          smooth([
            [26, 112],
            [30, 88],
            [52, 74],
            [80, 78],
            [108, 67],
            [136, 74],
            [164, 66],
            [192, 74],
            [216, 72],
            [236, 92],
            [234, 116],
          ]) +
          poly([[100, 190], [100, 232]]) +
          poly([[150, 236], [150, 278]]),
      },
    ],
  },
  {
    id: 'skull',
    name: 'Kuru kafa',
    emoji: '💀',
    parts: [
      {
        name: 'Kafa',
        color: C.white,
        d:
          'M45 190A100 100 0 1 1 215 190C201.8 211.2 199 226 198 244L196 296A20 20 0 0 1 176 316L84 316A20 20 0 0 1 64 296L62 244C61 226 58.2 211.2 45 190Z' +
          circle(92, 166, 28, 90) +
          circle(168, 166, 28, 90) +
          poly([[117, 236], [130, 206], [143, 236]]) +
          poly([[82, 258], [178, 258]]) +
          poly([[106, 258], [106, 300]]) +
          poly([[130, 258], [130, 300]]) +
          poly([[154, 258], [154, 300]]),
      },
    ],
  },
  {
    id: 'coffee',
    name: 'Kahve',
    emoji: '☕',
    parts: [
      {
        name: 'Fincan',
        color: C.warm,
        d:
          'M58 150L58 222A58 58 0 0 0 116 280L174 280A58 58 0 0 0 232 222L232 150' +
          poly([[44, 150], [246, 150]]) +
          'M232 172L246 172A26 26 0 0 1 272 198L272 210A26 26 0 0 1 246 236L229 236' +
          poly([[30, 300], [262, 300]]),
      },
      {
        name: 'Buhar',
        color: C.white,
        d:
          smooth([[112, 128], [101, 93], [113, 58], [102, 23]]) +
          smooth([[148, 128], [137, 93], [149, 58], [138, 23]]) +
          smooth([[184, 128], [173, 93], [185, 58], [174, 23]]),
      },
    ],
  },
  {
    id: 'cocktail',
    name: 'Kokteyl',
    emoji: '🍸',
    parts: [
      {
        name: 'Kadeh',
        color: C.ice,
        d:
          rounded(
            [
              [28, 40],
              [232, 40],
              [130, 172],
            ],
            [14, 14, 16],
          ) +
          poly([[52, 70], [208, 70]]) +
          poly([[130, 163], [130, 304]]) +
          poly([[78, 304], [182, 304]]),
      },
      { name: 'Zeytin', color: C.green, d: circle(112, 108, 16, 300) },
      { name: 'Kürdan', color: C.yellow, d: poly([[123, 96], [196, 18]]) },
    ],
  },
  {
    id: 'icecream',
    name: 'Dondurma',
    emoji: '🍦',
    parts: [
      {
        name: 'Külah',
        color: C.yellow,
        d:
          rounded(
            [
              [40, 150],
              [180, 150],
              [110, 338],
            ],
            [15, 15, 15],
          ) +
          poly([[95, 150], [137.5, 264.1]]) +
          poly([[145, 150], [162.5, 197]]) +
          poly([[125, 150], [82.5, 264.1]]) +
          poly([[75, 150], [57.5, 197]]),
      },
      {
        name: 'Top',
        color: C.pink,
        d: smooth([
          [34, 138],
          [26, 112],
          [44, 86],
          [70, 80],
          [86, 58],
          [112, 52],
          [136, 58],
          [152, 78],
          [178, 84],
          [194, 108],
          [186, 138],
        ]),
      },
      { name: 'Kiraz', color: C.red, d: circle(112, 22, 15, 270) },
    ],
  },
  {
    id: 'basketball',
    name: 'Basketbol',
    emoji: '🏀',
    parts: [
      {
        name: 'Top',
        color: C.orange,
        d:
          circle(150, 150, 140, 45) +
          poly([[150, 8], [150, 292]]) +
          poly([[8, 150], [292, 150]]) +
          arc(-63.65, 150, 163.65, -40.9, 40.9) +
          arc(363.65, 150, 163.65, 139.1, 220.9),
      },
    ],
  },
  {
    id: 'moon',
    name: 'Ay yıldız',
    emoji: '🌙',
    parts: [
      {
        name: 'Ay yıldız',
        color: C.white,
        d: 'M210.9 41A130 130 0 1 0 210.9 259A112 112 0 1 1 210.9 41Z' + star(274, 150, 72, 29, 13, 13),
      },
    ],
  },
  {
    id: 'music',
    name: 'Nota',
    emoji: '🎵',
    parts: [
      {
        name: 'Nota',
        color: C.purple,
        d:
          ellipse(70, 270, 30, 21, -20, 0) +
          ellipse(190, 240, 30, 21, -20, 0) +
          poly([
            [97, 262],
            [97, 62],
            [217, 32],
            [217, 232],
          ]),
      },
    ],
  },
  {
    id: 'flame',
    name: 'Alev',
    emoji: '🔥',
    parts: [
      {
        name: 'Dış alev',
        color: C.orange,
        d: smooth(
          [
            [110, 322],
            [60, 304],
            [34, 258],
            [38, 204],
            [62, 158],
            [94, 114],
            [112, 64],
            [118, 22],
            [142, 74],
            [168, 124],
            [188, 184],
            [188, 250],
            [162, 302],
          ],
          true,
        ),
      },
      {
        name: 'İç alev',
        color: C.yellow,
        d: smooth(
          [
            [110, 300],
            [80, 284],
            [70, 248],
            [84, 208],
            [106, 170],
            [118, 130],
            [130, 178],
            [146, 216],
            [150, 254],
            [138, 288],
          ],
          true,
        ),
      },
    ],
  },
  {
    id: 'crown',
    name: 'Taç',
    emoji: '👑',
    parts: [
      {
        name: 'Taç',
        color: C.yellow,
        d:
          rounded(
            [
              [40, 250],
              [40, 95],
              [100, 165],
              [150, 60],
              [200, 165],
              [260, 95],
              [260, 250],
            ],
            14,
          ) + poly([[40, 215], [260, 215]]),
      },
    ],
  },
];

/** Bounds of a template in its own coordinates (mm). */
export function templateBounds(
  t: NeonTemplate,
  flatten: (d: string) => { pts: { x: number; y: number }[] }[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const part of t.parts)
    for (const sp of flatten(part.d))
      for (const p of sp.pts) {
        b.minX = Math.min(b.minX, p.x);
        b.minY = Math.min(b.minY, p.y);
        b.maxX = Math.max(b.maxX, p.x);
        b.maxY = Math.max(b.maxY, p.y);
      }
  return b;
}
