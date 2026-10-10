import * as THREE from 'three';
import type { LightEngine } from './lightEngine';

export type Wall = 'plaster' | 'dark' | 'brick' | 'grass' | 'white' | 'photo';

export interface PreviewParams {
  /** ambient light on the wall, 0.01 (night) .. 1 (day) */
  ambient: number;
  /** extra exposure in EV */
  ev: number;
  /** fraction of the strip's light that reaches the wall */
  spill: number;
  /** near glow / bloom amount */
  glow: number;
  tone: 'camera' | 'eye';
  wall: Wall;
  standoff: number;
}

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
uniform vec4 uView;   // x0, y0, w, h (mm, y down)
uniform vec4 uGrid;   // x0, y0, w, h
varying vec2 vUv;
vec2 worldPos() { return vec2(uView.x + vUv.x * uView.z, uView.y + (1.0 - vUv.y) * uView.w); }
vec2 gridUv(vec2 p) { return vec2((p.x - uGrid.x) / uGrid.z, (uGrid.y + uGrid.w - p.y) / uGrid.w); }
bool inGrid(vec2 g) { return g.x >= 0.0 && g.x <= 1.0 && g.y >= 0.0 && g.y <= 1.0; }
`;

const BG_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tWall;
uniform sampler2D tPhoto;
uniform vec4 uPhoto;      // x0, y0, w, h in mm
uniform float uHasPhoto;
uniform float uAmbient;
uniform float uSpill;
uniform float uShadow;
uniform float uShadowOffset;
uniform int uWallMode;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { return 0.55 * noise(p) + 0.3 * noise(p * 2.03) + 0.15 * noise(p * 4.1); }

vec3 albedo(vec2 p) {
  if (uWallMode == 5 && uHasPhoto > 0.5) {
    vec2 q = (p - uPhoto.xy) / uPhoto.zw;
    if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) return texture2D(tPhoto, vec2(q.x, 1.0 - q.y)).rgb;
    return vec3(0.25);
  }
  if (uWallMode == 1) return vec3(0.045, 0.045, 0.05) * (0.85 + 0.3 * fbm(p * 0.08));
  if (uWallMode == 2) {
    float row = floor(p.y / 75.0);
    float x = p.x + mod(row, 2.0) * 112.5;
    vec2 cell = vec2(floor(x / 225.0), row);
    vec2 l = vec2(mod(x, 225.0), mod(p.y, 75.0));
    float mortar = (l.x < 10.0 || l.y < 10.0) ? 1.0 : 0.0;
    vec3 brick = vec3(0.36, 0.12, 0.07) * (0.7 + 0.6 * hash(cell)) * (0.85 + 0.3 * fbm(p * 0.25));
    vec3 m = vec3(0.40, 0.38, 0.35) * (0.85 + 0.3 * noise(p * 0.7));
    return mix(brick, m, mortar);
  }
  if (uWallMode == 3) {
    // artificial grass wall: dark base with bright blade tips at ~3 mm scale
    float n = fbm(p * 0.42) * 0.65 + noise(p * 1.7 + 13.0) * 0.35;
    float tips = smoothstep(0.55, 0.85, n);
    return mix(vec3(0.035, 0.085, 0.025), vec3(0.15, 0.31, 0.08), tips) * (0.8 + 0.4 * noise(p * 0.03));
  }
  if (uWallMode == 4) return vec3(0.78, 0.77, 0.74) * (0.95 + 0.05 * fbm(p * 0.1));
  return vec3(0.33, 0.32, 0.30) * (0.9 + 0.1 * fbm(p * 0.06)) * (0.97 + 0.03 * noise(p * 0.9));
}

void main() {
  vec2 p = worldPos();
  vec2 g = gridUv(p);
  vec4 wall = inGrid(g) ? texture2D(tWall, g) : vec4(0.0);
  vec2 gs = gridUv(p - vec2(0.0, uShadowOffset));
  float shadow = inGrid(gs) ? clamp(texture2D(tWall, gs).a * 1.6, 0.0, 1.0) : 0.0;
  vec3 a = albedo(p);
  vec3 col = a * uAmbient * (1.0 - uShadow * shadow) + a * wall.rgb * uSpill;
  gl_FragColor = vec4(col, 1.0);
}
`;

const GLOW_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tGlow;
uniform float uGlow;
void main() {
  vec2 g = gridUv(worldPos());
  vec3 c = inGrid(g) ? texture2D(tGlow, g).rgb : vec3(0.0);
  gl_FragColor = vec4(c * uGlow, 1.0);
}
`;

const TONE_FRAG = /* glsl */ `
uniform sampler2D tHdr;
uniform float uExposure;
uniform int uTone;
varying vec2 vUv;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec3 c = texture2D(tHdr, vUv).rgb * uExposure;
  if (uTone == 0) {
    // camera: sensor channel crosstalk makes saturated highlights burn towards white
    mat3 C = mat3(0.84, 0.12, 0.04, 0.12, 0.72, 0.16, 0.04, 0.16, 0.80);
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c, C * c, clamp(lum * 0.35, 0.0, 1.0));
    c = aces(c);
  } else {
    // eye: mostly hue preserving (tone map the max channel) so colours stay saturated,
    // with a little per-channel roll-off for a lighter core
    float m = max(max(c.r, c.g), c.b);
    vec3 hp = c * (aces(vec3(m)).r / max(m, 1e-5));
    c = mix(hp, aces(c), 0.22);
  }
  gl_FragColor = vec4(toSrgb(c), 1.0);
}
`;

export class PreviewRenderer {
  private hdr: THREE.WebGLRenderTarget | null = null;
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private viewCam = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
  private stripScene = new THREE.Scene();
  private stripMesh: THREE.Mesh | null = null;
  private photo: THREE.Texture | null = null;
  photoRect = new THREE.Vector4(0, 0, 1000, 700);
  private bgMat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  private toneMat: THREE.ShaderMaterial;

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    readonly engine: LightEngine,
  ) {
    const common = { uView: { value: new THREE.Vector4() }, uGrid: { value: new THREE.Vector4() } };
    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: BG_FRAG,
      uniforms: {
        ...common,
        tWall: { value: null },
        tPhoto: { value: null },
        uPhoto: { value: this.photoRect },
        uHasPhoto: { value: 0 },
        uAmbient: { value: 0.05 },
        uSpill: { value: 0.5 },
        uShadow: { value: 0.5 },
        uShadowOffset: { value: 10 },
        uWallMode: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: { uView: common.uView, uGrid: common.uGrid, tGlow: { value: null }, uGlow: { value: 1 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.toneMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: TONE_FRAG,
      uniforms: { tHdr: { value: null }, uExposure: { value: 1 }, uTone: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat);
    this.quad.frustumCulled = false;
    this.fsScene.add(this.quad);
  }

  setPhoto(img: HTMLImageElement | ImageBitmap | null, widthMm: number, x0: number, y0: number): void {
    this.photo?.dispose();
    this.photo = null;
    if (!img) return;
    const tex = new THREE.Texture(img as HTMLImageElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.photo = tex;
    const aspect = img.height / img.width;
    this.photoRect.set(x0, y0, widthMm, widthMm * aspect);
  }

  /** Rebuild strip mesh reference after the engine got a new plan. */
  syncGeometry(): void {
    if (this.stripMesh) this.stripScene.remove(this.stripMesh);
    this.stripMesh = null;
    if (this.engine.geometry) {
      this.stripMesh = new THREE.Mesh(this.engine.geometry, this.engine.stripMat);
      this.stripMesh.frustumCulled = false;
      this.stripScene.add(this.stripMesh);
    }
  }

  private fs(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  /** Render the composite for a view rect (mm) into the canvas (w x h device pixels). */
  render(view: { x0: number; y0: number; w: number; h: number }, w: number, h: number, p: PreviewParams): void {
    const r = this.renderer;
    if (!this.hdr || this.hdr.width !== w || this.hdr.height !== h) {
      this.hdr?.dispose();
      this.hdr = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        samples: 4,
      });
    }
    const g = this.engine.grid;
    const vu = this.bgMat.uniforms.uView.value as THREE.Vector4;
    vu.set(view.x0, view.y0, view.w, view.h);
    const gu = this.bgMat.uniforms.uGrid.value as THREE.Vector4;
    if (g) gu.set(g.x0, g.y0, g.w, g.h);
    else gu.set(0, 0, 1e-6, 1e-6);
    const day = Math.min(1, Math.max(0, (Math.log10(p.ambient) + 2) / 2));
    const b = this.bgMat.uniforms;
    b.tWall.value = this.engine.wallTex;
    b.tPhoto.value = this.photo;
    b.uHasPhoto.value = this.photo ? 1 : 0;
    b.uAmbient.value = p.ambient;
    b.uSpill.value = p.spill;
    b.uShadow.value = 0.55 * day;
    b.uShadowOffset.value = p.standoff * 0.5;
    b.uWallMode.value = ['plaster', 'dark', 'brick', 'grass', 'white', 'photo'].indexOf(p.wall);
    this.fs(this.bgMat, this.hdr);

    // crisp strips on top (radiance incl. jacket in daylight)
    if (this.stripMesh) {
      this.viewCam.left = view.x0;
      this.viewCam.right = view.x0 + view.w;
      this.viewCam.top = -view.y0;
      this.viewCam.bottom = -(view.y0 + view.h);
      this.viewCam.updateProjectionMatrix();
      const su = this.engine.stripMat.uniforms;
      su.uMode.value = 1;
      su.uAmbient.value = p.ambient;
      r.setRenderTarget(this.hdr);
      r.render(this.stripScene, this.viewCam);
      su.uMode.value = 0;
    }
    this.glowMat.uniforms.tGlow.value = this.engine.glowTex;
    this.glowMat.uniforms.uGlow.value = p.glow;
    if (this.engine.glowTex) this.fs(this.glowMat, this.hdr);

    // simulated auto exposure: the camera meters the wall, so dark scenes get exposed up and
    // the neon burns harder
    const meanAlbedo = { plaster: 0.32, dark: 0.05, brick: 0.25, grass: 0.1, white: 0.76, photo: 0.3 }[p.wall];
    const auto = 0.18 / (meanAlbedo * p.ambient + 0.012);
    this.toneMat.uniforms.tHdr.value = this.hdr.texture;
    this.toneMat.uniforms.uExposure.value = Math.min(4, Math.max(0.25, auto)) * Math.pow(2, p.ev);
    this.toneMat.uniforms.uTone.value = p.tone === 'camera' ? 0 : 1;
    this.fs(this.toneMat, null);
  }

  dispose(): void {
    this.hdr?.dispose();
    this.photo?.dispose();
    this.bgMat.dispose();
    this.glowMat.dispose();
    this.toneMat.dispose();
  }
}
