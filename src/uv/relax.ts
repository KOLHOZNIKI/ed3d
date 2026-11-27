import { edgeKey } from '../mesh/data';
import { cross, inspectLayout, read, type groups, type Layout, type Pair, type Surface } from './layout';

interface Options { strength: number; iterations: number; fixBoundary: boolean }

export function relaxUv(surface: Surface, layout: Layout, grouping: ReturnType<typeof groups>, selection: ReadonlySet<number>,
  pins: ReadonlySet<number>, { strength, iterations, fixBoundary }: Options) {
  if (!(strength > 0 && strength <= 1) || !Number.isInteger(iterations) || iterations < 1 || iterations > 50) {
    throw new Error('Choose a UV Relax strength greater than 0 and at most 1, with 1–50 iterations.');
  }
  const selected = new Set([...selection].map(grouping.vertexOf));
  const fixed = new Set([...pins].map(grouping.vertexOf));
  const weights = new Map<number, Map<number, number>>();
  const incidences = new Map<string, { a: number; b: number; total: number; inside: number }>();
  const link = (a: number, b: number, weight: number) => {
    if (!selected.has(a)) return;
    const row = weights.get(a) ?? new Map<number, number>();
    row.set(b, weight); weights.set(a, row);
  };
  for (let i = 0; i < layout.uv.length / 2; i += 3) {
    const vertices = [i, i + 1, i + 2].map(grouping.vertexOf);
    if (!vertices.some(id => selected.has(id))) continue;
    const inside = vertices.every(id => selected.has(id));
    for (let j = 0; j < 3; j++) {
      const a = vertices[j], b = vertices[(j + 1) % 3];
      if (a === b || !selected.has(a) && !selected.has(b)) continue;
      const key = edgeKey(a, b), edge = incidences.get(key) ?? { a, b, total: 0, inside: 0 };
      edge.total++;
      if (inside) edge.inside++;
      incidences.set(key, edge);
    }
  }
  const p = surface.positions;
  for (const { a, b, total, inside } of incidences.values()) {
    if (fixBoundary && (total !== 2 || inside !== 2)) { fixed.add(a); fixed.add(b); }
    const length = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
    const weight = 1 / Math.max(length, 1e-12);
    link(a, b, weight); link(b, a, weight);
  }
  const movable = [...weights].filter(([id]) => !fixed.has(id));
  if (!movable.length) throw new Error('UV Relax has no movable vertices. Expand the selection or review the boundary and pins.');
  const uv = layout.uv.slice(), pending = new Float64Array(movable.length * 2);
  for (let pass = 0; pass < iterations; pass++) {
    for (const [i, [id, row]] of movable.entries()) {
      let u = 0, v = 0, total = 0;
      for (const [other, weight] of row) { u += uv[other * 2] * weight; v += uv[other * 2 + 1] * weight; total += weight; }
      pending[i * 2] = uv[id * 2] + (u / total - uv[id * 2]) * strength;
      pending[i * 2 + 1] = uv[id * 2 + 1] + (v / total - uv[id * 2 + 1]) * strength;
    }
    for (const [i, [id]] of movable.entries()) {
      for (const corner of grouping.vertices.get(id)!) { uv[corner * 2] = pending[i * 2]; uv[corner * 2 + 1] = pending[i * 2 + 1]; }
    }
  }
  const changed = movable.filter(([id]) => uv[id * 2] !== layout.uv[id * 2] || uv[id * 2 + 1] !== layout.uv[id * 2 + 1]);
  if (!changed.length) throw new Error('UV Relax did not move any vertices.');
  const affected = new Set(changed.flatMap(([id]) => grouping.vertices.get(id)!.map(corner => Math.floor(corner / 3))));
  const area = (values: Float32Array, i: number) => cross(read(values, i), read(values, i + 1), read(values, i + 2));
  for (const triangle of affected) {
    const start = triangle * 3, after = area(uv, start);
    if (!Number.isFinite(after) || Math.abs(after) <= 1e-12 || area(layout.uv, start) * after <= 0) {
      throw new Error('UV Relax would collapse or flip a triangle. Reduce strength or iterations.');
    }
  }
  if (inspectLayout(uv, false, affected).conflicts.size) throw new Error('UV Relax would leave overlapping triangles. Review the selection or reduce the adjustment.');

  const seams = new Set(layout.seams);
  const same = (a: Pair, b: Pair) => a[0] === b[0] && a[1] === b[1];
  // Keep existing implicit seams if relaxation makes the coordinates coincide.
  for (const [key, sides] of grouping.sides) {
    if (sides.length !== 2 || seams.has(key)) continue;
    const [[a, b], [c, d]] = sides;
    if ((grouping.vertexOf(a) !== grouping.vertexOf(c) || grouping.vertexOf(b) !== grouping.vertexOf(d)) &&
      same(read(uv, a), read(uv, c)) && same(read(uv, b), read(uv, d))) seams.add(key);
  }
  return { layout: { uv, seams: [...seams] }, moved: changed.length, fixed: [...selected].filter(id => fixed.has(id)).length };
}
