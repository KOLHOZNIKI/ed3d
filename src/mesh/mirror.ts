import { Vector3 } from 'three';
import { point, usedVertices, type MeshData, type Vec3 } from './data';

export function matchMirroredPoints(positions: ReadonlyMap<number, Vector3>, axis: number, offset: number, tolerance: number) {
  if (!Number.isFinite(offset) || !Number.isInteger(axis) || axis < 0 || axis > 2 || !(tolerance > 1e-8 && Number.isFinite(tolerance))) {
    throw new Error('Choose a finite plane offset and a tolerance greater than 0.00000001.');
  }
  const cells = new Map<string, number[]>();
  const cell = (p: Vector3) => p.toArray().map(v => Math.floor(v / tolerance));
  for (const [id, p] of positions) {
    const key = cell(p).join('/'), list = cells.get(key) ?? [];
    list.push(id); cells.set(key, list);
  }
  const matches = new Map<number, number[]>();
  const neighbors = (p: Vector3) => {
    const [x, y, z] = cell(p), keys = new Set<string>(), candidates: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      keys.add(`${x + dx}/${y + dy}/${z + dz}`);
    }
    for (const key of keys) for (const peer of cells.get(key) ?? []) {
      if (p.distanceToSquared(positions.get(peer)!) <= tolerance ** 2) candidates.push(peer);
      if (candidates.length === 2) return candidates;
    }
    return candidates;
  };
  const candidatesFor = (id: number) => {
    const cached = matches.get(id);
    if (cached) return cached;
    const p = positions.get(id)!;
    const candidates = neighbors(p.clone().setComponent(axis, offset + (offset - p.getComponent(axis))));
    matches.set(id, candidates);
    return candidates;
  };
  return (id: number) => {
    const candidates = candidatesFor(id);
    if (!candidates.length) return { issue: 'No mirror match' } as const;
    const [other] = candidates, reverse = candidatesFor(other);
    if (candidates.length !== 1 || reverse.length !== 1 || reverse[0] !== id) return { issue: 'Ambiguous mirror match' } as const;
    return { other } as const;
  };
}

export function mirrorMove(mesh: MeshData, selected: ReadonlySet<number>, value: Vec3, axis: number, offset: number, tolerance: number) {
  if (!selected.size || !value.every(Number.isFinite)) throw new Error('Select vertices and enter finite movement values.');
  const points = new Map(usedVertices(mesh.faces).map(id => [id, new Vector3(...point(mesh, id))]));
  const match = matchMirroredPoints(points, axis, offset, tolerance);
  const positions = mesh.positions.slice(), changed = new Set<number>();
  const delta = new Vector3(...value), reflected = delta.clone().setComponent(axis, -value[axis]);
  const tangent = delta.clone().setComponent(axis, 0);
  const skipped = { unmatched: [] as number[], ambiguous: [] as number[], bothSelected: [] as number[] };
  let pairs = 0, center = 0;
  const move = (id: number, movement: Vector3) => {
    const before = points.get(id)!, after = before.clone().add(movement);
    if (!after.toArray().every(v => Number.isFinite(Math.fround(v)))) throw new Error('Mirror Move produced invalid coordinates.');
    if (!after.equals(before)) { after.toArray(positions, id * 3); changed.add(id); }
  };
  for (const id of selected) {
    const result = match(id);
    if (result.issue) { skipped[result.issue === 'No mirror match' ? 'unmatched' : 'ambiguous'].push(id); continue; }
    const { other } = result;
    if (other === id) { move(id, tangent); center++; }
    else if (selected.has(other)) skipped.bothSelected.push(id);
    else { move(id, delta); move(other, reflected); pairs++; }
  }
  return { positions, changed, pairs, center, skipped };
}

export function mirrorSummary({ pairs, center, skipped }: Pick<ReturnType<typeof mirrorMove>, 'pairs' | 'center' | 'skipped'>) {
  const sample = (ids: number[]) => `${ids.length}${ids.length ? ` [${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}]` : ''}`;
  return `${pairs} mirrored pairs · ${center} plane vertices · ${sample(skipped.unmatched)} unmatched · ${sample(skipped.ambiguous)} ambiguous · ${sample(skipped.bothSelected)} with both sides selected`;
}
