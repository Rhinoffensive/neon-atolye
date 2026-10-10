import type { Doc, PlanResult } from '../model/types';
import type { Vec } from '../geom/vec';
import { cumLengths, pointAt, tangentAt, slice, rdp } from '../geom/polyline';

const f = (n: number) => +n.toFixed(2);

function d(pts: Vec[]): string {
  const p = rdp(pts, 0.03);
  return p.map((q, i) => `${i ? 'L' : 'M'}${f(q.x)} ${f(q.y)}`).join('');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Layered, 1:1 (mm) SVG of the plan for laser software / Inkscape / printing. */
export function planToSvg(doc: Doc, plan: PlanResult, margin = 20): string {
  const b = plan.bounds;
  const minX = Math.min(b.minX, plan.entry.x) - margin;
  const minY = b.minY - margin;
  const maxX = Math.max(b.maxX, plan.entry.x) + margin;
  const maxY = Math.max(b.maxY, plan.entry.y) + margin;
  const W = maxX - minX;
  const H = maxY - minY;
  const profiles = new Map(doc.profiles.map((p) => [p.id, p]));
  const layer = (id: string, label: string, body: string, style = '') =>
    `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${label}" ${style}>\n${body}\n</g>`;

  const strips = plan.pieces
    .map((pc) => {
      const p = profiles.get(pc.profileId)!;
      return `<path d="${d(pc.pts)}" stroke="${p.color}" stroke-opacity="0.35" stroke-width="${p.width}" fill="none"/>`;
    })
    .join('\n');
  const lit = plan.pieces
    .map((pc) => {
      const p = profiles.get(pc.profileId)!;
      const s = slice(pc.pts, cumLengths(pc.pts), pc.litStart, pc.litEnd);
      return `<path d="${d(s)}" stroke="${p.color}" stroke-width="${f(p.width * 0.4)}" fill="none"/>`;
    })
    .join('\n');
  const centre = plan.pieces.map((pc) => `<path d="${d(pc.pts)}"/>`).join('\n');
  const marks = plan.pieces
    .map((pc) => {
      const p = profiles.get(pc.profileId)!;
      const cum = cumLengths(pc.pts);
      let out = '';
      const ss = Array.from({ length: pc.units + 1 }, (_, k) => pc.capStart + k * p.cutUnit);
      if (pc.darkTail > 0.5) ss.push(pc.capStart + pc.stripLength);
      for (const s of ss) {
        const c = pointAt(pc.pts, cum, s);
        const t = tangentAt(pc.pts, cum, s, 1);
        const h = p.width / 2 + 3;
        out += `<line x1="${f(c.x + t.y * h)}" y1="${f(c.y - t.x * h)}" x2="${f(c.x - t.y * h)}" y2="${f(c.y + t.x * h)}"/>`;
      }
      return out;
    })
    .join('\n');
  const holes = plan.holes.map((h) => `<circle cx="${f(h.at.x)}" cy="${f(h.at.y)}" r="${f(h.diameter / 2)}"/>`).join('\n');
  const wires = plan.wires.map((w) => `<line x1="${f(w.a.x)}" y1="${f(w.a.y)}" x2="${f(w.b.x)}" y2="${f(w.b.y)}"/>`).join('\n');
  const labels = plan.pieces
    .map((pc) => {
      const cum = cumLengths(pc.pts);
      const t = tangentAt(pc.pts, cum, 0, 1);
      const p0 = pc.pts[0];
      return `<text x="${f(p0.x - t.x * 9)}" y="${f(p0.y - t.y * 9 + 2)}">P${pc.no}</text>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
  width="${f(W)}mm" height="${f(H)}mm" viewBox="${f(minX)} ${f(minY)} ${f(W)} ${f(H)}">
<title>${esc(doc.name)} — Neon Atölye planı</title>
${layer('serit', 'Şerit izi', strips, 'stroke-linejoin="round"')}
${layer('isik', 'Yanan kısım', lit, 'stroke-linejoin="round"')}
${layer('orta', 'Orta çizgi (kazıma)', centre, 'fill="none" stroke="#000" stroke-width="0.2"')}
${layer('isaret', 'Kesim işaretleri', marks, 'stroke="#000" stroke-width="0.3"')}
${layer('delik', 'Kablo delikleri (kesim)', holes, 'fill="none" stroke="#ff0000" stroke-width="0.1"')}
${layer('kablo', 'Arka kablolama', wires, 'stroke="#c99a00" stroke-width="0.5" stroke-dasharray="4 3"')}
${layer('no', 'Parça numaraları', labels, 'font-family="sans-serif" font-size="6" text-anchor="middle" fill="#000"')}
</svg>
`;
}
