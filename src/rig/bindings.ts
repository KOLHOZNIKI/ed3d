import { AttachedBindMode, Bone, Float32BufferAttribute, Matrix4, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { renderControlPoints, sourceMesh } from '../e00/fbx-topology';
import type { Model } from '../project/adapter';
import type { Joint, RigState } from './state';

type Slot = readonly [index: number, weight: number];

export function rebindMesh(mesh: SkinnedMesh, format: Model['format'], ids: readonly string[], joints: readonly Joint[],
  state: RigState, nodes: ReadonlyMap<string, Bone>) {
  const original = mesh.skeleton, geometry = mesh.geometry, mode = mesh.bindMode;
  const matrix = mesh.bindMatrix.clone(), inverse = mesh.bindMatrixInverse.clone();
  const box = mesh.boundingBox, sphere = mesh.boundingSphere;
  const source = format === 'fbx' ? sourceMesh(geometry) : undefined;
  const affected = new Set(ids.map(id => joints.find(joint => joint.id === id)?.group).filter(Boolean));
  for (const id of ids) if (!nodes.has(id)) {
    const target = joints.find(joint => joint.id === state.transfers[id]);
    if (!target) throw new Error('A deleted joint has no weight destination.');
    affected.add(target.group);
  }
  const mapped = ids.map(id => nodes.has(id) ? id : state.transfers[id]);
  const transferred = ids.map((id, index) => id !== mapped[index]);
  const palette = [...new Set([...mapped, ...joints.filter(joint => joint.id.startsWith('joint-') && affected.has(joint.group)).map(joint => joint.id)])];
  if (palette.length > 65535) throw new Error('The rig exceeds the skin palette limit.');
  const bones = palette.map(id => {
    const bone = nodes.get(id);
    if (!bone) throw new Error('A skin refers to a missing joint.');
    return bone;
  });
  const skin = new Skeleton(bones, bones.map(bone => {
    if (Math.abs(bone.matrixWorld.determinant()) < 1e-12) throw new Error('A bind transform is singular.');
    return bone.matrixWorld.clone().invert();
  }));
  let replacement: typeof geometry | undefined;
  const restore = () => {
    mesh.geometry = geometry;
    mesh.skeleton = original;
    mesh.bindMode = mode;
    mesh.bindMatrix.copy(matrix);
    mesh.bindMatrixInverse.copy(inverse);
    mesh.boundingBox = box;
    mesh.boundingSphere = sphere;
    replacement?.dispose();
    skin.dispose();
  };
  try {
    if (ids.length !== palette.length || ids.some((id, i) => id !== palette[i])) {
      const indices = new Map(palette.map((id, i) => [id, i]));
      const remap = mapped.map(id => indices.get(id)!);
      // Own only the replacement skin attributes. The source geometry and its polygon layers remain immutable.
      replacement = geometry.clone();
      const rows: Slot[][] = Array.from({ length: source ? source.positions.length / 3 : geometry.attributes.position.count }, () => []);
      const changedRows = new Set<number>();
      const add = (row: number, joint: number, weight: number) => {
        if (!(weight > 0)) return;
        rows[row].push([remap[joint], weight]);
        if (transferred[joint]) changedRows.add(row);
      };
      if (source) {
        if (source.skin?.length !== ids.length) throw new Error('The raw FBX clusters do not match the preview rig.');
        for (const [index, cluster] of source.skin.entries()) for (let i = 0; i < cluster.indices.length; i++) {
          add(cluster.indices[i], index, cluster.weights[i]);
        }
      } else {
        const joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
        for (let i = 0; i < rows.length; i++) for (let k = 0; k < joints.itemSize; k++) {
          add(i, joints.getComponent(i, k), weights.getComponent(i, k));
        }
      }
      const normalized = rows.map((row, index) => {
        const sums = new Map<number, number>();
        for (const [id, weight] of row) sums.set(id, (sums.get(id) ?? 0) + weight);
        const entries = [...sums].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
        const sum = entries.reduce((n, [, w]) => n + w, 0);
        if (!(sum > 0)) return [];
        // A palette extension leaves untouched weights exactly as imported.
        return changedRows.has(index) ? entries.map(([id, w]): Slot => [id, w / sum]) : entries;
      });
      if (source) {
        const clusters = palette.map(() => ({ indices: [] as number[], weights: [] as number[] }));
        for (const [id, row] of normalized.entries()) for (const [j, w] of row) {
          clusters[j].indices.push(id);
          clusters[j].weights.push(w);
        }
        replacement.userData = { ...geometry.userData, assetFixerFbxSource: { ...source,
          skin: clusters, maxSkinInfluences: normalized.reduce((n, row) => Math.max(n, row.length), 0),
          pointsOverPreviewLimit: normalized.filter(row => row.length > 4).length } };
      }
      const points = source ? renderControlPoints(source) : Uint32Array.from(normalized, (_, i) => i);
      const jointData = new Uint16Array(points.length * 4), weightData = new Float32Array(points.length * 4);
      for (const [i, controlPoint] of points.entries()) {
        const row = normalized[controlPoint]?.slice(0, 4) ?? [];
        const sum = source ? row.reduce((n, [, w]) => n + w, 0) || 1 : 1;
        for (const [k, [j, w]] of row.entries()) { jointData[i * 4 + k] = j; weightData[i * 4 + k] = w / sum; }
      }
      replacement.setAttribute('skinIndex', new Uint16BufferAttribute(jointData, 4));
      replacement.setAttribute('skinWeight', new Float32BufferAttribute(weightData, 4));
      mesh.geometry = replacement;
    }
    if (Math.abs(mesh.matrixWorld.determinant()) < 1e-12) throw new Error('A skinned mesh has a singular bind transform.');
    mesh.bindMode = AttachedBindMode;
    mesh.bind(skin, mesh.matrixWorld.clone());
    mesh.bindMatrixInverse.copy(mesh.matrixWorld).invert();
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}

export function matrixDelta(a: Matrix4, b: Matrix4) {
  return a.elements.reduce((max, value, i) => Math.max(max, Math.abs(value - b.elements[i])), 0);
}
