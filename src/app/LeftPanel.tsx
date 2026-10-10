import { useRef } from 'react';
import { useStore } from './store';
import { Num, Section, Select } from './ui';
import { FONT_LIST } from '../core/text/svgfont';
import { defaultProfile, defaultText, PRESET_COLORS, uid } from '../core/model/defaults';
import type { Item, PathItem, StripProfile, TextItem } from '../core/model/types';
import { importSvg, scalePathD } from './importSvg';
import { boundsOf, boundsValid } from '../core/geom/vec';

function itemLabel(it: Item): string {
  if (it.kind === 'text') return it.text.split('\n')[0] || '(boş yazı)';
  return it.name || 'Çizim';
}

export function LeftPanel() {
  const doc = useStore((s) => s.doc);
  const selectedItemId = useStore((s) => s.selectedItemId);
  const tool = useStore((s) => s.tool);
  const strokes = useStore((s) => s.strokes);
  const update = useStore((s) => s.update);
  const setS = useStore((s) => s.set);
  const fileRef = useRef<HTMLInputElement>(null);
  const sel = doc.items.find((i) => i.id === selectedItemId) ?? null;

  const addText = () => {
    const b = boundsOf(strokes.map((s) => s.pts));
    const p = doc.profiles[0];
    const t = defaultText(p.id, {
      text: 'Yazı',
      fontId: 'EMSReadability',
      x: boundsValid(b) ? b.minX : 0,
      y: boundsValid(b) ? b.maxY + 160 : 0,
    });
    update((d) => {
      d.items.push(t);
    });
    setS({ selectedItemId: t.id, view: 'design' });
  };

  const onFile = async (f: File) => {
    const text = await f.text();
    const items = importSvg(text, doc.profiles[0].id, f.name.replace(/\.svg$/i, ''));
    if (!items.length) {
      alert('SVG içinde çizgi bulunamadı.');
      return;
    }
    update((d) => {
      d.items.push(...items);
    });
    setS({ selectedItemId: items[0].id });
    setTimeout(() => window.dispatchEvent(new Event('neon:fit')), 300);
  };

  const patchItem = (fn: (it: Item) => void, key?: string) =>
    update((d) => {
      const it = d.items.find((i) => i.id === selectedItemId);
      if (it) fn(it);
    }, key);

  return (
    <aside className="panel left">
      <Section title="Öğeler">
        <div className="btnrow">
          <button onClick={addText}>＋ Yazı</button>
          <button className={tool === 'draw' ? 'on' : ''} onClick={() => setS({ tool: tool === 'draw' ? 'select' : 'draw' })}>
            ✎ Çiz
          </button>
          <button onClick={() => fileRef.current?.click()}>⇪ SVG</button>
          <input
            ref={fileRef}
            type="file"
            accept=".svg,image/svg+xml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />
        </div>
        {tool === 'draw' && <p className="hint">Tuvalde sürükleyerek çiz. Başladığın yere dönersen kapalı şekil olur.</p>}
        <ul className="items">
          {doc.items.map((it) => {
            const prof = doc.profiles.find((p) => p.id === it.profileId) ?? doc.profiles[0];
            return (
              <li
                key={it.id}
                className={it.id === selectedItemId ? 'sel' : ''}
                onClick={() => setS({ selectedItemId: it.id, selectedPieceId: null })}
              >
                <span className="dot" style={{ background: prof.color, boxShadow: `0 0 6px ${prof.color}` }} />
                <span className="name">{itemLabel(it)}</span>
                <span className="kind">{it.kind === 'text' ? 'Yazı' : 'Çizim'}</span>
                <button
                  className="icon"
                  title="Sil"
                  onClick={(e) => {
                    e.stopPropagation();
                    update((d) => {
                      d.items = d.items.filter((x) => x.id !== it.id);
                    });
                    if (it.id === selectedItemId) setS({ selectedItemId: null });
                  }}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      {sel && (
        <Section title={sel.kind === 'text' ? 'Yazı' : 'Çizim'}>
          {sel.kind === 'text' ? <TextProps it={sel} patch={patchItem} /> : <PathProps it={sel} patch={patchItem} />}
          <div className="grid2">
            <Num label="X" unit="mm" value={sel.x} onChange={(v) => patchItem((it) => void (it.x = v), 'x')} />
            <Num label="Y" unit="mm" value={sel.y} onChange={(v) => patchItem((it) => void (it.y = v), 'y')} />
            <Num label="Açı" unit="°" value={sel.rotation} onChange={(v) => patchItem((it) => void (it.rotation = v), 'rot')} />
          </div>
          <Select
            label="Şerit"
            value={sel.profileId}
            options={doc.profiles.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(v) => patchItem((it) => void (it.profileId = v))}
          />
          <div className="btnrow">
            <button
              onClick={() => {
                const copy = { ...structuredClone(sel), id: uid(sel.kind === 'text' ? 'txt' : 'path'), y: sel.y + 60 };
                update((d) => void d.items.push(copy));
                setS({ selectedItemId: copy.id });
              }}
            >
              Çoğalt
            </button>
          </div>
        </Section>
      )}

      <ProfilesSection />
      <SettingsSection />
    </aside>
  );
}

function TextProps({ it, patch }: { it: TextItem; patch: (fn: (it: Item) => void, key?: string) => void }) {
  const t = (fn: (x: TextItem) => void, key?: string) => patch((x) => fn(x as TextItem), key);
  return (
    <>
      <label className="field col">
        <span className="lbl">Metin</span>
        <textarea rows={2} value={it.text} onChange={(e) => t((x) => void (x.text = e.target.value), 'text')} />
      </label>
      <div className="btnrow small">
        <button onClick={() => t((x) => void (x.text = x.text.toLocaleUpperCase('tr')))}>BÜYÜK</button>
        <button onClick={() => t((x) => void (x.text = x.text.toLocaleLowerCase('tr')))}>küçük</button>
        <button
          onClick={() =>
            t(
              (x) =>
                void (x.text = x.text
                  .toLocaleLowerCase('tr')
                  .replace(/(^|\s)(\S)/g, (_m, a: string, b: string) => a + b.toLocaleUpperCase('tr'))),
            )
          }
        >
          Baş Harf
        </button>
      </div>
      <Select
        label="Font"
        value={it.fontId}
        options={FONT_LIST.map((f) => ({ value: f.id, label: f.label }))}
        onChange={(v) => t((x) => void (x.fontId = v))}
      />
      <div className="grid2">
        <Num label="Büyük harf" unit="mm" min={10} step={5} value={it.capHeight} onChange={(v) => t((x) => void (x.capHeight = v), 'cap')} />
        <Num label="Harf aralığı" unit="%" step={1} value={it.letterSpacing} onChange={(v) => t((x) => void (x.letterSpacing = v), 'ls')} />
        <Num label="Satır aralığı" unit="×" step={0.1} min={0.5} value={it.lineSpacing} onChange={(v) => t((x) => void (x.lineSpacing = v), 'lh')} />
      </div>
      <input
        type="range"
        min={20}
        max={400}
        value={it.capHeight}
        onChange={(e) => t((x) => void (x.capHeight = +e.target.value), 'cap')}
      />
    </>
  );
}

function PathProps({ it, patch }: { it: PathItem; patch: (fn: (it: Item) => void, key?: string) => void }) {
  const strokes = useStore((s) => s.strokes);
  const b = boundsOf(strokes.filter((s) => s.itemId === it.id).map((s) => s.pts));
  const w = boundsValid(b) ? b.maxX - b.minX : 0;
  return (
    <>
      <label className="field col">
        <span className="lbl">Ad</span>
        <input value={it.name} onChange={(e) => patch((x) => void ((x as PathItem).name = e.target.value), 'name')} />
      </label>
      {w > 0 && (
        <Num
          label="Genişlik"
          unit="mm"
          value={Math.round(w * 10) / 10}
          min={5}
          step={5}
          onChange={(v) => patch((x) => void ((x as PathItem).d = scalePathD((x as PathItem).d, v / w)), 'pw')}
        />
      )}
    </>
  );
}

function ProfilesSection() {
  const doc = useStore((s) => s.doc);
  const update = useStore((s) => s.update);
  const pid = useStore((s) => s.doc.items.find((i) => i.id === s.selectedItemId)?.profileId) ?? doc.profiles[0].id;
  const p = doc.profiles.find((x) => x.id === pid) ?? doc.profiles[0];
  const set = (fn: (p: StripProfile) => void, key?: string) =>
    update((d) => {
      const x = d.profiles.find((q) => q.id === p.id);
      if (x) fn(x);
    }, key);
  return (
    <Section
      title="Şerit profili"
      open={false}
      right={
        <button
          className="icon"
          title="Yeni renk/şerit"
          onClick={() => {
            const np = defaultProfile({ ...p, id: uid('prof'), name: `${p.name} 2` });
            update((d) => void d.profiles.push(np));
          }}
        >
          ＋
        </button>
      }
    >
      <div className="profile-tabs">
        {doc.profiles.map((q) => (
          <span key={q.id} className={`chip ${q.id === p.id ? 'on' : ''}`} style={{ borderColor: q.color }}>
            <span className="dot" style={{ background: q.color }} />
            {q.name}
          </span>
        ))}
      </div>
      <p className="hint">Seçili öğenin şeridi düzenleniyor.</p>
      <label className="field col">
        <span className="lbl">Ad</span>
        <input value={p.name} onChange={(e) => set((x) => void (x.name = e.target.value), 'pname')} />
      </label>
      <div className="swatches">
        {PRESET_COLORS.map((c) => (
          <button
            key={c.color}
            title={c.name}
            className={`swatch ${p.color === c.color ? 'on' : ''}`}
            style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }}
            onClick={() =>
              set((x) => {
                x.color = c.color;
                x.jacketColor = c.jacket;
                if (/^(Mavi|Yeni|Kırmızı|Altın|Pembe|Mor|Yeşil|Sıcak|Soğuk|Buz)/.test(x.name))
                  x.name = `${c.name} ${x.width} mm`;
              })
            }
          />
        ))}
        <input type="color" value={p.color} onChange={(e) => set((x) => void (x.color = e.target.value), 'pcolor')} />
      </div>
      <div className="grid2">
        <Num label="Kesim birimi" unit="mm" value={p.cutUnit} min={1} onChange={(v) => set((x) => void (x.cutUnit = v), 'pu')} />
        <Num label="LED aralığı" unit="mm" value={p.ledPitch} min={1} step={0.1} onChange={(v) => set((x) => void (x.ledPitch = v), 'pp')} />
        <Num label="Genişlik" unit="mm" value={p.width} min={2} step={0.5} onChange={(v) => set((x) => void (x.width = v), 'pw')} />
        <Num label="Yükseklik" unit="mm" value={p.height} min={2} step={0.5} onChange={(v) => set((x) => void (x.height = v), 'ph')} />
        <Num label="Min R (uyarı)" unit="mm" value={p.rMinWarn} min={1} onChange={(v) => set((x) => void (x.rMinWarn = v), 'prw')} />
        <Num label="Min R (hata)" unit="mm" value={p.rMinHard} min={1} onChange={(v) => set((x) => void (x.rMinHard = v), 'prh')} />
        <Num label="Besleme kapağı" unit="mm" value={p.capFeed} min={0} step={0.5} onChange={(v) => set((x) => void (x.capFeed = v), 'pcf')} />
        <Num label="Kör kapak" unit="mm" value={p.capBlind} min={0} step={0.5} onChange={(v) => set((x) => void (x.capBlind = v), 'pcb')} />
        <Num label="Güç" unit="W/m" value={p.wattPerM} min={0} step={0.5} onChange={(v) => set((x) => void (x.wattPerM = v), 'pwm')} />
        <Num label="Gerilim" unit="V" value={p.voltage} min={1} onChange={(v) => set((x) => void (x.voltage = v), 'pv')} />
        <Num label="Stok" unit="m" value={p.stockMm / 1000} min={0} step={0.5} onChange={(v) => set((x) => void (x.stockMm = v * 1000), 'pst')} />
        <Num label="Difüzyon q" value={p.diffusion} min={0.2} max={1} step={0.05} onChange={(v) => set((x) => void (x.diffusion = v), 'pq')} hint="0,35 = nokta nokta görünen ucuz şerit, 0,6 = kusursuz düz çizgi" />
      </div>
      <Select
        label="Kablo çıkışı"
        value={p.cableExit}
        options={[
          { value: 'bottom', label: 'Alttan (delik kapağın altında)' },
          { value: 'end', label: 'Uçtan (delik ucun ötesinde)' },
        ]}
        onChange={(v) => set((x) => void (x.cableExit = v))}
      />
      {doc.profiles.length > 1 && (
        <button
          className="danger"
          onClick={() =>
            update((d) => {
              const other = d.profiles.find((q) => q.id !== p.id)!;
              d.items.forEach((it) => {
                if (it.profileId === p.id) it.profileId = other.id;
              });
              d.profiles = d.profiles.filter((q) => q.id !== p.id);
            })
          }
        >
          Bu profili sil
        </button>
      )}
    </Section>
  );
}

function SettingsSection() {
  const s = useStore((st) => st.doc.settings);
  const update = useStore((st) => st.update);
  const set = (fn: (x: typeof s) => void, key?: string) => update((d) => fn(d.settings), key);
  return (
    <Section title="Plan ayarları" open={false}>
      <Select
        label="Serbest uçlar"
        value={s.freeEndMode}
        options={[
          { value: 'lit', label: 'Işık çizilen yerde bitsin' },
          { value: 'physical', label: 'Şerit ucu çizilen yerde bitsin' },
        ]}
        onChange={(v) => set((x) => void (x.freeEndMode = v))}
      />
      <div className="grid2">
        <Num label="Şerit arası boşluk" unit="mm" value={s.clearance} min={0.5} step={0.5} onChange={(v) => set((x) => void (x.clearance = v), 'clr')} />
        <Num label="Köşe eşiği" unit="°" value={s.cornerAngle} min={10} max={170} onChange={(v) => set((x) => void (x.cornerAngle = v), 'ca')} />
        <Num label="Yuvarlatma sapması" unit="mm" value={s.maxFilletDeviation} min={0} step={0.5} onChange={(v) => set((x) => void (x.maxFilletDeviation = v), 'mfd')} hint="Köşe yuvarlatılırken çizgi en fazla bu kadar kayabilir; büyütürsen daha az kesim olur." />
        <Num label="Maks. parça" unit="mm" value={s.maxPieceLength} min={100} step={50} onChange={(v) => set((x) => void (x.maxPieceLength = v), 'mpl')} />
        <Num label="Birleştirme" unit="mm" value={s.joinTolerance} min={0} step={0.5} onChange={(v) => set((x) => void (x.joinTolerance = v), 'jt')} hint="Uçları bu kadar yakın çizgiler tek parça sayılır." />
        <Num label="Duvar mesafesi" unit="mm" value={s.standoff} min={0} step={5} onChange={(v) => set((x) => void (x.standoff = v), 'so')} />
      </div>
    </Section>
  );
}
