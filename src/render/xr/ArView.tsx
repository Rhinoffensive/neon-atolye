import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../app/store';
import { scaleDoc } from '../../app/RightPanel';
import { fmtCm } from '../../app/geomUi';
import type { ArMode, ArScene } from './arScene';

type ArModule = typeof import('./arScene');
let modPromise: Promise<ArModule> | null = null;
const loadAr = () => (modPromise ??= import('./arScene'));

async function arSupported(): Promise<boolean> {
  try {
    return !!(await navigator.xr?.isSessionSupported('immersive-ar'));
  } catch {
    return false;
  }
}

/**
 * "AR" button + the DOM overlay shown inside the immersive-ar session.
 * Two modes: 🎯 the sign floats in front of the camera (no surface tracking needed), or
 * 📍 it is placed on a wall found by hit-testing. Works on Android Chrome with ARCore.
 */
export function ArButton() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('');
  const [params, setParams] = useState({ on: 1, brightness: 1, exposure: 1.4, wallGain: 0.18, glow: 1, room: 0.25 });
  const [mode, setMode] = useState<ArMode>('follow');
  const [pinned, setPinned] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [canWall, setCanWall] = useState(true);
  const [distance, setDistance] = useState(1.5);
  const [tune, setTune] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ArScene | null>(null);
  const plan = useStore((s) => s.plan);
  const profiles = useStore((s) => s.doc.profiles);
  const standoff = useStore((s) => s.doc.settings.standoff);
  const update = useStore((s) => s.update);

  const modRef = useRef<ArModule | null>(null);
  useEffect(() => {
    arSupported().then((ok) => {
      setSupported(ok);
      // warm the module so the tap can start the session right away (user activation is short)
      if (ok) loadAr().then((m) => (modRef.current = m));
    });
  }, []);

  // taps on the overlay's buttons must not also count as a tap on the scene
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener('beforexrselect', stop);
    return () => el.removeEventListener('beforexrselect', stop);
  }, []);

  // re-plan while in AR (e.g. size changes) -> rebuild meshes and light
  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc || !active) return;
    sc.setPlan(plan, new Map(profiles.map((p) => [p.id, p])), standoff);
  }, [plan, profiles, standoff, active]);

  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc) return;
    sc.params = { ...sc.params, ...params };
    sc.applyParams();
  }, [params]);

  const start = async () => {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    const mod = modRef.current ?? (await loadAr());
    overlay.style.display = 'flex';
    const sc = new mod.ArScene(canvas);
    sc.params = { ...sc.params, ...params };
    sc.distance = distance;
    sc.onStatus = setStatus;
    sc.onState = () => {
      setMode(sc.mode);
      setPinned(sc.pinned);
      setPlaced(sc.placed);
      setCanWall(sc.canHitTest);
    };
    sc.onEnd = () => {
      setActive(false);
      overlay.style.display = 'none';
      sc.dispose();
      sceneRef.current = null;
    };
    sc.setPlan(plan, new Map(profiles.map((p) => [p.id, p])), standoff);
    sceneRef.current = sc;
    // must run inside the click (user activation)
    sc.start(overlay)
      .then(() => setActive(true))
      .catch((e) => {
        overlay.style.display = 'none';
        sc.dispose();
        sceneRef.current = null;
        alert('AR başlatılamadı: ' + (e?.message ?? e));
      });
  };

  const b = plan?.bounds;
  const size = b && Number.isFinite(b.minX) ? `${fmtCm(b.maxX - b.minX)} × ${fmtCm(b.maxY - b.minY)}` : '';
  const scale = (k: number) => update((d) => scaleDoc(d, k), 'ar-scale');
  const set = (k: keyof typeof params, v: number) => setParams((p) => ({ ...p, [k]: v }));
  const sc = () => sceneRef.current;

  return (
    <>
      <button
        className="ar-btn"
        disabled={!supported}
        title={supported ? 'Telefonda gerçek boyutta gör' : 'AR için Android telefonda Chrome (ARCore) gerekiyor'}
        onClick={start}
      >
        📱 AR
      </button>
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <div ref={overlayRef} className="ar-overlay" style={{ display: 'none' }}>
        <div className="ar-top">
          <span className="ar-status">{status}</span>
          <button onClick={() => sc()?.end()}>✕ Çık</button>
        </div>
        <div className="ar-bottom">
          <div className="row">
            <div className="seg">
              <button className={mode === 'follow' ? 'on' : ''} onClick={() => sc()?.setMode('follow')}>
                🎯 Ekranda
              </button>
              <button className={mode === 'wall' ? 'on' : ''} disabled={!canWall} onClick={() => sc()?.setMode('wall')}>
                📍 Duvarda
              </button>
            </div>
            <button className={params.on ? 'on' : ''} title="Aç / kapat" onClick={() => set('on', params.on ? 0 : 1)}>
              {params.on ? '●' : '○'}
            </button>
            <button className={tune ? 'on' : ''} title="Işık ayarları" onClick={() => setTune(!tune)}>
              ⚙
            </button>
          </div>
          {mode === 'follow' ? (
            <div className="row">
              <button className={pinned ? 'on' : ''} onClick={() => sc()?.togglePin()}>
                {pinned ? '🔓 Bırak' : '📌 Sabitle'}
              </button>
              <input
                className="grow"
                type="range"
                min={0.4}
                max={4}
                step={0.1}
                value={distance}
                aria-label="Mesafe"
                onChange={(e) => {
                  setDistance(+e.target.value);
                  sc()?.setDistance(+e.target.value);
                }}
              />
              <span className="ar-size">{distance.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} m</span>
            </div>
          ) : (
            placed && (
              <div className="row">
                <button onClick={() => sc()?.unplace()}>↺ Yeniden yerleştir</button>
              </div>
            )
          )}
          <div className="row">
            <button onClick={() => scale(1 / 1.1)}>−</button>
            <span className="ar-size">{size}</span>
            <button onClick={() => scale(1.1)}>＋</button>
          </div>
          {tune && (
            <>
              <label>
                Parlaklık
                <input type="range" min={0.2} max={3} step={0.01} value={params.brightness} onChange={(e) => set('brightness', +e.target.value)} />
              </label>
              <label>
                Pozlama
                <input type="range" min={0.3} max={4} step={0.01} value={params.exposure} onChange={(e) => set('exposure', +e.target.value)} />
              </label>
              <label>
                Hale
                <input type="range" min={0} max={0.8} step={0.01} value={params.wallGain} onChange={(e) => set('wallGain', +e.target.value)} />
              </label>
            </>
          )}
        </div>
      </div>
    </>
  );
}
