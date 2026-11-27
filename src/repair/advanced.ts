import { Vector2, Vector3 } from 'three';
import { edgeKey, type MeshData } from '../mesh/data';
import { polygon, vector } from '../mesh/polygon';
import { boundaryPlane, type Boundary } from './boundaries';

export type Influence = readonly [index: number, weight: number];
export interface Sample { point: Vector3; weights: readonly Influence[] }
export interface PatchCell { vertices: number[]; uv?: number[][] }
export interface Recipe {
  rim: number[];
  samples: Sample[];
  cells: PatchCell[];
  attached?: [number, number][];
  exposed?: [number, number][];
}
export interface SmoothSettings { density: number; iterations: number }
export interface GridSettings { corners?: number[] }
export interface BridgeSettings { startA: number; startB?: number; twist: number; segments: number; reverse: boolean; span?: number }

export function rimSamples(mesh: MeshData, rim: readonly number[]) {
  return rim.map((id, i): Sample => ({ point: vector(mesh, id), weights: [[i, 1]] }));
}

export function blend(samples: readonly Sample[], indices: readonly number[], weights?: readonly number[]): Sample {
  const point = new Vector3(), influences = new Map<number, number>();
  for (const [i, id] of indices.entries()) {
    const factor = weights?.[i] ?? 1 / indices.length;
    point.addScaledVector(samples[id].point, factor);
    for (const [rim, weight] of samples[id].weights) influences.set(rim, (influences.get(rim) ?? 0) + factor * weight);
  }
  return { point, weights: [...influences].filter(([, value]) => value > 0) };
}

export function smoothRecipe(mesh: MeshData, rim: number[], settings: SmoothSettings): Recipe {
  const samples = rimSamples(mesh, rim);
  const base = polygon(mesh, rim).triangles;
  const boundary = new Set(rim.map((_, i) => edgeKey(i, (i + 1) % rim.length)));
  let triangles = Array.from({ length: base.length / 3 }, (_, i) => base.slice(i * 3, i * 3 + 3));
  for (let pass = 0; pass < settings.density; pass++) {
    const midpoints = new Map<string, number>(), refined: number[][] = [];
    for (const triangle of triangles) {
      const ring: number[] = [];
      for (const [i, a] of triangle.entries()) {
        ring.push(a);
        const b = triangle[(i + 1) % 3], key = edgeKey(a, b);
        if (boundary.has(key)) continue;
        let id = midpoints.get(key);
        if (id === undefined) {
          id = samples.push(blend(samples, [a, b])) - 1;
          midpoints.set(key, id);
        }
        ring.push(id);
      }
      const center = samples.push(blend(samples, triangle)) - 1;
      for (const [i, id] of ring.entries()) refined.push([id, ring[(i + 1) % ring.length], center]);
    }
    if (refined.length > 8192) throw new Error('Reduce Smooth density for this contour.');
    triangles = refined;
  }
  const links = samples.map(() => new Set<number>());
  for (const triangle of triangles) for (const [i, a] of triangle.entries()) {
    const b = triangle[(i + 1) % 3];
    links[a].add(b);
    links[b].add(a);
  }
  for (let step = 0; step < settings.iterations; step++) {
    const smooth = samples.slice(rim.length).map(({ point }, i) => {
      const neighbors = links[rim.length + i];
      const average = new Vector3();
      for (const vertex of neighbors) average.add(samples[vertex].point);
      return point.clone().lerp(average.multiplyScalar(1 / neighbors.size), 0.4);
    });
    smooth.forEach((point, i) => { samples[rim.length + i].point = point; });
  }
  return { rim, samples, cells: triangles.map(vertices => ({ vertices })) };
}

export function gridRecipe(mesh: MeshData, rim: number[], boundary: Boundary, settings: GridSettings): Recipe {
  const samples = rimSamples(mesh, rim), n = rim.length;
  const plane = boundaryPlane(mesh, rim, boundary.diameter);
  const points = samples.map(sample => plane.project(sample.point));
  const turns = points.map((point, i) => ({
    i, strength: new Vector2().subVectors(point, points[(i + n - 1) % n]).normalize()
      .dot(new Vector2().subVectors(points[(i + 1) % n], point).normalize()),
  }));
  const corners = settings.corners?.map(id => rim.indexOf(id)) ?? turns.sort((a, b) => a.strength - b.strength).slice(0, 4).map(turn => turn.i);
  if (corners.length !== 4 || new Set(corners).size !== 4 || corners.includes(-1)) throw new Error('Choose four distinct vertices on the grid boundary.');
  corners.sort((a, b) => a - b);
  const side = (i: number) => {
    const start = corners[i], end = corners[(i + 1) % 4], count = (end + n - start) % n;
    return Array.from({ length: count + 1 }, (_, j) => (start + j) % n);
  };
  const bottom = side(0), right = side(1), top = side(2).reverse(), left = side(3).reverse();
  const width = bottom.length - 1, height = right.length - 1;
  if (width !== top.length - 1 || height !== left.length - 1) throw new Error('Opposite Grid sides must have the same number of edges. Choose four compatible corners.');
  if (width * height > 4096) throw new Error('The Grid would exceed 4,096 cells.');
  const grid: number[][] = [];
  for (let y = 0; y <= height; y++) {
    const row: number[] = [];
    for (let x = 0; x <= width; x++) {
      if (!y || y === height) row.push((!y ? bottom : top)[x]);
      else if (!x || x === width) row.push((!x ? left : right)[y]);
      else {
        const u = x / width, v = y / height;
        const sample = blend(samples, [bottom[x], right[y], top[x], left[y]], [(1 - v) * .5, u * .5, v * .5, (1 - u) * .5]);
        // The Coons corner term is subtracted only from positions. Attribute weights stay convex.
        sample.point.multiplyScalar(2).sub(blend(samples, corners, [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v]).point);
        row.push(samples.push(sample) - 1);
      }
    }
    grid.push(row);
  }
  const cells: PatchCell[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const vertices = [grid[y][x], grid[y][x + 1], grid[y + 1][x + 1], grid[y + 1][x]];
    const uv = [[x / width, y / height], [(x + 1) / width, y / height], [(x + 1) / width, (y + 1) / height], [x / width, (y + 1) / height]];
    cells.push({ vertices, uv });
  }
  return { rim, samples, cells };
}

export function bridgeRecipe(mesh: MeshData, first: Boundary, second: Boundary, settings: BridgeSettings): Recipe {
  if (first.kind !== 'loop' || second.kind !== 'loop') throw new Error('Bridge requires two simple closed contours.');
  const n = first.vertices.length, m = second.vertices.length, partial = !!settings.span;
  const edges = settings.span || n;
  if (n > 256 || m > 256 || !partial && n !== m || partial && edges >= Math.min(n, m)) {
    throw new Error('Bridge needs equal loop edge counts or a shared partial edge count smaller than both loops. The limit is 256 edges per loop.');
  }
  if (settings.startA >= n || (settings.startB ?? 0) >= m) throw new Error('Bridge start offsets must be smaller than the contour edge count.');
  const at = (index: number, count: number) => ((index % count) + count) % count;
  const count = partial ? edges + 1 : edges;
  const a = Array.from({ length: count }, (_, i) => first.vertices[at(i + settings.startA, n)]);
  let startB = settings.startB;
  if (startB === undefined) {
    const p = a.map(id => vector(mesh, id)), q = second.vertices.map(id => vector(mesh, id));
    let distance = Infinity;
    for (let start = 0; start < m; start++) {
      const error = p.reduce((sum, point, i) => sum + point.distanceToSquared(q[at(start - i, m)]), 0);
      if (error < distance) { distance = error; startB = start; }
    }
  }
  const b = Array.from({ length: count }, (_, i) => second.vertices[at(startB! + settings.twist - i, m)]);
  const rim = [...a, ...b], samples = rimSamples(mesh, rim), cells: PatchCell[] = [];
  const rows = Array.from({ length: settings.segments + 1 }, (_, layer) => a.map((_, i) => {
    if (!layer) return i;
    if (layer === settings.segments) return i + count;
    const v = layer / settings.segments;
    return samples.push(blend(samples, [i, i + count], [1 - v, v])) - 1;
  }));
  for (let row = 0; row < settings.segments; row++) for (let i = 0; i < edges; i++) {
    const next = (i + 1) % count;
    const vertices = [rows[row][i], rows[row][next], rows[row + 1][next], rows[row + 1][i]];
    const uv = [[i / edges, row / settings.segments], [(i + 1) / edges, row / settings.segments],
      [(i + 1) / edges, (row + 1) / settings.segments], [i / edges, (row + 1) / settings.segments]];
    cells.push({ vertices, uv });
  }
  if (!partial) return { rim, samples, cells };
  const attached: [number, number][] = [], exposed: [number, number][] = [];
  for (let i = 0; i < edges; i++) attached.push([a[i + 1], a[i]], [b[i], b[i + 1]]);
  for (let j = 0; j < settings.segments; j++) for (const column of [0, edges]) exposed.push([rows[j][column], rows[j + 1][column]]);
  return { rim, samples, cells, attached, exposed };
}
