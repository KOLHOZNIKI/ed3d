import { Euler, Matrix3, Matrix4, Vector3 } from 'three';
import type { MeshEdit } from './commands';
import { edgeKey, edgesOf, edgeVertices, ensureUvChannel, next, point, usedVertices, verticesOf, type Corner, type Face, type MeshData, type Side, type Weight } from './data';
import { faceNormal, polygon, vector } from './polygon';
import { recalculate, tangentFrame } from './normals';
import { applyRepairs } from '../repair/fill';
import { validatePatch } from '../repair/intersections';
import { applyUvLayout } from '../uv/mesh-layout';
import { applyWeightEdits } from '../weights/data';
import { softWeights } from './soft-selection';
import { smoothSelection } from './smooth-selection';
import { flattenSelection } from './flatten-selection';

type VertexSource = readonly [vertex: number, factor: number];
// Missing replacement entries keep their stable ID. Empty lists remove it from the source object.
interface TopologyChanges {
  readonly vertices: ReadonlyMap<number, readonly number[]>;
  readonly edges: ReadonlyMap<string, readonly string[]>;
  readonly faces: ReadonlyMap<number, readonly number[]>;
  readonly vertexSources: ReadonlyMap<number, readonly VertexSource[]>;
  readonly addedFaces: readonly number[];
  readonly pieceVertices?: ReadonlyMap<number, number>;
  readonly pieceFaces?: readonly number[];
}

interface MeshResult {
  mesh: MeshData;
  piece?: MeshData;
  topology?: TopologyChanges;
  influence?: ReadonlyMap<number, number>;
  smoothing?: { pinned: ReadonlySet<number>; changed: number };
}

function topologyChange(source: MeshData, result: MeshResult, changes: Partial<TopologyChanges> = {}): MeshResult {
  const survivingFaces = new Set(result.mesh.faces.map(face => face.id));
  const faces = new Map(changes.faces);
  for (const face of source.faces) if (!survivingFaces.has(face.id) && !faces.has(face.id)) faces.set(face.id, []);
  const liveVertices = new Set(usedVertices(result.mesh.faces));
  const vertices = new Map(changes.vertices);
  for (const vertex of usedVertices(source.faces)) {
    if (!liveVertices.has(vertex) && !vertices.has(vertex)) vertices.set(vertex, []);
  }
  const survivingEdges = edgesOf(result.mesh), edges = new Map(changes.edges);
  for (const key of edgesOf(source).keys()) {
    if (survivingEdges.has(key) || edges.has(key)) continue;
    const [a, b] = edgeVertices(key);
    const x = vertices.has(a) ? vertices.get(a)?.[0] : a, y = vertices.has(b) ? vertices.get(b)?.[0] : b;
    const target = x !== undefined && y !== undefined && edgeKey(x, y);
    edges.set(key, target && survivingEdges.has(target) ? [target] : []);
  }
  return { ...result, topology: { vertices, edges, faces, vertexSources: changes.vertexSources ?? new Map(),
    addedFaces: result.mesh.faces.filter(face => face.id >= source.nextFace).map(face => face.id),
    pieceVertices: changes.pieceVertices, pieceFaces: result.piece?.faces.map(face => face.id) } };
}

export function applyMeshEdit(mesh: MeshData, edit: MeshEdit): MeshResult {
  switch (edit.type) {
    case 'weights': return { mesh: applyWeightEdits(mesh, edit.rows) };
    case 'uv': return { mesh: applyUvLayout(mesh, edit) };
    case 'repair': {
      const vertexSources = new Map<number, readonly VertexSource[]>();
      const repaired = applyRepairs(mesh, edit.patches, (vertex, sources) => vertexSources.set(vertex, sources));
      return topologyChange(mesh, { mesh: repaired }, { vertexSources });
    }
    case 'extract': {
      const ids = pickFaces(mesh, edit.faces);
      const faces = mesh.faces.filter(face => ids.has(face.id));
      if (!faces.length || edit.cut && faces.length === mesh.faces.length) throw new Error('Cut must leave at least one source face. Use Copy for the whole mesh.');
      const vertices = usedVertices(faces), remap = new Map(vertices.map((id, i) => [id, i]));
      const positions = Float64Array.from(vertices.flatMap(id => point(mesh, id).map((value, axis) => value - edit.pivot[axis])));
      if (!positions.every(value => Number.isFinite(Math.fround(value)))) throw new Error('The extract pivot exceeds the geometry coordinate range.');
      const selected = filterFaces(mesh, faces);
      const corners = faces.map(face => ({ ...face, corners: face.corners.map(corner => ({ ...corner, vertex: remap.get(corner.vertex)! })) }));
      const uvSeams = selected.uvSeams && Object.fromEntries(Object.entries(selected.uvSeams).map(([channel, edges]) =>
        [channel, edges.map(key => { const [a, b] = edgeVertices(key); return edgeKey(remap.get(a)!, remap.get(b)!); })]));
      return topologyChange(mesh, { mesh: edit.cut ? filterFaces(mesh, mesh.faces.filter(face => !ids.has(face.id))) : mesh,
        piece: { ...selected, positions, faces: corners, uvSeams } }, { pieceVertices: remap });
    }
    case 'move': case 'rotate': case 'scale': case 'softTransform': return transform(mesh, edit);
    case 'smoothSelection': {
      const faces = edit.faces && pickFaces(mesh, edit.faces);
      const vertices = edit.vertices ? pickVertices(mesh, edit.vertices) : new Set(mesh.faces.filter(face => faces!.has(face.id)).flatMap(verticesOf));
      const { positions, changed, pinned } = smoothSelection(mesh, vertices, faces, edit.settings);
      return { mesh: deform(mesh, positions, changed), smoothing: { pinned, changed: changed.size } };
    }
    case 'flattenSelection': {
      const { positions, changed } = flattenSelection(mesh, pickVertices(mesh, edit.vertices), edit.plane);
      return { mesh: deform(mesh, positions, changed) };
    }
    case 'delete': case 'separate': {
      const faces = pickFaces(mesh, edit.faces);
      if (faces.size === mesh.faces.length) throw new Error('Keep at least one face in the source object.');
      const piece = edit.type === 'separate' ? filterFaces(mesh, mesh.faces.filter(face => faces.has(face.id))) : undefined;
      return topologyChange(mesh, { mesh: filterFaces(mesh, mesh.faces.filter(face => !faces.has(face.id))), piece },
        { pieceVertices: piece && new Map(usedVertices(piece.faces).map(id => [id, id])) });
    }
    case 'recalculate': return { mesh: recalculate(mesh, pickFaces(mesh, edit.faces)) };
    case 'flipNormals':
      return { mesh: flipNormals(mesh, pickFaces(mesh, edit.faces)) };
    case 'create': return topologyChange(mesh, { mesh: create(mesh, edit) });
    case 'splitEdge': {
      const [a, b] = edgeVertices(edit.edge), vertex = mesh.positions.length / 3;
      return topologyChange(mesh, { mesh: splitEdge(mesh, requireEdge(mesh, edit.edge), edit.fraction) }, {
        edges: new Map([[edit.edge, [edgeKey(a, vertex), edgeKey(b, vertex)]]]),
        vertexSources: new Map([[vertex, [[a, 1 - edit.fraction], [b, edit.fraction]]]]),
      });
    }
    case 'splitFace': return topologyChange(mesh, { mesh: splitFace(mesh, edit) }, { faces: new Map([[edit.face, [edit.face, mesh.nextFace]]]) });
    case 'dissolve': case 'flipEdge': {
      const sides = requireEdge(mesh, edit.edge), flip = edit.type === 'flipEdge', result = combine(mesh, sides, flip);
      const ids = sides.map(side => side.face.id), replacements = flip ? ids : ids.slice(0, 1);
      const nextEdge = flip ? edgeKey(...sides.map(({ face, corner }) => face.corners[(corner + 2) % 3].vertex) as [number, number]) : undefined;
      return topologyChange(mesh, { mesh: result }, { faces: new Map(ids.map(id => [id, replacements])),
        edges: new Map([[edit.edge, nextEdge ? [nextEdge] : []]]) });
    }
    case 'weld': {
      pickVertices(mesh, edit.vertices);
      const groups = weldGroups(mesh, edit), result = weld(mesh, edit, groups);
      const live = new Set(usedVertices(result.faces));
      const vertices = new Map<number, readonly number[]>(), sources = new Map<number, readonly VertexSource[]>();
      for (const group of groups) {
        const target = group[0];
        for (const vertex of group) vertices.set(vertex, live.has(target) ? [target] : []);
        if (edit.mode !== 'first' && live.has(target)) sources.set(target, group.map(id => [id, 1 / group.length]));
      }
      return topologyChange(mesh, { mesh: result }, { vertices, vertexSources: sources });
    }
  }
}

function filterFaces(mesh: MeshData, faces: readonly Face[]): MeshData {
  const result = { ...mesh, faces };
  if (!mesh.uvSeams) return result;
  const edges = edgesOf(result);
  return { ...result, uvSeams: Object.fromEntries(Object.entries(mesh.uvSeams).map(([channel, seams]) =>
    [channel, seams.filter(seam => edges.has(seam))])) };
}

function pickFaces(mesh: MeshData, ids: readonly number[]) {
  const selected = new Set(ids);
  if (mesh.faces.filter(face => selected.has(face.id)).length !== selected.size) throw new Error('Select existing faces.');
  return selected;
}

function pickVertices(mesh: MeshData, ids: readonly number[]) {
  const active = new Set(mesh.faces.flatMap(verticesOf));
  if (!ids.every(id => active.has(id))) throw new Error('Select existing vertices of this object.');
  return new Set(ids);
}

function requireEdge(mesh: MeshData, key: string) {
  const sides = edgesOf(mesh).get(key);
  if (!sides?.length) throw new Error('Select an existing edge.');
  return sides;
}

function transform(mesh: MeshData, edit: Extract<MeshEdit, { vertices: number[]; value: readonly number[] }>): MeshResult {
  const vertices = pickVertices(mesh, edit.vertices);
  const mode = edit.type === 'softTransform' ? edit.mode : edit.type;
  const influence = edit.type === 'softTransform' ? softWeights(mesh, vertices, edit.soft) : undefined;
  const positions = mesh.positions.slice(), value = new Vector3(...edit.value);
  const pivot = edit.pivot ? new Vector3(...edit.pivot) : center(mesh, edit.vertices);
  if (mode === 'scale' && Math.min(...edit.value) <= 0) throw new Error('Scale factors must be positive.');
  const rad = Math.PI / 180;
  const matrix = new Matrix4(), angles = new Euler(), factors = new Vector3();
  if (mode === 'rotate') matrix.makeRotationFromEuler(angles.set(value.x * rad, value.y * rad, value.z * rad));
  if (mode === 'scale') matrix.makeScale(...edit.value);
  const changed = new Set<number>();
  for (const id of influence?.keys() ?? vertices) {
    const start = vector(mesh, id), end = start.clone(), weight = influence?.get(id) ?? 1;
    if (mode === 'move') end.addScaledVector(value, weight);
    else {
      end.sub(pivot);
      if (weight === 1) end.applyMatrix4(matrix);
      else if (mode === 'scale') end.multiply(factors.set(1, 1, 1).lerp(value, weight));
      else end.applyEuler(angles.set(value.x * rad * weight, value.y * rad * weight, value.z * rad * weight));
      end.add(pivot);
    }
    if (!end.toArray().every(value => Number.isFinite(Math.fround(value)))) throw new Error('The transform produced invalid coordinates.');
    if (end.equals(start)) continue;
    end.toArray(positions, id * 3);
    changed.add(id);
  }
  if (!changed.size) throw new Error('The transform does not move the selection.');
  const affine = mode !== 'move' && mesh.faces.every(face => face.corners.every(c => vertices.has(c.vertex))) ? matrix : undefined;
  return { mesh: deform(mesh, positions, changed, affine), influence };
}

function deform(mesh: MeshData, positions: Float64Array, changed: ReadonlySet<number>, affine?: Matrix4): MeshData {
  const result = { ...mesh, positions };
  const transformedBasis = new Set<number>();
  const affected = new Set<number>();
  for (const face of mesh.faces) {
    if (!face.corners.some(corner => changed.has(corner.vertex))) continue;
    requireTriangles(result, face);
    if (affine) continue;
    if (changedShape(mesh, result, face)) transformedBasis.add(face.id);
    if (faceNormal(mesh, face).normalize().distanceToSquared(faceNormal(result, face).normalize()) > 1e-16) affected.add(face.id);
  }
  if (affine) {
    const normal = new Matrix3().getNormalMatrix(affine);
    return { ...result, faces: mesh.faces.map(face => ({ ...face, corners: face.corners.map(corner => ({
      ...corner,
      attributes: corner.attributes.map((values, i) => {
        const channel = mesh.channels[i].name;
        if (channel === 'normal') return new Vector3().fromArray(values).applyNormalMatrix(normal).toArray();
        if (channel === 'tangent') return [...new Vector3().fromArray(values).transformDirection(affine).toArray(), values[3]];
        return values;
      }),
    })) })) };
  }
  const updated = recalculate(result, affected, mesh);
  return { ...updated, faces: updated.faces.map((face, i) =>
    transformedBasis.has(face.id) && face === mesh.faces[i] ? tangentFrame(result, face) : face) };
}

function changedShape(before: MeshData, after: MeshData, face: Face) {
  const origin = face.corners[0].vertex, oldPoint = vector(before, origin), newPoint = vector(after, origin);
  return face.corners.slice(1).some(corner => vector(before, corner.vertex).sub(oldPoint)
    .distanceToSquared(vector(after, corner.vertex).sub(newPoint)) > 1e-20);
}

export function center(mesh: MeshData, ids: readonly number[]) {
  const sum = new Vector3();
  for (const id of ids) sum.add(vector(mesh, id));
  return sum.multiplyScalar(1 / ids.length);
}

function flipNormals(mesh: MeshData, faces: Set<number>) {
  const normal = mesh.channels.findIndex(channel => channel.name === 'normal');
  const tangent = mesh.channels.findIndex(channel => channel.name === 'tangent');
  return { ...mesh, faces: mesh.faces.map(face => {
    if (!faces.has(face.id)) return face;
    const reverse = (i: number) => face.corners.length - i - 1;
    const corners = face.corners.map((_, i) => {
      const corner = face.corners[reverse(i)], attributes = corner.attributes.slice();
      if (normal >= 0) attributes[normal] = attributes[normal].map(value => -value);
      if (tangent >= 0) attributes[tangent] = attributes[tangent].map((value, i) => i === 3 ? -value : value);
      return { ...corner, attributes };
    });
    const triangles = face.triangles.map((_, i) => reverse(face.triangles[i % 3 === 0 ? i : i % 3 === 1 ? i + 1 : i - 1]));
    return { ...face, corners, triangles };
  }) };
}

function create(mesh: MeshData, edit: MeshEdit & { type: 'create' }) {
  const selected = pickVertices(mesh, edit.vertices);
  if (edit.material >= mesh.materialCount) throw new Error('Choose an existing material slot.');
  if (mesh.faces.some(face => face.corners.length === selected.size && face.corners.every(c => selected.has(c.vertex)))) {
    throw new Error('A face already uses these vertices.');
  }
  const shape = polygon(mesh, edit.vertices, true);
  const open = edgesOf(mesh);
  for (const [i, a] of edit.vertices.entries()) {
    const b = edit.vertices[(i + 1) % edit.vertices.length];
    const sides = open.get(edgeKey(a, b)) ?? [];
    if (sides.length > 1) throw new Error('This face would create an edge with more than two incident faces.');
    if (sides[0]?.face.corners[sides[0].corner].vertex === a) throw new Error('The face follows a shared edge in the same direction. Flip or reorder the contour.');
  }
  if (edit.project) mesh = ensureUvChannel(mesh);
  const attributes = new Map<number, Corner['attributes']>();
  for (const face of mesh.faces) for (const corner of face.corners) {
    if (selected.has(corner.vertex) && !attributes.has(corner.vertex)) attributes.set(corner.vertex, corner.attributes);
  }
  const corners = edit.vertices.map((vertex, i) => ({
    vertex,
    attributes: mesh.channels.map(({ name }, k) => {
      if (name === 'normal') return shape.normal;
      if (/^uv\d*$/.test(name)) return edit.project ? shape.uv[i] : [0, 0];
      return attributes.get(vertex)![k];
    }),
  }));
  const face: Face = { id: mesh.nextFace, corners, triangles: shape.triangles, material: edit.material,
    created: true, needsUv: edit.project ? undefined : true };
  const facets: Face[] = [];
  for (let i = 0; i < shape.triangles.length; i += 3) {
    facets.push({ ...face, corners: shape.triangles.slice(i, i + 3).map(index => corners[index]), triangles: [0, 1, 2] });
  }
  const origin = vector(mesh, edit.vertices[0]);
  const diameter = Math.max(...edit.vertices.map(id => vector(mesh, id).distanceTo(origin)));
  validatePatch(mesh, facets, { diameter, edges: edit.vertices.map((id, i) => [id, edit.vertices[(i + 1) % edit.vertices.length]]) },
    new Vector3().fromArray(shape.normal));
  return { ...mesh, faces: [...mesh.faces, tangentFrame(mesh, face)], nextFace: mesh.nextFace + 1 };
}

function splitEdge(mesh: MeshData, sides: Side[], fraction: number) {
  const first = sides[0], a = first.face.corners[first.corner].vertex, b = first.face.corners[next(first.face, first.corner)].vertex;
  const [lo, hi] = edgeVertices(edgeKey(a, b));
  const vertex = mesh.positions.length / 3, positions = new Float64Array(mesh.positions.length + 3);
  positions.set(mesh.positions);
  vector(mesh, lo).lerp(vector(mesh, hi), fraction).toArray(positions, vertex * 3);
  const weights = mesh.weights && [...mesh.weights, mixWeights(mesh, [lo, hi], [1 - fraction, fraction])];
  const affected = new Map<number, Face>();
  for (const { face, corner } of sides) {
    const other = next(face, corner), start = face.corners[corner], end = face.corners[other];
    if (affected.has(face.id)) throw new Error('An incident polygon uses this edge more than once.');
    const t = start.vertex === lo ? fraction : 1 - fraction;
    const attributes = start.attributes.map((tuple, i) => {
      const values = tuple.map((value, k) => value * (1 - t) + end.attributes[i][k] * t);
      if (['normal', 'tangent'].includes(mesh.channels[i].name)) {
        const normal = new Vector3(values[0], values[1], values[2]).normalize();
        if (!normal.lengthSq()) return t < .5 ? tuple : end.attributes[i];
        return values.length === 4 ? [...normal.toArray(), t < .5 ? tuple[3] : end.attributes[i][3]] : normal.toArray();
      }
      return values;
    });
    const insert = corner + 1;
    const corners = [...face.corners.slice(0, insert), { vertex, attributes }, ...face.corners.slice(insert)];
    const triangles = splitFanEdge(face, corner, other, insert);
    affected.set(face.id, { ...face, corners, triangles });
  }
  return { ...mesh, positions, weights, faces: mesh.faces.map(face => affected.get(face.id) ?? face) };
}

function splitFanEdge(face: Face, a: number, b: number, insert: number) {
  const result: number[] = [];
  const shifted = (i: number) => i < insert ? i : i + 1;
  let found = false;
  for (let corner = 0; corner < face.triangles.length; corner += 3) {
    const tri = face.triangles.slice(corner, corner + 3);
    if (!tri.includes(a) || !tri.includes(b)) { result.push(...tri.map(shifted)); continue; }
    const index = tri.indexOf(a), start = tri[(index + 1) % 3] === b ? index : tri.indexOf(b);
    const p = shifted(tri[start]), q = shifted(tri[(start + 1) % 3]), r = shifted(tri[(start + 2) % 3]);
    result.push(p, insert, r, insert, q, r);
    found = true;
  }
  if (!found) throw new Error('The source triangulation omits the boundary edge.');
  return result;
}

function splitFace(mesh: MeshData, edit: MeshEdit & { type: 'splitFace' }) {
  const face = mesh.faces.find(face => face.id === edit.face);
  if (!face) throw new Error('Select the face to split.');
  const [a, b] = edit.diagonal;
  if (edgesOf(mesh).has(edgeKey(a, b))) throw new Error('Choose a new diagonal between non-adjacent vertices.');
  const i = face.corners.findIndex(c => c.vertex === a), j = face.corners.findIndex(c => c.vertex === b);
  if (i < 0 || j < 0) throw new Error('Both diagonal vertices must belong to the selected face.');
  const start = Math.min(i, j), end = Math.max(i, j);
  const aSide = face.corners.slice(start, end + 1), bSide = [...face.corners.slice(end), ...face.corners.slice(0, start + 1)];
  const first = withCorners(mesh, face, aSide), second = withCorners(mesh, { ...face, id: mesh.nextFace }, bSide);
  const originalNormal = faceNormal(mesh, face);
  if ([first, second].some(part => faceNormal(mesh, part).dot(originalNormal) <= 0) ||
      Math.abs(faceNormal(mesh, first).length() + faceNormal(mesh, second).length() - originalNormal.length()) > originalNormal.length() * .025) {
    throw new Error('The diagonal leaves the face or crosses a strongly curved region.');
  }
  return { ...mesh, faces: mesh.faces.flatMap(value => value === face ? [first, second] : [value]), nextFace: mesh.nextFace + 1 };
}

function combine(mesh: MeshData, sides: Side[], flip: boolean) {
  if (sides.length !== 2 || sides[0].face === sides[1].face) throw new Error('Select an edge shared by exactly two faces.');
  const [a, b] = sides;
  if (a.face.material !== b.face.material) throw new Error('The two faces use different materials.');
  if (flip && (a.face.corners.length !== 3 || b.face.corners.length !== 3)) throw new Error('Flip Edge requires two triangles.');
  const after = ({ face, corner }: Side) => Array.from({ length: face.corners.length }, (_, i) => face.corners[(corner + 1 + i) % face.corners.length]);
  const aa = after(a), bb = after(b);
  if (!sameCorner(aa[0], bb.at(-1)!) || !sameCorner(aa.at(-1)!, bb[0])) {
    throw new Error('The edge has a UV, normal, color, or winding discontinuity. Keep the edge to preserve it.');
  }
  const outline = [...aa.slice(0, -1), ...bb.slice(0, -1)];
  const merged = withCorners(mesh, { ...a.face, created: a.face.created || b.face.created, repaired: a.face.repaired || b.face.repaired,
    needsUv: a.face.needsUv || b.face.needsUv }, outline, true);
  let result: Face[] = [merged];
  if (flip) {
    if (edgesOf(mesh).has(edgeKey(outline[1].vertex, outline[3].vertex))) throw new Error('The other diagonal already exists.');
    result = [withCorners(mesh, merged, [outline[0], outline[1], outline[3]]),
      withCorners(mesh, { ...merged, id: b.face.id }, [outline[1], outline[2], outline[3]])];
    if (result.some(face => faceNormal(mesh, face).dot(faceNormal(mesh, merged)) <= 0)) throw new Error('The new diagonal leaves the two triangles.');
  }
  return { ...mesh, faces: mesh.faces.flatMap(face => face === a.face ? result : face === b.face ? [] : [face]) };
}

function withCorners(mesh: MeshData, face: Face, corners: readonly Corner[], strict = false): Face {
  return { ...face, corners, triangles: polygon(mesh, corners.map(c => c.vertex), strict).triangles };
}

function sameCorner(a: Corner, b: Corner) {
  return a.vertex === b.vertex && a.attributes.every((tuple, i) => tuple.every((value, k) => Math.abs(value - b.attributes[i][k]) <= 1e-6));
}

function weld(mesh: MeshData, edit: MeshEdit & { type: 'weld' }, groups: readonly number[][]) {
  if (!groups.length) throw new Error('There are no selected vertices within the weld tolerance.');
  const target = new Map<number, number>(), positions = mesh.positions.slice(), weights = mesh.weights?.slice();
  for (const group of groups) {
    const [first] = group;
    for (const id of group) target.set(id, first);
    if (edit.mode !== 'first') {
      center(mesh, group).toArray(positions, first * 3);
      if (weights) weights[first] = mixWeights(mesh, group, group.map(() => 1 / group.length));
    }
  }
  const partial: MeshData = { ...mesh, positions, weights };
  const changed = new Set<number>();
  const faces: Face[] = [];
  for (const face of mesh.faces) {
    if (!face.corners.some(c => target.has(c.vertex))) { faces.push(face); continue; }
    const c = face.corners.map(corner => ({ ...corner, vertex: target.get(corner.vertex) ?? corner.vertex }));
    const corners = c.filter((corner, i) => corner.vertex !== c[(i + c.length - 1) % c.length].vertex);
    if (corners.length < 3) continue;
    faces.push(withCorners(partial, face, corners));
    changed.add(face.id);
  }
  if (!faces.length) throw new Error('The weld would collapse every face of the object.');
  const result = { ...partial, faces };
  const prior = edgesOf(mesh), polygons = new Map<string, number>();
  for (const sides of edgesOf(result).values()) {
    if (sides.length <= 2) continue;
    const { face, corner } = sides[0];
    const key = edgeKey(face.corners[corner].vertex, face.corners[next(face, corner)].vertex);
    if (sides.length > (prior.get(key)?.length ?? 2)) throw new Error('The weld would create a non-manifold edge.');
  }
  for (const face of faces) {
    const key = verticesOf(face).sort((a, b) => a - b).join('/');
    const first = polygons.get(key);
    if (first !== undefined && (changed.has(first) || changed.has(face.id))) throw new Error('The weld would create duplicate faces.');
    polygons.set(key, face.id);
  }
  return recalculate(result, changed);
}

function weldGroups(mesh: MeshData, { mode, vertices, tolerance }: MeshEdit & { type: 'weld' }) {
  if (mode !== 'tolerance') return [vertices];
  if (vertices.length > 2048) throw new Error('Select up to 2,048 vertices for a tolerance weld.');
  const roots = vertices.map((_, i) => i);
  const root = (i: number) => { while (roots[i] !== i) i = roots[i]; return i; };
  const points = vertices.map(id => vector(mesh, id));
  for (let i = 1; i < points.length; i++) for (let j = 0; j < i; j++) {
    if (points[i].distanceToSquared(points[j]) > tolerance * tolerance) continue;
    const a = root(i), b = root(j);
    roots[Math.max(a, b)] = Math.min(a, b);
  }
  const groups = new Map<number, number[]>();
  vertices.forEach((id, i) => {
    const r = root(i), group = groups.get(r) ?? [];
    group.push(id);
    groups.set(r, group);
  });
  return [...groups.values()].filter(group => group.length > 1);
}

function mixWeights(mesh: MeshData, vertices: number[], factors: number[]): Weight[] {
  const result = new Map<number, number>();
  for (const [i, vertex] of vertices.entries()) for (const [bone, weight] of mesh.weights![vertex]) {
    result.set(bone, (result.get(bone) ?? 0) + weight * factors[i]);
  }
  const active = [...result].filter(pair => pair[1] > 0);
  if (mesh.glb && active.length > 4) throw new Error('This GLB edit would create more than four weights on a vertex.');
  if (!active.length) throw new Error('The new vertex has no valid skin influences.');
  return active.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

function requireTriangles(mesh: MeshData, face: Face) {
  for (let i = 0; i < face.triangles.length; i += 3) {
    const [a, b, c] = face.triangles.slice(i, i + 3).map(j => point(mesh, face.corners[j].vertex));
    const p = new Vector3(...b).sub(new Vector3(...a)), q = new Vector3(...c).sub(new Vector3(...a));
    if (p.clone().cross(q).lengthSq() <= Math.max(p.lengthSq(), q.lengthSq()) ** 2 * 1e-16) {
      throw new Error('The transform would collapse a triangle.');
    }
  }
}
