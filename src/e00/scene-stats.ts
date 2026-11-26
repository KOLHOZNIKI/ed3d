import { Mesh, SkinnedMesh, type Bone, type Object3D } from 'three';

export function sceneStats(scene: Object3D, format: string) {
  let meshes = 0;
  let triangles = 0;
  const bones = new Set<Bone>();
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    meshes++;
    triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
    if (object instanceof SkinnedMesh) {
      for (const bone of object.skeleton.bones) bones.add(bone);
    }
  });
  if (!meshes) throw new Error(`The ${format} contains no meshes.`);
  return { meshes, triangles, bones: bones.size, clips: scene.animations.length };
}
