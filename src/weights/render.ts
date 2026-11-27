import { Float32BufferAttribute, Uint16BufferAttribute, type BufferGeometry } from 'three';
import { renderControlPoints, sourceMesh } from '../e00/fbx-topology';
import type { MeshData, Weight } from '../mesh/data';
import type { RenderMesh } from '../mesh/render';
import type { Topology } from '../project/topology';

export function skinData(data: MeshData, vertices: Iterable<number>) {
  if (!data.weights || !data.weightJoints || data.sourceWeightSlots === undefined) return;
  const keep = new Set<number>();
  for (const id of new Set(vertices)) for (const [slot, weight] of data.weights[id]) if (weight > 0) keep.add(slot);
  const slots = data.weightJoints.map((_, i) => i).filter(i => i < data.sourceWeightSlots! || keep.has(i));
  if (slots.length > 65535) throw new Error('Too many joints in a skin palette.');
  const reverse = new Map(slots.map((slot, i) => [slot, i]));
  return { joints: slots.map(i => data.weightJoints![i]), rows: slots.length === data.weightJoints.length ? data.weights :
    data.weights.map(row => row.flatMap(([slot, weight]): Weight[] => reverse.has(slot) ? [[reverse.get(slot)!, weight]] : [])) };
}

type Skin = NonNullable<ReturnType<typeof skinData>>;

export function previewSkin(geometry: BufferGeometry, glb: boolean, skin: Skin, vertices: ArrayLike<number>) {
  const joints = new Uint16Array(vertices.length * 4), weights = new Float32Array(vertices.length * 4);
  for (let i = 0; i < vertices.length; i++) {
    const row = skin.rows[vertices[i]];
    const preview = glb ? row : row.filter(([, w]) => w > 0 && Number.isFinite(w)).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
    const sum = glb ? 1 : preview.reduce((value, pair) => value + pair[1], 0) || 1;
    for (let k = 0; k < Math.min(4, preview.length); k++) {
      joints[4 * i + k] = preview[k][0];
      weights[4 * i + k] = preview[k][1] / sum;
    }
  }
  geometry.userData.assetFixerJointIds = skin.joints;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
}

export function rawSkin(skin: Skin, ids: Iterable<number>, index: (id: number) => number) {
  const clusters = skin.joints.map(() => ({ indices: [] as number[], weights: [] as number[] }));
  let maxSkinInfluences = 0, pointsOverPreviewLimit = 0;
  for (const id of ids) {
    const row = skin.rows[id], count = new Set(row.filter(([, w]) => w > 0).map(([joint]) => joint)).size;
    maxSkinInfluences = Math.max(maxSkinInfluences, count);
    if (count > 4) pointsOverPreviewLimit++;
    for (const [joint, weight] of row) {
      clusters[joint].indices.push(index(id));
      clusters[joint].weights.push(weight);
    }
  }
  return { skin: clusters, maxSkinInfluences, pointsOverPreviewLimit };
}

export function renderSkin(data: MeshData, original: BufferGeometry, topology: Topology): RenderMesh {
  const source = data.glb ? undefined : sourceMesh(original);
  const count = original.getAttribute('position').count;
  const points = source ? renderControlPoints(source) : Uint32Array.from({ length: count }, (_, i) => i);
  const skin = skinData(data, points)!;
  const geometry = original.clone();
  geometry.userData = { ...original.userData };
  if (source) geometry.userData.assetFixerFbxSource = { ...source, ...rawSkin(skin, skin.rows.keys(), id => id) };
  previewSkin(geometry, data.glb, skin, points);
  const renderVertices = original.index ? Uint32Array.from(original.index.array) : points;
  return { geometry, topology, renderVertices, faceIds: data.faces.map(face => face.id) };
}
