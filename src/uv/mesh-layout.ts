import type { MeshEdit } from '../mesh/commands';
import { edgeKey, type Corner, type Face, type MeshData } from '../mesh/data';
import { tangentFrame } from '../mesh/normals';

export function applyUvLayout(mesh: MeshData, edit: MeshEdit & { type: 'uv' }): MeshData {
  const name = mesh.glb && !edit.channel ? 'uv' : `uv${edit.channel}`;
  const channels = [...mesh.channels];
  let slot = channels.findIndex(channel => channel.name === name);
  if (slot < 0) {
    const available = channels.filter(channel => /^uv\d*$/.test(channel.name)).length;
    if (edit.channel !== available) throw new Error('Create consecutive UV channels.');
    slot = channels.length;
    channels.push({ name, size: 2 });
  }
  let offset = 0, nextFace = mesh.nextFace;
  const faces: Face[] = [];
  const edges = new Set<string>();
  const withUv = { ...mesh, channels };
  for (const face of mesh.faces) {
    const corner = new Map<number, Corner>(), variants: Corner[] = [];
    let split = false;
    for (const [i, index] of face.triangles.entries()) {
      const a = face.corners[index], b = face.corners[face.triangles[i % 3 === 2 ? i - 2 : i + 1]];
      edges.add(edgeKey(a.vertex, b.vertex));
      const u = edit.coordinates[offset++], v = edit.coordinates[offset++];
      if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error('The UV layout does not match the source corners.');
      const attributes = a.attributes.slice();
      attributes[slot] = [u, v];
      const value = { ...a, attributes };
      const first = corner.get(index)?.attributes[slot];
      if (first && (first[0] !== u || first[1] !== v)) split = true;
      corner.set(index, value);
      variants.push(value);
    }
    const needsUv = edit.suppliesTexture ? undefined : face.needsUv;
    if (split) {
      for (let i = 0; i < variants.length; i += 3) {
        const tri = { ...face, needsUv, id: i === 0 ? face.id : nextFace++, corners: variants.slice(i, i + 3), triangles: [0, 1, 2] };
        faces.push(edit.channel === 0 ? tangentFrame(withUv, tri) : tri);
      }
    } else {
      const changed = { ...face, needsUv, corners: face.corners.map((value, i) => corner.get(i) ?? value) };
      if (changed.corners.some(value => !value.attributes[slot])) throw new Error('The source has a polygon corner omitted by its triangulation.');
      faces.push(edit.channel === 0 ? tangentFrame(withUv, changed) : changed);
    }
  }
  if (offset !== edit.coordinates.length || edit.seams.some(key => !edges.has(key))) throw new Error('The UV layout does not match the source topology.');
  return { ...withUv, faces, nextFace, uvSeams: { ...mesh.uvSeams, [edit.channel]: [...edit.seams] } };
}
