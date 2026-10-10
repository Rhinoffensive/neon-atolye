import { FONT_LIST, parseSvgFont, type SvgFont } from '../core/text/svgfont';
import { buildStrokes } from '../core/model/strokes';
import { planDesign } from '../core/plan/planner';
import type { Doc } from '../core/model/types';

let fonts: Promise<Map<string, SvgFont>> | null = null;

function loadFonts(base: string): Promise<Map<string, SvgFont>> {
  return Promise.all(
    FONT_LIST.map(async (f) => {
      const res = await fetch(`${base}fonts/${f.file}`);
      return [f.id, parseSvgFont(f.id, await res.text())] as const;
    }),
  ).then((list) => new Map(list));
}

export interface PlanRequest {
  id: number;
  doc: Doc;
  base: string;
}

self.onmessage = async (e: MessageEvent<PlanRequest>) => {
  const { id, doc, base } = e.data;
  try {
    fonts ??= loadFonts(base);
    const fm = await fonts;
    const t0 = performance.now();
    const strokes = buildStrokes(doc, fm);
    const plan = planDesign(strokes, doc.profiles, doc.settings);
    (self as unknown as Worker).postMessage({ id, strokes, plan, ms: performance.now() - t0 });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.stack ?? err) });
  }
};
