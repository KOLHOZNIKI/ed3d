import { Matrix4, Triangle, Vector3 } from 'three';
import { spatialProjection } from '../e00/projection-rays';
import { point, usedVertices, type MeshData } from '../mesh/data';
import { jointId, type Row } from './data';
import { blend } from './operations';

export function bonePairs(text: string, symmetric: boolean) {
  const pairs = new Map<string, string>();
  const add = (a: string, b: string) => {
    if (!jointId(a) || !jointId(b) || pairs.has(a) && pairs.get(a) !== b) throw new Error('Enter consistent joint ID pairs, for example object-1=object-2.');
    pairs.set(a, b);
  };
  if (!text.trim()) return pairs;
  for (const item of text.split(',')) {
    const [a, b, rest] = item.split('=').map(word => word.trim());
    if (rest !== undefined || !b) throw new Error('Enter source=target joint ID pairs.');
    add(a, b);
    if (symmetric) add(b, a);
  }
  return pairs;
}

export function mapRow(row: Row, map: ReadonlyMap<string, string>, palette: ReadonlySet<string>, requirePair: boolean) {
  return blend(row.map(([id, weight]) => {
    const mapped = map.get(id) ?? (requirePair ? undefined : id);
    if (!mapped || !palette.has(mapped)) throw new Error(`Influence ${id} needs an explicit target joint.`);
    return [[[mapped, weight]], 1];
  }));
}

function points(data: MeshData, matrix: Matrix4) {
  return new Map(usedVertices(data.faces).map(id => [id, new Vector3(...point(data, id)).applyMatrix4(matrix)]));
}

export function mirrorMatches(data: MeshData, matrix: Matrix4, axis: number, offset: number, tolerance: number) {
  if (!Number.isFinite(offset) || !Number.isInteger(axis) || axis < 0 || axis > 2 || !(tolerance > 1e-8 && Number.isFinite(tolerance))) {
    throw new Error('Choose a finite plane offset and a tolerance greater than 0.00000001.');
  }
  const world = points(data, matrix), cells = new Map<string, number[]>();
  const cell = (p: Vector3) => p.toArray().map(v => Math.floor(v / tolerance));
  for (const [id, p] of world) {
    const key = cell(p).join('/'), list = cells.get(key) ?? [];
    list.push(id); cells.set(key, list);
  }
  const matches = new Map<number, number[]>();
  for (const [id, p] of world) {
    const reflected = p.clone().setComponent(axis, 2 * offset - p.getComponent(axis));
    const [x, y, z] = cell(reflected), candidates: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const peer of cells.get(`${x + dx}/${y + dy}/${z + dz}`) ?? []) {
        if (reflected.distanceToSquared(world.get(peer)!) <= tolerance ** 2) candidates.push(peer);
      }
    }
    matches.set(id, candidates);
  }
  return (id: number) => {
    const candidates = matches.get(id)!;
    if (!candidates.length) return { issue: 'No mirror match' } as const;
    const [other] = candidates, back = matches.get(other)!;
    if (candidates.length !== 1 || back.length !== 1 || back[0] !== id) return { issue: 'Ambiguous mirror match' } as const;
    return { other } as const;
  };
}

export interface Snapshot {
  data: MeshData;
  rows: ReadonlyMap<number, Row>;
  matrix: Matrix4;
}

export function surfaceTransfer(source: Snapshot, sourceFaces: ReadonlySet<number> | undefined, target: MeshData, matrix: Matrix4,
  vertices: readonly number[], distance: number, angle: number) {
  if (!(distance > 0 && Number.isFinite(distance)) || !(angle >= 0 && angle <= 90)) {
    throw new Error('Enter a positive transfer distance and a normal angle between 0 and 90 degrees.');
  }
  const world = points(source.data, source.matrix), triangles: number[][] = [], xyz: number[] = [], normals: number[] = [];
  const normal = new Vector3();
  for (const face of source.data.faces) {
    if (sourceFaces && !sourceFaces.has(face.id)) continue;
    for (let i = 0; i < face.triangles.length; i += 3) {
      const ids = face.triangles.slice(i, i + 3).map(corner => face.corners[corner].vertex);
      if (!ids.every(id => source.rows.get(id)?.length)) continue;
      const [a, b, c] = ids.map(id => world.get(id)!);
      Triangle.getNormal(a, b, c, normal);
      if (!normal.lengthSq()) continue;
      triangles.push(ids); xyz.push(...a.toArray(), ...b.toArray(), ...c.toArray());
      for (let k = 0; k < 3; k++) normals.push(...normal.toArray());
    }
  }
  if (!triangles.length) throw new Error('The source selection has no triangles with usable skin weights.');
  const positions = points(target, matrix), byVertex = new Map(vertices.map(id => [id, new Vector3()]));
  for (const face of target.faces) for (let i = 0; i < face.triangles.length; i += 3) {
    const ids = face.triangles.slice(i, i + 3).map(corner => face.corners[corner].vertex);
    if (!ids.some(id => byVertex.has(id))) continue;
    const [a, b, c] = ids.map(id => positions.get(id)!);
    Triangle.getNormal(a, b, c, normal);
    for (const id of ids) byVertex.get(id)?.add(normal);
  }
  // One query per logical target vertex. The interpolator uses the first sample of each query.
  const targetPosition = Float32Array.from(vertices.flatMap(id => [...positions.get(id)!.toArray(), 0, 0, 0, 0, 0, 0]));
  const targetNormal = Float32Array.from(vertices.flatMap(id => [...byVertex.get(id)!.normalize().toArray(), 0, 0, 0, 0, 0, 0]));
  const sourcePosition = Float32Array.from(xyz), sourceWorldNormal = Float32Array.from(normals);
  const identity = new Matrix4().toArray();
  const query = spatialProjection({ sourceName: 'Weight snapshot', sourcePosition,
    sourceComponents: new Uint32Array(triangles.length), targetComponents: new Uint32Array(vertices.length), eligibleSources: [[0]], maxDistance: distance,
    spatial: { direction: 'both', minNormalDot: Math.cos(angle * Math.PI / 180) - 1e-7, offset: 0, fallback: 'nearest', color: [0, 0, 0],
      targetPosition, targetNormal, sourceLocalPosition: sourcePosition, sourceLocalNormal: sourceWorldNormal, sourceWorldNormal,
      sourceNormalToWorld: identity, worldNormalToTarget: identity } });
  return (index: number) => {
    const hit = query(index, 1, 0, 0);
    if (!hit) return;
    const factors = [hit.a, hit.b, hit.c];
    return blend(triangles[hit.face].map((id, slot) => [source.rows.get(id)!, Math.max(0, factors[slot])]));
  };
}
