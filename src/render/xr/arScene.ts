import * as THREE from 'three';
import type { PlanResult, StripProfile } from '../../core/model/types';
import { LightEngine, STRIP_VERT } from '../lightEngine';

/**
 * WebXR immersive-ar scene (Android Chrome + ARCore). The sign is placed on a wall found by
 * hit-testing and held by an anchor. Real scale comes for free: WebXR works in metres.
 *
 * Rendering (v1, works on every ARCore device): the camera image is composited by the system,
 * so we ADD light on top of it (premultiplied output with alpha 0): wall light + glow quads
 * and the strip faces (opaque).
 */

const MM = 0.001;

const TONE = /* glsl */ `
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
`;

const STRIP_AR_FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uOn;
uniform float uExposure;
uniform float uRoom;
varying float vS;
varying float vU;
varying vec3 vColor;
varying vec4 vLed;
varying vec3 vJacket;
varying float vPid;
${TONE}
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
  float across = exp(-0.7 * pow(abs(vU), 4.0));
  vec3 E = vColor * uIntensity * uOn * ledField(vS) * across;
  float dome = 0.72 + 0.28 * sqrt(max(0.0, 1.0 - vU * vU));
  vec3 c = (vJacket * uRoom * dome + E) * uExposure;
  mat3 C = mat3(0.84, 0.12, 0.04, 0.12, 0.72, 0.16, 0.04, 0.16, 0.80);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, C * c, clamp(lum * 0.35, 0.0, 1.0));
  gl_FragColor = vec4(toSrgb(aces(c)), 1.0);
}
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const LIGHT_FRAG = /* glsl */ `
uniform sampler2D tLight;
uniform float uGain;
uniform float uExposure;
varying vec2 vUv;
${TONE}
void main() {
  vec3 L = texture2D(tLight, vUv).rgb * uGain * uExposure;
  // additive light: rgb is added to the camera image, alpha 0 keeps the camera visible
  gl_FragColor = vec4(toSrgb(aces(L)), 0.0);
}
`;

function additive(mat: THREE.ShaderMaterial): THREE.ShaderMaterial {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  return mat;
}

export type ArMode = 'follow' | 'wall';
const ONE = new THREE.Vector3(1, 1, 1);

export interface ArParams {
  on: number;
  brightness: number;
  /** assumed wall albedo * spill */
  wallGain: number;
  glow: number;
  exposure: number;
  /** room light on the jacket (0 = dark) */
  room: number;
}

export class ArScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.01, 50);
  readonly engine: LightEngine;
  private signRoot = new THREE.Group();
  private signContent = new THREE.Group();
  private reticle: THREE.Mesh;
  private stripMat: THREE.ShaderMaterial;
  private wallMat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  private session: XRSession | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private hitSource: XRHitTestSource | null = null;
  private lastHitAt = 0;
  private searching = false;
  /** wall mode: a tap asks to place; done inside the next XR frame (hit results and anchors
   *  are only valid in the frame they belong to) */
  private placeRequested = false;
  private anchor: XRAnchor | null = null;
  /** sign pose relative to its anchor, fixed at placement time */
  private anchorOffset: THREE.Matrix4 | null = null;
  private lockedMatrix: THREE.Matrix4 | null = null;
  private smoothPos = new THREE.Vector3();
  private smoothQuat = new THREE.Quaternion();
  private hasSmooth = false;
  /** 'follow': the sign floats in front of the camera; 'wall': placed on a detected surface */
  mode: ArMode = 'follow';
  /** follow mode: frozen where it was when the user tapped */
  pinned = false;
  /** follow mode: distance in front of the camera (m) */
  distance = 1.5;
  placed = false;
  canHitTest = false;
  signHeightM = 0.2;
  onStatus: (s: string) => void = () => {};
  onEnd: () => void = () => {};
  onState: () => void = () => {};
  params: ArParams = { on: 1, brightness: 1, wallGain: 0.18, glow: 1, exposure: 1.4, room: 0.25 };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.xr.enabled = true;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.engine = new LightEngine(this.renderer);
    this.stripMat = new THREE.ShaderMaterial({
      vertexShader: STRIP_VERT,
      fragmentShader: STRIP_AR_FRAG,
      uniforms: {
        uIntensity: { value: 10 },
        uOn: { value: 1 },
        uExposure: { value: 1.4 },
        uRoom: { value: 0.25 },
      },
      side: THREE.DoubleSide,
    });
    const lightMat = () =>
      additive(
        new THREE.ShaderMaterial({
          vertexShader: QUAD_VERT,
          fragmentShader: LIGHT_FRAG,
          uniforms: { tLight: { value: null }, uGain: { value: 1 }, uExposure: { value: 1.4 } },
          side: THREE.DoubleSide,
        }),
      );
    this.wallMat = lightMat();
    this.glowMat = lightMat();
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);
    this.signRoot.matrixAutoUpdate = false;
    this.signRoot.visible = false;
    this.signRoot.add(this.signContent);
    this.scene.add(this.signRoot);
  }

  /** Build meshes for a plan (call again whenever the plan changes). */
  setPlan(plan: PlanResult | null, profiles: Map<string, StripProfile>, standoff: number): void {
    this.signContent.clear();
    // three.js swaps in the XR camera for every render while presenting, even into render
    // targets; the light passes need their own cameras, so XR is switched off around them
    const xrOn = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;
    try {
      this.engine.setPlan(plan, profiles, standoff, 768);
      if (plan && this.engine.geometry && this.engine.grid)
        this.engine.render({ on: 1, brightness: 1, time: 0, flicker: 0 });
    } finally {
      this.renderer.xr.enabled = xrOn;
    }
    if (!plan || !this.engine.geometry || !this.engine.grid) return;
    const b = plan.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    this.signHeightM = (b.maxY - b.minY) * MM;
    const g = this.engine.grid;
    const face = (standoff + 12) * MM; // strip face distance from the wall
    // wall light lies on the wall plane (z = 0), glow sits at the strip face
    const quad = (mat: THREE.ShaderMaterial, z: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(g.w * MM, g.h * MM), mat);
      m.position.set((g.x0 + g.w / 2 - cx) * MM, -(g.y0 + g.h / 2 - cy) * MM, z);
      m.renderOrder = z === 0 ? 0 : 2;
      return m;
    };
    this.wallMat.uniforms.tLight.value = this.engine.wallTex;
    this.glowMat.uniforms.tLight.value = this.engine.glowTex;
    this.signContent.add(quad(this.wallMat, 0));
    const strips = new THREE.Mesh(this.engine.geometry, this.stripMat);
    strips.scale.setScalar(MM);
    strips.position.set(-cx * MM, cy * MM, face);
    strips.renderOrder = 1;
    strips.frustumCulled = false;
    this.signContent.add(strips);
    this.signContent.add(quad(this.glowMat, face + 0.001));
    this.applyParams();
  }

  applyParams(): void {
    const p = this.params;
    this.stripMat.uniforms.uIntensity.value = 10 * p.brightness;
    this.stripMat.uniforms.uOn.value = p.on;
    this.stripMat.uniforms.uExposure.value = p.exposure;
    this.stripMat.uniforms.uRoom.value = p.room;
    this.wallMat.uniforms.uGain.value = p.wallGain * p.on * p.brightness;
    this.wallMat.uniforms.uExposure.value = p.exposure;
    this.glowMat.uniforms.uGain.value = p.glow * p.on * p.brightness;
    this.glowMat.uniforms.uExposure.value = p.exposure;
  }

  async start(overlay: HTMLElement): Promise<void> {
    const xr = navigator.xr;
    if (!xr) throw new Error('Bu tarayıcıda WebXR yok.');
    // hit-test is only needed for wall placement; the camera-follow mode works without it
    const session = await xr.requestSession('immersive-ar', {
      optionalFeatures: ['hit-test', 'anchors', 'dom-overlay'],
      domOverlay: { root: overlay },
    } as XRSessionInit);
    this.session = session;
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);
    this.refSpace = this.renderer.xr.getReferenceSpace();
    try {
      const viewer = await session.requestReferenceSpace('viewer');
      this.hitSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    } catch {
      this.hitSource = null;
    }
    this.canHitTest = !!this.hitSource;
    session.addEventListener('select', () => this.tap());
    session.addEventListener('end', () => this.cleanup());
    this.setMode('follow');
    this.renderer.setAnimationLoop((_t, frame) => this.frame(frame));
  }

  setMode(mode: ArMode): void {
    if (mode === 'wall' && !this.canHitTest) {
      this.onStatus('Bu cihazda yüzey bulma (hit-test) yok; tabela ekranda kalacak.');
      mode = 'follow';
    }
    this.mode = mode;
    this.pinned = false;
    this.unplace(false);
    this.hasSmooth = false;
    this.placeRequested = false;
    this.lastHitAt = performance.now();
    this.searching = false;
    this.onStatus(
      mode === 'follow'
        ? `Tabela ${this.distance.toLocaleString('tr-TR')} m önünde, gerçek boyutta. Ekrana dokun: bu noktada sabitlensin.`
        : 'Telefonu duvara doğru tut, halka duvarın üstüne otursun, sonra dokun.',
    );
    this.onState();
  }

  setDistance(m: number): void {
    this.distance = m;
    if (this.mode === 'follow' && !this.pinned) this.onStatus(`Tabela ${m.toLocaleString('tr-TR')} m önünde, gerçek boyutta. Ekrana dokun: bu noktada sabitlensin.`);
  }

  private tap(): void {
    if (this.mode === 'follow') this.togglePin();
    else if (!this.placed) this.placeRequested = true;
  }

  /** Follow mode: freeze the sign where it is now / let it follow the camera again. */
  togglePin(): void {
    this.pinned = !this.pinned;
    this.onStatus(
      this.pinned
        ? 'Bu noktada sabitlendi. Tekrar dokun: yine kamerayla gelsin.'
        : `Tabela ${this.distance.toLocaleString('tr-TR')} m önünde. Ekrana dokun: sabitlensin.`,
    );
    this.onState();
  }

  /**
   * Wall mode, inside an XR frame: lock the sign where the preview is. The anchor is made from
   * this frame's hit (or from the preview pose if the wall was lost for a moment).
   */
  private placeNow(frame: XRFrame, hit: XRHitTestResult | null): void {
    if (!this.refSpace || !this.hasSmooth) return;
    const signM = new THREE.Matrix4().compose(this.smoothPos, this.smoothQuat, ONE);
    let anchorPose: THREE.Matrix4 = signM;
    let anchorPromise: Promise<XRAnchor> | undefined;
    const hitPose = hit?.getPose(this.refSpace);
    const hitWithAnchor = hit as (XRHitTestResult & { createAnchor?: () => Promise<XRAnchor> }) | null;
    if (hitPose && hitWithAnchor?.createAnchor) {
      anchorPose = new THREE.Matrix4().fromArray(hitPose.transform.matrix);
      anchorPromise = hitWithAnchor.createAnchor();
    } else if (frame.createAnchor) {
      const p = this.smoothPos;
      const q = this.smoothQuat;
      anchorPromise = frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), this.refSpace);
    }
    this.lockedMatrix = signM;
    this.anchorOffset = anchorPose.clone().invert().multiply(signM);
    this.placed = true;
    this.placeRequested = false;
    this.reticle.visible = false;
    anchorPromise
      ?.then((a) => {
        if (this.placed) this.anchor = a;
        else a.delete?.();
      })
      .catch(() => {});
    this.onStatus('Duvara yerleştirildi. Yeniden yerleştirmek için butonu kullan.');
    this.onState();
  }

  unplace(announce = true): void {
    this.anchor?.delete?.();
    this.anchor = null;
    this.anchorOffset = null;
    this.lockedMatrix = null;
    this.placed = false;
    this.placeRequested = false;
    this.hasSmooth = false;
    if (announce) this.onStatus('Duvara doğru tut ve dokun.');
    this.onState();
  }

  /** Sign frame from a hit pose: Z = surface normal (towards the viewer), Y = up. */
  private signMatrix(hitPose: THREE.Matrix4): THREE.Matrix4 {
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    hitPose.decompose(pos, q, s);
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    let Z: THREE.Vector3;
    let Y: THREE.Vector3;
    if (Math.abs(n.dot(up)) > 0.7) {
      // floor / table: stand the sign upright, facing the camera, bottom edge on the surface
      const camPos = new THREE.Vector3().setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
      Z = camPos.sub(pos).setY(0).normalize();
      Y = up.clone();
      pos.addScaledVector(up, this.signHeightM / 2 + 0.03);
    } else {
      Z = n.setY(0).normalize();
      Y = up.clone();
    }
    const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
    Y = new THREE.Vector3().crossVectors(Z, X).normalize();
    return new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(pos);
  }

  /** Follow mode: `distance` m straight ahead of the camera, facing it, kept upright. */
  private followMatrix(viewer: THREE.Matrix4): THREE.Matrix4 {
    const pos = new THREE.Vector3().setFromMatrixPosition(viewer);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(viewer);
    const Z = fwd.clone().negate();
    const Y = new THREE.Vector3(0, 1, 0).addScaledVector(Z, -Z.y);
    if (Y.lengthSq() < 1e-6) Y.set(0, 0, -1);
    Y.normalize();
    const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
    Y.crossVectors(Z, X);
    return new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(pos.addScaledVector(fwd, this.distance));
  }

  private frame(frame: XRFrame | undefined): void {
    if (!frame || !this.refSpace) return;
    if (this.mode === 'follow') {
      this.reticle.visible = false;
      if (!this.pinned) {
        const vp = frame.getViewerPose(this.refSpace);
        if (vp) {
          this.signRoot.matrix.copy(this.followMatrix(new THREE.Matrix4().fromArray(vp.transform.matrix)));
          this.signRoot.visible = true;
        }
      }
    } else if (!this.placed && this.hitSource) {
      const hits = frame.getHitTestResults(this.hitSource);
      if (hits.length) {
        this.lastHitAt = performance.now();
        if (this.searching) {
          this.searching = false;
          this.onStatus('Halka duvarın üstünde: yerleştirmek için ekrana dokun.');
        }
        const pose = hits[0].getPose(this.refSpace);
        if (pose) {
          const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
          this.reticle.matrix.copy(m);
          this.reticle.visible = true;
          // low-pass the preview so hit-test noise does not make it jump around
          const tp = new THREE.Vector3();
          const tq = new THREE.Quaternion();
          this.signMatrix(m).decompose(tp, tq, new THREE.Vector3());
          if (!this.hasSmooth || this.smoothPos.distanceTo(tp) > 0.6) {
            this.smoothPos.copy(tp);
            this.smoothQuat.copy(tq);
            this.hasSmooth = true;
          } else {
            this.smoothPos.lerp(tp, 0.2);
            this.smoothQuat.slerp(tq, 0.2);
          }
          this.signRoot.matrix.compose(this.smoothPos, this.smoothQuat, ONE);
          this.signRoot.visible = true;
        }
        if (this.placeRequested) this.placeNow(frame, hits[0]);
      } else {
        this.reticle.visible = false;
        // wall lost for a moment: a tap still pins the sign where the preview is
        if (this.placeRequested) {
          if (this.hasSmooth) this.placeNow(frame, null);
          else this.placeRequested = false;
        }
        if (!this.searching && performance.now() - this.lastHitAt > 1500) {
          this.searching = true;
          this.onStatus('Duvar aranıyor… telefonu yavaşça sağa sola gezdir. Bulamazsa 🎯 Ekranda modunu kullan.');
        }
      }
    } else if (this.placed) {
      if (this.anchor && this.anchorOffset && frame.trackedAnchors?.has(this.anchor)) {
        const pose = frame.getPose(this.anchor.anchorSpace, this.refSpace);
        if (pose) this.lockedMatrix = new THREE.Matrix4().fromArray(pose.transform.matrix).multiply(this.anchorOffset);
      }
      if (this.lockedMatrix) {
        this.signRoot.matrix.copy(this.lockedMatrix);
        this.signRoot.visible = true;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  async end(): Promise<void> {
    await this.session?.end().catch(() => {});
  }

  private cleanup(): void {
    this.renderer.setAnimationLoop(null);
    this.hitSource?.cancel();
    this.hitSource = null;
    this.session = null;
    this.placed = false;
    this.pinned = false;
    this.anchor = null;
    this.anchorOffset = null;
    this.onEnd();
  }

  dispose(): void {
    this.engine.dispose();
    this.stripMat.dispose();
    this.wallMat.dispose();
    this.glowMat.dispose();
    this.renderer.dispose();
  }
}
