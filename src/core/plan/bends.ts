import type { BendStep, StripProfile } from '../model/types';
import type { Vec } from '../geom/vec';
import { fitLinesArcs, turnDir } from '../geom/arcfit';

/**
 * Turn a piece centreline (feed end first) into bending steps, positioned against the
 * cut marks printed on the strip: mark 0 is the feed-end cut, mark k is k cut units further.
 */
export function bendSteps(pts: Vec[], prof: StripProfile, units: number): BendStep[] {
  const u = prof.cutUnit;
  const els = fitLinesArcs(pts, 0.3, 400);
  return els.map((e) => {
    const sStrip = e.s0 - prof.capFeed;
    const mark = Math.max(0, Math.min(units, Math.floor((sStrip + 1e-6) / u)));
    const step: BendStep = {
      kind: e.kind,
      sStrip,
      length: e.length,
      mark,
      markOffset: sStrip - mark * u,
    };
    if (e.kind === 'arc') {
      step.dir = turnDir(e.sweep);
      step.angleDeg = (Math.abs(e.sweep) * 180) / Math.PI;
      step.radius = e.radius;
      const warn: string[] = [];
      if (e.radius < prof.rMinHard) warn.push('çok sıkı büküm');
      else if (e.radius < prof.rMinWarn) warn.push('sıkı büküm');
      if (e.radius < prof.rMinWarn) {
        for (let k = 1; k < units; k++) {
          const m = k * u;
          if (m > sStrip && m < sStrip + e.length) {
            warn.push(`İ${k} işareti bükümün içinde`);
            break;
          }
        }
      }
      if (sStrip < 0) warn.push('uç kapağına yakın');
      if (warn.length) step.warning = warn.join(', ');
    }
    return step;
  });
}

/** "İ3+8" style position label. */
export function markLabel(mark: number, offset: number): string {
  const o = Math.round(offset);
  return `İ${mark}${o >= 0 ? '+' : ''}${o}`;
}

export function stepText(st: BendStep): string {
  const at = markLabel(st.mark, st.markOffset);
  if (st.kind === 'line') return `${at} → düz ${Math.round(st.length)} mm`;
  const dir = st.dir === 'L' ? 'sola' : 'sağa';
  return `${at} → ${dir} ${Math.round(st.angleDeg!)}° R${Math.round(st.radius!)} (yay ${Math.round(st.length)} mm)`;
}
