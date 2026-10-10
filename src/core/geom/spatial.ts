import type { Vec } from './vec';

/** Uniform grid hash for nearest-neighbour style queries over tagged points. */
export class PointHash<T> {
  private cells = new Map<number, { p: Vec; tag: T }[]>();
  constructor(private cell: number) {}

  private key(ix: number, iy: number): number {
    // Cantor-free packing; coordinates stay well within +-2^20 cells for signs.
    return (ix + 1048576) * 2097152 + (iy + 1048576);
  }

  insert(p: Vec, tag: T): void {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell));
    let arr = this.cells.get(k);
    if (!arr) this.cells.set(k, (arr = []));
    arr.push({ p, tag });
  }

  /** Calls fn for every stored point within radius r of q (exact distance filter applied). */
  query(q: Vec, r: number, fn: (p: Vec, tag: T, d: number) => void): void {
    const x0 = Math.floor((q.x - r) / this.cell);
    const x1 = Math.floor((q.x + r) / this.cell);
    const y0 = Math.floor((q.y - r) / this.cell);
    const y1 = Math.floor((q.y + r) / this.cell);
    const r2 = r * r;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const arr = this.cells.get(this.key(ix, iy));
        if (!arr) continue;
        for (const e of arr) {
          const dx = e.p.x - q.x;
          const dy = e.p.y - q.y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2) fn(e.p, e.tag, Math.sqrt(d2));
        }
      }
    }
  }
}
