import { describe, it, expect } from 'vitest';
import { TEMPLATES } from '../src/core/templates';
import { planDesign } from '../src/core/plan/planner';
import { defaultProfile, defaultSettings } from '../src/core/model/defaults';
import { buildStrokes } from '../src/core/model/strokes';
import { flattenPath } from '../src/core/geom/svgpath';
import type { Doc, PathItem } from '../src/core/model/types';

/** Lay a template out as a document: one path item per part, one strip profile per colour. */
function templateDoc(id: string): Doc {
  const t = TEMPLATES.find((x) => x.id === id)!;
  const colors = [...new Set(t.parts.map((p) => p.color))];
  const profiles = colors.map((c, i) => defaultProfile({ id: `P${i}`, color: c }));
  const items: PathItem[] = t.parts.map((p, i) => ({
    id: `it${i}`,
    kind: 'path',
    name: p.name,
    profileId: `P${colors.indexOf(p.color)}`,
    x: 0,
    y: 0,
    rotation: 0,
    d: p.d,
  }));
  return { version: 1, name: t.name, profiles, items, settings: defaultSettings() };
}

describe('templates', () => {
  it('every template parses', () => {
    for (const t of TEMPLATES)
      for (const p of t.parts) expect(flattenPath(p.d).length, `${t.id}/${p.name}`).toBeGreaterThan(0);
  });

  for (const t of TEMPLATES) {
    it(`${t.emoji} ${t.name} plans without errors at its default size`, () => {
      const doc = templateDoc(t.id);
      const r = planDesign(buildStrokes(doc, new Map()), doc.profiles, doc.settings);
      const errs = r.issues.filter((i) => i.severity === 'error');
      if (errs.length || process.env.SHOW)
        console.log(
          `${t.id}: ${r.pieces.length} parça\n  ` +
            r.issues
              .filter((i) => i.severity !== 'info')
              .map((i) => `${i.severity} ${i.message} @${i.at ? `${Math.round(i.at.x)},${Math.round(i.at.y)}` : ''}`)
              .join('\n  '),
        );
      expect(errs.map((e) => e.message)).toEqual([]);
    });
  }
});
