import type { Vec } from '../geom/vec';
import { smoothKeepCorners } from '../geom/polyline';
import { type SvgFont, glyphPaths } from './svgfont';

export interface GlyphStroke {
  pts: Vec[];
  closed: boolean;
  char: string;
  charIndex: number;
}

export interface LayoutOptions {
  capHeight: number;
  /** % of cap height added between letters */
  letterSpacing: number;
  /** multiple of cap height between baselines */
  lineSpacing: number;
  /** vertex turns above this stay sharp when smoothing glyph polylines */
  cornerDeg?: number;
}

/**
 * Lay out text with a single-line font. Output is in mm, y down, origin at the
 * baseline-left of the first line.
 */
export function layoutText(font: SvgFont, text: string, o: LayoutOptions): GlyphStroke[] {
  const scale = o.capHeight / font.capHeight;
  const extra = (o.letterSpacing / 100) * o.capHeight;
  const out: GlyphStroke[] = [];
  const lines = text.split('\n');
  let charIndex = 0;
  lines.forEach((line, li) => {
    const baseY = li * o.lineSpacing * o.capHeight;
    let pen = 0;
    const chars = [...line];
    chars.forEach((ch, ci) => {
      const g = font.glyphs.get(ch) ?? font.glyphs.get(ch.normalize('NFD')[0]);
      const adv = g ? g.adv : font.defaultAdv;
      for (const sp of glyphPaths(font, g ? g.unicode : ' ')) {
        const raw = sp.pts.map((p) => ({ x: (pen + p.x) * scale, y: baseY - p.y * scale }));
        const pts = smoothKeepCorners(raw, o.cornerDeg ?? 60, 0.5, sp.closed);
        out.push({ pts, closed: sp.closed, char: ch, charIndex });
      }
      const next = chars[ci + 1];
      const k = next ? font.kern.get(ch + next) ?? 0 : 0;
      pen += adv - k + extra / scale;
      charIndex++;
    });
    charIndex++; // newline
  });
  return out;
}

/** Width of the laid out text block in mm (approximate: advance based). */
export function textAdvance(font: SvgFont, text: string, o: LayoutOptions): number {
  const scale = o.capHeight / font.capHeight;
  const extra = (o.letterSpacing / 100) * o.capHeight;
  let best = 0;
  for (const line of text.split('\n')) {
    let pen = 0;
    for (const ch of line) pen += (font.glyphs.get(ch)?.adv ?? font.defaultAdv) * scale + extra;
    best = Math.max(best, pen);
  }
  return best;
}
