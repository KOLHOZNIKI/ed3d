import type { MeshData } from './data';

export const falloffs = ['linear', 'smooth', 'sharp'] as const;
export interface SoftSelection {
  radius: number;
  falloff: typeof falloffs[number];
}

type Neighbor = { vertex: number; distance: number };

export function softWeights(mesh: MeshData, seeds: ReadonlySet<number>, { radius, falloff }: SoftSelection) {
  if (!Number.isFinite(radius) || radius <= 0 || !falloffs.includes(falloff)) {
    throw new Error('Choose a positive Soft Selection radius and a supported falloff.');
  }
  const neighbors = new Map<number, Neighbor[]>();
  const add = (source: number, vertex: number, distance: number) => {
    const row = neighbors.get(source);
    if (row) row.push({ vertex, distance });
    else neighbors.set(source, [{ vertex, distance }]);
  };
  const points = mesh.positions;
  for (const { corners } of mesh.faces) for (const [i, { vertex: a }] of corners.entries()) {
    const b = corners[(i + 1) % corners.length].vertex;
    const distance = Math.hypot(points[a * 3] - points[b * 3], points[a * 3 + 1] - points[b * 3 + 1], points[a * 3 + 2] - points[b * 3 + 2]);
    if (distance >= radius) continue;
    add(a, b, distance);
    add(b, a, distance);
  }

  // Propagate from all selected vertices at once across authored edges. Shared positions and UV seams do not define adjacency.
  const queue: Neighbor[] = [], nearest = new Map<number, number>();
  for (const vertex of seeds) {
    nearest.set(vertex, 0);
    queue.push({ vertex, distance: 0 });
  }
  while (queue.length) {
    const { vertex, distance } = takeNearest(queue);
    if (nearest.get(vertex) !== distance) continue;
    for (const next of neighbors.get(vertex) ?? []) {
      const candidate = distance + next.distance;
      if (candidate >= radius || candidate >= (nearest.get(next.vertex) ?? Infinity)) continue;
      nearest.set(next.vertex, candidate);
      enqueue(queue, { vertex: next.vertex, distance: candidate });
    }
  }

  const weights = new Map<number, number>();
  for (const [vertex, distance] of nearest) {
    const t = (radius - distance) / radius;
    weights.set(vertex, falloff === 'linear' ? t : falloff === 'sharp' ? t * t : t * t * (3 - 2 * t));
  }
  return weights;
}

function enqueue(queue: Neighbor[], item: Neighbor) {
  let i = queue.length;
  queue.push(item);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (queue[parent].distance <= item.distance) break;
    queue[i] = queue[parent];
    i = parent;
  }
  queue[i] = item;
}

function takeNearest(queue: Neighbor[]) {
  const result = queue[0], last = queue.pop()!;
  if (!queue.length) return result;
  let i = 0;
  while (2 * i + 1 < queue.length) {
    let child = 2 * i + 1;
    if (child + 1 < queue.length && queue[child + 1].distance < queue[child].distance) child++;
    if (last.distance <= queue[child].distance) break;
    queue[i] = queue[child];
    i = child;
  }
  queue[i] = last;
  return result;
}
