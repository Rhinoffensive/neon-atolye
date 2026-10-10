import type { PathItem } from '../core/model/types';
import type { Vec } from '../core/geom/vec';
import { flattenPath, polylineToD } from '../core/geom/svgpath';
import { boundsOf, boundsValid } from '../core/geom/vec';
import { uid } from '../core/model/defaults';

const PX_TO_MM = 25.4 / 96;

function shapeToD(el: Element): string | null {
  const n = (a: string) => parseFloat(el.getAttribute(a) ?? '0') || 0;
  switch (el.tagName.toLowerCase()) {
    case 'path':
      return el.getAttribute('d');
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const nums = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
      if (nums.length < 4) return null;
      let d = `M${nums[0]} ${nums[1]}`;
      for (let i = 2; i + 1 < nums.length; i += 2) d += `L${nums[i]} ${nums[i + 1]}`;
      return el.tagName.toLowerCase() === 'polygon' ? d + 'Z' : d;
    }
    case 'circle': {
      const r = n('r');
      const cx = n('cx');
      const cy = n('cy');
      return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
    }
    case 'ellipse': {
      const rx = n('rx');
      const ry = n('ry');
      const cx = n('cx');
      const cy = n('cy');
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'rect': {
      const x = n('x');
      const y = n('y');
      const w = n('width');
      const h = n('height');
      return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
    }
    default:
      return null;
  }
}

/**
 * Import the centrelines of an SVG drawing (strokes are used as-is; filled shapes are taken
 * as their outline). Units follow the file's width/height (mm, cm, in, pt, px).
 */
export function importSvg(text: string, profileId: string, name: string): PathItem[] {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;';
  host.innerHTML = text;
  document.body.appendChild(host);
  try {
    const root = host.querySelector('svg');
    if (!root) return [];
    root.querySelectorAll('script,foreignObject').forEach((e) => e.remove());
    const subpaths: { pts: Vec[]; closed: boolean }[] = [];
    root.querySelectorAll('path,line,polyline,polygon,circle,ellipse,rect').forEach((el) => {
      if (el.closest('defs,clipPath,mask,symbol,marker,pattern')) return;
      const d = shapeToD(el);
      if (!d) return;
      const m = (el as SVGGraphicsElement).getCTM?.();
      let sps: { pts: Vec[]; closed: boolean }[];
      try {
        sps = flattenPath(d, 0.3);
      } catch {
        return;
      }
      for (const sp of sps) {
        const pts = sp.pts.map((p) =>
          m
            ? { x: (m.a * p.x + m.c * p.y + m.e) * PX_TO_MM, y: (m.b * p.x + m.d * p.y + m.f) * PX_TO_MM }
            : { x: p.x * PX_TO_MM, y: p.y * PX_TO_MM },
        );
        subpaths.push({ pts, closed: sp.closed });
      }
    });
    if (!subpaths.length) return [];
    const b = boundsOf(subpaths.map((s) => s.pts));
    if (!boundsValid(b)) return [];
    const d = subpaths
      .map((s) => polylineToD(s.pts.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY })), s.closed))
      .join('');
    return [
      {
        id: uid('path'),
        kind: 'path',
        name: name || 'SVG',
        profileId,
        x: Math.round(b.minX),
        y: Math.round(b.minY),
        rotation: 0,
        d,
      },
    ];
  } finally {
    host.remove();
  }
}

/** Scale a stored path about its origin. */
export function scalePathD(d: string, k: number): string {
  return flattenPath(d, 0.3)
    .map((s) => polylineToD(s.pts.map((p) => ({ x: p.x * k, y: p.y * k })), s.closed))
    .join('');
}
