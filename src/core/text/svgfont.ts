import { flattenPath } from '../geom/svgpath';
import type { Vec } from '../geom/vec';

/** Single-line ("engraving") SVG font, as used by Inkscape's Hershey Text extension. */
export interface SvgGlyph {
  unicode: string;
  adv: number;
  d: string;
}

export interface SvgFont {
  id: string;
  family: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  /** cap height measured from the 'H' glyph (font units) */
  capHeight: number;
  xHeight: number;
  defaultAdv: number;
  glyphs: Map<string, SvgGlyph>;
  kern: Map<string, number>;
  /** cache of flattened glyph subpaths in font units (y up) */
  flatCache: Map<string, { pts: Vec[]; closed: boolean }[]>;
}

const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) out[m[1]] = m[2];
  return out;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function parseSvgFont(id: string, xml: string): SvgFont {
  const fontTag = xml.match(/<font\b[^>]*>/)?.[0] ?? '';
  const faceTag = xml.match(/<font-face\b[^>]*>/s)?.[0] ?? '';
  const fa = attrs(fontTag);
  const ff = attrs(faceTag);
  const glyphs = new Map<string, SvgGlyph>();
  const defaultAdv = parseFloat(fa['horiz-adv-x'] ?? '500');
  for (const m of xml.matchAll(/<glyph\b[^>]*?\/?>/gs)) {
    const a = attrs(m[0]);
    if (a.unicode === undefined) continue;
    const u = decodeEntities(a.unicode);
    if ([...u].length !== 1) continue;
    glyphs.set(u, { unicode: u, adv: parseFloat(a['horiz-adv-x'] ?? String(defaultAdv)), d: a.d ?? '' });
  }
  const kern = new Map<string, number>();
  for (const m of xml.matchAll(/<hkern\b[^>]*?\/?>/gs)) {
    const a = attrs(m[0]);
    if (a.u1 && a.u2 && a.k) kern.set(decodeEntities(a.u1) + decodeEntities(a.u2), parseFloat(a.k));
  }
  const font: SvgFont = {
    id,
    family: ff['font-family'] ?? id,
    unitsPerEm: parseFloat(ff['units-per-em'] ?? '1000'),
    ascent: parseFloat(ff.ascent ?? '800'),
    descent: parseFloat(ff.descent ?? '-200'),
    capHeight: parseFloat(ff['cap-height'] ?? '500'),
    xHeight: parseFloat(ff['x-height'] ?? '300'),
    defaultAdv,
    glyphs,
    kern,
    flatCache: new Map(),
  };
  // measure a real cap height: the declared value is a placeholder in these fonts
  for (const probe of ['H', 'I', 'E']) {
    const g = glyphs.get(probe);
    if (!g?.d) continue;
    let maxY = -Infinity;
    for (const sp of flattenPath(g.d, 5)) for (const p of sp.pts) maxY = Math.max(maxY, p.y);
    if (maxY > 50) {
      font.capHeight = maxY;
      break;
    }
  }
  return font;
}

/** Flattened glyph outlines in font units (y up). */
export function glyphPaths(font: SvgFont, ch: string): { pts: Vec[]; closed: boolean }[] {
  const hit = font.flatCache.get(ch);
  if (hit) return hit;
  const g = font.glyphs.get(ch);
  const res = g?.d ? flattenPath(g.d, 4) : [];
  font.flatCache.set(ch, res);
  return res;
}

export interface FontInfo {
  id: string;
  label: string;
  file: string;
  style: 'script' | 'sans' | 'deco';
}

/** Bundled single-line fonts (all include the Turkish letters ç ğ ı İ ö ş ü). */
export const FONT_LIST: FontInfo[] = [
  { id: 'EMSAllure', label: 'Allure (el yazısı)', file: 'EMSAllure.svg', style: 'script' },
  { id: 'HersheyScript1', label: 'Hershey Script', file: 'HersheyScript1.svg', style: 'script' },
  { id: 'EMSReadability', label: 'Readability (düz)', file: 'EMSReadability.svg', style: 'sans' },
  { id: 'HersheySans1', label: 'Hershey Sans', file: 'HersheySans1.svg', style: 'sans' },
  { id: 'EMSTech', label: 'Tech (teknik)', file: 'EMSTech.svg', style: 'sans' },
  { id: 'EMSFelix', label: 'Felix', file: 'EMSFelix.svg', style: 'deco' },
  { id: 'EMSNixish', label: 'Nixish', file: 'EMSNixish.svg', style: 'deco' },
];
