import { Box3, Line3, Triangle, Vector3 } from 'three';
import { edgeKey, type Face, type MeshData } from '../mesh/data';
import { vector } from '../mesh/polygon';
import type { Boundary } from './boundaries';

type Facet = { ids: number[]; points: Vector3[]; area: Triangle; normal: Vector3; bounds: Box3 };
const tolerance = 1e-8;

export function validatePatch(mesh: MeshData, patch: readonly Face[], boundary: Pick<Boundary, 'edges' | 'diameter'>,
  normal?: Vector3, sourceWinding = false, exposed: readonly (readonly [number, number])[] = []) {
  const rim = new Map(boundary.edges.map(([a, b]) => [edgeKey(a, b), a]));
  const ends = new Set(exposed.map(([a, b]) => edgeKey(a, b)));
  const edges = new Map<string, number[]>();
  const epsilon = boundary.diameter * tolerance;
  const added = patch.flatMap(face => Array.from({ length: face.triangles.length / 3 }, (_, i) =>
    facet(mesh, face.triangles.slice(i * 3, i * 3 + 3).map(corner => face.corners[corner].vertex))));
  const area = new Box3();
  for (const face of added) {
    const cross = face.points[1].clone().sub(face.points[0]).cross(face.points[2].clone().sub(face.points[0]));
    const orientedArea = normal ? cross.dot(normal) : cross.length();
    if (orientedArea <= epsilon * epsilon) throw new Error('The patch has a collapsed or inverted triangle.');
    area.union(face.bounds);
    face.ids.forEach((id, i) => {
      const to = face.ids[(i + 1) % 3], key = edgeKey(id, to), uses = edges.get(key) ?? [];
      uses.push(id);
      edges.set(key, uses);
    });
  }
  for (const [key, uses] of edges) {
    if (rim.has(key) ? uses.length !== 1 || sourceWinding && uses[0] === rim.get(key) :
        ends.has(key) ? uses.length !== 1 : uses.length !== 2 || uses[0] === uses[1]) {
      throw new Error('The patch does not meet the source boundary with consistent winding.');
    }
  }
  if ([...rim.keys(), ...ends].some(key => !edges.has(key))) throw new Error('The patch skipped a boundary edge.');
  added.sort((a, b) => a.bounds.min.x - b.bounds.min.x);
  for (const [i, face] of added.entries()) for (let j = i + 1; j < added.length; j++) {
    const other = added[j];
    if (other.bounds.min.x > face.bounds.max.x + epsilon) break;
    if (intersects(face, other, epsilon)) throw new Error('The patch crosses itself. Adjust its parameters.');
  }

  area.expandByScalar(epsilon);
  for (const face of mesh.faces) {
    const bounds = new Box3().setFromPoints(face.corners.map(corner => vector(mesh, corner.vertex)));
    if (!area.intersectsBox(bounds)) continue;
    for (let i = 0; i < face.triangles.length; i += 3) {
      const triangle = facet(mesh, face.triangles.slice(i, i + 3).map(corner => face.corners[corner].vertex));
      if (!triangle.normal.lengthSq()) continue;
      if (added.some(candidate => intersects(candidate, triangle, epsilon))) {
        throw new Error(`The patch intersects existing face ${face.id}. Try another method or inspect this boundary manually.`);
      }
    }
  }
}

function facet(mesh: MeshData, ids: number[]): Facet {
  const points = ids.map(id => vector(mesh, id));
  return makeFacet(ids, points);
}

function makeFacet(ids: number[], points: Vector3[]): Facet {
  const area = new Triangle(points[0], points[1], points[2]);
  return { ids, points, area, normal: area.getNormal(new Vector3()), bounds: new Box3().setFromPoints(points) };
}

export function scanIntersections(positions: Float64Array, triangles: Uint32Array, budget = 800_000) {
  const facets: { index: number; facet: Facet }[] = [];
  const bounds = new Box3();
  for (let i = 0; i < triangles.length; i += 3) {
    const ids = Array.from(triangles.subarray(i, i + 3)), points = ids.map(id => new Vector3().fromArray(positions, id * 3));
    const facet = makeFacet(ids, points);
    if (!facet.normal.lengthSq()) continue;
    bounds.union(facet.bounds);
    facets.push({ index: i / 3, facet });
  }
  const epsilon = Math.max(1e-12, bounds.getSize(new Vector3()).length() * tolerance);
  const size = bounds.getSize(new Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
  facets.sort((a, b) => a.facet.bounds.min[axis] - b.facet.bounds.min[axis]);
  let tested = 0;
  for (const [i, a] of facets.entries()) for (let j = i + 1; j < facets.length; j++) {
    const b = facets[j];
    if (b.facet.bounds.min[axis] > a.facet.bounds.max[axis] + epsilon) break;
    if (++tested > budget) return { reachedLimit: true };
    if (intersects(a.facet, b.facet, epsilon)) return { triangle: a.index, reachedLimit: false };
  }
  return { reachedLimit: false };
}

function intersects(a: Facet, b: Facet, epsilon: number) {
  if (!a.bounds.clone().expandByScalar(epsilon).intersectsBox(b.bounds)) return false;
  const shared = a.ids.flatMap((id, i) => b.ids.includes(id) ? [a.points[i]] : []);
  if (shared.length === 3) return true;
  const sharedEdge = shared.length === 2 ? new Line3(shared[0], shared[1]) : undefined;
  const allowed = (point: Vector3) => shared.some(vertex => vertex.distanceToSquared(point) <= (epsilon * 4) ** 2) ||
    !!sharedEdge && sharedEdge.closestPointToPoint(point, true, new Vector3()).distanceToSquared(point) <= (epsilon * 4) ** 2;
  return crossesSurface(a, b, epsilon, allowed) || crossesSurface(b, a, epsilon, allowed);
}

function crossesSurface(a: Facet, b: Facet, epsilon: number, allowed: (p: Vector3) => boolean) {
  const distances = a.points.map(point => point.clone().sub(b.points[0]).dot(b.normal));
  if (distances.every(d => d > epsilon) || distances.every(d => d < -epsilon)) return false;
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, da = distances[i], db = distances[j];
    const x = a.points[i], y = a.points[j];
    if (Math.abs(da) <= epsilon && Math.abs(db) <= epsilon) {
      const start = b.area.getBarycoord(x, new Vector3()), end = b.area.getBarycoord(y, new Vector3());
      if (!start || !end) continue;
      const clip = clipBarycentric(start, end);
      if (clip && [clip[0], clip[1], (clip[0] + clip[1]) / 2].some(t => !allowed(x.clone().lerp(y, t)))) return true;
      continue;
    }
    if (da > epsilon && db > epsilon || da < -epsilon && db < -epsilon) continue;
    const t = Math.min(1, Math.max(0, da / (da - db)));
    const point = x.clone().lerp(y, t), w = b.area.getBarycoord(point, new Vector3());
    if (w && Math.min(w.x, w.y, w.z) >= -tolerance && !allowed(point)) return true;
  }
  return false;
}

// Barycentric coordinates change linearly along a coplanar segment.
function clipBarycentric(a: Vector3, b: Vector3) {
  let lo = 0, hi = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    // Expanding the barycentric half-spaces can extend a valid shared
    // vertex contact into a false overlap along a nearly parallel edge.
    const start = snap(a[axis]), end = snap(b[axis]), slope = end - start;
    if (slope === 0) {
      if (start < 0) return;
      continue;
    }
    const t = -start / slope;
    if (slope > 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  return lo <= hi ? [lo, hi] : undefined;
}

function snap(value: number) { return Math.abs(value) <= 1e-12 ? 0 : value; }
