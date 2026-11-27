import { Vector3 } from 'three';
import { edgeKey, edgesOf, ensureUvChannel, next, type Corner, type Face, type MeshData, type Vec3, type Weight } from '../mesh/data';
import { tangentFrame } from '../mesh/normals';
import { polygon, vector } from '../mesh/polygon';
import { boundaryContours, boundaryPlane, type Boundary } from './boundaries';
import { validatePatch } from './intersections';

export type FillMethod = 'planar' | 'fan';
export interface Fill {
  readonly id: string;
  readonly method: FillMethod;
  readonly tolerance: number;
  readonly project: boolean;
  readonly material?: number;
  readonly center?: Vec3;
}

export function applyRepairs(source: MeshData, fills: readonly Fill[]) {
  let mesh = source;
  const boundaries = new Map(boundaryContours(mesh).map(contour => [contour.id, contour]));
  for (const fill of fills) {
    const boundary = boundaries.get(fill.id);
    if (!boundary) throw new Error('The saved repair boundary no longer exists.');
    mesh = fillBoundary(mesh, boundary, fill);
    boundaries.delete(fill.id);
  }
  return mesh;
}

export function fillBoundary(mesh: MeshData, boundary: Boundary, fill: Fill): MeshData {
  if (boundary.kind !== 'loop') throw new Error(boundary.reason ?? 'Select a simple closed boundary.');
  const vertices = boundary.vertices;
  const plane = boundaryPlane(mesh, vertices, boundary.diameter);
  if (fill.method === 'planar' && plane.deviation > fill.tolerance) {
    throw new Error(`Deviation is ${(plane.deviation * 100).toFixed(2)}%. Increase tolerance or try Fan Fill.`);
  }
  if (fill.project) mesh = ensureUvChannel(mesh);
  const edges = edgesOf(mesh), witness = new Map<number, Corner['attributes']>(), materials = new Map<number, number>();
  for (const [i, a] of vertices.entries()) {
    const b = vertices[(i + 1) % vertices.length], sides = edges.get(edgeKey(a, b));
    if (sides?.length !== 1) throw new Error('The boundary changed before it could be filled.');
    const { face, corner } = sides[0], following = face.corners[next(face, corner)];
    if (face.corners[corner].vertex !== b || following.vertex !== a) throw new Error('The boundary winding changed.');
    witness.set(a, following.attributes);
    materials.set(face.material, (materials.get(face.material) ?? 0) + 1);
  }
  const slot = fill.material ?? [...materials].sort(([a, n], [b, m]) => m - n || a - b)[0][0];
  if (slot >= mesh.materialCount) throw new Error('Choose an existing material slot.');
  const contour = vertices.map(id => vector(mesh, id)), projected = contour.map(plane.project);
  const xs = projected.map(p => p.x), ys = projected.map(p => p.y);
  const loX = Math.min(...xs), loY = Math.min(...ys);
  const width = Math.max(...xs) - loX, height = Math.max(...ys) - loY;
  const uv = projected.map(p => [(p.x - loX) / width, (p.y - loY) / height]);
  let localIds = [...vertices], positions = mesh.positions, weights = mesh.weights;
  let triangles = polygon(mesh, vertices).triangles;
  if (fill.method === 'fan') {
    const center = fill.center ? new Vector3(...fill.center) : plane.origin;
    if (!center.toArray().every(value => Number.isFinite(Math.fround(value)))) throw new Error('Choose a center with finite coordinates.');
    const middle = plane.project(center);
    for (const [i, a] of projected.entries()) {
      const b = projected[(i + 1) % projected.length];
      if ((b.x - a.x) * (middle.y - a.y) - (b.y - a.y) * (middle.x - a.x) <= 1e-8) {
        throw new Error('The Fan center must see every boundary edge in the projected contour. Move it or use Planar Fill.');
      }
    }
    if (Math.abs(plane.distance(center)) > boundary.diameter) throw new Error('The Fan center is too far from the boundary plane.');
    const id = positions.length / 3;
    positions = new Float64Array(mesh.positions.length + 3);
    positions.set(mesh.positions);
    center.toArray(positions, 3 * id);
    localIds = [...vertices, id];
    uv.push([(middle.x - loX) / width, (middle.y - loY) / height]);
    if (weights) weights = [...weights, centerWeights(mesh, vertices)];
    const rows = vertices.map(id => witness.get(id)!);
    witness.set(id, mesh.channels.map(({ size }, k) =>
      Array.from({ length: size }, (_, j) => rows.reduce((sum, row) => sum + row[k][j], 0) / rows.length)));
    triangles = vertices.flatMap((_, i) => [i, (i + 1) % vertices.length, vertices.length]);
  }
  const points = { ...mesh, positions, weights };
  const normals = localIds.map(() => new Vector3());
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3);
    const p = vector(points, localIds[a]), cross = vector(points, localIds[b]).sub(p).cross(vector(points, localIds[c]).sub(p));
    for (const j of [a, b, c]) normals[j].add(cross);
  }
  const corners = localIds.map((vertex, i): Corner => {
    if (mesh.glb && !fill.project && i < vertices.length) return { vertex, attributes: witness.get(vertex)! };
    return { vertex, attributes: mesh.channels.map(({ name }, k) => {
      if (name === 'normal') return normals[i].normalize().toArray();
      if (/^uv\d*$/.test(name)) return fill.project ? uv[i] : mesh.glb ? witness.get(vertex)![k] : [0, 0];
      if (name === 'tangent') {
        const n = normals[i].clone().normalize();
        return [...new Vector3(Math.abs(n.x) < .8 ? 1 : 0, Math.abs(n.x) < .8 ? 0 : 1, 0).cross(n).normalize().toArray(), 1];
      }
      return witness.get(vertex)![k];
    }) };
  });
  const patch: Face[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const face: Face = { id: mesh.nextFace + patch.length, material: slot,
      corners: triangles.slice(i, i + 3).map(index => corners[index]), triangles: [0, 1, 2],
      created: true, repaired: true, needsUv: fill.project ? undefined : true };
    patch.push(fill.project ? tangentFrame(points, face) : face);
  }
  validatePatch(points, patch, boundary, plane.normal);
  return { ...points, faces: [...mesh.faces, ...patch], nextFace: mesh.nextFace + patch.length };
}

function centerWeights(mesh: MeshData, vertices: readonly number[]): Weight[] {
  const totals = new Map<number, number>();
  for (const vertex of vertices) {
    const row = mesh.weights![vertex].filter(([, weight]) => weight > 0);
    const sum = row.reduce((total, [, weight]) => total + weight, 0);
    if (!Number.isFinite(sum) || sum <= 0) throw new Error(`Boundary vertex ${vertex} has no usable skin weights for Fan Fill.`);
    for (const [bone, weight] of row) totals.set(bone, (totals.get(bone) ?? 0) + weight / sum);
  }
  const result = [...totals].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (mesh.glb && result.length > 4) throw new Error('Fan Fill would require more than four GLB weights. Try Planar Fill to reuse the boundary vertices.');
  const sum = result.reduce((total, [, weight]) => total + weight, 0);
  return result.map(([bone, weight]) => [bone, weight / sum]);
}
