import { Box3, Vector3 } from 'three';
import { validatePatch } from '../repair/intersections';
import { freeUvBox } from '../uv/free-space';
import { edgeKey, edgesOf, ensureUvChannel, next, type Corner, type Face, type MeshData, type Side } from './data';
import { tangentFrame } from './normals';
import { faceNormal, vector } from './polygon';

export const extrudeDirections = ['normal', 'x', 'y', 'z'] as const;
export type ExtrudeDirection = typeof extrudeDirections[number];
export type ExtrudeSelection = { faces: readonly number[] } | { edges: readonly string[] };
type RimEdge = { a: Corner; b: Corner; face: Face };

export function extrude(source: MeshData, selection: ExtrudeSelection, depth: number, direction: ExtrudeDirection) {
  if (source.weights || source.channels.some(({ name }) => name.startsWith('morph:'))) throw new Error('Extrude supports static meshes without skin or morph targets.');
  if (!Number.isFinite(depth) || depth === 0 || !extrudeDirections.includes(direction)) throw new Error('Choose an extrusion direction and a finite, nonzero depth.');
  const mesh = ensureUvChannel(source), incident = edgesOf(mesh);
  const region = 'faces' in selection ? new Set(selection.faces) : undefined;
  const faces = region ? mesh.faces.filter(face => region.has(face.id)) : [];
  const rim: RimEdge[] = [], neighbors = new Map<number, number[]>();
  const end = ({ face, corner }: Side) => face.corners[next(face, corner)];
  if (region) {
    if (!faces.length || faces.length !== region.size) throw new Error('Select an existing face region to extrude.');
    for (const sides of incident.values()) {
      const inside = sides.filter(side => region.has(side.face.id));
      if (!inside.length) continue;
      if (sides.length > 2 || sides.length === 2 && (sides[0].face.id === sides[1].face.id ||
          sides[0].face.corners[sides[0].corner].vertex !== end(sides[1]).vertex)) {
        throw new Error('The selected region touches a non-manifold or inconsistently wound edge.');
      }
      const [a, b] = inside;
      if (b) {
        for (const [x, y] of [[a.face.id, b.face.id], [b.face.id, a.face.id]]) {
          const list = neighbors.get(x) ?? [];
          list.push(y); neighbors.set(x, list);
        }
      } else rim.push({ a: a.face.corners[a.corner], b: end(a), face: a.face });
    }
    const reached = new Set([faces[0].id]);
    for (const id of reached) for (const adjacent of neighbors.get(id) ?? []) reached.add(adjacent);
    if (reached.size !== faces.length) throw new Error('Select one edge-connected face region.');
  } else if ('edges' in selection) {
    for (const edge of selection.edges) {
      const sides = incident.get(edge);
      if (sides?.length !== 1) throw new Error('Edge Extrude requires open boundary edges. Use Face mode to extrude a region.');
      const [side] = sides;
      rim.push({ a: end(side), b: side.face.corners[side.corner], face: side.face });
    }
  }
  const paths = rimPaths(rim, !!region);
  const offset = new Vector3();
  if (direction === 'normal') {
    for (const face of new Set(region ? faces : rim.map(edge => edge.face))) offset.add(faceNormal(mesh, face));
    if (!offset.lengthSq()) throw new Error('The selected faces have no average normal. Choose an axis.');
    offset.normalize();
  } else offset.setComponent(['x', 'y', 'z'].indexOf(direction), 1);
  offset.multiplyScalar(depth);

  const used = new Set(region ? faces.flatMap(face => face.corners.map(corner => corner.vertex))
    : rim.flatMap(({ a, b }) => [a.vertex, b.vertex]));
  const keptFaces = mesh.faces.filter(face => !region?.has(face.id));
  const duplicate = new Set(rim.flatMap(({ a, b }) => [a.vertex, b.vertex]));
  if (region) for (const face of keptFaces) for (const { vertex } of face.corners) {
    if (used.has(vertex)) duplicate.add(vertex);
  }
  const first = mesh.positions.length / 3;
  const copies = new Map([...duplicate].sort((a, b) => a - b).map((old, i) => [old, first + i]));
  const moved = (id: number) => copies.get(id) ?? id;
  const positions = new Float64Array(mesh.positions.length + copies.size * 3), bounds = new Box3();
  positions.set(mesh.positions);
  for (const old of used) {
    const point = vector(mesh, old);
    bounds.expandByPoint(point);
    const projected = point.add(offset).toArray();
    if (!projected.every(v => Number.isFinite(Math.fround(v)))) throw new Error('Extrude would exceed the supported coordinate range.');
    positions.set(projected, moved(old) * 3);
  }
  const copy = (corner: Corner) => ({ ...corner, vertex: moved(corner.vertex) });
  const rest = { ...mesh, positions, faces: keptFaces };
  const caps = faces.map(face => ({ ...face, corners: face.corners.map(copy) }));
  const channels = mesh.channels.flatMap(({ name }, i) => /^uv\d*$/.test(name) ? [i] : []);
  const channelSet = new Set(channels), free = freeUvBox(mesh, channels);
  // Keep a usable strip for subsequent unwrapping even when the original tile is already occupied.
  const { x0, x1, y0, y1 } = free ?? { x0: 1.01, x1: 1.99, y0: .01, y1: .99 };
  const row = (y1 - y0) / paths.length;
  const walls: Face[] = [];
  const exposed: [number, number][] = [];
  for (const [i, path] of paths.entries()) {
    const lengths = path.map(({ a, b }) => vector(mesh, a.vertex).distanceTo(vector(mesh, b.vertex)));
    const total = lengths.reduce((sum, number) => sum + number, 0);
    if (!(total > 0)) throw new Error('The extrusion boundary has zero length.');
    const startV = y0 + i * row, endV = startV + row * .9;
    let u = x0;
    for (const [j, { a, b, face }] of path.entries()) {
      const a1 = copy(a), b1 = copy(b), u1 = u + (x1 - x0) * lengths[j] / total;
      const v = mesh.glb ? endV : startV, v1 = mesh.glb ? startV : endV;
      const normal = vector(mesh, b.vertex).sub(vector(mesh, a.vertex)).cross(offset).normalize().toArray();
      const withUv = (corner: Corner, uv: readonly number[]): Corner => ({ ...corner,
        attributes: corner.attributes.map((attr, index) => channelSet.has(index) ? uv : mesh.channels[index].name === 'normal' ? normal : attr) });
      walls.push(tangentFrame(rest, { id: mesh.nextFace + walls.length, material: face.material, created: true, repaired: true,
        needsUv: free ? undefined : true, corners: [withUv(a, [u, v]), withUv(b, [u1, v]), withUv(b1, [u1, v1]), withUv(a1, [u, v1])],
        triangles: [0, 1, 2, 0, 2, 3] }));
      if (!region) exposed.push([a1.vertex, b1.vertex]);
      u = u1;
    }
    const start = path[0].a.vertex, end = path[path.length - 1].b.vertex;
    if (!region && start !== end) exposed.push([start, copies.get(start)!], [end, copies.get(end)!]);
  }
  validatePatch(rest, [...caps, ...walls], { edges: rim.map(({ a, b }) => [b.vertex, a.vertex]),
    diameter: Math.max(bounds.getSize(new Vector3()).length(), Math.abs(depth)) }, undefined, true, exposed);

  const replacements = new Map(caps.map(face => [face.id, face]));
  const result: MeshData = { ...rest, faces: [...mesh.faces.map(face => replacements.get(face.id) ?? face), ...walls], nextFace: mesh.nextFace + walls.length };
  const originalEdges = new Set<string>(), capEdges = new Set<string>();
  if (mesh.uvSeams) {
    for (const face of result.faces) for (const [i, corner] of face.triangles.entries()) {
      const other = face.triangles[i % 3 === 2 ? i - 2 : i + 1];
      originalEdges.add(edgeKey(face.corners[corner].vertex, face.corners[other].vertex));
      if (replacements.has(face.id)) capEdges.add(edgeKey(face.corners[corner].vertex, face.corners[other].vertex));
    }
  }
  const uvSeams = mesh.uvSeams && Object.fromEntries(Object.entries(mesh.uvSeams).map(([channel, seams]) => [channel, seams.flatMap(key => {
    const [a, b] = key.split('/').map(Number), mapped = edgeKey(moved(a), moved(b));
    return [...(originalEdges.has(key) ? [key] : []), ...(mapped !== key && capEdges.has(mapped) ? [mapped] : [])];
  })]));
  const edges = new Map<string, string[]>();
  const follow = (a: number, b: number) => edges.set(edgeKey(a, b), [edgeKey(moved(a), moved(b))]);
  if (region) for (const face of faces) for (const [i, corner] of face.corners.entries()) follow(corner.vertex, face.corners[next(face, i)].vertex);
  else for (const { a, b } of rim) follow(a.vertex, b.vertex);
  return { mesh: { ...result, uvSeams }, copies, edges, walls: walls.length, projected: !!free };
}

function rimPaths(edges: readonly RimEdge[], region: boolean) {
  if (!edges.length) throw new Error('Choose open edges or a face region with a perimeter.');
  const from = new Map<number, RimEdge>(), ends = new Set<number>();
  for (const edge of edges) {
    if (from.has(edge.a.vertex) || ends.has(edge.b.vertex)) throw new Error('The extrusion perimeter must not branch.');
    from.set(edge.a.vertex, edge); ends.add(edge.b.vertex);
  }
  const starts = edges.filter(edge => !ends.has(edge.a.vertex));
  if (region && starts.length) throw new Error('The face region must have closed perimeter loops.');
  const paths: RimEdge[][] = [];
  for (const seed of [...starts, ...edges]) {
    if (!from.has(seed.a.vertex)) continue;
    const path: RimEdge[] = [];
    let edge: RimEdge | undefined = seed;
    while (edge) {
      path.push(edge); from.delete(edge.a.vertex);
      edge = from.get(edge.b.vertex);
    }
    paths.push(path);
  }
  if (!region && paths.length !== 1) throw new Error('Select one connected open-edge chain or loop.');
  return paths;
}
