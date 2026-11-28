import { ClampToEdgeWrapping, Mesh, Source, Texture, type Material } from 'three';
import type { Model, ModelAdapter } from '../project/adapter';
import { blankPaintMesh, type TextureBake } from '../e00/rebake';
import { atlasColor, type UvBake, type WorkingState } from '../project/state';
import { decodeImage, decodePng, drawImage, encodeImage, type TextureImage } from './image';

type ColorMaterial = Material & { map: Texture | null };
const scalarSlots = ['metalRough', 'aoMap', 'roughness', 'metallic'] as const;
type ScalarSlot = typeof scalarSlots[number];
export const scalarChannels: Record<ScalarSlot, { label: string; channel: 0 | 1 | 2 | 'rgb' }[]> = {
  metalRough: [{ label: 'Roughness', channel: 1 }, { label: 'Metallic', channel: 2 }], aoMap: [{ label: 'AO', channel: 0 }],
  roughness: [{ label: 'Roughness', channel: 'rgb' }], metallic: [{ label: 'Metallic', channel: 'rgb' }],
};
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
  readonly semantic?: ScalarSlot;
}

export interface TextureTarget {
  readonly key: string;
  readonly binding: TextureBinding;
  readonly atlas: boolean;
  readonly shared: readonly TextureBinding[];
  readonly transfer?: UvBake;
  readonly baked?: TextureBake['maps'][number];
}

export class TextureCatalog {
  readonly bindings: TextureBinding[] = [];
  #scalar: TextureBinding[] = [];
  #decoded?: { source: Blob; image: Promise<TextureImage> };
  #atlases = new WeakMap<Uint8Array, TextureImage>();
  #generatedBinding?: TextureBinding;
  #format: Model['format'];

  constructor(adapter: ModelAdapter) {
    const first = new Map<object | string, { key: string; blob: Blob; name?: string }>();
    const model = adapter.model;
    this.#format = model.format;
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
    const shared = new Map<object | string, Map<ScalarSlot, string>>();
    const add = (binding: Pick<TextureBinding, 'id' | 'object' | 'slot' | 'mesh' | 'material' | 'label'>,
      semantic: ScalarSlot, texture: Texture, source: Blob, resource: object | string, sourceName?: string) => {
      const id = `${binding.id}/${semantic}`;
      let keys = shared.get(resource);
      if (!keys) { keys = new Map(); shared.set(resource, keys); }
      const sharedKey = keys.get(semantic) ?? `${binding.id.replace('slot/', 'base/')}/${semantic}`;
      keys.set(semantic, sharedKey);
      this.#scalar.push({ ...binding, id, sharedKey, texture, semantic, source, sourceName,
        label: binding.label.replace(/Base Color$/, scalarChannels[semantic].map(channel => channel.label).join(' / ')) });
    };
    for (const [object, mesh] of adapter.objects) {
      if (!(mesh instanceof Mesh)) continue;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const [slot, material] of materials.entries()) {
        const base = this.bindings.find(binding => binding.mesh === mesh && binding.slot === slot);
        const info = base ?? { id: `slot/${object}/${slot}`, object, slot, mesh, material: material as ColorMaterial,
          label: `${mesh.name || object} · ${material.name || `Material ${slot + 1}`} · Base Color` };
        const maps = material as unknown as Record<string, unknown>;
        for (const [semantic, names] of [['metalRough', ['roughnessMap', 'metalnessMap']], ['aoMap', ['aoMap']]] as const) {
          const texture = maps[names[0]];
          if (!(texture instanceof Texture) || names.some(name => maps[name] !== texture)) continue;
          const image: unknown = texture.image;
          if (typeof image !== 'object' || !image) continue;
          const embedded = model.format === 'glb' ? model.images.get(image) : undefined;
          const path = model.format === 'fbx' && image instanceof HTMLImageElement ? model.imagePathsByUrl.get(image.src) : undefined;
          const bytes = path && model.format === 'fbx' ? model.images.get(path) : undefined;
          const source = embedded?.blob ?? (bytes && new Blob([bytes]));
          if (source) add(info, semantic, texture, source, path ?? image, path ?? embedded?.name);
        }
        if (model.format !== 'fbx' || !base) continue;
        const color = base.texture.image;
        const colorPath = color instanceof HTMLImageElement ? model.imagePathsByUrl.get(color.src) : undefined;
        for (const semantic of ['roughness', 'metallic'] as const) {
          const pattern = new RegExp(`_${semantic}\\.(png|jpe?g)$`, 'i');
          const paths = [...model.images.keys()].filter(path => pattern.test(path) &&
            (model.stats.meshes === 1 && this.bindings.length === 1 || colorPath !== undefined &&
              path.replace(/_(roughness|metallic)\.[^.]+$/i, '') === colorPath.replace(/_basecolor\.[^.]+$/i, '')));
          if (paths.length === 1) add(base, semantic, base.texture, new Blob([model.images.get(paths[0])!]), paths[0], paths[0]);
        }
      }
    }
  }

  targets(state: WorkingState): TextureTarget[] {
    if (state.bake) {
      const binding = state.bake.generated ? this.#generatedBinding : this.bindings[0];
      return binding ? [{ binding, key: atlasColor, atlas: true, shared: [binding] }] : [];
    }
    const transferFor = (binding: TextureBinding) => state.extracts?.[binding.object]?.bakes[binding.slot] ??
      (binding.slot === 0 ? state.uvBakes?.[binding.object] : undefined);
    const keyFor = (binding: TextureBinding) => state.textures?.[binding.id] || transferFor(binding) ? binding.id : binding.sharedKey;
    return this.bindings.map(binding => {
      const key = keyFor(binding);
      return { binding, key, atlas: false, transfer: transferFor(binding), shared: this.bindings.filter(other => keyFor(other) === key) };
    });
  }

  editTargets(state: WorkingState): TextureTarget[] {
    const base = this.targets(state);
    const targets = base.flatMap(target => scalarSlots.flatMap(semantic => {
      const { binding } = target;
      const source = this.#scalar.find(item => item.object === binding.object && item.slot === binding.slot && item.semantic === semantic);
      const baked = (target.atlas ? state.bake : target.transfer?.bake)?.maps.find(map => map.slot === semantic);
      if (!baked && (!source || target.transfer || target.atlas)) return [];
      const id = `${binding.id}/${semantic}${target.atlas ? '/atlas' : ''}`;
      const scalar = source && !target.atlas ? source : { ...(source ?? binding), semantic, id, sharedKey: id,
        label: binding.label.replace(/Base Color$/, scalarChannels[semantic].map(channel => channel.label).join(' / ')) };
      const key = baked || state.textures?.[id] ? id : scalar.sharedKey;
      return [{ ...target, binding: scalar, key, baked, shared: [] as TextureBinding[] }];
    }));
    for (const binding of this.#scalar) if (!state.bake && !base.some(target => target.binding.object === binding.object && target.binding.slot === binding.slot)) {
      targets.push({ binding, key: state.textures?.[binding.id] ? binding.id : binding.sharedKey,
        atlas: false, baked: undefined, shared: [] });
    }
    for (const target of targets) target.shared = targets.filter(other => other.key === target.key).map(other => other.binding);
    return [...base, ...targets];
  }

  workingBake(state: WorkingState, object: string, slot: number, bake: TextureBake) {
    const targets = this.editTargets(state).filter(target => target.binding.object === object && target.binding.slot === slot);
    return { ...bake, maps: bake.maps.map(map => {
      const target = targets.find(target => (target.binding.semantic ?? 'map') === map.slot);
      const image = target && state.textures?.[target.key]?.image;
      return image ? { ...map, png: encodeImage(image) } : map;
    }) };
  }

  validate(state: WorkingState) {
    for (const [object, asset] of Object.entries(state.extracts ?? {})) for (const [slot, transfer] of Object.entries(asset.bakes)) {
      const binding = this.bindings.find(item => item.object === object && item.slot === Number(slot));
      const channel = transfer.channel ? `uv${transfer.channel}` : 'uv';
      if (!binding || !binding.mesh.geometry.hasAttribute(channel)) throw new Error('The saved extraction has no matching material and UV channel.');
    }
    for (const [object, transfer] of Object.entries(state.uvBakes ?? {})) {
      const binding = this.bindings.find(item => item.object === object);
      const channel = transfer.channel ? `uv${transfer.channel}` : 'uv';
      if (this.#format === 'fbx' && transfer.channel !== 0 || !binding || Array.isArray(binding.mesh.material) || !binding.mesh.geometry.hasAttribute(channel)) {
        throw new Error('The saved UV transfer has no matching material and channel.');
      }
    }
    if (state.bake?.generated && !this.#generatedBinding) throw new Error('The source does not support a generated paint atlas.');
    const editable = this.editTargets(state);
    for (const [key, edit] of Object.entries(state.textures ?? {})) {
      if (key === atlasColor) {
        if (!state.bake) {
          throw new Error('The edited atlas image does not match the saved bake.');
        }
      } else if (!editable.some(target => target.binding.sharedKey === key || target.binding.id === key) &&
          !this.#scalar.some(binding => binding.sharedKey === key || binding.id === key) &&
          !this.bindings.some(binding => binding.sharedKey === key || binding.id === key) || edit.paint) {
        throw new Error('An edited texture does not match a material map binding in the project.');
      }
    }
  }

  load(target: TextureTarget, state: WorkingState): Promise<TextureImage> {
    const working = state.textures?.[target.key]?.image;
    if (working) return Promise.resolve(working);
    if (target.baked) return Promise.resolve(this.#decodeBaked(target.baked.png));
    if (target.transfer) return Promise.resolve(this.transferredImage(target)!);
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

  transferredImage(target: TextureTarget) {
    const png = target.baked?.png ?? target.transfer?.bake.maps.find(entry => entry.slot === 'map')?.png;
    if (!png) return;
    return this.#decodeBaked(png);
  }

  #decodeBaked(png: Uint8Array) {
    let image = this.#atlases.get(png);
    if (!image) { image = decodePng(png); this.#atlases.set(png, image); }
    return image;
  }
}

export function transferSampling(texture: Texture, channel: number) {
  texture.channel = channel;
  texture.offset.set(0, 0);
  texture.repeat.set(1, 1);
  texture.center.set(0, 0);
  texture.rotation = 0;
  texture.matrix.identity();
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
}

export function sourceImage(image: TextureImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  drawImage(canvas.getContext('2d')!, image);
  return canvas;
}

export function mappedTexture(texture: Texture, image: HTMLCanvasElement | HTMLImageElement): Texture {
  const mapped = texture.clone();
  mapped.source = new Source(image);
  mapped.needsUpdate = true;
  return mapped;
}

export function projectedModel(model: Model, state: WorkingState, catalog: TextureCatalog): Model {
  const edit = state.textures?.[atlasColor];
  if (model.format !== 'fbx' || !model.textureBake) return model;
  const edits = new Map(catalog.editTargets(state).filter(target => target.atlas && target.binding.semantic)
    .map(target => [target.binding.semantic!, state.textures?.[target.key]?.image]));
  const png = edit && encodeImage(edit.image);
  return { ...model, texturePaint: edit ? edit.paint && { ...edit.paint, png: png! } : model.texturePaint,
    textureBake: { ...model.textureBake, maps: model.textureBake.maps.map(map => {
      if (map.slot === 'map' && png) return { ...map, png };
      const image = edits.get(map.slot as ScalarSlot);
      return image ? { ...map, png: encodeImage(image) } : map;
    }) } };
}

export function withoutAtlasEdits(state: WorkingState): WorkingState['textures'] {
  if (!state.textures) return;
  return Object.fromEntries(Object.entries(state.textures).filter(([key]) => key !== atlasColor && !key.endsWith('/atlas')));
}
