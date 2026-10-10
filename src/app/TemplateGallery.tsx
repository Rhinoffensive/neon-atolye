import { useMemo } from 'react';
import { useStore } from './store';
import { TEMPLATES, templateBounds, type NeonTemplate } from '../core/templates';
import { flattenPath } from '../core/geom/svgpath';
import { boundsOf, boundsValid } from '../core/geom/vec';
import { PRESET_COLORS, uid } from '../core/model/defaults';
import type { Doc, PathItem, StripProfile } from '../core/model/types';

/** Strip profile for a colour: reuse one with the same colour, else copy the first profile. */
function profileFor(d: Doc, color: string): StripProfile {
  const hit = d.profiles.find((p) => p.color.toLowerCase() === color.toLowerCase());
  if (hit) return hit;
  const base = d.profiles[0];
  const preset = PRESET_COLORS.find((c) => c.color.toLowerCase() === color.toLowerCase());
  const prof: StripProfile = {
    ...base,
    id: uid('prof'),
    color,
    jacketColor: preset?.jacket ?? base.jacketColor,
    name: `${preset?.name ?? 'Renk'} ${base.width} mm`,
  };
  d.profiles.push(prof);
  return prof;
}

export function insertTemplate(t: NeonTemplate): void {
  const st = useStore.getState();
  const tb = templateBounds(t, (d) => flattenPath(d, 2));
  const b = boundsOf(st.strokes.map((s) => s.pts));
  // to the right of what is already there, top aligned
  const x = Math.round(boundsValid(b) ? b.maxX + 80 - tb.minX : -tb.minX);
  const y = Math.round(boundsValid(b) ? b.minY - tb.minY : -tb.minY);
  const groupId = uid('grp');
  const ids: string[] = [];
  st.update((d) => {
    for (const part of t.parts) {
      const prof = profileFor(d, part.color);
      const item: PathItem = {
        id: uid('path'),
        kind: 'path',
        name: t.parts.length > 1 ? `${t.name} · ${part.name}` : t.name,
        profileId: prof.id,
        x,
        y,
        rotation: 0,
        d: part.d,
        groupId,
      };
      ids.push(item.id);
      d.items.push(item);
    }
  });
  st.set({ selectedItemId: ids[0], selectedPieceId: null, tool: 'select' });
  setTimeout(() => window.dispatchEvent(new Event('neon:fit')), 250);
}

function Thumb({ t }: { t: NeonTemplate }) {
  const b = useMemo(() => templateBounds(t, (d) => flattenPath(d, 2)), [t]);
  const pad = 14;
  const vb = `${b.minX - pad} ${b.minY - pad} ${b.maxX - b.minX + 2 * pad} ${b.maxY - b.minY + 2 * pad}`;
  return (
    <svg viewBox={vb} className="tpl-thumb">
      <defs>
        <filter id={`g-${t.id}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {t.parts.map((p) => (
        <path
          key={p.name}
          d={p.d}
          fill="none"
          stroke={p.color}
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#g-${t.id})`}
        />
      ))}
    </svg>
  );
}

export function TemplateGallery({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>Şablonlar</b>
          <span className="muted small">6 mm şerit için çizildi, hepsi planlayıcıdan hatasız geçer</span>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="tpl-grid">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className="tpl-card"
              onClick={() => {
                insertTemplate(t);
                onClose();
              }}
            >
              <Thumb t={t} />
              <span>
                {t.emoji} {t.name}
              </span>
            </button>
          ))}
        </div>
        <p className="hint">Ekledikten sonra sol panelde "Grup genişliği" ile boyutlandır; parçalar birlikte taşınır.</p>
      </div>
    </div>
  );
}
