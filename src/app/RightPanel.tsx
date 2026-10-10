import { useStore } from './store';
import { Bar, Section } from './ui';
import { fmtCm, fmtLen, shade } from './geomUi';
import { stepText, cutInstruction, unitsLabel, blindCutLabel } from '../core/plan/bends';
import type { Doc, Piece, StripProfile, EndKind } from '../core/model/types';
import { scalePathD } from './importSvg';

const END_TR: Record<EndKind, string> = {
  free: 'serbest',
  corner: 'köşe',
  cross: 'kesişim',
  abut: 'dayanma',
  seam: 'ek yeri',
  split: 'bölme',
};

export function scaleDoc(d: Doc, k: number): void {
  for (const it of d.items) {
    it.x = +(it.x * k).toFixed(2);
    it.y = +(it.y * k).toFixed(2);
    if (it.kind === 'text') it.capHeight = +(it.capHeight * k).toFixed(1);
    else it.d = scalePathD(it.d, k);
  }
}

export function RightPanel() {
  const plan = useStore((s) => s.plan);
  const doc = useStore((s) => s.doc);
  const planMs = useStore((s) => s.planMs);
  const planError = useStore((s) => s.planError);
  const view = useStore((s) => s.view);
  const selectedPieceId = useStore((s) => s.selectedPieceId);
  const setS = useStore((s) => s.set);
  const update = useStore((s) => s.update);
  const profiles = new Map(doc.profiles.map((p) => [p.id, p]));
  if (planError) return <aside className="panel right"><pre className="err">{planError}</pre></aside>;
  if (!plan) return <aside className="panel right"><p className="hint">Plan hesaplanıyor…</p></aside>;
  if (view === 'build') return <BuildPanel />;

  const errors = plan.issues.filter((i) => i.severity === 'error');
  const warns = plan.issues.filter((i) => i.severity === 'warn');
  const infos = plan.issues.filter((i) => i.severity === 'info');
  const piece = plan.pieces.find((p) => p.id === selectedPieceId) ?? null;
  const w = plan.bounds.maxX - plan.bounds.minX;
  const h = plan.bounds.maxY - plan.bounds.minY;

  const focus = (at?: { x: number; y: number }, pieceId?: string) => {
    if (pieceId) setS({ selectedPieceId: pieceId });
    if (at) setS({ cam: { ...useStore.getState().cam, cx: at.x, cy: at.y }, view: 'plan' });
  };

  return (
    <aside className="panel right">
      <Section title="Özet" right={<span className="muted small">{Math.round(planMs)} ms</span>}>
        <div className="stats">
          <div>
            <b>{plan.pieces.length}</b>
            <span>parça</span>
          </div>
          <div>
            <b>{plan.pieces.reduce((a, p) => a + p.units, 0)}</b>
            <span>birim</span>
          </div>
          <div>
            <b>{w > 0 ? `${fmtCm(w)} × ${fmtCm(h)}` : '–'}</b>
            <span>boyut</span>
          </div>
        </div>
        {plan.stock
          .filter((s) => s.pieces > 0)
          .map((s) => {
            const p = profiles.get(s.profileId)!;
            return (
              <div key={s.profileId} className="stock">
                <div className="row">
                  <span className="dot" style={{ background: p.color, boxShadow: `0 0 6px ${p.color}` }} />
                  <span>{p.name}</span>
                  <span className="grow" />
                  <b>{fmtLen(s.usedMm)}</b>
                  <span className="muted">/ {fmtLen(s.availableMm)}</span>
                </div>
                <Bar value={s.usedMm} max={s.availableMm} color={p.color} />
              </div>
            );
          })}
        <div className="kv">
          <span>Güç</span>
          <b>
            {plan.power.watts.toFixed(1)} W · {plan.power.amps.toFixed(2)} A
          </b>
          <span>Adaptör</span>
          <b>≥ {plan.power.psuWatts} W</b>
          <span>Arka kablo</span>
          <b>
            {fmtLen(plan.power.wireLength)} · {String(plan.power.wireMm2).replace('.', ',')} mm²
          </b>
        </div>
        <SizeHint
          minScale={plan.size.minScale}
          minReason={plan.size.minReason}
          maxScale={plan.size.maxScale}
          maxReason={plan.size.maxReason}
          onScale={(k) => update((d) => scaleDoc(d, k))}
        />
      </Section>

      <Section title={`Uyarılar (${errors.length + warns.length})`}>
        {!errors.length && !warns.length && <p className="ok">✓ Sorun yok, bu tasarım yapılabilir.</p>}
        <ul className="issues">
          {[...errors, ...warns, ...infos].map((i) => (
            <li key={i.id} className={i.severity} onClick={() => focus(i.at, i.pieceId)}>
              <span className="sev">{i.severity === 'error' ? '●' : i.severity === 'warn' ? '▲' : 'ℹ'}</span>
              {i.message}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Parçalar">
        <table className="pieces">
          <thead>
            <tr>
              <th>#</th>
              <th />
              <th>birim</th>
              <th>boy</th>
              <th>uçlar</th>
            </tr>
          </thead>
          <tbody>
            {plan.pieces.map((p) => {
              const pr = profiles.get(p.profileId)!;
              return (
                <tr
                  key={p.id}
                  className={p.id === selectedPieceId ? 'sel' : ''}
                  onClick={() => setS({ selectedPieceId: p.id === selectedPieceId ? null : p.id, view: 'plan' })}
                >
                  <td>P{p.no}</td>
                  <td>
                    <span className="dot" style={{ background: pr.color }} />
                  </td>
                  <td>{p.darkTail > 0.5 ? `${p.units}+` : p.units}</td>
                  <td>{fmtCm(p.stripLength)}</td>
                  <td className="muted small">
                    {END_TR[p.startKind]} → {END_TR[p.endKind]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      {piece && <PieceDetail piece={piece} prof={profiles.get(piece.profileId)!} />}
    </aside>
  );
}

function SizeHint(p: { minScale: number; minReason: string; maxScale: number; maxReason: string; onScale: (k: number) => void }) {
  const tooSmall = p.minScale > 1.001;
  const tooBig = p.maxScale < 0.999;
  return (
    <div className="sizehint">
      {tooSmall && (
        <div className="row err">
          <span>
            Büküm için en az <b>×{p.minScale.toFixed(2)}</b> büyütmek gerek ({p.minReason}).
          </span>
          <button onClick={() => p.onScale(Math.ceil(p.minScale * 100) / 100)}>Büyüt</button>
        </div>
      )}
      {!tooSmall && p.minScale > 0 && (
        <div className="row muted small">
          Büküm sınırına göre ×{p.minScale.toFixed(2)}'e kadar küçültülebilir ({p.minReason}).
        </div>
      )}
      {tooBig && (
        <div className="row err">
          <span>
            Stok yetmiyor: en fazla <b>×{p.maxScale.toFixed(2)}</b> ({p.maxReason}).
          </span>
          <button onClick={() => p.onScale(Math.floor(p.maxScale * 100) / 100)}>Küçült</button>
        </div>
      )}
      {!tooBig && Number.isFinite(p.maxScale) && (
        <div className="row muted small">Stok ×{p.maxScale.toFixed(2)} büyütmeye yeter ({p.maxReason}).</div>
      )}
    </div>
  );
}

function PieceDetail({ piece, prof }: { piece: Piece; prof: StripProfile }) {
  return (
    <Section title={`P${piece.no} · büküm adımları`}>
      <p className="small">
        {cutInstruction(piece)}{' '}
        {piece.loop && 'Kapalı harf: uçlar ek yerinde buluşuyor. '}
        {Math.abs(piece.residual) > 0.5 &&
          `Uçlar 25'lik birime oturması için toplam ${Math.round(Math.abs(piece.residual))} mm ${piece.residual > 0 ? 'uzatıldı' : 'kısaltıldı'}.`}
      </p>
      <StripDiagram piece={piece} prof={prof} />
      <ol className="steps">
        {piece.bends.map((b, i) => (
          <li key={i} className={b.warning ? 'warn' : ''}>
            <span className={`tag ${b.kind === 'arc' ? (b.dir === 'L' ? 'left' : 'right') : 'line'}`}>
              {b.kind === 'arc' ? (b.dir === 'L' ? '↶' : '↷') : '│'}
            </span>
            {stepText(b)}
            {b.warning && <em> — {b.warning}</em>}
          </li>
        ))}
      </ol>
      <p className="muted small">
        İ0 = besleme ucundaki kesim yeri, İ1, İ2… şeridin üstündeki kesim işaretleri. "İ3+8" = 3. işaretten 8 mm sonra.
        {` Kör uç: ${blindCutLabel(piece)}.`}
      </p>
    </Section>
  );
}

export function StripDiagram({ piece, prof }: { piece: Piece; prof: StripProfile }) {
  const L = piece.length;
  const H = 34;
  const y = 14;
  const sw = prof.width;
  const cut0 = piece.capStart;
  return (
    <div className="strip-scroll">
      <svg
        className="strip"
        viewBox={`-4 0 ${L + 8} ${H}`}
        style={{ width: `max(100%, ${Math.round(L * 1.4)}px)` }}
        preserveAspectRatio="xMinYMid meet"
      >
        <rect x={0} y={y} width={L} height={sw} rx={1} fill={shade(prof.color, 0.3)} />
        <rect x={piece.litStart} y={y + sw * 0.2} width={Math.max(0, piece.litEnd - piece.litStart)} height={sw * 0.6} fill={prof.color} />
        <rect x={0} y={y} width={piece.capStart} height={sw} fill="#777" />
        <rect x={L - piece.capEnd} y={y} width={piece.capEnd} height={sw} fill="#555" />
        {piece.bends
          .filter((b) => b.kind === 'arc')
          .map((b, i) => {
            const x0 = cut0 + b.sStrip;
            const col = b.dir === 'L' ? 'var(--left)' : 'var(--right)';
            return (
              <g key={i}>
                <rect x={x0} y={y - 4} width={b.length} height={2.5} fill={col} />
                {b.length > 14 && (
                  <text x={x0 + b.length / 2} y={y - 6} fontSize={4.2} textAnchor="middle" fill={col}>
                    {Math.round(b.angleDeg!)}° R{Math.round(b.radius!)}
                  </text>
                )}
              </g>
            );
          })}
        {piece.darkTail > 0.5 && (
          <line x1={cut0 + piece.stripLength} y1={y - 2} x2={cut0 + piece.stripLength} y2={y + sw + 2} stroke="var(--err)" strokeWidth={0.8} />
        )}
        {Array.from({ length: piece.units + 1 }, (_, k) => {
          const x = cut0 + k * prof.cutUnit;
          const cut = k === 0 || (k === piece.units && piece.darkTail <= 0.5);
          return (
            <g key={k}>
              <line x1={x} y1={y - 1} x2={x} y2={y + sw + 1} stroke={cut ? 'var(--err)' : '#fff'} strokeWidth={cut ? 0.8 : 0.4} />
              <text x={x} y={y + sw + 6} fontSize={4} textAnchor="middle" fill="var(--muted)">
                {k}
              </text>
            </g>
          );
        })}
        <text x={-3} y={y + sw - 1} fontSize={5} textAnchor="end" fill="var(--wire)">
          ⚡
        </text>
      </svg>
    </div>
  );
}

function BuildPanel() {
  const plan = useStore((s) => s.plan)!;
  const doc = useStore((s) => s.doc);
  const step = useStore((s) => s.buildStep);
  const done = useStore((s) => s.buildDone);
  const setS = useStore((s) => s.set);
  const profiles = new Map(doc.profiles.map((p) => [p.id, p]));
  const n = plan.pieces.length;
  const k = Math.min(step, n);
  const piece = k > 0 ? plan.pieces[k - 1] : null;
  const key = (id: string) => `${doc.name}:${id}`;
  const doneCount = plan.pieces.filter((p) => done[key(p.id)]).length;

  const go = (to: number) => {
    const t = Math.max(0, Math.min(n, to));
    const pc = t > 0 ? plan.pieces[t - 1] : null;
    const st = useStore.getState();
    if (pc) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of pc.pts) {
        x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
      }
      setS({ buildStep: t, selectedPieceId: pc.id, cam: { ...st.cam, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } });
    } else setS({ buildStep: t, selectedPieceId: null });
  };
  const toggle = (id: string) => setS({ buildDone: { ...done, [key(id)]: !done[key(id)] } });

  return (
    <aside className="panel right build">
      <div className="build-head">
        <b>{k === 0 ? 'Hazırlık' : `Parça ${k} / ${n}`}</b>
        <span className="muted small">{doneCount}/{n} tamam</span>
      </div>
      <Bar value={doneCount} max={n} color="var(--ok)" />
      {k === 0 ? (
        <div className="build-card">
          <ol className="prep">
            <li>PDF'i indir, <b>%100 / gerçek boyutta</b> yazdır, 100 mm çubuğu cetvelle ölç.</li>
            <li>Şablon sayfalarını + işaretleri üst üste gelecek şekilde bantla.</li>
            <li>Şablonu şeffaf pleksinin (ya da panonun) altına koy.</li>
            <li>
              Rulodan kesilecekler (toplam {plan.pieces.reduce((a, p) => a + p.consumedUnits, 0)} birim ={' '}
              {fmtLen(plan.pieces.reduce((a, p) => a + p.consumedUnits * (profiles.get(p.profileId)?.cutUnit ?? 25), 0))}):
              <div className="cutlist">
                {[...plan.pieces]
                  .sort((a, b) => b.stripLength - a.stripLength)
                  .map((p) => (
                    <span key={p.id} className="chip on" style={{ borderColor: profiles.get(p.profileId)?.color }}>
                      P{p.no}: {unitsLabel(p)}
                    </span>
                  ))}
              </div>
            </li>
            <li>Her parçayı kesim işaretinden kes, numarasını bantla parçanın üstüne yaz.</li>
          </ol>
          <button className="big" onClick={() => go(1)}>
            Başla →
          </button>
        </div>
      ) : (
        piece && (
          <div className="build-card">
            <div className="big-line">
              <span className="dot" style={{ background: profiles.get(piece.profileId)?.color }} />
              P{piece.no}: <b>{unitsLabel(piece)}</b> ({fmtCm(piece.stripLength)})
            </div>
            <StripDiagram piece={piece} prof={profiles.get(piece.profileId)!} />
            <ol className="steps big-steps">
              <li>{cutInstruction(piece)}</li>
              <li>
                Besleme ucunu (İ0) lehimle, {profiles.get(piece.profileId)?.cableExit === 'bottom' ? 'alttan çıkışlı' : 'uçtan çıkışlı'} kapağı tak; diğer uca kör kapak.
              </li>
              {piece.bends.map((b, i) => (
                <li key={i} className={b.warning ? 'warn' : ''}>
                  {stepText(b)}
                  {b.warning && <em> — {b.warning}</em>}
                </li>
              ))}
              <li>Şablonda <b>{piece.no}</b> numaralı daireden başlayarak çizgiye yerleştir; işaretleri çentiklerle hizala.</li>
              <li>Kabloyu deliğe geçir, silikonla sabitle.</li>
            </ol>
            <label className="donebox">
              <input type="checkbox" checked={!!done[key(piece.id)]} onChange={() => toggle(piece.id)} /> Bu parça tamam
            </label>
          </div>
        )
      )}
      <div className="build-nav">
        <button onClick={() => go(k - 1)} disabled={k === 0}>
          ← Geri
        </button>
        <button
          className="on"
          onClick={() => {
            if (piece && !done[key(piece.id)]) toggle(piece.id);
            go(k + 1);
          }}
          disabled={k >= n}
        >
          {k === 0 ? 'Başla' : 'Tamam, sonraki →'}
        </button>
      </div>
    </aside>
  );
}
