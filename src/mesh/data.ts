export type Vec3 = readonly [number, number, number];
export type Weight = readonly [bone: number, weight: number];
export interface Corner {
  readonly vertex: number;
  readonly attributes: readonly (readonly number[])[];
}
export interface Face {
  readonly id: number;
  readonly corners: readonly Corner[];
  readonly triangles: readonly number[];
  readonly material: number;
  readonly created?: true;
  readonly repaired?: true;
  readonly needsUv?: true;
}
export interface MeshData {
  readonly positions: Float64Array;
  readonly faces: readonly Face[];
  readonly channels: readonly { name: string; size: number }[];
  readonly weights?: readonly (readonly Weight[])[];
  readonly weightJoints?: readonly string[];
  readonly sourceWeightSlots?: number;
  readonly nextFace: number;
  readonly materialCount: number;
  readonly glb: boolean;
  readonly uvSeams?: Readonly<Record<number, readonly string[]>>;
}

export type Kind = 'vertex' | 'edge' | 'face';
export interface Side { face: Face; corner: number }

export const edgeKey = (a: number, b: number) => a < b ? `${a}/${b}` : `${b}/${a}`;
export const point = (mesh: MeshData, id: number): Vec3 => [mesh.positions[3 * id], mesh.positions[3 * id + 1], mesh.positions[3 * id + 2]];
export const verticesOf = (face: Face) => face.corners.map(corner => corner.vertex);
export const usedVertices = (faces: readonly Face[]) => [...new Set(faces.flatMap(verticesOf))].sort((a, b) => a - b);
export const edgeVertices = (key: string) => key.split('/').map(Number);
export const next = (face: Face, index: number) => (index + 1) % face.corners.length;

export function edgesOf(mesh: MeshData) {
  const edges = new Map<string, Side[]>();
  for (const face of mesh.faces) for (const [corner, a] of face.corners.entries()) {
    const key = edgeKey(a.vertex, face.corners[next(face, corner)].vertex);
    const sides = edges.get(key);
    if (sides) sides.push({ face, corner });
    else edges.set(key, [{ face, corner }]);
  }
  return edges;
}

export function connected(mesh: MeshData, seeds: Iterable<number>) {
  const adjacent = new Map<number, Set<number>>();
  for (const sides of edgesOf(mesh).values()) {
    if (sides.length < 2) continue;
    for (const { face } of sides) {
      const targets = adjacent.get(face.id) ?? new Set<number>();
      for (const side of sides) targets.add(side.face.id);
      adjacent.set(face.id, targets);
    }
  }
  const ids = new Set(seeds), queue = [...ids];
  for (let i = 0; i < queue.length; i++) for (const id of adjacent.get(queue[i]) ?? []) {
    if (ids.has(id)) continue;
    ids.add(id);
    queue.push(id);
  }
  return ids;
}

export function ensureUvChannel(mesh: MeshData): MeshData {
  if (mesh.channels.some(({ name }) => /^uv\d*$/.test(name))) return mesh;
  return { ...mesh, channels: [...mesh.channels, { name: mesh.glb ? 'uv' : 'uv0', size: 2 }],
    faces: mesh.faces.map(face => ({ ...face, corners: face.corners.map(corner => ({
      ...corner, attributes: [...corner.attributes, [0, 0]],
    })) })) };
}
