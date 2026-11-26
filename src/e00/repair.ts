import { Mesh, SkinnedMesh, Vector3 } from 'three';
import { sourceMesh, type FbxSourceMesh } from './fbx-topology';
import type { ImportedAsset } from './round-trip';

export type RepairMethod = 'smooth' | 'grid';

interface Face {
  id: number;
  start: number;
  vertices: number[];
}

export interface RepairPatch {
  inputGeometry: Mesh['geometry'];
  positions: Float64Array;
  polygons: Int32Array;
  sourceCorners: Uint32Array<ArrayBuffer>;
  metadata: ReturnType<typeof describePatch>;
}

export function repairQuadPatch(asset: ImportedAsset, center: number, method: RepairMethod): ImportedAsset {
  const mesh = asset.scene.getObjectByProperty('isMesh', true);
  if (!(mesh instanceof Mesh) || mesh instanceof SkinnedMesh || asset.stats.meshes !== 1 ||
      asset.positionEdit || asset.uvAtlas || asset.repairPatch) {
    throw new Error('The E00 fill requires a single unedited static FBX mesh.');
  }
  const source = sourceMesh(mesh.geometry);
  if (source.hasMorphTargets || source.skin) throw new Error('The E00 fill requires a static mesh without morph targets.');
  const faces = readFaces(source.polygons);
  const removed = faces.filter(face => face.vertices.includes(center));
  if (removed.length !== 4 || removed.some(face => new Set(face.vertices).size !== 4 || face.vertices.length !== 4)) {
    throw new Error('Select an interior control point shared by exactly four quads.');
  }
  const boundary = patchBoundary(faces, removed, center);
  const point = (id: number) => new Vector3().fromArray(source.positions, id * 3);
  const originalCenter = point(center);
  const ring = boundary.map(point);
  const normal = new Vector3();
  for (let i = 0; i < ring.length; i++) {
    normal.add(ring[i].clone().sub(originalCenter).cross(ring[(i + 1) % ring.length].clone().sub(originalCenter)));
  }
  normal.normalize();
  const target = new Vector3();
  for (let i = 0; i < ring.length; i++) {
    // The boundary alternates side midpoints and corners. Coons at (0.5, 0.5)
    // blends four edge midpoints and subtracts the bilinear corner term.
    target.addScaledVector(ring[i], method === 'smooth' ? 1 / 8 : i % 2 === 0 ? 0.5 : -0.25);
  }
  if (!starShaped(ring, originalCenter, normal) || !starShaped(ring, target, normal)) {
    throw new Error('The selected boundary would produce collapsed or overlapping patch triangles.');
  }
  if (method === 'grid') {
    for (const face of removed) {
      const quad = face.vertices.map(id => id === center ? target : point(id));
      if (quad.some((p, i) => quad[(i + 1) % 4].clone().sub(p)
        .cross(quad[(i + 2) % 4].clone().sub(quad[(i + 1) % 4])).dot(normal) <= 1e-12)) {
        throw new Error('Grid Fill requires convex cells in the patch projection.');
      }
    }
  }

  const fill = new Map<number, number[][]>();
  for (let sector = 0; sector < 8; sector += 2) {
    const quad = [center, boundary[sector], boundary[sector + 1], boundary[(sector + 2) % 8]];
    const original = removed.find(face => {
      const start = face.vertices.indexOf(center);
      return quad.every((id, i) => face.vertices[(start + i) % 4] === id);
    });
    if (!original) throw new Error('A grid sector has no unambiguous original corner mapping.');
    // Keep each reconstructed grid cell's original cyclic start for FBX readers
    // whose quad triangulation can depend on the first corner.
    const start = quad.indexOf(original.vertices[0]);
    const cells = method === 'grid' ? [quad.slice(start).concat(quad.slice(0, start))]
      : [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]];
    fill.set(original.id, cells.map(cell => cell.map(id => original.start + original.vertices.indexOf(id))));
  }
  const polygons: number[] = [], corners: number[] = [];
  const inserted: { face: Face; corners: number[][] }[] = [];
  for (const face of faces) {
    const replacements = fill.get(face.id);
    if (replacements) inserted.push({ face, corners: replacements });
    const polygonsByCorner = replacements ?? [face.vertices.map((_, i) => face.start + i)];
    for (const polygon of polygonsByCorner) {
      polygon.forEach((corner, i) => {
        const vertex = face.vertices[corner - face.start];
        polygons.push(i === polygon.length - 1 ? -vertex - 1 : vertex);
        corners.push(corner);
      });
    }
  }
  const positions = Float64Array.from(source.positions);
  target.toArray(positions, center * 3);
  const metadata = describePatch(source, method, center, boundary, inserted, originalCenter, target);
  const repairPatch = { inputGeometry: mesh.geometry, positions, polygons: Int32Array.from(polygons),
    sourceCorners: Uint32Array.from(corners), metadata };
  return { ...asset, repairPatch };
}

function readFaces(polygons: ArrayLike<number>): Face[] {
  const faces: Face[] = [];
  let start = 0, vertices: number[] = [];
  for (let i = 0; i < polygons.length; i++) {
    const index = polygons[i];
    vertices.push(index < 0 ? -index - 1 : index);
    if (index >= 0) continue;
    faces.push({ id: faces.length, start, vertices });
    vertices = [];
    start = i + 1;
  }
  if (vertices.length) throw new Error('The source FBX has an unterminated polygon.');
  return faces;
}

function patchBoundary(faces: Face[], removed: Face[], center: number): number[] {
  const sides = new Map<number, number>(), midpoints = new Set<number>();
  const edges = new Set<string>();
  for (const { vertices } of removed) {
    const i = vertices.indexOf(center);
    const [a, b, c] = [1, 2, 3].map(k => vertices[(i + k) % 4]);
    midpoints.add(a);
    for (const [from, to] of [[a, b], [b, c]]) {
      if (sides.has(from) || edges.has(`${to}/${from}`)) throw new Error('The patch boundary branches or repeats an edge.');
      sides.set(from, to);
      edges.add(`${from}/${to}`);
    }
  }
  const first = Math.min(...midpoints);
  const boundary: number[] = [first];
  while (boundary.length < 8) {
    const next = sides.get(boundary.at(-1)!);
    if (next === undefined || boundary.includes(next)) throw new Error('The four quads do not form one simple ring.');
    boundary.push(next);
  }
  if (sides.get(boundary[7]) !== first || boundary.some((vertex, i) => midpoints.has(vertex) !== (i % 2 === 0))) {
    throw new Error('The ring must have four sides with two edges on each side.');
  }
  const reverse = new Set<string>();
  const selected = new Set(removed);
  for (const face of faces) {
    if (selected.has(face)) continue;
    face.vertices.forEach((from, i) => {
      const to = face.vertices[(i + 1) % face.vertices.length];
      const opposite = `${to}/${from}`;
      if (edges.has(`${from}/${to}`) || reverse.has(opposite)) {
        throw new Error('The selected boundary is non-manifold or has inconsistent winding.');
      }
      if (edges.has(opposite)) reverse.add(opposite);
    });
  }
  if (reverse.size !== sides.size) throw new Error('The patch must be attached to the surrounding surface on every boundary edge.');
  return boundary;
}

function starShaped(ring: Vector3[], center: Vector3, normal: Vector3): boolean {
  const rays = ring.map(point => point.clone().sub(center).projectOnPlane(normal));
  const angles = rays.map((a, i) => {
    const b = rays[(i + 1) % rays.length];
    const area = a.clone().cross(b).dot(normal);
    return area > 1e-12 ? Math.atan2(area, a.dot(b)) : NaN;
  });
  return Math.abs(angles.reduce((total, angle) => total + angle, 0) - 2 * Math.PI) < 1e-6;
}

function describePatch(source: FbxSourceMesh, method: RepairMethod, center: number, boundary: number[],
  faces: { face: Face; corners: number[][] }[], before: Vector3, after: Vector3) {
  const position = (point: Vector3) => point.applyMatrix4(source.preTransform).toArray();
  return {
    method, center, boundary, before: position(before.clone()), after: position(after.clone()),
    boundaryPositions: boundary.map(id => {
      const [x, y, z] = position(new Vector3().fromArray(source.positions, id * 3));
      return { x, y, z };
    }),
    removed: faces.map(({ face }) => ({
      face: face.id, vertices: face.vertices,
      uv: source.uvs[0] && face.vertices.map((id, i) => {
        const coordinates = source.readCorner(face.start + i, face.id, id, source.uvs[0]);
        return { x: coordinates[0], y: coordinates[1] };
      }),
    })),
    replacementPolygons: faces.reduce((count, face) => count + face.corners.length, 0),
  };
}
