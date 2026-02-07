import { Building } from './types';

const CELL_SIZE = 320;

export class SpatialGrid {
  private cells: Map<number, Building[]> = new Map();

  constructor(buildings: Building[]) {
    for (const b of buildings) {
      const x0 = Math.floor((b.x - 40) / CELL_SIZE);
      const x1 = Math.floor((b.x + b.w + 40) / CELL_SIZE);
      const y0 = Math.floor((b.y - 40) / CELL_SIZE);
      const y1 = Math.floor((b.y + b.h + 40) / CELL_SIZE);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = cx * 10000 + cy;
          let list = this.cells.get(key);
          if (!list) { list = []; this.cells.set(key, list); }
          list.push(b);
        }
      }
    }
  }

  queryNear(x: number, y: number, margin: number): Building[] {
    const cx0 = Math.floor((x - margin) / CELL_SIZE);
    const cx1 = Math.floor((x + margin) / CELL_SIZE);
    const cy0 = Math.floor((y - margin) / CELL_SIZE);
    const cy1 = Math.floor((y + margin) / CELL_SIZE);
    if (cx0 === cx1 && cy0 === cy1) {
      return this.cells.get(cx0 * 10000 + cy0) || [];
    }
    const seen = new Set<Building>();
    const result: Building[] = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const list = this.cells.get(cx * 10000 + cy);
        if (!list) continue;
        for (const b of list) {
          if (!seen.has(b)) { seen.add(b); result.push(b); }
        }
      }
    }
    return result;
  }
}
