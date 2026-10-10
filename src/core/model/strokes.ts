import type { Doc, DesignStroke, Item } from './types';
import type { Vec } from '../geom/vec';
import { flattenPath } from '../geom/svgpath';
import { layoutText } from '../text/layout';
import type { SvgFont } from '../text/svgfont';

export type FontMap = Map<string, SvgFont>;

function transformer(item: Item): (p: Vec) => Vec {
  const t = (item.rotation * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return (p) => ({ x: item.x + p.x * c - p.y * s, y: item.y + p.x * s + p.y * c });
}

/** Local (untransformed) centrelines of one item. */
export function itemLocalStrokes(item: Item, fonts: FontMap): { pts: Vec[]; closed: boolean }[] {
  if (item.kind === 'text') {
    const font = fonts.get(item.fontId);
    if (!font) return [];
    return layoutText(font, item.text, {
      capHeight: item.capHeight,
      letterSpacing: item.letterSpacing,
      lineSpacing: item.lineSpacing,
    });
  }
  try {
    return flattenPath(item.d, 0.5);
  } catch {
    return [];
  }
}

/** All design centrelines of the document in world mm. */
export function buildStrokes(doc: Doc, fonts: FontMap): DesignStroke[] {
  const out: DesignStroke[] = [];
  for (const item of doc.items) {
    const tf = transformer(item);
    itemLocalStrokes(item, fonts).forEach((st, i) => {
      out.push({
        id: `${item.id}#${i}`,
        itemId: item.id,
        profileId: item.profileId,
        pts: st.pts.map(tf),
        closed: st.closed,
      });
    });
  }
  return out;
}
