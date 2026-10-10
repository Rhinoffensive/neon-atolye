import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planDesign } from '../src/core/plan/planner';
import { defaultProfile, defaultSettings } from '../src/core/model/defaults';
import { parseSvgFont, FONT_LIST } from '../src/core/text/svgfont';
import { buildStrokes } from '../src/core/model/strokes';
import type { Doc } from '../src/core/model/types';

const fonts = new Map(
  FONT_LIST.map((f) => [f.id, parseSvgFont(f.id, readFileSync(new URL(`../public/fonts/${f.file}`, import.meta.url), 'utf8'))]),
);
const prof = defaultProfile({ id: 'P' });

function plan(text: string, fontId: string, capHeight: number) {
  const doc: Doc = {
    version: 1,
    name: 't',
    profiles: [prof],
    settings: defaultSettings(),
    items: [{ id: 'it', kind: 'text', profileId: 'P', x: 0, y: 0, rotation: 0, text, fontId, capHeight, letterSpacing: 0, lineSpacing: 1.6 }],
  };
  return planDesign(buildStrokes(doc, fonts), [prof], doc.settings);
}
const errors = (r: ReturnType<typeof plan>) => r.issues.filter((i) => i.severity === 'error');

describe('bundled fonts', () => {
  it('all fonts carry the Turkish letters', () => {
    for (const f of fonts.values()) for (const ch of 'çÇğĞıİöÖşŞüÜ') expect(f.glyphs.has(ch), `${f.id} ${ch}`).toBe(true);
  });
});

describe('regressions on real signs', () => {
  it('"eczane" Hershey Sans at 12 cm plans without errors', () => {
    const r = plan('eczane', 'HersheySans1', 120);
    expect(errors(r)).toEqual([]);
    expect(r.pieces.length).toBeLessThanOrEqual(14);
  });
  it('"GSM" Readability at 20 cm: flat-top M corners are cut, no errors', () => {
    const r = plan('GSM', 'EMSReadability', 200);
    expect(errors(r)).toEqual([]);
  });
  it('small script asks to be scaled up instead of failing silently', () => {
    const r = plan('İlkan', 'EMSAllure', 80);
    expect(r.size.minScale).toBeGreaterThan(1);
    expect(r.issues.some((i) => i.code === 'tight-bend' && i.severity === 'error')).toBe(true);
  });
  it('every piece lights whole units and its length matches the roll use', () => {
    for (const [t, f] of [
      ['Hoş Geldin', 'EMSAllure'],
      ['eczane', 'EMSReadability'],
      ['GSM', 'HersheySans1'],
    ] as const) {
      const r = plan(t, f, 150);
      for (const p of r.pieces) {
        expect(Number.isInteger(p.units) && p.units >= 1).toBe(true);
        expect(p.length).toBeCloseTo(p.stripLength + prof.capFeed + prof.capBlind, 6);
        expect(p.darkTail).toBeGreaterThanOrEqual(0);
        expect(p.darkTail).toBeLessThan(prof.cutUnit);
      }
      const used = r.stock.reduce((a, s) => a + s.usedMm, 0);
      expect(used).toBeCloseTo(r.pieces.reduce((a, p) => a + p.consumedUnits * prof.cutUnit, 0), 6);
    }
  });
});
