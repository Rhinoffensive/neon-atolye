import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore } from '../app/store';
import { LightEngine } from './lightEngine';
import { PreviewRenderer, type PreviewParams, type Wall } from './previewRenderer';

const WALLS: { id: Wall; label: string }[] = [
  { id: 'plaster', label: 'Sıva' },
  { id: 'dark', label: 'Koyu' },
  { id: 'brick', label: 'Tuğla' },
  { id: 'grass', label: 'Çim duvar' },
  { id: 'white', label: 'Beyaz' },
  { id: 'photo', label: 'Fotoğraf…' },
];

const PARAMS_KEY = 'neon-atolye-preview-v2';
function loadParams(): PreviewParams & { brightness: number } {
  const def = { ambient: 0.03, ev: 0, spill: 0.35, glow: 1, tone: 'camera' as const, wall: 'grass' as Wall, standoff: 20, brightness: 1 };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(PARAMS_KEY) ?? '{}') };
  } catch {
    return def;
  }
}

export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const plan = useStore((s) => s.plan);
  const profiles = useStore((s) => s.doc.profiles);
  const standoff = useStore((s) => s.doc.settings.standoff);
  const cam = useStore((s) => s.cam);
  const [params, setParams] = useState(loadParams);
  const [on, setOn] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const ctx = useRef<{ renderer: THREE.WebGLRenderer; engine: LightEngine; preview: PreviewRenderer } | null>(null);
  const anim = useRef<{ t0: number; raf: number } | null>(null);
  const frame = useRef({ time: 0, flicker: 0 });
  const [photoW, setPhotoW] = useState(1200);
  const [collapsed, setCollapsed] = useState(false);
  const photoRef = useRef<ImageBitmap | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
    } catch {
      /* ignore */
    }
  }, [params]);

  // init WebGL
  useEffect(() => {
    const canvas = canvasRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    } catch (e) {
      setErr('WebGL2 açılamadı: ' + e);
      return;
    }
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const engine = new LightEngine(renderer);
    const preview = new PreviewRenderer(renderer, engine);
    ctx.current = { renderer, engine, preview };
    return () => {
      if (anim.current) cancelAnimationFrame(anim.current.raf);
      preview.dispose();
      engine.dispose();
      renderer.dispose();
      ctx.current = null;
    };
  }, []);

  const draw = () => {
    const c = ctx.current;
    const canvas = canvasRef.current;
    if (!c || !canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) c.renderer.setSize(w, h, false);
    const cm = useStore.getState().cam;
    const view = {
      x0: cm.cx - (canvas.clientWidth * cm.mmPerPx) / 2,
      y0: cm.cy - (canvas.clientHeight * cm.mmPerPx) / 2,
      w: canvas.clientWidth * cm.mmPerPx,
      h: canvas.clientHeight * cm.mmPerPx,
    };
    c.engine.render({ on, brightness: params.brightness, time: frame.current.time, flicker: frame.current.flicker });
    c.preview.render(view, w, h, { ...params, standoff });
  };

  // plan / profile changes rebuild geometry
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.engine.setPlan(plan, new Map(profiles.map((p) => [p.id, p])), standoff);
    c.preview.syncGeometry();
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, profiles, standoff]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam, params, on]);

  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ignite = () => {
    if (anim.current) cancelAnimationFrame(anim.current.raf);
    const t0 = performance.now();
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      const dur = 1.4;
      frame.current.time = t;
      frame.current.flicker = t < dur ? 1 - Math.pow(t / dur, 3) : 0;
      setOn(t < 0.08 ? 0 : 1);
      draw();
      if (t < dur) anim.current = { t0, raf: requestAnimationFrame(step) };
      else anim.current = null;
    };
    anim.current = { t0, raf: requestAnimationFrame(step) };
  };

  const savePng = () => {
    draw();
    canvasRef.current?.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `${useStore.getState().doc.name || 'tabela'}-onizleme.png`;
      a.click();
    }, 'image/png');
  };

  const placePhoto = (bmp: ImageBitmap, wmm: number) => {
    const b = useStore.getState().plan?.bounds;
    const cx = b ? (b.minX + b.maxX) / 2 : 0;
    const cy = b ? (b.minY + b.maxY) / 2 : 0;
    ctx.current?.preview.setPhoto(bmp, wmm, cx - wmm / 2, cy - (wmm * bmp.height) / bmp.width / 2);
  };
  const onPhoto = async (f: File) => {
    const bmp = await createImageBitmap(f);
    photoRef.current = bmp;
    placePhoto(bmp, photoW);
    setParams((p) => ({ ...p, wall: 'photo' }));
    draw();
  };
  useEffect(() => {
    if (photoRef.current) {
      placePhoto(photoRef.current, photoW);
      draw();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoW]);

  const set = <K extends keyof (PreviewParams & { brightness: number })>(k: K, v: (PreviewParams & { brightness: number })[K]) =>
    setParams((p) => ({ ...p, [k]: v }));
  const nightDay = Math.log10(params.ambient) + 2; // 0..2

  return (
    <>
      <canvas ref={canvasRef} className="preview-canvas" />
      {err && <div className="overlay-msg">{err}</div>}
      <div className={`preview-panel ${collapsed ? 'collapsed' : ''}`}>
        <div className="row">
          <button className="icon" title={collapsed ? 'Ayarları aç' : 'Ayarları gizle'} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? '☰' : '▾'}
          </button>
          <button className={on ? 'on' : ''} onClick={() => setOn(on ? 0 : 1)}>
            {on ? '● Açık' : '○ Kapalı'}
          </button>
          <button onClick={ignite}>⚡ Yak</button>
          <button onClick={savePng}>⬇ PNG</button>
        </div>
        <label>
          <span>Gece ↔ Gündüz</span>
          <input type="range" min={0} max={2} step={0.01} value={nightDay} onChange={(e) => set('ambient', Math.pow(10, +e.target.value - 2))} />
        </label>
        <label>
          <span>Parlaklık</span>
          <input type="range" min={0.1} max={3} step={0.01} value={params.brightness} onChange={(e) => set('brightness', +e.target.value)} />
        </label>
        <label>
          <span>Pozlama</span>
          <input type="range" min={-3} max={3} step={0.05} value={params.ev} onChange={(e) => set('ev', +e.target.value)} />
        </label>
        <label>
          <span>Duvara vuran ışık</span>
          <input type="range" min={0} max={1.5} step={0.01} value={params.spill} onChange={(e) => set('spill', +e.target.value)} />
        </label>
        <label>
          <span>Hale / parlama</span>
          <input type="range" min={0} max={3} step={0.01} value={params.glow} onChange={(e) => set('glow', +e.target.value)} />
        </label>
        <div className="row">
          <span className="muted small">Görünüm</span>
          <button className={params.tone === 'camera' ? 'on' : ''} onClick={() => set('tone', 'camera')} title="Telefon kamerası: parlak yerler beyaza yanar">
            Kamera
          </button>
          <button className={params.tone === 'eye' ? 'on' : ''} onClick={() => set('tone', 'eye')} title="Göz: renkler doygun kalır">
            Göz
          </button>
        </div>
        <div className="row wrap">
          {WALLS.map((w) => (
            <button
              key={w.id}
              className={params.wall === w.id ? 'on' : ''}
              onClick={() => (w.id === 'photo' ? fileRef.current?.click() : set('wall', w.id))}
            >
              {w.label}
            </button>
          ))}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onPhoto(f);
            }}
          />
        </div>
        {params.wall === 'photo' && (
          <label>
            <span>Fotoğraf genişliği: {Math.round(photoW / 10)} cm</span>
            <input type="range" min={300} max={6000} step={10} value={photoW} onChange={(e) => setPhotoW(+e.target.value)} />
          </label>
        )}
        <p className="muted small">Duvar mesafesi (hale yayılması) Plan ayarlarında: {standoff} mm.</p>
      </div>
    </>
  );
}
