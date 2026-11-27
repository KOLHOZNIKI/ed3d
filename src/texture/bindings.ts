import { Mesh, Source, Texture, type Material } from 'three';
import type { Model, ModelAdapter } from '../project/adapter';
import { blankPaintMesh } from '../e00/rebake';
import { atlasColor, type WorkingState } from '../project/state';
import { decodeImage, decodePng, drawImage, encodeImage, type TextureImage } from './image';

type ColorMaterial = Material & { map: Texture | null };
export interface TextureBinding {
  readonly id: string;
  readonly sharedKey: string;
  readonly object: string;
  readonly label: string;
  readonly mesh: Mesh;
  readonly material: ColorMaterial;
  readonly slot: number;
  readonly texture: Texture;
  readonly source: Blob;
  readonly sourceName?: string;
}

export interface TextureTarget {
  readonly key: string;
  readonly binding: TextureBinding;
  readonly atlas: boolean;
  readonly shared: readonly TextureBinding[];
}

export class TextureCatalog {
  readonly bindings: TextureBinding[] = [];
  #decoded?: { source: Blob; image: Promise<TextureImage> };
  #atlases = new WeakMap<Uint8Array, TextureImage>();
  #generatedBinding?: TextureBinding;

  constructor(adapter: ModelAdapter) {
    const first = new Map<object | string, { key: string; blob: Blob; name?: string }>();
    const model = adapter.model;
    const generated = model.format === 'fbx' && blankPaintMesh(model);
    for (const [object, node] of adapter.objects) {
      if (!(node instanceof Mesh)) continue;
      if (generated && generated.mesh === node) {
        this.#generatedBinding = { id: `slot/${object}/0`, sharedKey: atlasColor, object, mesh: node, material: generated.material,
          slot: 0, texture: generated.material.map ?? new Texture(), source: new Blob(),
          label: `${node.name || object} · Generated Base Color` };
      }
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const [slot, material] of materials.entries()) {
        if (!('map' in material) || !(material.map instanceof Texture)) continue;
        const texture = material.map, image: unknown = texture.image;
        if (!image || typeof image !== 'object') continue;
        const path = model.format === 'fbx' && image instanceof HTMLImageElement ? model.imagePathsByUrl.get(image.src) : undefined;
        const id = `slot/${object}/${slot}`;
        const source = path ?? image;
        let group = first.get(source);
        if (!group) {
          const bytes = model.format === 'fbx' && path ? model.images.get(path) : undefined;
          const embedded = model.format === 'glb' ? model.images.get(image) : undefined;
          const blob = bytes ? new Blob([bytes]) : embedded?.blob;
          if (!blob) continue;
          group = { key: `base/${object}/${slot}`, blob, name: embedded?.name };
          first.set(source, group);
        }
        this.bindings.push({ id, object, mesh: node, material: material as ColorMaterial, slot, texture,
          sharedKey: group.key, source: group.blob, sourceName: group.name,
          label: `${node.name || object} · ${material.name || `Material ${slot + 1}`} · Base Color` });
      }
    }
  }

  targets(state: WorkingState): TextureTarget[] {
    if (state.bake) {
      const binding = state.bake.generated ? this.#generatedBinding : this.bindings[0];
      return binding ? [{ binding, key: atlasColor, atlas: true, shared: [binding] }] : [];
    }
    const keyFor = (binding: TextureBinding) => state.textures?.[binding.id] ? binding.id : binding.sharedKey;
    return this.bindings.map(binding => {
      const key = keyFor(binding);
      return { binding, key, atlas: false, shared: this.bindings.filter(other => keyFor(other) === key) };
    });
  }

  validate(state: WorkingState) {
    if (state.bake?.generated && !this.#generatedBinding) throw new Error('The source does not support a generated paint atlas.');
    for (const [key, edit] of Object.entries(state.textures ?? {})) {
      if (key === atlasColor) {
        if (!state.bake || edit.image.width !== state.bake.width || edit.image.height !== state.bake.height) {
          throw new Error('The edited atlas image does not match the saved bake.');
        }
      } else if (!this.bindings.some(binding => binding.sharedKey === key || binding.id === key) || edit.paint) {
        throw new Error('An edited texture does not match a Base Color binding in the project.');
      }
    }
  }

  load(target: TextureTarget, state: WorkingState): Promise<TextureImage> {
    const working = state.textures?.[target.key]?.image;
    if (working) return Promise.resolve(working);
    if (target.atlas) {
      const png = state.paint?.png ?? state.bake?.maps.find(map => map.slot === 'map')?.png;
      if (!png) throw new Error('The baked Base Color map is missing.');
      let image = this.#atlases.get(png);
      if (!image) {
        image = decodePng(png);
        this.#atlases.set(png, image);
      }
      return Promise.resolve(image);
    }
    const blob = target.binding.source;
    if (this.#decoded?.source !== blob) this.#decoded = { source: blob, image: decodeImage(blob) };
    return this.#decoded.image;
  }
}

export function sourceImage(image: TextureImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  drawImage(canvas.getContext('2d')!, image);
  return canvas;
}

export function mappedTexture(texture: Texture, image: HTMLCanvasElement): Texture {
  const mapped = texture.clone();
  mapped.source = new Source(image);
  mapped.needsUpdate = true;
  return mapped;
}

export function projectedModel(model: Model, state: WorkingState): Model {
  const edit = state.textures?.[atlasColor];
  if (model.format !== 'fbx' || !model.textureBake || !edit) return model;
  const png = encodeImage(edit.image);
  return { ...model, texturePaint: edit.paint && { ...edit.paint, png },
    textureBake: { ...model.textureBake, maps: model.textureBake.maps.map(map => map.slot === 'map' ? { ...map, png } : map) } };
}

export function withoutAtlasEdits(state: WorkingState): WorkingState['textures'] {
  if (!state.textures?.[atlasColor]) return state.textures;
  const textures = { ...state.textures };
  delete textures[atlasColor];
  return textures;
}
