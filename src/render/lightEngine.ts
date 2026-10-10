import * as THREE from 'three';
import type { PlanResult, StripProfile } from '../core/model/types';
import { cumLengths, tangentAt } from '../core/geom/polyline';
import { emissionColor, hexToLinear, fitPoissonWeights } from './kernels';

/**
 * Light engine: renders the planned strips into a sign-plane grid (mm), then spreads that light
 * with a dual-Kawase pyramid into two fields:
 *   wall  = irradiance on the wall behind the sign (Poisson kernel, depends on standoff); alpha = soft shadow
 *   glow  = near-field diffuser haze + lens bloom (added on top of everything)
 * The same textures are reused by the desktop preview and the AR view.
 */

export interface LightParams {
  /** 0..1 global switch (animated during ignition) */
  on: number;
  /** face brightness multiplier */
  brightness: number;
  /** seconds, drives ignition flicker */
  time: number;
  /** 0..1 how much pieces flicker (ignition) */
  flicker: number;
}

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const STRIP_VERT = /* glsl */ `
attribute float aS;
attribute float aU;
attribute vec3 aColor;
attribute vec4 aLed;
attribute vec3 aJacket;
attribute float aPid;
varying float vS;
varying float vU;
varying vec3 vColor;
varying vec4 vLed;
varying vec3 vJacket;
varying float vPid;
void main() {
  vS = aS; vU = aU; vColor = aColor; vLed = aLed; vJacket = aJacket; vPid = aPid;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** uMode 0: emission + coverage (grid pass). uMode 1: visible radiance incl. jacket (view pass). */
export const STRIP_FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uOn;
uniform float uTime;
uniform float uFlicker;
uniform float uAmbient;
uniform float uMode;
varying float vS;
varying float vU;
varying vec3 vColor;
varying vec4 vLed;
varying vec3 vJacket;
varying float vPid;

float hash(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }

float ledField(float s) {
  float s0 = vLed.x; float p = vLed.y; float n = vLed.z; float sig = vLed.w;
  float idx = floor((s - s0) / p + 0.5);
  float acc = 0.0;
  for (int k = -3; k <= 3; k++) {
    float i = idx + float(k);
    if (i < 0.0 || i > n - 1.0) continue;
    float d = (s - s0 - i * p) / sig;
    acc += exp(-0.5 * d * d);
  }
  return acc * p / (sig * 2.5066283);
}

void main() {
  // ignition: each piece flickers with its own rhythm before settling
  float t = uTime + hash(vPid) * 0.35;
  float fl = step(0.45, fract(sin(floor(t * 23.0) * 12.9898 + vPid) * 43758.5)) ;
  float on = uOn * mix(1.0, fl, uFlicker);
  float along = ledField(vS);
  float across = exp(-0.7 * pow(abs(vU), 4.0));
  vec3 E = vColor * uIntensity * on * along * across;
  if (uMode < 0.5) { gl_FragColor = vec4(E, 1.0); return; }
  float dome = 0.72 + 0.28 * sqrt(max(0.0, 1.0 - vU * vU));
  gl_FragColor = vec4(vJacket * uAmbient * dome + E, 1.0);
}
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 s = texture2D(tSrc, vUv) * 4.0;
  s += texture2D(tSrc, vUv - uTexel);
  s += texture2D(tSrc, vUv + uTexel);
  s += texture2D(tSrc, vUv + vec2(uTexel.x, -uTexel.y));
  s += texture2D(tSrc, vUv - vec2(uTexel.x, -uTexel.y));
  gl_FragColor = s / 8.0;
}
`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tPrev;
uniform sampler2D tLevel;
uniform vec2 uTexel;
uniform float uW;
uniform float uHasPrev;
varying vec2 vUv;
void main() {
  vec4 s = vec4(0.0);
  if (uHasPrev > 0.5) {
    vec2 h = uTexel * 0.5;
    s += texture2D(tPrev, vUv + vec2(-h.x * 2.0, 0.0));
    s += texture2D(tPrev, vUv + vec2(-h.x, h.y)) * 2.0;
    s += texture2D(tPrev, vUv + vec2(0.0, h.y * 2.0));
    s += texture2D(tPrev, vUv + vec2(h.x, h.y)) * 2.0;
    s += texture2D(tPrev, vUv + vec2(h.x * 2.0, 0.0));
    s += texture2D(tPrev, vUv + vec2(h.x, -h.y)) * 2.0;
    s += texture2D(tPrev, vUv + vec2(0.0, -h.y * 2.0));
    s += texture2D(tPrev, vUv + vec2(-h.x, -h.y)) * 2.0;
    s /= 12.0;
  }
  gl_FragColor = s + uW * texture2D(tLevel, vUv);
}
`;

export interface Grid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  mmPerPx: number;
  pw: number;
  ph: number;
}

function makeRT(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
}

/** Triangle-strip style mesh of all pieces in three.js coordinates (x, -y). */
export function buildStripGeometry(plan: PlanResult, profiles: Map<string, StripProfile>): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const aS: number[] = [];
  const aU: number[] = [];
  const aColor: number[] = [];
  const aLed: number[] = [];
  const aJacket: number[] = [];
  const aPid: number[] = [];
  const index: number[] = [];
  let base = 0;
  plan.pieces.forEach((pc, pid) => {
    const p = profiles.get(pc.profileId);
    if (!p || pc.pts.length < 2) return;
    const cum = cumLengths(pc.pts);
    const hw = p.width / 2;
    const col = emissionColor(p.color);
    const jac = hexToLinear(p.jacketColor);
    const nLed = Math.round((pc.units * p.cutUnit) / p.ledPitch);
    const led = [pc.capStart + p.ledPitch / 2, p.ledPitch, nLed, Math.max(0.5, p.diffusion * p.ledPitch)];
    for (let i = 0; i < pc.pts.length; i++) {
      const c = pc.pts[i];
      const t = tangentAt(pc.pts, cum, cum[i], 0.6);
      const nx = t.y;
      const ny = -t.x;
      for (const side of [1, -1]) {
        pos.push(c.x + nx * hw * side, -(c.y + ny * hw * side), 0);
        aS.push(cum[i]);
        aU.push(side);
        aColor.push(...col);
        aLed.push(...led);
        aJacket.push(...jac);
        aPid.push(pid);
      }
      if (i < pc.pts.length - 1) {
        const a = base + 2 * i;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    base += 2 * pc.pts.length;
  });
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 1));
  g.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(aColor, 3));
  g.setAttribute('aLed', new THREE.Float32BufferAttribute(aLed, 4));
  g.setAttribute('aJacket', new THREE.Float32BufferAttribute(aJacket, 3));
  g.setAttribute('aPid', new THREE.Float32BufferAttribute(aPid, 1));
  g.setIndex(index);
  return g;
}

export function makeStripMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: STRIP_VERT,
    fragmentShader: STRIP_FRAG,
    uniforms: {
      uIntensity: { value: 14 },
      uOn: { value: 1 },
      uTime: { value: 0 },
      uFlicker: { value: 0 },
      uAmbient: { value: 0.05 },
      uMode: { value: 0 },
    },
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
}

export class LightEngine {
  readonly stripMat = makeStripMaterial();
  geometry: THREE.BufferGeometry | null = null;
  grid: Grid | null = null;
  levels: THREE.WebGLRenderTarget[] = [];
  upWall: THREE.WebGLRenderTarget[] = [];
  upGlow: THREE.WebGLRenderTarget[] = [];
  private stripScene = new THREE.Scene();
  private stripMesh: THREE.Mesh | null = null;
  private gridCam = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsQuad: THREE.Mesh;
  private downMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: DOWN_FRAG,
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    depthTest: false,
    depthWrite: false,
  });
  private upMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: UP_FRAG,
    uniforms: {
      tPrev: { value: null },
      tLevel: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uW: { value: 0 },
      uHasPrev: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  wallWeights: number[] = [];
  glowWeights: number[] = [];

  constructor(readonly renderer: THREE.WebGLRenderer) {
    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.downMat);
    this.fsQuad.frustumCulled = false;
    this.fsScene.add(this.fsQuad);
  }

  get wallTex(): THREE.Texture | null {
    return this.upWall[0]?.texture ?? null;
  }
  get glowTex(): THREE.Texture | null {
    return this.upGlow[0]?.texture ?? null;
  }

  /** Rebuild geometry + grid for a new plan. `spreadMm` = largest light reach to keep inside the grid. */
  setPlan(plan: PlanResult | null, profiles: Map<string, StripProfile>, standoff: number, maxPx = 1024): void {
    this.geometry?.dispose();
    this.geometry = plan ? buildStripGeometry(plan, profiles) : null;
    if (this.stripMesh) this.stripScene.remove(this.stripMesh);
    this.stripMesh = null;
    if (!this.geometry || !plan) {
      this.grid = null;
      return;
    }
    this.stripMesh = new THREE.Mesh(this.geometry, this.stripMat);
    this.stripMesh.frustumCulled = false;
    this.stripScene.add(this.stripMesh);
    const b = plan.bounds;
    const h = standoff + 8;
    const margin = Math.max(60, 5 * h);
    const x0 = b.minX - margin;
    const y0 = b.minY - margin;
    const w = b.maxX - b.minX + 2 * margin;
    const hh = b.maxY - b.minY + 2 * margin;
    const mmPerPx = Math.max(0.5, Math.max(w, hh) / maxPx);
    const pw = Math.ceil(w / mmPerPx);
    const ph = Math.ceil(hh / mmPerPx);
    const sameSize = this.grid && this.grid.pw === pw && this.grid.ph === ph;
    this.grid = { x0, y0, w: pw * mmPerPx, h: ph * mmPerPx, mmPerPx, pw, ph };
    if (!sameSize) this.allocate(pw, ph);
    // effective blur of each pyramid level (mm), rough calibration of the dual filter
    const sig = this.levels.map((_, i) => (i === 0 ? 0.45 : 0.62 * Math.pow(2, i)) * mmPerPx);
    // level 0 is the unblurred strip itself; the wall never sees it sharp
    this.wallWeights = [0, ...fitPoissonWeights(h, sig.slice(1))];
    // diffuser haze (~2 mm) + softer halo (~7 mm) + faint lens bloom (~30 mm)
    this.glowWeights = sig.map(() => 0);
    const addGauss = (s: number, w: number) => {
      let best = 0;
      for (let i = 0; i < sig.length; i++) if (Math.abs(Math.log(sig[i] / s)) < Math.abs(Math.log(sig[best] / s))) best = i;
      this.glowWeights[best] += w;
    };
    addGauss(2, 0.5);
    addGauss(6, 0.32);
    addGauss(25, 0.08);
  }

  private allocate(pw: number, ph: number): void {
    for (const rt of [...this.levels, ...this.upWall, ...this.upGlow]) rt.dispose();
    this.levels = [];
    this.upWall = [];
    this.upGlow = [];
    let w = pw;
    let h = ph;
    for (let i = 0; i < 9; i++) {
      this.levels.push(makeRT(w, h));
      this.upWall.push(makeRT(w, h));
      this.upGlow.push(makeRT(w, h));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      if (w < 4 || h < 4) break;
    }
  }

  private fs(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.fsQuad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  /** Emission into the grid + light pyramid. */
  render(p: LightParams): void {
    const g = this.grid;
    if (!g || !this.stripMesh) return;
    const r = this.renderer;
    const prevClear = r.getClearAlpha();
    const prevColor = new THREE.Color();
    r.getClearColor(prevColor);
    r.setClearColor(0x000000, 0);
    this.gridCam.left = g.x0;
    this.gridCam.right = g.x0 + g.w;
    this.gridCam.top = -g.y0;
    this.gridCam.bottom = -(g.y0 + g.h);
    this.gridCam.updateProjectionMatrix();
    const u = this.stripMat.uniforms;
    u.uMode.value = 0;
    u.uIntensity.value = 10 * p.brightness;
    u.uOn.value = p.on;
    u.uTime.value = p.time;
    u.uFlicker.value = p.flicker;
    r.setRenderTarget(this.levels[0]);
    r.clear();
    r.render(this.stripScene, this.gridCam);
    // down chain
    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1];
      this.downMat.uniforms.tSrc.value = src.texture;
      this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.fs(this.downMat, this.levels[i]);
    }
    // up chains
    for (const [chain, weights] of [
      [this.upWall, this.wallWeights],
      [this.upGlow, this.glowWeights],
    ] as const) {
      for (let i = this.levels.length - 1; i >= 0; i--) {
        const um = this.upMat.uniforms;
        um.tLevel.value = this.levels[i].texture;
        um.uW.value = weights[i] ?? 0;
        if (i === this.levels.length - 1) {
          um.uHasPrev.value = 0;
          um.tPrev.value = this.levels[i].texture;
        } else {
          um.uHasPrev.value = 1;
          um.tPrev.value = chain[i + 1].texture;
          um.uTexel.value.set(1 / chain[i + 1].width, 1 / chain[i + 1].height);
        }
        this.fs(this.upMat, chain[i]);
      }
    }
    r.setRenderTarget(null);
    r.setClearColor(prevColor, prevClear);
  }

  dispose(): void {
    for (const rt of [...this.levels, ...this.upWall, ...this.upGlow]) rt.dispose();
    this.geometry?.dispose();
    this.stripMat.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
  }
}
