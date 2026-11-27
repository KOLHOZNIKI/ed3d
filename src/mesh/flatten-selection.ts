import { Vector3 } from 'three';
import { point, type MeshData, type Vec3 } from './data';

export type FlattenPlane = { mode: 'bestFit' } | { mode: 'specified'; normal: Vec3; offset: number };

export function flattenSelection(mesh: MeshData, selection: ReadonlySet<number>, plane: FlattenPlane) {
  if (!selection.size) throw new Error('Select vertices, edges or faces to flatten.');
  const vertices = [...selection].sort((a, b) => a - b);
  const { normal, origin } = plane.mode === 'bestFit' ? fitPlane(mesh, vertices) : specifiedPlane(plane.normal, plane.offset);
  const positions = mesh.positions.slice(), changed = new Set<number>();
  const vertex = new Vector3(), relative = new Vector3();
  for (const id of vertices) {
    vertex.fromArray(mesh.positions, id * 3);
    relative.copy(vertex).sub(origin);
    const distance = relative.dot(normal);
    // Ignore errors at the precision of the dot product when a point is already on the plane.
    const magnitude = Math.abs(relative.x * normal.x) + Math.abs(relative.y * normal.y) + Math.abs(relative.z * normal.z);
    if (Math.abs(distance) <= 8 * Number.EPSILON * magnitude) continue;
    vertex.addScaledVector(normal, -distance);
    const projected = vertex.toArray();
    if (!projected.every(value => Number.isFinite(Math.fround(value)))) throw new Error('The plane puts vertices outside the supported coordinate range.');
    if (projected.every((value, axis) => value === mesh.positions[id * 3 + axis])) continue;
    positions.set(projected, id * 3);
    changed.add(id);
  }
  if (!changed.size) throw new Error('The selected vertices already lie on the plane.');
  return { positions, changed };
}

function specifiedPlane(direction: Vec3, offset: number) {
  const scale = Math.max(...direction.map(Math.abs));
  if (!Number.isFinite(scale) || !scale || !Number.isFinite(offset)) throw new Error('Enter a finite, nonzero plane normal and a finite offset.');
  const normal = new Vector3(direction[0] / scale, direction[1] / scale, direction[2] / scale).normalize();
  return { normal, origin: normal.clone().multiplyScalar(offset) };
}

function fitPlane(mesh: MeshData, vertices: readonly number[]) {
  if (vertices.length < 3) throw new Error('Best Fit needs at least three non-collinear vertices.');
  const anchor = new Vector3(...point(mesh, vertices[0]));
  const mean = new Vector3(), relative = new Vector3();
  for (const id of vertices) mean.add(relative.fromArray(mesh.positions, id * 3).sub(anchor));
  mean.divideScalar(vertices.length);
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const id of vertices) {
    const { x, y, z } = relative.fromArray(mesh.positions, id * 3).sub(anchor).sub(mean);
    xx += x * x; yy += y * y; zz += z * z;
    xy += x * y; xz += x * z; yz += y * z;
  }
  const scale = Math.max(xx, yy, zz);
  if (!scale) throw new Error('Best Fit needs at least three non-collinear vertices.');
  const covariance = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]].map(row => row.map(value => value / scale));
  return { normal: leastVarianceDirection(covariance), origin: mean.add(anchor) };
}

function leastVarianceDirection(matrix: number[][]) {
  const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // Jacobi rotations diagonalize the symmetric covariance. The least-variance axis is the fitted normal.
  for (let step = 0; step < 24; step++) {
    let p = 0, q = 1;
    if (Math.abs(matrix[0][2]) > Math.abs(matrix[p][q])) q = 2;
    if (Math.abs(matrix[1][2]) > Math.abs(matrix[p][q])) { p = 1; q = 2; }
    const offDiagonal = matrix[p][q];
    if (Math.abs(offDiagonal) < 1e-15) break;
    const angle = .5 * Math.atan2(2 * offDiagonal, matrix[q][q] - matrix[p][p]);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const pp = matrix[p][p], qq = matrix[q][q];
    matrix[p][p] = cos * cos * pp - 2 * cos * sin * offDiagonal + sin * sin * qq;
    matrix[q][q] = sin * sin * pp + 2 * cos * sin * offDiagonal + cos * cos * qq;
    matrix[p][q] = matrix[q][p] = 0;
    for (let i = 0; i < 3; i++) {
      if (i !== p && i !== q) {
        const ip = matrix[i][p], iq = matrix[i][q];
        matrix[i][p] = matrix[p][i] = cos * ip - sin * iq;
        matrix[i][q] = matrix[q][i] = sin * ip + cos * iq;
      }
      const bp = basis[i][p], bq = basis[i][q];
      basis[i][p] = cos * bp - sin * bq;
      basis[i][q] = sin * bp + cos * bq;
    }
  }
  const [first, second, third] = [0, 1, 2].sort((a, b) => matrix[a][a] - matrix[b][b]);
  const tolerance = 1e-12 * matrix[third][third];
  if (matrix[second][second] <= tolerance) throw new Error('Best Fit needs at least three non-collinear vertices.');
  if (matrix[second][second] - matrix[first][first] <= tolerance) throw new Error('This selection has no unique best-fit plane. Choose a specified plane.');
  return new Vector3(basis[0][first], basis[1][first], basis[2][first]).normalize();
}
