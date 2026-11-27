import { AnimationClip, Mesh, Object3D, PropertyBinding, Skeleton, SkinnedMesh, Texture, type BufferGeometry } from 'three';
import { sourceDeformation } from '../e00/round-trip';
import { sceneStats } from '../e00/scene-stats';
import { trimmedMesh } from '../extract/export';
import type { MeshView } from '../texture/appearance';
import type { Model, ModelAdapter } from './adapter';

export function selectedMeshes(adapter: ModelAdapter, ids: ReadonlySet<string>) {
  const meshes = new Set<Mesh>();
  for (const id of ids) {
    const object = adapter.objects.get(id);
    if (object instanceof Mesh) meshes.add(object);
    else object?.traverse(node => { if (node instanceof Mesh) meshes.add(node); });
  }
  return meshes;
}

export function exportSelection(model: Model, adapter: ModelAdapter, ids: ReadonlySet<string>, views: readonly MeshView[],
  clips: readonly AnimationClip[], auxiliaryPaths: ReadonlySet<string>) {
  const meshes = selectedMeshes(adapter, ids), needed = new Set<Object3D>([model.scene]);
  if (!meshes.size) throw new Error('Select at least one mesh or group to export.');
  const include = (node: Object3D) => {
    for (let ancestor: Object3D | null = node; ancestor && !needed.has(ancestor); ancestor = ancestor.parent) needed.add(ancestor);
  };
  for (const mesh of meshes) {
    include(mesh);
    if (mesh instanceof SkinnedMesh) for (const bone of mesh.skeleton.bones) include(bone);
  }
  const appearances = new Map(views.map(view => [view.mesh, view]));
  const copies = new Map<Object3D, Object3D>();
  const geometries: BufferGeometry[] = [];
  const scene = model.scene.clone(false);
  scene.uuid = model.scene.uuid;
  copies.set(model.scene, scene);
  const copyTree = (source: Object3D, parent: Object3D) => {
    if (!needed.has(source)) return;
    let copy: Object3D;
    if (source instanceof Mesh && meshes.has(source)) {
      const template = source.clone(false);
      const view = appearances.get(source);
      if (view) template.material = view.material;
      if (view?.geometry) template.geometry = view.geometry;
      const mesh = trimmedMesh(template, model.format, false);
      if (mesh.geometry !== template.geometry) geometries.push(mesh.geometry);
      copy = mesh;
    } else copy = source instanceof Mesh ? new Object3D().copy(source, false) : source.clone(false);
    copy.uuid = source.uuid;
    copy.visible = true;
    copy.animations = [];
    parent.add(copy);
    copies.set(source, copy);
    for (const child of source.children) copyTree(child, copy);
  };
  const dispose = () => { for (const geometry of geometries) geometry.dispose(); };
  try {
    for (const child of model.scene.children) copyTree(child, scene);
    const skeletons = new Map<Skeleton, Skeleton>();
    for (const mesh of meshes) if (mesh instanceof SkinnedMesh) {
      let skeleton = skeletons.get(mesh.skeleton);
      if (!skeleton) {
        const bones = mesh.skeleton.bones.map(bone => copies.get(bone) as typeof bone | undefined);
        if (bones.some(bone => !bone)) throw new Error('A selected skin has joints outside its source scene.');
        skeleton = new Skeleton(bones as typeof mesh.skeleton.bones, mesh.skeleton.boneInverses.map(inverse => inverse.clone()));
        skeletons.set(mesh.skeleton, skeleton);
      }
      (copies.get(mesh) as SkinnedMesh).bind(skeleton, mesh.bindMatrix);
    }
    scene.animations = clips.flatMap(clip => {
      const tracks = clip.tracks.filter(track => {
        const target = PropertyBinding.parseTrackName(track.name);
        const node = PropertyBinding.findNode(model.scene, target.nodeName) as Object3D | null;
        return !!node && needed.has(node) && (target.propertyName !== 'morphTargetInfluences' || node instanceof Mesh && meshes.has(node));
      });
      return tracks.length ? [new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode)] : [];
    });
    scene.updateMatrixWorld(true);
    const stats = sceneStats(scene, model.format.toUpperCase());
    const objects = new Map<string, Object3D>([...adapter.objects].flatMap(([id, node]) =>
      node instanceof Mesh && meshes.has(node) ? [[id, copies.get(node)!]] : []));
    if (model.format === 'glb') {
      const skins = new Map([...model.skins].filter(([mesh]) => meshes.has(mesh)).map(([mesh, skin]) => [copies.get(mesh) as SkinnedMesh,
        { ...skin, skeleton: skin.skeleton && copies.get(skin.skeleton) }]));
      return { model: { ...model, scene, stats, skins }, objects, dispose };
    }
    const paths = new Set(auxiliaryPaths);
    for (const original of meshes) {
      const mesh = copies.get(original) as Mesh;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const texture of Object.values(material)) if (texture instanceof Texture && texture.image instanceof HTMLImageElement) {
          const path = model.imagePathsByUrl.get(texture.image.src);
          if (path) paths.add(path);
        }
      }
    }
    const images = new Map([...model.images].filter(([path]) => paths.has(path)));
    const scopedAtlas = model.uvAtlas && [...meshes].some(mesh => mesh.geometry === model.uvAtlas!.inputGeometry);
    return { model: { ...model, scene, stats, images, deformation: sourceDeformation(scene),
      uvAtlas: scopedAtlas ? model.uvAtlas : undefined, textureBake: scopedAtlas ? model.textureBake : undefined,
      texturePaint: scopedAtlas ? model.texturePaint : undefined }, objects, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
