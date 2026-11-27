import { Vector3 } from 'three';
import { edgesOf, next, type Face, type MeshData } from './data';
import { faceNormal, vector } from './polygon';

export function recalculate(mesh: MeshData, affected: ReadonlySet<number>, reference = mesh): MeshData {
  const slot = mesh.channels.findIndex(channel => channel.name === 'normal');
  if (slot < 0 || !affected.size) return mesh;
  const offsets = new Map<number, number>();
  let total = 0;
  for (const face of mesh.faces) {
    offsets.set(face.id, total);
    total += face.corners.length;
  }
  const roots = Int32Array.from({ length: total }, (_, i) => i);
  const root = (i: number) => {
    while (i !== roots[i]) { roots[i] = roots[roots[i]]; i = roots[i]; }
    return i;
  };
  const unify = (a: number, b: number) => { roots[root(a)] = root(b); };
  const oldFaces = new Map(reference.faces.map(face => [face.id, face]));
  for (const sides of edgesOf(mesh).values()) {
    if (sides.length !== 2) continue;
    const [a, b] = sides, aa = next(a.face, a.corner), bb = next(b.face, b.corner);
    if (a.face.corners[a.corner].vertex !== b.face.corners[bb].vertex) continue;
    const agrees = (i: number, j: number) => {
      const x = oldFaces.get(a.face.id)!.corners[i].attributes[slot], y = oldFaces.get(b.face.id)!.corners[j].attributes[slot];
      return x.every((value, k) => Math.abs(value - y[k]) <= 1e-5);
    };
    if (!agrees(a.corner, bb) || !agrees(aa, b.corner)) continue;
    unify(offsets.get(a.face.id)! + a.corner, offsets.get(b.face.id)! + bb);
    unify(offsets.get(a.face.id)! + aa, offsets.get(b.face.id)! + b.corner);
  }
  const sums = new Map<number, Vector3>(), touched = new Set<number>();
  for (const face of mesh.faces) {
    const normal = faceNormal(mesh, face), start = offsets.get(face.id)!;
    for (let i = 0; i < face.corners.length; i++) {
      const r = root(start + i);
      const sum = sums.get(r);
      if (sum) sum.add(normal);
      else sums.set(r, normal.clone());
      if (affected.has(face.id)) touched.add(r);
    }
  }
  return { ...mesh, faces: mesh.faces.map(face => {
    let changed = false;
    const corners = face.corners.map((corner, i) => {
      const id = root(offsets.get(face.id)! + i);
      if (!touched.has(id) || !sums.get(id)!.lengthSq()) return corner;
      changed = true;
      const attributes = corner.attributes.slice();
      attributes[slot] = sums.get(id)!.clone().normalize().toArray();
      return { ...corner, attributes };
    });
    return changed ? tangentFrame(mesh, { ...face, corners }) : face;
  }) };
}

export function tangentFrame(mesh: MeshData, face: Face): Face {
  const tangent = mesh.channels.findIndex(channel => channel.name === 'tangent');
  const normal = mesh.channels.findIndex(channel => channel.name === 'normal');
  const uv = mesh.channels.findIndex(channel => channel.name === 'uv' || channel.name === 'uv0');
  if (tangent < 0 || normal < 0 || uv < 0) return face;
  const u = new Vector3(), v = new Vector3();
  for (let i = 0; i < face.triangles.length; i += 3) {
    const [a, b, c] = face.triangles.slice(i, i + 3).map(j => face.corners[j]);
    const p = vector(mesh, a.vertex), e = vector(mesh, b.vertex).sub(p), f = vector(mesh, c.vertex).sub(p);
    const [s, t] = a.attributes[uv], [s1, t1] = b.attributes[uv], [s2, t2] = c.attributes[uv];
    const det = (s1 - s) * (t2 - t) - (s2 - s) * (t1 - t);
    if (Math.abs(det) <= 1e-12) continue;
    u.addScaledVector(e, (t2 - t) / det).addScaledVector(f, -(t1 - t) / det);
    v.addScaledVector(e, -(s2 - s) / det).addScaledVector(f, (s1 - s) / det);
  }
  return { ...face, corners: face.corners.map(corner => {
    const [x, y, z] = corner.attributes[normal], n = new Vector3(x, y, z);
    const t = u.clone().addScaledVector(n, -n.dot(u));
    if (!t.lengthSq()) return corner;
    t.normalize();
    const attributes = corner.attributes.slice();
    attributes[tangent] = [...t.toArray(), n.clone().cross(t).dot(v) < 0 ? -1 : 1];
    return { ...corner, attributes };
  }) };
}
