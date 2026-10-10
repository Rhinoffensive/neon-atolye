import { jsPDF } from 'jspdf';
import type { Doc, Piece, PlanResult, StripProfile } from '../model/types';
import type { Vec } from '../geom/vec';
import { cumLengths, pointAt, tangentAt, rdp, slice } from '../geom/polyline';
import { stepText } from '../plan/bends';

export interface PdfFontData {
  regular: string;
  bold: string;
}

const A4 = { w: 210, h: 297 };
let FONT = 'Body';
const MARGIN = 8;
const OVERLAP = 10;

const END_TR: Record<string, string> = {
  free: 'serbest',
  corner: 'köşe',
  cross: 'kesişim',
  abut: 'dayanma',
  seam: 'ek yeri',
  split: 'bölme',
};

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixWhite(hex: string, k: number): [number, number, number] {
  const [r, g, b] = hexRgb(hex);
  return [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k].map(Math.round) as [number, number, number];
}
const fmtCm = (mm: number) => `${(mm / 10).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} cm`;

type Tf = (p: Vec) => Vec;

function polyPath(pdf: jsPDF, pts: Vec[], tf: Tf) {
  const p = rdp(pts, 0.05);
  if (p.length < 2) return;
  const a = tf(p[0]);
  pdf.moveTo(a.x, a.y);
  for (let i = 1; i < p.length; i++) {
    const q = tf(p[i]);
    pdf.lineTo(q.x, q.y);
  }
  pdf.stroke();
}

/** Draw the plan (strips, centre lines, marks, numbers, holes, wires) through transform tf. */
function drawPlan(
  pdf: jsPDF,
  doc: Doc,
  plan: PlanResult,
  tf: Tf,
  scale: number,
  opts: { marks: boolean; markNumbers: boolean; wires: boolean },
) {
  const profiles = new Map(doc.profiles.map((p) => [p.id, p]));
  pdf.setLineJoin('round');
  // strip footprints
  pdf.setLineCap('butt');
  for (const pc of plan.pieces) {
    const p = profiles.get(pc.profileId)!;
    pdf.setDrawColor(...mixWhite(p.color, 0.72));
    pdf.setLineWidth(p.width * scale);
    polyPath(pdf, pc.pts, tf);
  }
  // lit part (thin, saturated) and centreline
  for (const pc of plan.pieces) {
    const p = profiles.get(pc.profileId)!;
    pdf.setDrawColor(...mixWhite(p.color, 0.15));
    pdf.setLineWidth(Math.max(0.25, p.width * 0.18 * scale));
    polyPath(pdf, slice(pc.pts, cumLengths(pc.pts), pc.litStart, pc.litEnd), tf);
    pdf.setDrawColor(0);
    pdf.setLineWidth(0.12);
    polyPath(pdf, pc.pts, tf);
  }
  // cut marks
  if (opts.marks) {
    for (const pc of plan.pieces) {
      const p = profiles.get(pc.profileId)!;
      const cum = cumLengths(pc.pts);
      for (let k = 0; k <= pc.units; k++) {
        const s = pc.capStart + k * p.cutUnit;
        const c = pointAt(pc.pts, cum, s);
        const t = tangentAt(pc.pts, cum, s, 1);
        const h = p.width / 2 + 3;
        const a = tf({ x: c.x + t.y * h, y: c.y - t.x * h });
        const b = tf({ x: c.x - t.y * h, y: c.y + t.x * h });
        const end = k === 0 || k === pc.units;
        pdf.setDrawColor(end ? 200 : 0, 0, 0);
        pdf.setLineWidth(end ? 0.35 : 0.2);
        pdf.line(a.x, a.y, b.x, b.y);
        if (opts.markNumbers && k > 0 && k < pc.units) {
          const lab = tf({ x: c.x - t.y * (h + 2.2), y: c.y + t.x * (h + 2.2) });
          pdf.setFontSize(5.5);
          pdf.setTextColor(90);
          pdf.text(String(k), lab.x, lab.y + 0.8, { align: 'center' });
        }
      }
    }
  }
  // holes
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.2);
  for (const h of plan.holes) {
    const c = tf(h.at);
    const r = (h.diameter / 2) * scale;
    pdf.circle(c.x, c.y, r, 'S');
    pdf.line(c.x - r - 1, c.y, c.x + r + 1, c.y);
    pdf.line(c.x, c.y - r - 1, c.x, c.y + r + 1);
  }
  if (opts.wires) {
    pdf.setDrawColor(190, 150, 0);
    pdf.setLineWidth(0.25);
    pdf.setLineDashPattern([2, 1.5], 0);
    for (const w of plan.wires) {
      const a = tf(w.a);
      const b = tf(w.b);
      pdf.line(a.x, a.y, b.x, b.y);
    }
    pdf.setLineDashPattern([], 0);
    const e = tf(plan.entry);
    pdf.setFillColor(255, 220, 80);
    pdf.rect(e.x - 2, e.y - 2, 4, 4, 'FD');
  }
  // piece numbers at feed end
  for (const pc of plan.pieces) {
    const cum = cumLengths(pc.pts);
    const t = tangentAt(pc.pts, cum, 0, 1);
    const p0 = pc.pts[0];
    const c = tf({ x: p0.x - t.x * 8, y: p0.y - t.y * 8 });
    pdf.setFillColor(255, 255, 255);
    pdf.setDrawColor(0);
    pdf.setLineWidth(0.3);
    pdf.circle(c.x, c.y, 3.2, 'FD');
    pdf.setFontSize(7);
    pdf.setTextColor(0);
    pdf.text(String(pc.no), c.x, c.y + 1.1, { align: 'center' });
  }
}

function header(pdf: jsPDF, title: string, sub: string) {
  pdf.setFont(FONT, 'bold');
  pdf.setFontSize(15);
  pdf.setTextColor(0);
  pdf.text(title, MARGIN + 2, 16);
  pdf.setFont(FONT, 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(90);
  pdf.text(sub, MARGIN + 2, 21.5);
}

/** 1:1 unrolled strip, wrapped into rows of `rowLen` mm. Returns the y after drawing. */
function drawUnrolled(pdf: jsPDF, pc: Piece, p: StripProfile, x0: number, y0: number, rowLen: number): number {
  const L = pc.length;
  const rows = Math.ceil(L / rowLen);
  const bodyH = Math.max(6, p.width);
  let y = y0;
  for (let r = 0; r < rows; r++) {
    const a = r * rowLen;
    const b = Math.min(L, a + rowLen);
    const X = (s: number) => x0 + (s - a);
    const by = y + 6;
    // body + caps + lit
    pdf.setFillColor(...mixWhite(p.color, 0.8));
    pdf.rect(X(a), by, b - a, bodyH, 'F');
    pdf.setFillColor(170, 170, 170);
    if (pc.capStart > a) pdf.rect(X(a), by, Math.min(b, pc.capStart) - a, bodyH, 'F');
    if (L - pc.capEnd < b) pdf.rect(X(Math.max(a, L - pc.capEnd)), by, b - Math.max(a, L - pc.capEnd), bodyH, 'F');
    const l0 = Math.max(a, pc.litStart);
    const l1 = Math.min(b, pc.litEnd);
    if (l1 > l0) {
      pdf.setFillColor(...mixWhite(p.color, 0.25));
      pdf.rect(X(l0), by + bodyH * 0.35, l1 - l0, bodyH * 0.3, 'F');
    }
    // bends
    for (const st of pc.bends) {
      if (st.kind !== 'arc') continue;
      const s0 = pc.capStart + st.sStrip;
      const s1 = s0 + st.length;
      const c0 = Math.max(a, s0);
      const c1 = Math.min(b, s1);
      if (c1 <= c0) continue;
      const col: [number, number, number] = st.dir === 'L' ? [40, 120, 230] : [235, 130, 30];
      pdf.setFillColor(...col);
      pdf.rect(X(c0), by - 2.2, c1 - c0, 1.6, 'F');
      if (s0 >= a && s0 < b) {
        pdf.setFontSize(6);
        pdf.setTextColor(...col);
        pdf.text(`${st.dir === 'L' ? 'sola' : 'sağa'} ${Math.round(st.angleDeg!)}° R${Math.round(st.radius!)}`, X(s0) + 0.3, by - 3.2);
      }
    }
    // marks
    for (let k = 0; k <= pc.units; k++) {
      const s = pc.capStart + k * p.cutUnit;
      if (s < a - 0.01 || s > b + 0.01) continue;
      const end = k === 0 || k === pc.units;
      pdf.setDrawColor(end ? 200 : 0, 0, 0);
      pdf.setLineWidth(end ? 0.4 : 0.25);
      pdf.line(X(s), by - 0.8, X(s), by + bodyH + 0.8);
      pdf.setFontSize(6);
      pdf.setTextColor(60);
      pdf.text(`İ${k}`, X(s), by + bodyH + 3.4, { align: 'center' });
    }
    pdf.setDrawColor(0);
    pdf.setLineWidth(0.15);
    pdf.rect(X(a), by, b - a, bodyH, 'S');
    if (r < rows - 1) {
      pdf.setFontSize(6);
      pdf.setTextColor(120);
      pdf.text('devam ↓', X(b) + 1, by + bodyH / 2 + 1);
    }
    y = by + bodyH + 7;
  }
  return y;
}

/**
 * Build sheet + 1:1 template, tiled on A4 with overlap and alignment crosses.
 * Print at "actual size / 100 %".
 */
export function buildTemplatePdf(doc: Doc, plan: PlanResult, fonts: PdfFontData | null): ArrayBuffer {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  if (fonts) {
    pdf.addFileToVFS('DejaVuSans.ttf', fonts.regular);
    pdf.addFont('DejaVuSans.ttf', 'Body', 'normal');
    pdf.addFileToVFS('DejaVuSans-Bold.ttf', fonts.bold);
    pdf.addFont('DejaVuSans-Bold.ttf', 'Body', 'bold');
  }
  FONT = fonts ? 'Body' : 'helvetica'; // tests fall back to the built-in font (no Turkish glyphs)
  pdf.setFont(FONT, 'normal');
  const profiles = new Map(doc.profiles.map((p) => [p.id, p]));
  const b = plan.bounds;
  const pad = 15;
  const W = b.maxX - b.minX + 2 * pad;
  const H = Math.max(b.maxY, plan.entry.y + 5) - b.minY + 2 * pad;
  const date = new Date().toLocaleDateString('tr-TR');

  // ---------------------------------------------------------------- page 1: summary
  header(pdf, doc.name, `Neon Atölye yapım föyü · ${date} · ${fmtCm(b.maxX - b.minX)} × ${fmtCm(b.maxY - b.minY)}`);
  // thumbnail
  const boxW = A4.w - 2 * MARGIN - 4;
  const boxH = 95;
  const k = Math.min(boxW / W, boxH / H);
  const ox = MARGIN + 2 + (boxW - W * k) / 2;
  const oy = 27 + (boxH - H * k) / 2;
  drawPlan(pdf, doc, plan, (p) => ({ x: ox + (p.x - b.minX + pad) * k, y: oy + (p.y - b.minY + pad) * k }), k, {
    marks: false,
    markNumbers: false,
    wires: true,
  });
  let y = 27 + boxH + 8;
  pdf.setFont(FONT, 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(0);
  pdf.text('Malzeme', MARGIN + 2, y);
  pdf.setFont(FONT, 'normal');
  pdf.setFontSize(8.5);
  y += 5;
  for (const s of plan.stock.filter((x) => x.pieces)) {
    const p = profiles.get(s.profileId)!;
    pdf.setFillColor(...hexRgb(p.color));
    pdf.circle(MARGIN + 4, y - 1, 1.3, 'F');
    pdf.setTextColor(s.usedMm > s.availableMm ? 200 : 0, 0, 0);
    pdf.text(
      `${p.name}: ${s.pieces} parça, ${s.usedMm / p.cutUnit} birim = ${fmtCm(s.usedMm)} (stok ${fmtCm(s.availableMm)}, kalan ${fmtCm(s.availableMm - s.usedMm)})`,
      MARGIN + 7,
      y,
    );
    y += 4.6;
  }
  pdf.setTextColor(0);
  const pw = plan.power;
  const caps = plan.pieces.length;
  pdf.text(
    `Güç ${pw.watts.toFixed(1)} W (${pw.amps.toFixed(2)} A) → adaptör ≥ ${pw.psuWatts} W · arka kablo ≈ ${fmtCm(pw.wireLength * 1.15)}, ${String(pw.wireMm2).replace('.', ',')} mm² · ${caps} besleme + ${caps} kör kapak`,
    MARGIN + 7,
    y,
  );
  y += 8;
  // issues
  const serious = plan.issues.filter((i) => i.severity !== 'info');
  pdf.setFont(FONT, 'bold');
  pdf.setFontSize(10);
  pdf.text(serious.length ? `Uyarılar (${serious.length})` : 'Uyarı yok ✓', MARGIN + 2, y);
  pdf.setFont(FONT, 'normal');
  pdf.setFontSize(8);
  y += 4.6;
  for (const i of serious.slice(0, 12)) {
    pdf.setTextColor(i.severity === 'error' ? 190 : 170, i.severity === 'error' ? 0 : 110, 0);
    const lines = pdf.splitTextToSize(`• ${i.message}`, A4.w - 2 * MARGIN - 8) as string[];
    pdf.text(lines, MARGIN + 4, y);
    y += 3.8 * lines.length;
  }
  if (serious.length > 12) {
    pdf.text(`… ve ${serious.length - 12} uyarı daha`, MARGIN + 4, y);
    y += 4;
  }
  y += 4;
  // cut list
  pdf.setTextColor(0);
  pdf.setFont(FONT, 'bold');
  pdf.setFontSize(10);
  pdf.text('Rulodan kesim listesi (uzundan kısaya)', MARGIN + 2, y);
  pdf.setFontSize(8);
  y += 5;
  const cols = [MARGIN + 4, MARGIN + 18, MARGIN + 60, MARGIN + 80, MARGIN + 102, MARGIN + 140];
  ['Parça', 'Şerit', 'Birim', 'Boy', 'Uçlar', 'Büküm'].forEach((t, i) => pdf.text(t, cols[i], y));
  pdf.setFont(FONT, 'normal');
  y += 1.5;
  const sorted = [...plan.pieces].sort((a, c) => c.units - a.units || a.no - c.no);
  for (const pc of sorted) {
    if (y > A4.h - 12) {
      pdf.addPage();
      y = 16;
    }
    y += 4.2;
    const p = profiles.get(pc.profileId)!;
    pdf.setDrawColor(220);
    pdf.setLineWidth(0.1);
    pdf.line(MARGIN + 2, y - 3.2, A4.w - MARGIN - 2, y - 3.2);
    pdf.text(`P${pc.no}`, cols[0], y);
    pdf.text(p.name, cols[1], y);
    pdf.text(String(pc.units), cols[2], y);
    pdf.text(fmtCm(pc.stripLength), cols[3], y);
    pdf.text(`${END_TR[pc.startKind]} → ${END_TR[pc.endKind]}`, cols[4], y);
    pdf.text(String(pc.bends.filter((s) => s.kind === 'arc').length), cols[5], y);
  }

  // ---------------------------------------------------------------- bending pages
  pdf.addPage();
  header(pdf, 'Büküm talimatları', 'Şerit 1:1 açılmış hali: üstüne koyup büküm başlangıçlarını kalemle işaretleyebilirsin. İ0 = besleme ucu.');
  y = 28;
  const rowLen = A4.w - 2 * MARGIN - 18;
  for (const pc of plan.pieces) {
    const p = profiles.get(pc.profileId)!;
    const rows = Math.ceil(pc.length / rowLen);
    const need = 8 + rows * 22 + pc.bends.length * 3.8 + 6;
    if (y + Math.min(need, 120) > A4.h - 10) {
      pdf.addPage();
      y = 16;
    }
    pdf.setFont(FONT, 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(0);
    pdf.text(`P${pc.no} · ${p.name} · ${pc.units} birim (${fmtCm(pc.stripLength)})${pc.loop ? ' · kapalı harf' : ''}`, MARGIN + 2, y);
    pdf.setFont(FONT, 'normal');
    y = drawUnrolled(pdf, pc, p, MARGIN + 6, y + 1, rowLen);
    pdf.setFontSize(8);
    for (const st of pc.bends) {
      if (y > A4.h - 10) {
        pdf.addPage();
        y = 16;
      }
      pdf.setTextColor(st.warning ? 170 : 0, st.warning ? 90 : 0, 0);
      pdf.text(`${stepText(st)}${st.warning ? `  (${st.warning})` : ''}`, MARGIN + 6, y);
      y += 3.8;
    }
    y += 6;
  }

  // ---------------------------------------------------------------- template tiles
  const portrait = { w: A4.w, h: A4.h };
  const landscape = { w: A4.h, h: A4.w };
  const tiles = (pg: { w: number; h: number }) => {
    const uw = pg.w - 2 * MARGIN;
    const uh = pg.h - 2 * MARGIN - 6;
    const nx = Math.max(1, Math.ceil((W - OVERLAP) / (uw - OVERLAP)));
    const ny = Math.max(1, Math.ceil((H - OVERLAP) / (uh - OVERLAP)));
    return { nx, ny, uw, uh };
  };
  const tp = tiles(portrait);
  const tl = tiles(landscape);
  const useLand = tl.nx * tl.ny < tp.nx * tp.ny;
  const pg = useLand ? landscape : portrait;
  const { nx, ny, uw, uh } = useLand ? tl : tp;

  // calibration page
  pdf.addPage('a4', useLand ? 'landscape' : 'portrait');
  header(pdf, '1:1 şablon', `${nx * ny} sayfa (${ny} satır × ${nx} sütun). Yazdırırken ölçek: %100 / "Gerçek boyut".`);
  pdf.setFontSize(9);
  pdf.setTextColor(0);
  const lines = [
    '1. Önce bu sayfadaki 100 mm çubuğu cetvelle ölç. 100 mm değilse yazıcı ayarını düzelt.',
    `2. Sayfaları kenarlardaki + işaretleri üst üste gelecek şekilde ${OVERLAP} mm bindirerek bantla.`,
    '3. Şablonu şeffaf pleksinin altına koy; şeridi orta çizgiye, şeritteki kesim işaretlerini çentiklere hizala.',
    '4. Numaralı daireler besleme ucunu (kablo tarafı) gösterir; artı işaretli daireler kablo delikleridir.',
  ];
  lines.forEach((l, i) => pdf.text(l, MARGIN + 2, 32 + i * 6));
  const cy = 64;
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.4);
  pdf.line(MARGIN + 2, cy, MARGIN + 102, cy);
  for (let mm = 0; mm <= 100; mm += 10) pdf.line(MARGIN + 2 + mm, cy - (mm % 50 ? 2 : 4), MARGIN + 2 + mm, cy);
  pdf.text('0', MARGIN + 2, cy + 4, { align: 'center' });
  pdf.text('100 mm', MARGIN + 102, cy + 4, { align: 'center' });
  // page map
  const covW = (nx - 1) * (uw - OVERLAP) + uw;
  const covH = (ny - 1) * (uh - OVERLAP) + uh;
  const mapK = Math.min((pg.w - 2 * MARGIN - 4) / covW, (pg.h - 84) / covH);
  const mx = MARGIN + 2;
  const my = 76;
  drawPlan(pdf, doc, plan, (p) => ({ x: mx + (p.x - b.minX + pad) * mapK, y: my + (p.y - b.minY + pad) * mapK }), mapK, {
    marks: false,
    markNumbers: false,
    wires: false,
  });
  pdf.setDrawColor(120);
  pdf.setLineWidth(0.15);
  pdf.setFontSize(7);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = mx + i * (uw - OVERLAP) * mapK;
      const yy = my + j * (uh - OVERLAP) * mapK;
      pdf.rect(x, yy, uw * mapK, uh * mapK, 'S');
      pdf.setTextColor(120);
      pdf.text(`${String.fromCharCode(65 + j)}${i + 1}`, x + 1.5, yy + 3.5);
    }

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      pdf.addPage('a4', useLand ? 'landscape' : 'portrait');
      const wx0 = b.minX - pad + i * (uw - OVERLAP);
      const wy0 = b.minY - pad + j * (uh - OVERLAP);
      const tf: Tf = (p) => ({ x: MARGIN + (p.x - wx0), y: MARGIN + (p.y - wy0) });
      pdf.saveGraphicsState();
      pdf.rect(MARGIN, MARGIN, uw, uh, null);
      pdf.clip();
      pdf.discardPath();
      drawPlan(pdf, doc, plan, tf, 1, { marks: true, markNumbers: true, wires: true });
      pdf.restoreGraphicsState();
      // overlap guides and alignment crosses
      pdf.setDrawColor(150);
      pdf.setLineWidth(0.15);
      pdf.setLineDashPattern([1.5, 1.5], 0);
      if (i > 0) pdf.line(MARGIN + OVERLAP, MARGIN, MARGIN + OVERLAP, MARGIN + uh);
      if (i < nx - 1) pdf.line(MARGIN + uw - OVERLAP, MARGIN, MARGIN + uw - OVERLAP, MARGIN + uh);
      if (j > 0) pdf.line(MARGIN, MARGIN + OVERLAP, MARGIN + uw, MARGIN + OVERLAP);
      if (j < ny - 1) pdf.line(MARGIN, MARGIN + uh - OVERLAP, MARGIN + uw, MARGIN + uh - OVERLAP);
      pdf.setLineDashPattern([], 0);
      pdf.setDrawColor(0);
      pdf.setLineWidth(0.25);
      const cross = (x: number, y: number) => {
        pdf.line(x - 3, y, x + 3, y);
        pdf.line(x, y - 3, x, y + 3);
        pdf.circle(x, y, 1.2, 'S');
      };
      // crosses sit at world positions on the overlap band centre, so neighbours share them
      const xs = [MARGIN + OVERLAP / 2, MARGIN + uw - OVERLAP / 2];
      const ys = [MARGIN + OVERLAP / 2, MARGIN + uh - OVERLAP / 2];
      for (const x of xs) for (const yy of ys) cross(x, yy);
      pdf.setLineWidth(0.1);
      pdf.rect(MARGIN, MARGIN, uw, uh, 'S');
      pdf.setFontSize(7);
      pdf.setTextColor(80);
      pdf.text(
        `${doc.name} · sayfa ${String.fromCharCode(65 + j)}${i + 1} (satır ${j + 1}/${ny}, sütun ${i + 1}/${nx}) · %100 yazdır`,
        MARGIN,
        pg.h - MARGIN + 4,
      );
      // 50 mm check bar
      pdf.setDrawColor(0);
      pdf.setLineWidth(0.3);
      const bx = pg.w - MARGIN - 50;
      const by = pg.h - MARGIN + 3;
      pdf.line(bx, by, bx + 50, by);
      pdf.line(bx, by - 1.5, bx, by + 0.5);
      pdf.line(bx + 50, by - 1.5, bx + 50, by + 0.5);
      pdf.text('50 mm', bx + 25, by - 0.8, { align: 'center' });
    }
  }
  return pdf.output('arraybuffer');
}
