import { MeshBasicMaterial, MeshStandardMaterial, NoColorSpace, SRGBColorSpace,
  type BufferGeometry, type Material, type Mesh, type Texture } from 'three';
import { mappedTexture, sourceImage, transferSampling, type TextureCatalog, type TextureTarget } from './bindings';
import type { WorkingState } from '../project/state';
import { decodePng, encodeImage, type TextureImage } from './image';

export interface MeshView {
  mesh: Mesh;
  geometry?: BufferGeometry;
  material: Material | Material[];
}

export interface Appearance {
  views: MeshView[];
  textures: Texture[];
  materials: Material[];
  geometries: BufferGeometry[];
}

export function emptyAppearance(): Appearance { return { views: [], textures: [], materials: [], geometries: [] }; }

export function applyViews(views: readonly MeshView[]): () => void {
  const before = views.map(({ mesh }) => ({ mesh, geometry: mesh.geometry, material: mesh.material }));
  for (const current of views) {
    if (current.geometry) current.mesh.geometry = current.geometry;
    current.mesh.material = current.material;
  }
  return () => {
    for (const previous of before) {
      previous.mesh.geometry = previous.geometry;
      previous.mesh.material = previous.material;
    }
  };
}

export function disposeAppearance(appearance: Appearance) {
  for (const geometry of appearance.geometries) geometry.dispose();
  for (const material of appearance.materials) material.dispose();
  for (const texture of appearance.textures) texture.dispose();
}

export function unlitColor(source: Material, map: Texture | null) {
  return new MeshBasicMaterial({ map, side: source.side, transparent: source.transparent, opacity: source.opacity,
    alphaTest: source.alphaTest, depthWrite: source.depthWrite, toneMapped: false });
}

export function sourceAppearance(catalog: TextureCatalog, state: WorkingState, mode: 'preview' | 'fbx' | 'glb' = 'preview',
  live?: { target: TextureTarget; canvas: HTMLCanvasElement }, unlit = false, object?: string) {
  const result = emptyAppearance();
  const fbx = new Map<Texture, Uint8Array<ArrayBuffer>>();
  const auxiliary = new Map<string, { png: Uint8Array<ArrayBuffer>; semantic: string }>();
  const glb = new Map<HTMLCanvasElement, { blob: Blob; name?: string }>();
  const canvases = new Map<TextureImage, HTMLCanvasElement>();
  const encoded = new Map<TextureImage, Uint8Array<ArrayBuffer>>();
  const materialsByMesh = new Map<Mesh, Material[]>();
  const encode = (image: TextureImage) => {
    let png = encoded.get(image);
    if (!png) {
      png = encodeImage(image);
      encoded.set(image, png);
    }
    return png;
  };
  try {
    for (const target of catalog.editTargets(state)) {
      if (target.atlas || object !== undefined && target.binding.object !== object) continue;
      const edited = state.textures?.[target.key]?.image;
      const { binding } = target, semantic = binding.semantic;
      if (semantic && (unlit || !edited && live?.target.key !== target.key)) continue;
      if (semantic === 'roughness' || semantic === 'metallic') {
        if (mode === 'fbx' && edited && binding.sourceName && !target.baked) auxiliary.set(binding.sourceName, { png: encode(edited), semantic });
        continue;
      }
      const image = edited ?? catalog.transferredImage(target);
      let canvas = live?.target.key === target.key ? live.canvas : undefined;
      if (!image && !canvas && !unlit) continue;
      if (!canvas && image && mode !== 'fbx') {
        canvas = canvases.get(image);
        if (!canvas) {
          canvas = sourceImage(image);
          canvases.set(image, canvas);
        }
      }
      const texture = canvas ? mappedTexture(binding.texture, canvas) : image ? binding.texture.clone() : binding.texture;
      if (texture !== binding.texture) result.textures.push(texture);
      if (target.transfer) transferSampling(texture, target.transfer.channel);
      if (semantic) texture.colorSpace = NoColorSpace;
      if (mode === 'fbx' && image) fbx.set(texture, (!edited && target.transfer?.bake.maps.find(map => map.slot === 'map')?.png) || encode(image));
      if (mode === 'glb' && image && canvas) {
        texture.userData = { ...texture.userData, mimeType: 'image/png' };
        const png = !edited ? target.transfer?.bake.maps.find(map => map.slot === 'map')?.png : undefined;
        if (!glb.has(canvas)) glb.set(canvas, { blob: new Blob([png ?? encode(image)], { type: 'image/png' }), name: binding.sourceName });
      }
      let replacement = materialsByMesh.get(binding.mesh);
      if (!replacement) {
        replacement = Array.isArray(binding.mesh.material) ? [...binding.mesh.material] : [binding.mesh.material];
        materialsByMesh.set(binding.mesh, replacement);
      }
      const material = unlit ? unlitColor(binding.material, texture) : replacement[binding.slot].clone();
      const materialSlots = material as unknown as Record<string, Texture | null>;
      const names = semantic === 'metalRough' ? ['roughnessMap', 'metalnessMap'] : [semantic ?? 'map'];
      for (const name of names) materialSlots[name] = texture;
      if (!semantic && target.transfer && !unlit) {
        const slots = material as unknown as Record<string, Texture | null>;
        for (const entry of target.transfer.bake.maps) {
          if (entry.slot === 'map') continue;
          if (entry.slot === 'roughness' || entry.slot === 'metallic') continue;
          const names = entry.slot === 'metalRough' ? ['metalnessMap', 'roughnessMap'] : [entry.slot];
          const original = slots[names[0]], source = original ?? binding.texture;
          const canvas = mode === 'fbx' ? undefined : sourceImage(decodePng(entry.png));
          const texture = canvas ? mappedTexture(source, canvas) : source.clone();
          transferSampling(texture, target.transfer.channel);
          if (!original) {
            texture.colorSpace = entry.slot === 'emissiveMap' ? SRGBColorSpace : NoColorSpace;
            if (entry.slot === 'normalMap' && material instanceof MeshStandardMaterial) material.normalScale.y = -material.normalScale.x;
          }
          texture.userData = { ...texture.userData, mimeType: 'image/png' };
          result.textures.push(texture);
          if (mode === 'glb' && canvas) glb.set(canvas, { blob: new Blob([entry.png], { type: 'image/png' }), name: entry.source });
          if (mode === 'fbx') fbx.set(texture, entry.png);
          for (const name of names) slots[name] = texture;
        }
      }
      material.needsUpdate = true;
      replacement[binding.slot] = material;
      result.materials.push(material);
    }
    for (const [mesh, replacement] of materialsByMesh) {
      result.views.push({ mesh, material: Array.isArray(mesh.material) ? replacement : replacement[0] });
    }
    return { appearance: result, fbx, glb, auxiliary };
  } catch (error) {
    disposeAppearance(result);
    throw error;
  }
}
