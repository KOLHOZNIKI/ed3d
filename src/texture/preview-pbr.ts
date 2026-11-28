import { NoColorSpace, type Material, type Mesh, type MeshStandardMaterial } from 'three';
import { pbrMaterial } from '../project/display-material';
import type { WorkingState } from '../project/state';
import type { Appearance } from './appearance';
import { mappedTexture, sourceImage, type TextureCatalog, type TextureTarget } from './bindings';
import { textureImportBudget } from './image';

const images = new WeakMap<Blob | Uint8Array, Promise<HTMLImageElement>>();

function previewImage(source: Blob, key: Blob | Uint8Array) {
  let image = images.get(key);
  if (!image) {
    image = (async () => {
      const url = URL.createObjectURL(source);
      try {
        const value = new Image();
        value.src = url;
        await value.decode();
        return value;
      } finally { URL.revokeObjectURL(url); }
    })();
    images.set(key, image);
  }
  return image;
}

export async function addFbxPbrMaps(appearance: Appearance, catalog: TextureCatalog, state: WorkingState,
  live?: { target: TextureTarget; canvas: HTMLCanvasElement }) {
  const checkImage = textureImportBudget();
  const previous = new Map(appearance.views.map((view, i) => [view.mesh, i]));
  const replacements = new Map<Mesh, { materials: Material[]; converted: Map<number, MeshStandardMaterial> }>();
  for (const target of catalog.editTargets(state)) {
    const { mesh, slot, semantic, source, sourceName } = target.binding;
    if (semantic !== 'roughness' && semantic !== 'metallic') continue;
    const index = previous.get(mesh);
    const view = index === undefined ? undefined : appearance.views[index];
    let replacement = replacements.get(mesh);
    if (!replacement) {
      const original = view?.material ?? mesh.material;
      replacement = { materials: Array.isArray(original) ? [...original] : [original], converted: new Map() };
      replacements.set(mesh, replacement);
    }
    let material = replacement.converted.get(slot);
    if (!material) {
      material = pbrMaterial(replacement.materials[slot]);
      appearance.materials.push(material);
      replacement.materials[slot] = material;
      replacement.converted.set(slot, material);
    }
    const edited = state.textures?.[target.key]?.image;
    let image: HTMLImageElement | HTMLCanvasElement;
    if (live?.target.key === target.key) image = live.canvas;
    else if (edited) image = sourceImage(edited);
    else {
      const png = target.baked?.png;
      checkImage(png ?? new Uint8Array(await source.arrayBuffer()), sourceName ?? semantic);
      const blob = png ? new Blob([png], { type: 'image/png' }) : source;
      image = await previewImage(blob, png ?? source);
    }
    // Sample companion maps with the current Base Color UVs, including an applied UV bake.
    const texture = mappedTexture(material.map ?? target.binding.texture, image);
    texture.colorSpace = NoColorSpace;
    if (semantic === 'roughness') {
      material.roughnessMap = texture;
      material.roughness = 1;
    } else {
      material.metalnessMap = texture;
      material.metalness = 1;
    }
    appearance.textures.push(texture);
  }
  for (const [mesh, { materials }] of replacements) {
    const index = previous.get(mesh);
    const material = Array.isArray(mesh.material) ? materials : materials[0];
    if (index === undefined) appearance.views.push({ mesh, material });
    else appearance.views[index] = { ...appearance.views[index], material };
  }
}
