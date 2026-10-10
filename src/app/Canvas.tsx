import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { frameAt, ptsToD, subPts, shade } from './geomUi';
import type { Vec } from '../core/geom/vec';
import { boundsOf, boundsValid, dist } from '../core/geom/vec';
import { cumLengths, rdp, catmullRom } from '../core/geom/polyline';
import { polylineToD } from '../core/geom/svgpath';
import { uid } from '../core/model/defaults';
import type { StripProfile } from '../core/model/types';

type Drag =
  | { mode: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { mode: 'move'; sx: number; sy: number; members: { id: string; ox: number; oy: number }[]; moved: boolean }
  | { mode: 'draw'; pts: Vec[] }
  | { mode: 'pinch'; d0: number; m0: number; mid: Vec; cx: number; cy: number };

export function Canvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const cam = useStore((s) => s.cam);
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const doc = useStore((s) => s.doc);
  const strokes = useStore((s) => s.strokes);
  const plan = useStore((s) => s.plan);
  const selectedItemId = useStore((s) => s.selectedItemId);
  const selectedPieceId = useStore((s) => s.selectedPieceId);
  const setS = useStore((s) => s.set);
  const update = useStore((s) => s.update);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, Vec>());
  const [draft, setDraft] = useState<Vec[] | null>(null);

  useEffect(() => {
    const el = svgRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vb = {
    x: cam.cx - (size.w * cam.mmPerPx) / 2,
    y: cam.cy - (size.h * cam.mmPerPx) / 2,
    w: size.w * cam.mmPerPx,
    h: size.h * cam.mmPerPx,
  };
  const px = cam.mmPerPx;

  const toMm = (cx: number, cy: number): Vec => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: vb.x + (cx - r.left) * px, y: vb.y + (cy - r.top) * px };
  };

  // fit to content on first plan
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !strokes.length || size.w < 10) return;
    fitted.current = true;
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, size]);

  function fitView() {
    const st = useStore.getState().strokes;
    const b = boundsOf(st.map((s) => s.pts), 30);
    if (!boundsValid(b)) return;
    const mm = Math.max((b.maxX - b.minX) / (size.w * 0.9), (b.maxY - b.minY) / (size.h * 0.85));
    setS({ cam: { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, mmPerPx: Math.max(0.03, mm) } });
  }
  useEffect(() => {
    const h = () => fitView();
    window.addEventListener('neon:fit', h);
    return () => window.removeEventListener('neon:fit', h);
  });

  const onWheel = (e: React.WheelEvent) => {
    const m = toMm(e.clientX, e.clientY);
    const f = Math.exp(e.deltaY * 0.0015);
    const mm = Math.min(20, Math.max(0.02, px * f));
    const k = mm / px;
    setS({ cam: { cx: m.x - (m.x - cam.cx) * k, cy: m.y - (m.y - cam.cy) * k, mmPerPx: mm } });
  };

  const hitItem = (m: Vec): string | null => {
    const tol = 8 * px;
    let best: string | null = null;
    let bd = tol;
    for (const st of strokes) {
      for (let i = 0; i < st.pts.length; i += 2) {
        const d = dist(st.pts[i], m);
        if (d < bd) {
          bd = d;
          best = st.itemId;
        }
      }
    }
    return best;
  };
  const hitPiece = (m: Vec): string | null => {
    if (!plan) return null;
    let best: string | null = null;
    let bd = 8 * px + 3;
    for (const pc of plan.pieces) {
      for (let i = 0; i < pc.pts.length; i += 2) {
        const d = dist(pc.pts[i], m);
        if (d < bd) {
          bd = d;
          best = pc.id;
        }
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = {
        mode: 'pinch',
        d0: dist(a, b),
        m0: px,
        mid: toMm((a.x + b.x) / 2, (a.y + b.y) / 2),
        cx: cam.cx,
        cy: cam.cy,
      };
      setDraft(null);
      return;
    }
    const m = toMm(e.clientX, e.clientY);
    if (e.button === 1 || e.button === 2 || e.altKey) {
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.cx, cy: cam.cy };
      return;
    }
    if (tool === 'draw') {
      drag.current = { mode: 'draw', pts: [m] };
      setDraft([m]);
      return;
    }
    const pieceId = view === 'plan' || view === 'build' ? hitPiece(m) : null;
    const itemId = hitItem(m) ?? (pieceId ? plan?.pieces.find((p) => p.id === pieceId)?.itemId ?? null : null);
    setS({ selectedPieceId: pieceId, selectedItemId: itemId });
    const item = doc.items.find((i) => i.id === itemId);
    if (item) {
      // template parts (same group) move together
      const members = (item.groupId ? doc.items.filter((i) => i.groupId === item.groupId) : [item]).map((i) => ({
        id: i.id,
        ox: i.x,
        oy: i.y,
      }));
      drag.current = { mode: 'move', sx: m.x, sy: m.y, members, moved: false };
    } else {
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.cx, cy: cam.cy };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const mm = Math.min(20, Math.max(0.02, (d.m0 * d.d0) / Math.max(1, dist(a, b))));
      const k = mm / d.m0;
      setS({ cam: { cx: d.mid.x - (d.mid.x - d.cx) * k, cy: d.mid.y - (d.mid.y - d.cy) * k, mmPerPx: mm } });
    } else if (d.mode === 'pan') {
      setS({ cam: { ...cam, cx: d.cx - (e.clientX - d.sx) * px, cy: d.cy - (e.clientY - d.sy) * px } });
    } else if (d.mode === 'move') {
      const m = toMm(e.clientX, e.clientY);
      const dx = m.x - d.sx;
      const dy = m.y - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 2 * px) return;
      d.moved = true;
      const snap = (v: number) => (e.shiftKey ? v : Math.round(v));
      update((doc) => {
        for (const mb of d.members) {
          const it = doc.items.find((i) => i.id === mb.id);
          if (it) {
            it.x = snap(mb.ox + dx);
            it.y = snap(mb.oy + dy);
          }
        }
      }, `move-${d.members[0].id}`);
    } else if (d.mode === 'draw') {
      const m = toMm(e.clientX, e.clientY);
      if (dist(m, d.pts[d.pts.length - 1]) > 1.5 * px) {
        d.pts.push(m);
        setDraft([...d.pts]);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    drag.current = null;
    if (d?.mode === 'draw') {
      setDraft(null);
      finishDraw(d.pts);
    }
  };

  function finishDraw(raw: Vec[]) {
    if (raw.length < 2) return;
    const simple = rdp(raw, Math.max(0.6, 2 * px));
    const smooth = simple.length > 2 ? catmullRom(simple, 1) : simple;
    const total = cumLengths(smooth).at(-1)!;
    if (total < 3) return;
    const closed = dist(smooth[0], smooth[smooth.length - 1]) < Math.max(4, 10 * px) && total > 40;
    const o = smooth[0];
    const local = smooth.map((p) => ({ x: +(p.x - o.x).toFixed(2), y: +(p.y - o.y).toFixed(2) }));
    if (closed) local[local.length - 1] = { x: 0, y: 0 };
    const id = uid('path');
    const profileId = useStore.getState().doc.profiles[0].id;
    update((doc) => {
      doc.items.push({
        id,
        kind: 'path',
        name: 'Çizim',
        profileId,
        x: +o.x.toFixed(2),
        y: +o.y.toFixed(2),
        rotation: 0,
        d: polylineToD(local, closed),
      });
    });
    setS({ selectedItemId: id });
  }

  const profiles = useMemo(() => new Map(doc.profiles.map((p) => [p.id, p])), [doc.profiles]);
  const profOf = (id: string): StripProfile => profiles.get(id) ?? doc.profiles[0];

  const pieceEls = useMemo(() => {
    if (!plan) return null;
    return plan.pieces.map((pc) => {
      const p = profOf(pc.profileId);
      const cum = cumLengths(pc.pts);
      const marks: { a: Vec; b: Vec; k: number; cut: boolean }[] = [];
      const tick = (s: number, k: number, cut: boolean) => {
        const f = frameAt(pc.pts, s, cum);
        const h = p.width / 2 + 2.5;
        marks.push({ a: { x: f.p.x - f.n.x * h, y: f.p.y - f.n.y * h }, b: { x: f.p.x + f.n.x * h, y: f.p.y + f.n.y * h }, k, cut });
      };
      const tail = pc.darkTail > 0.3;
      for (let k = 0; k <= pc.units; k++) tick(pc.capStart + k * p.cutUnit, k, k === 0 || (k === pc.units && !tail));
      if (tail) tick(pc.capStart + pc.stripLength, -1, true);
      return {
        pc,
        p,
        body: ptsToD(pc.pts),
        lit: ptsToD(subPts(pc.pts, pc.litStart, pc.litEnd)),
        marks,
        start: frameAt(pc.pts, 0, cum),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, profiles]);

  const strokeEls = useMemo(
    () => strokes.map((s) => ({ s, d: ptsToD(s.pts, 0.03) + (s.closed ? 'Z' : '') })),
    [strokes],
  );

  const selBounds = useMemo(() => {
    if (!selectedItemId) return null;
    const b = boundsOf(strokes.filter((s) => s.itemId === selectedItemId).map((s) => s.pts), 6);
    return boundsValid(b) ? b : null;
  }, [selectedItemId, strokes]);

  const showLabels = px < 0.45;
  const gridMinor = px < 0.25 ? 10 : px < 1.5 ? 50 : 100;

  return (
    <svg
      ref={svgRef}
      className={`canvas tool-${tool}`}
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <pattern id="grid" width={gridMinor} height={gridMinor} patternUnits="userSpaceOnUse">
          <path d={`M${gridMinor} 0L0 0 0 ${gridMinor}`} fill="none" stroke="var(--grid)" strokeWidth={px} />
        </pattern>
        <pattern id="grid5" width={gridMinor * 5} height={gridMinor * 5} patternUnits="userSpaceOnUse">
          <rect width={gridMinor * 5} height={gridMinor * 5} fill="url(#grid)" />
          <path d={`M${gridMinor * 5} 0L0 0 0 ${gridMinor * 5}`} fill="none" stroke="var(--grid-major)" strokeWidth={px} />
        </pattern>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={Math.max(1.5, 2.5)} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill={view === 'preview' ? 'transparent' : 'url(#grid5)'} />
      {view !== 'preview' && (
      <>

      {/* hot spots under everything */}
      {view === 'plan' &&
        plan?.hotspots.map((h, i) => (
          <path
            key={`hs${i}`}
            d={ptsToD(h.pts)}
            fill="none"
            stroke={h.severity === 'error' ? 'var(--err)' : 'var(--warn)'}
            strokeOpacity={h.severity === 'error' ? 0.5 : 0.2}
            strokeWidth={14}
            strokeLinecap="round"
          />
        ))}

      {/* design centrelines */}
      {strokeEls.map(({ s, d }) => (
        <path
          key={s.id}
          d={d}
          fill="none"
          stroke={view === 'design' ? profOf(s.profileId).color : 'var(--centre)'}
          strokeWidth={view === 'design' ? 2.2 * px : px}
          strokeDasharray={view === 'design' ? undefined : `${4 * px} ${3 * px}`}
          filter={view === 'design' ? 'url(#glow)' : undefined}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      {(view === 'plan' || view === 'build') && plan && (
        <g>
          {plan.wires.map((w, i) => (
            <line
              key={`w${i}`}
              x1={w.a.x}
              y1={w.a.y}
              x2={w.b.x}
              y2={w.b.y}
              stroke="var(--wire)"
              strokeWidth={1.2 * px}
              strokeDasharray={`${6 * px} ${4 * px}`}
            />
          ))}
          {pieceEls?.map(({ pc, p, body, lit, marks }) => (
            <g key={pc.id} opacity={selectedPieceId && selectedPieceId !== pc.id ? (view === 'build' ? 0.25 : 0.55) : 1}>
              {selectedPieceId === pc.id && (
                <path d={body} fill="none" stroke="var(--sel)" strokeWidth={p.width + 3} strokeLinejoin="round" />
              )}
              <path d={body} fill="none" stroke={shade(p.color, 0.32)} strokeWidth={p.width} strokeLinejoin="round" />
              <path d={lit} fill="none" stroke={p.color} strokeWidth={p.width * 0.62} strokeLinejoin="round" />
              {marks.map((m) => (
                <line
                  key={m.k}
                  x1={m.a.x}
                  y1={m.a.y}
                  x2={m.b.x}
                  y2={m.b.y}
                  stroke={m.cut ? 'var(--cut-end)' : 'var(--mark)'}
                  strokeWidth={m.cut ? 1.6 * px : 0.9 * px}
                />
              ))}
            </g>
          ))}
          {plan.holes.map((h) => (
            <circle key={h.id} cx={h.at.x} cy={h.at.y} r={h.diameter / 2} fill="none" stroke="var(--hole)" strokeWidth={px} />
          ))}
          <g transform={`translate(${plan.entry.x} ${plan.entry.y}) scale(${px})`}>
            <rect x={-7} y={-7} width={14} height={14} rx={3} fill="var(--panel)" stroke="var(--wire)" />
            <text y={4} textAnchor="middle" className="badge-text">
              ⚡
            </text>
          </g>
          {pieceEls?.map(({ pc, start }) => (
            <g
              key={`n${pc.id}`}
              transform={`translate(${start.p.x - start.t.x * 9 * px} ${start.p.y - start.t.y * 9 * px}) scale(${px})`}
            >
              <circle r={9} className={pc.id === selectedPieceId ? 'badge badge-sel' : 'badge'} />
              <text y={3.5} textAnchor="middle" className="badge-text">
                {pc.no}
              </text>
            </g>
          ))}
          {showLabels &&
            pieceEls?.map(({ pc, marks }) =>
              marks
                .filter((m) => !m.cut && m.k > 0)
                .map((m) => (
                  <text
                    key={`ml${pc.id}${m.k}`}
                    x={m.b.x}
                    y={m.b.y}
                    fontSize={7 * px}
                    className="mark-label"
                    textAnchor="middle"
                  >
                    {m.k}
                  </text>
                )),
            )}
          {plan.issues
            .filter((i) => i.at && i.severity !== 'info')
            .map((i) => (
              <g key={i.id} transform={`translate(${i.at!.x} ${i.at!.y}) scale(${px})`}>
                <circle r={11} fill="none" stroke={i.severity === 'error' ? 'var(--err)' : 'var(--warn)'} strokeWidth={2} />
              </g>
            ))}
        </g>
      )}

      </>
      )}
      {selBounds && view !== 'preview' && (
        <rect
          x={selBounds.minX}
          y={selBounds.minY}
          width={selBounds.maxX - selBounds.minX}
          height={selBounds.maxY - selBounds.minY}
          fill="none"
          stroke="var(--sel)"
          strokeWidth={px}
          strokeDasharray={`${5 * px} ${4 * px}`}
        />
      )}
      {draft && draft.length > 1 && (
        <path d={ptsToD(draft, 0)} fill="none" stroke="var(--sel)" strokeWidth={2 * px} strokeLinecap="round" />
      )}
    </svg>
  );
}
