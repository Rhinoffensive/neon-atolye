import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planDesign } from '../src/core/plan/planner';
import { defaultProfile, defaultSettings } from '../src/core/model/defaults';
import type { DesignStroke, PlanSettings, StripProfile } from '../src/core/model/types';
import type { Vec } from '../src/core/geom/vec';
import { parseSvgFont } from '../src/core/text/svgfont';
import { buildStrokes } from '../src/core/model/strokes';
import { flattenPath } from '../src/core/geom/svgpath';
import { fitLinesArcs } from '../src/core/geom/arcfit';
import { resample } from '../src/core/geom/polyline';
import { stepText } from '../src/core/plan/bends';

const prof: StripProfile = defaultProfile({ id: 'P' });
const set: PlanSettings = defaultSettings();

const stroke = (pts: Vec[], closed = false, id = 's'): DesignStroke => ({
  id,
  itemId: 'it',
  profileId: 'P',
  pts,
  closed,
});
const line = (x0: number, y0: number, x1: number, y1: number, id = 's') =>
  stroke(
    [
      { x: x0, y: y0 },
      { x: x1, y: y1 },
    ],
    false,
    id,
  );
const circle = (cx: number, cy: number, r: number): Vec[] => {
  const pts: Vec[] = [];
  for (let i = 0; i <= 360; i++) pts.push({ x: cx + r * Math.cos((i * Math.PI) / 180), y: cy + r * Math.sin((i * Math.PI) / 180) });
  return pts;
};
const errors = (r: ReturnType<typeof planDesign>) => r.issues.filter((i) => i.severity === 'error');

describe('svg path', () => {
  it('parses arcs with compact flags and closes subpaths', () => {
    const sp = flattenPath('M0 0 a10 10 0 1110 10Z');
    expect(sp).toHaveLength(1);
    expect(sp[0].closed).toBe(true);
  });
  it('fits a circle as one arc', () => {
    const pts = resample(circle(0, 0, 40).slice(0, 181), 0.5);
    const els = fitLinesArcs(pts, 0.4);
    expect(els).toHaveLength(1);
    expect(els[0].kind).toBe('arc');
    expect(els[0].radius).toBeCloseTo(40, 0);
    expect(Math.abs(els[0].sweep)).toBeCloseTo(Math.PI, 1);
  });
});

describe('planner', () => {
  it('straight line: whole units, light ends within half a unit of the drawing', () => {
    const r = planDesign([line(0, 0, 100, 0)], [prof], set);
    expect(r.pieces).toHaveLength(1);
    const p = r.pieces[0];
    expect(Number.isInteger(p.units)).toBe(true);
    expect(p.length).toBeCloseTo(p.units * prof.cutUnit + prof.capFeed + prof.capBlind, 3);
    const lit = p.litEnd - p.litStart;
    expect(Math.abs(lit - 100)).toBeLessThanOrEqual(prof.cutUnit / 2 + 0.01);
    expect(errors(r)).toHaveLength(0);
  });

  it('dot becomes a one-unit dash', () => {
    const r = planDesign([line(0, 0, 3, -4)], [prof], set);
    expect(r.pieces[0].units).toBe(1);
    expect(r.pieces[0].length).toBeCloseTo(25 + 12, 3);
  });

  it('closed circle: one looped piece with a seam gap, no overlap', () => {
    const r = planDesign([stroke(circle(0, 0, 50), true)], [prof], set);
    expect(r.pieces).toHaveLength(1);
    const p = r.pieces[0];
    expect(p.loop).toBe(true);
    expect(p.startKind).toBe('seam');
    const circ = 2 * Math.PI * 50;
    expect(p.length).toBeLessThan(circ);
    expect(circ - p.length).toBeLessThan(prof.cutUnit + 3 * set.clearance);
    expect(errors(r)).toHaveLength(0);
  });

  it('crossing lines: shorter one is broken and pulled clear', () => {
    const r = planDesign([line(-100, 0, 100, 0, 'a'), line(0, -60, 0, 60, 'b')], [prof], set);
    expect(r.pieces).toHaveLength(3);
    expect(errors(r)).toHaveLength(0);
    const brokenEnds = r.pieces.flatMap((p) => [p.startKind, p.endKind]).filter((k) => k === 'cross');
    expect(brokenEnds).toHaveLength(2);
  });

  it('90 degree corner is cut into two pieces without touching', () => {
    const st = stroke([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    const r = planDesign([st], [prof], set);
    expect(r.pieces).toHaveLength(2);
    expect(errors(r)).toHaveLength(0);
  });

  it('gentle 40 degree corner is rounded instead of cut', () => {
    const t = (40 * Math.PI) / 180;
    const st = stroke([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100 + 100 * Math.cos(t), y: 100 * Math.sin(t) },
    ]);
    const r = planDesign([st], [prof], set);
    expect(r.pieces).toHaveLength(1);
    expect(r.issues.filter((i) => i.code === 'tight-bend' && i.severity === 'error')).toHaveLength(0);
  });

  it('T junction: the stem stops short of the bar', () => {
    const r = planDesign([line(-80, 0, 80, 0, 'bar'), line(0, 0, 0, 100, 'stem')], [prof], set);
    expect(r.pieces).toHaveLength(2);
    expect(errors(r)).toHaveLength(0);
  });

  it('bend steps read against cut marks', () => {
    const pts: Vec[] = [];
    for (let i = 0; i <= 90; i++) pts.push({ x: 60 * Math.cos((i * Math.PI) / 180), y: 60 * Math.sin((i * Math.PI) / 180) });
    const r = planDesign([stroke([{ x: 60, y: -80 }, ...pts])], [prof], set);
    const steps = r.pieces[0].bends;
    expect(steps.some((s) => s.kind === 'arc' && Math.abs((s.radius ?? 0) - 60) < 3)).toBe(true);
    expect(steps.map(stepText).join(' | ')).toMatch(/İ\d+\+\d+/);
  });

  it('stock limit is reported', () => {
    const small = { ...prof, stockMm: 50 };
    const r = planDesign([line(0, 0, 300, 0)], [small], set);
    expect(r.issues.some((i) => i.code === 'stock')).toBe(true);
    expect(r.size.maxScale).toBeLessThan(1);
  });
});

describe('text', () => {
  const xml = readFileSync(new URL('../public/fonts/EMSAllure.svg', import.meta.url), 'utf8');
  const font = parseSvgFont('EMSAllure', xml);

  it('has the Turkish letters', () => {
    for (const ch of 'çÇğĞıİöÖşŞüÜ') expect(font.glyphs.has(ch)).toBe(true);
  });

  it('plans "İlkan" without crashing and gives the İ dot its own piece', () => {
    const doc = {
      version: 1 as const,
      name: 't',
      profiles: [prof],
      settings: set,
      items: [
        {
          id: 'it',
          kind: 'text' as const,
          profileId: 'P',
          x: 0,
          y: 0,
          rotation: 0,
          text: 'İlkan',
          fontId: 'EMSAllure',
          capHeight: 150,
          letterSpacing: 0,
          lineSpacing: 1.6,
        },
      ],
    };
    const strokes = buildStrokes(doc, new Map([['EMSAllure', font]]));
    expect(strokes.length).toBeGreaterThan(3);
    const r = planDesign(strokes, [prof], set);
    expect(r.pieces.length).toBeGreaterThan(2);
    expect(r.pieces.some((p) => p.units === 1)).toBe(true);
    for (const p of r.pieces) expect(p.length).toBeCloseTo(p.units * 25 + 12, 1);
    // print a summary to eyeball
    console.log(
      r.pieces.map((p) => `P${p.no}: ${p.units}u ${p.startKind}/${p.endKind}`).join(', '),
      '\n',
      r.issues.map((i) => `${i.severity}: ${i.message}`).join('\n '),
    );
  });
});
