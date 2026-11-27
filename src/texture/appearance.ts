import { MeshBasicMaterial, type BufferGeometry, type Material, type Mesh, type Texture } from 'three';
import { mappedTexture, sourceImage, type TextureCatalog, type TextureTarget } from './bindings';
import type { WorkingState } from '../project/state';
import { encodeImage, type TextureImage } from './image';

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
  live?: { target: TextureTarget; canvas: HTMLCanvasElement }, unlit = false) {
  const result = emptyAppearance();
  const fbx = new Map<Texture, Uint8Array<ArrayBuffer>>();
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
    for (const target of catalog.targets(state)) {
      if (target.atlas) continue;
      const image = state.textures?.[target.key]?.image;
      let canvas = live?.target.key === target.key ? live.canvas : undefined;
      if (!image && !canvas && !unlit) continue;
      const { binding } = target;
      if (!canvas && image && mode !== 'fbx') {
        canvas = canvases.get(image);
        if (!canvas) {
          canvas = sourceImage(image);
          canvases.set(image, canvas);
        }
      }
      const texture = canvas ? mappedTexture(binding.texture, canvas) : image ? binding.texture.clone() : binding.texture;
      if (texture !== binding.texture) result.textures.push(texture);
      if (mode === 'fbx' && image) fbx.set(texture, encode(image));
      if (mode === 'glb' && image && canvas) {
        texture.userData = { ...texture.userData, mimeType: 'image/png' };
        if (!glb.has(canvas)) glb.set(canvas, { blob: new Blob([encode(image)], { type: 'image/png' }), name: binding.sourceName });
      }
      const material = unlit ? unlitColor(binding.material, texture) : binding.material.clone();
      material.map = texture;
      material.needsUpdate = true;
      let replacement = materialsByMesh.get(binding.mesh);
      if (!replacement) {
        replacement = Array.isArray(binding.mesh.material) ? [...binding.mesh.material] : [binding.mesh.material];
        materialsByMesh.set(binding.mesh, replacement);
      }
      replacement[binding.slot] = material;
      result.materials.push(material);
    }
    for (const [mesh, replacement] of materialsByMesh) {
      result.views.push({ mesh, material: Array.isArray(mesh.material) ? replacement : replacement[0] });
    }
    return { appearance: result, fbx, glb };
  } catch (error) {
    disposeAppearance(result);
    throw error;
  }
}
