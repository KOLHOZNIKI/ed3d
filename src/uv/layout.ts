import { Vector3 } from 'three';
import { edgeKey } from '../mesh/data';

export interface Surface {
  readonly positions: Float32Array<ArrayBuffer>;
  readonly normals: Float32Array<ArrayBuffer>;
  readonly points: Uint32Array<ArrayBuffer>;
  readonly faces: Uint32Array<ArrayBuffer>;
  readonly slots: Uint32Array<ArrayBuffer>;
}

export interface Layout {
  readonly uv: Float32Array<ArrayBuffer>;
  readonly seams: readonly string[];
}

export interface Box { x0: number; y0: number; x1: number; y1: number }
export type Pair = readonly [number, number];

export function groups(surface: Pick<Surface, 'points'>, layout: Layout) {
  const { points } = surface, { uv, seams } = layout;
  const vertex = disjoint(points.length), island = disjoint(points.length / 3);
  const sides = new Map<string, Pair[]>();
  const cuts = new Set(seams);
  const equal = (a: number, b: number) => uv[2 * a] === uv[2 * b] && uv[2 * a + 1] === uv[2 * b + 1];
  for (let a = 0; a < points.length; a++) {
    let b = a % 3 === 2 ? a - 2 : a + 1;
    const key = edgeKey(points[a], points[b]);
    let lo = a;
    if (points[lo] > points[b]) [lo, b] = [b, lo];
    const list = sides.get(key);
    if (list) list.push([lo, b]);
    else sides.set(key, [[lo, b]]);
  }
  for (const [key, edges] of sides) {
    if (cuts.has(key) || edges.length !== 2) continue;
    const [[a, b], [c, d]] = edges;
    if (!equal(a, c) || !equal(b, d)) continue;
    vertex.join(a, c);
    vertex.join(b, d);
    island.join(Math.floor(a / 3), Math.floor(c / 3));
  }
  const vertices = new Map<number, number[]>(), islands = new Map<number, number[]>();
  const add = (map: Map<number, number[]>, id: number, value: number) => {
    const list = map.get(id);
    if (list) list.push(value);
    else map.set(id, [value]);
  };
  for (let i = 0; i < points.length; i++) {
    add(vertices, vertex.root(i), i);
    add(islands, island.root(Math.floor(i / 3)), i);
  }
  return { sides, vertices, islands, vertexOf: vertex.root, islandOf: (corner: number) => island.root(Math.floor(corner / 3)) };
}

export function disjoint(length: number) {
  const parent = Uint32Array.from({ length }, (_, i) => i);
  const root = (id: number) => {
    while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; }
    return id;
  };
  return { root, join(a: number, b: number) {
    const x = root(a), y = root(b);
    parent[Math.max(x, y)] = Math.min(x, y);
  } };
}

export function bounds(uv: Float32Array, corners: Iterable<number>): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of corners) {
    const x = uv[2 * i], y = uv[2 * i + 1];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

export function editUv(layout: Layout, corners: ReadonlySet<number>, map: (u: number, v: number, corner: number) => Pair): Layout {
  const uv = layout.uv.slice();
  for (const i of corners) {
    const [x, y] = map(uv[2 * i], uv[2 * i + 1], i);
    if (!Number.isFinite(Math.fround(x)) || !Number.isFinite(Math.fround(y))) throw new Error('The UV operation produced nonfinite coordinates.');
    uv.set([x, y], 2 * i);
  }
  return { ...layout, uv };
}

export function planar(surface: Surface, layout: Layout, corners: ReadonlySet<number>, axis: string) {
  const normal = new Vector3();
  for (const i of corners) if (i % 3 === 0 && corners.has(i + 1) && corners.has(i + 2)) normal.add(area3(surface, i));
  if (axis === 'xy') normal.set(0, 0, 1);
  if (axis === 'xz') normal.set(0, 1, 0);
  if (axis === 'yz') normal.set(1, 0, 0);
  if (!normal.lengthSq()) throw new Error('Choose a projection plane for this selection.');
  normal.normalize();
  const right = new Vector3(Math.abs(normal.y) < .8 ? 0 : 1, Math.abs(normal.y) < .8 ? 1 : 0, 0).cross(normal).normalize();
  const up = normal.clone().cross(right), p = new Vector3();
  const next = editUv(layout, corners, (_u, _v, i) => {
    p.fromArray(surface.positions, 3 * i);
    return [p.dot(right), p.dot(up)];
  });
  const box = bounds(next.uv, corners), scale = Math.max(box.x1 - box.x0, box.y1 - box.y0);
  if (!(scale > 0)) throw new Error('The projection has no area.');
  return editUv(next, corners, (x, y) => [(x - box.x0) / scale, (y - box.y0) / scale]);
}

export function density(surface: Surface, uv: Float32Array, corners: readonly number[], width: number, height = width) {
  let world = 0, area = 0;
  for (const i of corners) {
    if (i % 3 !== 0) continue;
    area += Math.abs(cross(read(uv, i), read(uv, i + 1), read(uv, i + 2))) / 2;
    world += area3(surface, i).length() / 2;
  }
  return world > 0 ? Math.sqrt(width * height * area / world) : 0;
}

function area3(surface: Surface, corner: number) {
  const a = new Vector3().fromArray(surface.positions, corner * 3);
  return new Vector3().fromArray(surface.positions, (corner + 1) * 3).sub(a)
    .cross(new Vector3().fromArray(surface.positions, (corner + 2) * 3).sub(a));
}

export const read = (uv: Float32Array, i: number): Pair => [uv[2 * i], uv[2 * i + 1]];
export const cross = (a: Pair, b: Pair, c: Pair) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export function diagnose(uv: Float32Array, topDown: boolean) {
  const { result, conflicts } = inspectLayout(uv, topDown);
  return { ...result, overlaps: conflicts.size };
}

export function inspectLayout(uv: Float32Array, topDown: boolean) {
  const result = { outside: 0, degenerate: 0, flipped: 0 };
  const triangles: { box: Box; points: Pair[]; id: number }[] = [];
  for (let i = 0; i < uv.length / 2; i += 3) {
    const points = [read(uv, i), read(uv, i + 1), read(uv, i + 2)];
    const area = cross(points[0], points[1], points[2]);
    if (points.some(p => p.some(v => v < 0 || v > 1))) result.outside++;
    if (!Number.isFinite(area) || Math.abs(area) < 1e-12) { result.degenerate++; continue; }
    if (topDown ? area > 0 : area < 0) result.flipped++;
    triangles.push({ box: bounds(uv, [i, i + 1, i + 2]), points: area < 0 ? points.reverse() : points, id: i / 3 });
  }
  return { result, conflicts: findOverlaps(triangles) };
}

type UvTriangle = { box: Box; points: Pair[]; id: number };

function findOverlaps(triangles: UvTriangle[]) {
  const overlaps = new Set<number>();
  if (triangles.length < 2) return overlaps;
  const extent = triangles.reduce((box, entry) => mergeBox(box, entry.box), triangles[0].box);
  const sx = 32767 / (extent.x1 - extent.x0 || 1), sy = 32767 / (extent.y1 - extent.y0 || 1);
  // Interleave centroid coordinates to keep both axes local in the hierarchy.
  const ordered = triangles.map(triangle => {
    const { x0, y0, x1, y1 } = triangle.box;
    const x = ((x0 + x1) * .5 - extent.x0) * sx, y = ((y0 + y1) * .5 - extent.y0) * sy;
    return { triangle, key: mortonAxis(x) | (mortonAxis(y) << 1) };
  }).sort((a, b) => a.key - b.key).map(entry => entry.triangle);
  const tree: Box[] = [];
  const build = (node: number, start: number, end: number): Box => {
    if (end - start > 8) {
      const middle = (start + end) >>> 1;
      return tree[node] = mergeBox(build(node * 2, start, middle), build(node * 2 + 1, middle, end));
    }
    let box = ordered[start].box;
    for (let i = start + 1; i < end; i++) box = mergeBox(box, ordered[i].box);
    return tree[node] = box;
  };
  build(1, 0, ordered.length);
  const visit = (a: UvTriangle, node: number, start: number, end: number): number | undefined => {
    if (!boxesIntersect(a.box, tree[node])) return;
    if (end - start > 8) {
      const middle = (start + end) >>> 1;
      return visit(a, node * 2, start, middle) ?? visit(a, node * 2 + 1, middle, end);
    }
    for (let i = start; i < end; i++) {
      const b = ordered[i];
      if (a !== b && boxesIntersect(a.box, b.box) && overlap(a.points, b.points)) return b.id;
    }
  };
  for (const triangle of ordered) {
    if (overlaps.has(triangle.id)) continue;
    const other = visit(triangle, 1, 0, ordered.length);
    if (other !== undefined) { overlaps.add(triangle.id); overlaps.add(other); }
  }
  return overlaps;
}

function mortonAxis(coordinate: number) {
  let value = coordinate & 0x7fff;
  value = (value | (value << 8)) & 0x00ff00ff;
  value = (value | (value << 4)) & 0x0f0f0f0f;
  value = (value | (value << 2)) & 0x33333333;
  return (value | (value << 1)) & 0x55555555;
}

function mergeBox(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function boxesIntersect(a: Box, b: Box) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function overlap(a: Pair[], b: Pair[]) {
  let polygon = a;
  for (let i = 0; i < 3; i++) {
    const start = b[i], end = b[(i + 1) % 3], clipped: Pair[] = [];
    for (let j = 0; j < polygon.length; j++) {
      const x = polygon[j], y = polygon[(j + 1) % polygon.length];
      const p = cross(start, end, x), q = cross(start, end, y);
      if (p >= 0) clipped.push(x);
      if ((p < 0) !== (q < 0)) {
        const t = p / (p - q);
        clipped.push([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t]);
      }
    }
    polygon = clipped;
    if (polygon.length < 3) return false;
  }
  let area = 0;
  for (let i = 1; i < polygon.length - 1; i++) area += cross(polygon[0], polygon[i], polygon[i + 1]);
  return area > 1e-12;
}
