import { Mesh, SkinnedMesh, Texture, type BufferGeometry, type Material, type Object3D } from 'three';

export function disposeModel(model: { scene: Object3D }) {
  model.scene.removeFromParent();
  const textures = new Set<Texture>(), materials = new Set<Material>(), geometries = new Set<BufferGeometry>();
  const bitmaps = new Set<ImageBitmap>(), skeletons = new Set<SkinnedMesh['skeleton']>();
  model.scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const property of Object.values(material)) if (property instanceof Texture) textures.add(property);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    if (texture.image instanceof ImageBitmap) bitmaps.add(texture.image);
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
}
