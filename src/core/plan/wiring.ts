import type { Hole, Piece, PowerInfo, StripProfile, WireEdge } from '../model/types';
import { type Vec, dist } from '../geom/vec';

const RHO_CU = 0.0175; // ohm * mm^2 / m
const GAUGES = [0.14, 0.22, 0.34, 0.5, 0.75, 1.0, 1.5, 2.5];
const PSU_WATTS = [12, 18, 24, 36, 48, 60, 72, 100, 150, 200, 300, 400];

/**
 * Minimum spanning tree (Prim) from the power entry over all feed holes, with the
 * current carried by each edge and a wire cross-section that keeps the voltage drop <= 3 %.
 */
export function planWiring(
  entry: Vec,
  holes: Hole[],
  pieces: Piece[],
  profiles: Map<string, StripProfile>,
): { wires: WireEdge[]; power: PowerInfo } {
  const pieceById = new Map(pieces.map((p) => [p.id, p]));
  const nodes: Vec[] = [entry, ...holes.map((h) => h.at)];
  const load = [0, ...holes.map((h) => {
    const pc = pieceById.get(h.pieceId)!;
    const pr = profiles.get(pc.profileId)!;
    return (pr.wattPerM * pc.units * pr.cutUnit) / 1000 / pr.voltage;
  })];
  const n = nodes.length;
  const parent = new Array<number>(n).fill(-1);
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  best[0] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
    if (u < 0) break;
    inTree[u] = true;
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = dist(nodes[u], nodes[v]);
      if (d < best[v]) {
        best[v] = d;
        parent[v] = u;
      }
    }
  }
  // downstream current: accumulate loads up the tree (children processed before parents)
  const children: number[][] = nodes.map(() => []);
  for (let v = 1; v < n; v++) if (parent[v] >= 0) children[parent[v]].push(v);
  const current = new Array<number>(n).fill(0);
  const order: number[] = [];
  const stack = [0];
  while (stack.length) {
    const v = stack.pop()!;
    order.push(v);
    stack.push(...children[v]);
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const v = order[k];
    current[v] = load[v] + children[v].reduce((a, c) => a + current[c], 0);
  }
  const wires: WireEdge[] = [];
  for (let v = 1; v < n; v++) {
    if (parent[v] < 0) continue;
    wires.push({ a: nodes[parent[v]], b: nodes[v], length: dist(nodes[parent[v]], nodes[v]), current: current[v] });
  }
  const voltage = pieces.length ? profiles.get(pieces[0].profileId)?.voltage ?? 12 : 12;
  const watts = pieces.reduce((a, pc) => {
    const pr = profiles.get(pc.profileId)!;
    return a + (pr.wattPerM * pc.units * pr.cutUnit) / 1000;
  }, 0);
  // worst drop entry -> any hole for a given cross-section
  const dropFor = (A: number) => {
    const drop = new Array<number>(n).fill(0);
    for (const v of order) {
      if (v === 0) continue;
      const p = parent[v];
      drop[v] = drop[p] + (2 * RHO_CU * (dist(nodes[p], nodes[v]) / 1000) * current[v]) / A;
    }
    return Math.max(0, ...drop);
  };
  let wireMm2 = GAUGES[GAUGES.length - 1];
  for (const A of GAUGES) {
    if (dropFor(A) <= 0.03 * voltage) {
      wireMm2 = A;
      break;
    }
  }
  const psuMin = watts / 0.8;
  const psuWatts = PSU_WATTS.find((w) => w >= psuMin) ?? Math.ceil(psuMin / 50) * 50;
  return {
    wires,
    power: {
      watts,
      amps: watts / voltage,
      psuWatts,
      wireMm2,
      wireLength: wires.reduce((a, w) => a + w.length, 0),
      maxDropV: dropFor(wireMm2),
    },
  };
}
