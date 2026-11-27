import { Box3, Vector2, Vector3 } from 'three';
import { edgeKey, edgeVertices, edgesOf, next, point, type MeshData } from '../mesh/data';
import { faceNormal, polygon, vector } from '../mesh/polygon';

export interface Boundary {
  readonly id: string;
  readonly kind: 'loop' | 'chain' | 'branch' | 'non-manifold' | 'ambiguous';
  readonly vertices: readonly number[];
  readonly edges: readonly (readonly [number, number])[];
  readonly perimeter: number;
  readonly diameter: number;
  readonly approximate: boolean;
  readonly deviation?: number;
  readonly reason?: string;
}

export function boundaryContours(mesh: MeshData): Boundary[] {
  const open: [number, number][] = [], invalid: [number, number][] = [];
  const directions = new Map<string, number>();
  const nonManifoldVertices = new Set<number>();
  for (const [key, sides] of edgesOf(mesh)) {
    if (sides.length === 2) continue;
    const [a, b] = edgeVertices(key);
    if (sides.length > 2 || a === b) {
      invalid.push([a, b]);
      nonManifoldVertices.add(a);
      nonManifoldVertices.add(b);
      continue;
    }
    const { face, corner } = sides[0];
    const from = face.corners[corner].vertex, to = face.corners[next(face, corner)].vertex;
    directions.set(key, from);
    open.push([from, to]);
  }
  const coincident = coincidentEdges(mesh, open);
  const result: Boundary[] = [];
  for (const [type, edges] of [['open', open], ['invalid', invalid]] as const) {
    const incidence = new Map<number, number[]>();
    edges.forEach(([a, b], i) => {
      for (const vertex of new Set([a, b])) {
        const linked = incidence.get(vertex) ?? [];
        linked.push(i);
        incidence.set(vertex, linked);
      }
    });
    const visited = new Set<number>();
    for (const start of incidence.keys()) {
      if (visited.has(start)) continue;
      const points = new Set([start]), component = new Set<number>(), queue = [start];
      visited.add(start);
      for (let i = 0; i < queue.length; i++) for (const e of incidence.get(queue[i])!) {
        component.add(e);
        for (const other of edges[e]) {
          if (visited.has(other)) continue;
          visited.add(other);
          points.add(other);
          queue.push(other);
        }
      }
      const vertices = [...points].sort((a, b) => a - b);
      const outline = [...component].map(i => edges[i]);
      const id = `${type === 'open' ? 'B' : 'N'}${vertices[0]}`;
      const approximate = vertices.length > 1024;
      const diameter = size(mesh, vertices, approximate);
      const perimeter = outline.reduce((sum, [a, b]) => sum + vector(mesh, a).distanceTo(vector(mesh, b)), 0);
      const metrics = { id, vertices, edges: outline, diameter, perimeter, approximate };
      const add = (kind: Boundary['kind'], reason: string) => result.push({ ...metrics, kind, reason });
      if (type === 'invalid') { add('non-manifold', 'An edge has invalid or more than two incident faces.'); continue; }
      if (vertices.some(v => incidence.get(v)!.length > 2)) { add('branch', 'Several open edges branch at one vertex.'); continue; }
      if (vertices.some(v => nonManifoldVertices.has(v))) { add('ambiguous', 'This boundary touches a non-manifold edge.'); continue; }
      if (vertices.some(v => incidence.get(v)!.length !== 2)) { add('chain', 'The open chain has endpoints.'); continue; }
      if (outline.some(([a, b]) => coincident.has(edgeKey(a, b)))) {
        add('ambiguous', 'An unjoined edge coincides with another edge. Inspect for a split seam or touching parts.');
        continue;
      }
      if (vertices.length < 3 || approximate) {
        add('ambiguous', approximate ? 'This contour exceeds the 1,024-vertex triangulation profile.' : 'Too few distinct vertices.');
        continue;
      }
      const ordered = traceEdges(vertices[0], outline, incidence, edges);
      if (!ordered || !outline.every(([a, b]) => directed(ordered, b, a))) {
        add('ambiguous', 'The surrounding faces have inconsistent winding.');
        continue;
      }
      try {
        polygon(mesh, ordered);
        const plane = boundaryPlane(mesh, ordered, diameter);
        result.push({ ...metrics, vertices: ordered, kind: 'loop', deviation: plane.deviation });
      } catch (error) {
        add('ambiguous', error instanceof Error ? error.message : String(error));
      }
    }
  }
  return result.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || a.id.localeCompare(b.id));
}

function coincidentEdges(mesh: MeshData, open: readonly [number, number][]) {
  const observed = new Map<string, string>();
  const overlaps = new Set<string>();
  for (const [a, b] of open) {
    const x = point(mesh, a).join(','), y = point(mesh, b).join(',');
    const position = x < y ? `${x}/${y}` : `${y}/${x}`;
    const key = edgeKey(a, b), previous = observed.get(position);
    if (previous) { overlaps.add(previous); overlaps.add(key); }
    else observed.set(position, key);
  }
  return overlaps;
}

function directed(order: readonly number[], a: number, b: number) {
  return order[(order.indexOf(a) + 1) % order.length] === b;
}

function traceEdges(start: number, outline: [number, number][], incidence: Map<number, number[]>, edges: readonly [number, number][]) {
  const incoming = outline.find(([, to]) => to === start);
  if (!incoming) return;
  const order = [start], count = outline.length;
  let previous = start, current = incoming[0];
  while (current !== start && order.length <= count) {
    order.push(current);
    const pair = incidence.get(current)!.map(i => {
      const [a, b] = edges[i];
      return a === current ? b : a;
    });
    const following = pair.find(v => v !== previous);
    if (following === undefined) return;
    previous = current;
    current = following;
  }
  return current === start && order.length === count ? order : undefined;
}

function size(mesh: MeshData, vertices: readonly number[], approximate: boolean) {
  const points = vertices.map(id => vector(mesh, id));
  if (approximate) return new Box3().setFromPoints(points).getSize(new Vector3()).length();
  let max = 0;
  for (let i = 0; i < points.length; i++) for (let j = 0; j < i; j++) {
    max = Math.max(max, points[i].distanceToSquared(points[j]));
  }
  return Math.sqrt(max);
}

export function boundaryPlane(mesh: MeshData, vertices: readonly number[], diameter: number) {
  const points = vertices.map(id => vector(mesh, id));
  const origin = points.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / points.length);
  const normal = faceNormal(mesh, { corners: vertices.map(vertex => ({ vertex, attributes: [] })) }).normalize();
  const axis = new Vector3(Math.abs(normal.x) < .8 ? 1 : 0, Math.abs(normal.x) < .8 ? 0 : 1, 0).cross(normal).normalize();
  const up = normal.clone().cross(axis);
  const distance = (point: Vector3) => point.clone().sub(origin).dot(normal);
  const project = (point: Vector3) => {
    const relative = point.clone().sub(origin);
    return new Vector2(relative.dot(axis) / diameter, relative.dot(up) / diameter);
  };
  return { origin, normal, distance, project, deviation: Math.max(...points.map(point => Math.abs(distance(point)))) / diameter };
}

export function authoredKeepOpen(contour: Boundary, hint: unknown) {
  if (contour.kind !== 'loop' || !Array.isArray(hint) || hint.length < 3) return false;
  const pointIds = new Set(contour.vertices);
  return hint.every(id => Number.isSafeInteger(id) && pointIds.has(id));
}
