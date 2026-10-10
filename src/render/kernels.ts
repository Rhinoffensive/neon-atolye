/**
 * Fit non-negative weights w_i so that sum_i w_i * G(sigma_i) approximates the irradiance a strip
 * at height h above a wall produces: the Poisson kernel K_h(r) = h / (2 pi (h^2 + r^2)^1.5),
 * damped beyond ~tail*h. Gaussians are normalised 2D kernels, so the weights carry the energy.
 */
export function fitPoissonWeights(h: number, sigmas: number[], tail = 3): number[] {
  const R = 8 * h + 3 * Math.max(...sigmas);
  const N = 160;
  const rows: number[][] = [];
  const target: number[] = [];
  for (let k = 0; k < N; k++) {
    const r = (R * (k + 0.5)) / N;
    const wgt = Math.sqrt(r); // area weighting (2 pi r dr), softened
    // the strip throws most light forward; only side light reaches the wall, so the far
    // tail of the isotropic kernel is damped
    const K = (h / (2 * Math.PI * Math.pow(h * h + r * r, 1.5))) * Math.exp(-r / (tail * h));
    target.push(K * r * wgt);
    rows.push(sigmas.map((s) => (Math.exp((-r * r) / (2 * s * s)) / (2 * Math.PI * s * s)) * r * wgt));
  }
  return nnls(rows, target, 600);
}

/** Tiny projected-gradient non-negative least squares. */
function nnls(A: number[][], b: number[], iters: number): number[] {
  const n = A[0].length;
  const AtA = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => A.reduce((s, row) => s + row[i] * row[j], 0)));
  const Atb = Array.from({ length: n }, (_, i) => A.reduce((s, row, k) => s + row[i] * b[k], 0));
  // step = 1 / largest eigenvalue (power iteration)
  let v = new Array(n).fill(1);
  let lam = 1;
  for (let it = 0; it < 40; it++) {
    const w = AtA.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
    lam = Math.hypot(...w);
    v = w.map((x) => x / (lam || 1));
  }
  const step = 1 / (lam || 1);
  let x = new Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const g = AtA.map((row, i) => row.reduce((s, a, j) => s + a * x[j], 0) - Atb[i]);
    x = x.map((xi, i) => Math.max(0, xi - step * g[i]));
  }
  return x;
}

export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return [c[0], c[1], c[2]];
}

/** Emission colour: linear chroma with the brightest channel at 1. */
export function emissionColor(hex: string): [number, number, number] {
  const c = hexToLinear(hex);
  const m = Math.max(...c, 1e-4);
  return [c[0] / m, c[1] / m, c[2] / m];
}
