import { ShapeUtils, Vector2, Vector3 } from 'three';
import { point, type Face, type MeshData } from './data';

export const vector = (mesh: MeshData, vertex: number) => new Vector3(...point(mesh, vertex));

export function faceNormal(mesh: MeshData, face: Pick<Face, 'corners'>) {
  const origin = vector(mesh, face.corners[0].vertex), normal = new Vector3();
  for (let i = 1; i < face.corners.length - 1; i++) {
    normal.add(vector(mesh, face.corners[i].vertex).sub(origin).cross(vector(mesh, face.corners[i + 1].vertex).sub(origin)));
  }
  return normal;
}

export function polygon(mesh: MeshData, vertices: readonly number[], strict = false) {
  if (vertices.length < 3 || vertices.length > 1024 || new Set(vertices).size !== vertices.length) {
    throw new Error('A face needs 3 to 1,024 distinct vertices in contour order.');
  }
  const points = vertices.map(id => vector(mesh, id)), origin = points[0];
  const extent = Math.max(...points.map(p => p.distanceTo(origin)));
  const normal = faceNormal(mesh, { corners: vertices.map(vertex => ({ vertex, attributes: [] })) });
  if (!extent || normal.length() < extent ** 2 * 1e-9) throw new Error('The contour has zero area or intersects itself.');
  normal.normalize();
  if (strict && points.some(p => Math.abs(p.clone().sub(origin).dot(normal)) > extent * .025)) {
    throw new Error('The contour is too far from a plane. Build smaller faces across the opening.');
  }
  const tangent = new Vector3(Math.abs(normal.x) < .8 ? 1 : 0, Math.abs(normal.x) < .8 ? 0 : 1, 0).cross(normal).normalize();
  const bitangent = normal.clone().cross(tangent);
  const contour = points.map(p => new Vector2(p.clone().sub(origin).dot(tangent) / extent, p.clone().sub(origin).dot(bitangent) / extent));
  for (let i = 0; i < contour.length; i++) for (let j = i + 2; j < contour.length; j++) {
    if (!i && j === contour.length - 1) continue;
    if (intersects(contour[i], contour[(i + 1) % contour.length], contour[j], contour[(j + 1) % contour.length])) {
      throw new Error('The contour crosses itself. Change the vertex order.');
    }
  }
  const triangles = ShapeUtils.triangulateShape(contour.slice(), []).map(([a, b, c]) =>
    orient(contour[a], contour[b], contour[c]) > 0 ? [a, b, c] : [a, c, b]).flat();
  if (triangles.length !== (vertices.length - 2) * 3 || new Set(triangles).size !== vertices.length) {
    throw new Error('The contour cannot be triangulated with every selected vertex.');
  }
  const us = contour.map(v => v.x), vs = contour.map(v => v.y);
  const loU = Math.min(...us), loV = Math.min(...vs), du = Math.max(...us) - loU, dv = Math.max(...vs) - loV;
  return { triangles, normal: normal.toArray(), uv: contour.map(v => [(v.x - loU) / du, (v.y - loV) / dv]) };
}

function orient(a: Vector2, b: Vector2, c: Vector2) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function intersects(a: Vector2, b: Vector2, c: Vector2, d: Vector2) {
  const e = 1e-10;
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) - e || Math.max(c.x, d.x) < Math.min(a.x, b.x) - e ||
      Math.max(a.y, b.y) < Math.min(c.y, d.y) - e || Math.max(c.y, d.y) < Math.min(a.y, b.y) - e) return false;
  const p = orient(a, b, c), q = orient(a, b, d), r = orient(c, d, a), s = orient(c, d, b);
  return (p < e && q > -e || q < e && p > -e) && (r < e && s > -e || s < e && r > -e);
}
