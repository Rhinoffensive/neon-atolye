import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { useStore, type View } from './store';
import { Canvas } from './Canvas';
import { LeftPanel } from './LeftPanel';
import { RightPanel } from './RightPanel';
import { newDoc } from '../core/model/defaults';
import type { Doc } from '../core/model/types';
import { ArButton } from '../render/xr/ArView';

const Preview = lazy(() => import('../render/Preview'));

const VIEWS: { id: View; label: string }[] = [
  { id: 'design', label: 'Tasarım' },
  { id: 'plan', label: 'Plan' },
  { id: 'preview', label: 'Önizleme' },
  { id: 'build', label: 'Yapım' },
];

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function App() {
  const view = useStore((s) => s.view);
  const doc = useStore((s) => s.doc);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const { undo, redo, set, update, replaceDoc } = useStore.getState();
  const openRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [panels, setPanels] = useState<'none' | 'left' | 'right'>('none');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = useStore.getState().selectedItemId;
        if (id) {
          update((d) => void (d.items = d.items.filter((i) => i.id !== id)));
          set({ selectedItemId: null });
        }
      } else if (e.key === 'Escape') {
        set({ selectedItemId: null, selectedPieceId: null, tool: 'select' });
      } else if (e.key.startsWith('Arrow')) {
        const id = useStore.getState().selectedItemId;
        if (!id) return;
        e.preventDefault();
        const k = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0;
        const dy = e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0;
        update((d) => {
          const it = d.items.find((i) => i.id === id);
          if (it) {
            it.x += dx;
            it.y += dy;
          }
        }, `nudge-${id}`);
      } else if (e.key === 'f') {
        window.dispatchEvent(new Event('neon:fit'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, set, update]);

  const exportPdf = async () => {
    const plan = useStore.getState().plan;
    if (!plan) return;
    setBusy('PDF hazırlanıyor…');
    try {
      const { buildTemplatePdf } = await import('../core/export/pdf');
      const { loadPdfFonts } = await import('./pdfFonts');
      const bytes = buildTemplatePdf(useStore.getState().doc, plan, await loadPdfFonts());
      download(`${slug(doc.name)}-sablon.pdf`, bytes, 'application/pdf');
    } catch (e) {
      console.error(e);
      alert('PDF oluşturulamadı: ' + e);
    } finally {
      setBusy(null);
    }
  };
  const exportSvg = async () => {
    const plan = useStore.getState().plan;
    if (!plan) return;
    const { planToSvg } = await import('../core/export/svg');
    download(`${slug(doc.name)}-plan.svg`, planToSvg(useStore.getState().doc, plan), 'image/svg+xml');
  };

  return (
    <div className={`app view-${view} panels-${panels}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo">◉</span> Neon Atölye
        </div>
        <input
          className="docname"
          value={doc.name}
          onChange={(e) => update((d) => void (d.name = e.target.value), 'docname')}
        />
        <nav className="tabs">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => set({ view: v.id })}>
              {v.label}
            </button>
          ))}
        </nav>
        <div className="actions">
          <button className="icon" title="Geri al (⌘Z)" disabled={!past} onClick={undo}>
            ↶
          </button>
          <button className="icon" title="Yinele (⇧⌘Z)" disabled={!future} onClick={redo}>
            ↷
          </button>
          <button className="icon" title="Sığdır (F)" onClick={() => window.dispatchEvent(new Event('neon:fit'))}>
            ⤢
          </button>
          <span className="sep" />
          <ArButton />
          <button onClick={exportPdf} title="1:1 şablon + yapım föyü">
            ⬇ PDF
          </button>
          <button onClick={exportSvg} title="Plan SVG (lazer/çizim programı için)">
            ⬇ SVG
          </button>
          <button onClick={() => download(`${slug(doc.name)}.neon.json`, JSON.stringify(doc, null, 1), 'application/json')} title="Projeyi kaydet">
            💾
          </button>
          <button onClick={() => openRef.current?.click()} title="Proje aç">
            📂
          </button>
          <button
            title="Yeni proje"
            onClick={() => {
              if (confirm('Yeni proje açılsın mı? (Mevcut proje geri al ile geri gelir.)')) replaceDoc(newDoc());
            }}
          >
            ＋
          </button>
          <input
            ref={openRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const d = JSON.parse(await f.text()) as Doc;
                if (d.version !== 1 || !Array.isArray(d.items)) throw new Error('format');
                replaceDoc(d);
                setTimeout(() => window.dispatchEvent(new Event('neon:fit')), 300);
              } catch {
                alert('Bu dosya bir Neon Atölye projesi değil.');
              }
            }}
          />
          <span className="mobile-only">
            <button onClick={() => setPanels(panels === 'left' ? 'none' : 'left')}>☰</button>
            <button onClick={() => setPanels(panels === 'right' ? 'none' : 'right')}>ℹ</button>
          </span>
        </div>
      </header>
      <LeftPanel />
      <main className="stage">
        <Canvas />
        {view === 'preview' && (
          <Suspense fallback={<div className="overlay-msg">Önizleme yükleniyor…</div>}>
            <Preview />
          </Suspense>
        )}
        {busy && <div className="overlay-msg">{busy}</div>}
      </main>
      <RightPanel />
    </div>
  );
}

function slug(s: string): string {
  return (
    s
      .toLocaleLowerCase('tr')
      .replace(/ı/g, 'i')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'tabela'
  );
}
