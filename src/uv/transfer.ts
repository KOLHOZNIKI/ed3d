import { Mesh, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial, Texture, type Material } from 'three';
import { bakeInWorker, originalFbxMaps, samplerWrap, type TextureBake } from '../e00/rebake';
import { renderControlPoints, sourceMesh } from '../e00/fbx-topology';
import type { BakeMap } from '../e00/rebake-worker';
import type { ProjectionInput } from '../e00/projection-rays';
import type { Model, ModelAdapter } from '../project/adapter';
import type { WorkingState } from '../project/state';
import type { TextureCatalog } from '../texture/bindings';
import { decodeImage, decodePng, encodeImage, rgbaBytes, type TextureImage } from '../texture/image';
import { diagnose, type Layout, type Surface } from './layout';
import { flatten, uvName } from './surface';

export interface TransferOptions {
  size: number;
  padding: number;
  filter: 'nearest' | 'linear';
  original: boolean;
  fillMissing: boolean;
  scope?: { slot: number; triangles: readonly number[]; clearUnused: boolean };
  projection?: { object: string; input: ProjectionInput };
}

export const glbSlots = ['map', 'normalMap', 'emissiveMap', 'aoMap', 'metalRough'] as const;

export async function transfer(adapter: ModelAdapter, model: Model, catalog: TextureCatalog, state: WorkingState,
  revision: number, object: string, layout: Layout, surface: Surface, options: TransferOptions, signal?: AbortSignal): Promise<TextureBake> {
  signal?.throwIfAborted();
  const diagnostics = diagnose(layout.uv, model.format === 'glb');
  if (diagnostics.outside || diagnostics.degenerate || diagnostics.overlaps) {
    throw new Error(`Target UVs must be inside 0–1 with no degenerate or overlapping triangles. Found ${diagnostics.outside} outside, ${diagnostics.degenerate} degenerate, ${diagnostics.overlaps} conflicting.`);
  }
  const { scope, projection } = options;
  const sourceObject = projection?.object ?? object;
  const mesh = adapter.objects.get(sourceObject);
  if (!(mesh instanceof Mesh) || Array.isArray(mesh.material) && !scope) throw new Error('Direct transfer requires one material on the selected mesh.');
  const slot = scope?.slot ?? 0;
  const material = Array.isArray(mesh.material) ? mesh.material[slot] : mesh.material;
  if (!material) throw new Error('The selected faces have no material.');
  if (mesh.geometry.hasAttribute('tangent')) throw new Error('Direct transfer requires generated tangents. Authored tangent replacement is unavailable.');
  const geometry = options.original ? adapter.mesh.originalGeometry(sourceObject) : mesh.geometry;
  if (!geometry) throw new Error('This object has no original imported mesh. Choose the working snapshot.');
  if (geometry !== mesh.geometry && !projection) {
    const points = model.format === 'fbx' ? renderControlPoints(sourceMesh(geometry)) :
      Uint32Array.from({ length: geometry.index?.count ?? geometry.getAttribute('position').count }, (_, i) => geometry.index?.getX(i) ?? i);
    const same = (a: ArrayLike<number> | undefined, b: Float32Array) =>
      a?.length === b.length && b.every((value, i) => value === a[i]);
    if (points.length !== surface.points.length || !points.every((point, i) => point === surface.points[i]) ||
        !same(flatten(geometry, 'position', 3), surface.positions) || !same(flatten(geometry, 'normal', 3), surface.normals)) {
      throw new Error('The original geometry no longer matches these corners. Choose the working snapshot.');
    }
  }
  const target = catalog.targets(state).find(target => target.binding.object === sourceObject && target.binding.slot === slot);
  const currentColor = !options.original && target && state.textures?.[target.key]?.image;
  const fbxHasBakedRepairs = !options.original && model.format === 'fbx' && state.bake?.direct && model.uvAtlas;
  const pending = new Set(fbxHasBakedRepairs || projection ? [] :
    adapter.mesh.render.get(object)?.state.mesh.faces.filter(face => face.needsUv).map(face => face.id));
  const missing = Uint8Array.from(surface.faces, id => Number(pending.has(id)));
  if (!options.fillMissing && missing.includes(1)) throw new Error('Some repair faces have no source texture. Enable neutral fill for those faces to continue.');
  const maps: BakeMap[] = [];
  let sourceUv: Float32Array<ArrayBuffer> | undefined;
  const stored = !options.original ? target?.transfer : undefined;
  if (stored) {
    sourceUv = flatten(geometry, uvName(stored.channel), 2);
    for (const entry of stored.bake.maps) maps.push(pngMap(entry, entry.slot === 'map' ? currentColor || undefined : undefined, model.format === 'glb'));
  } else if (model.format === 'fbx') {
    if (!scope && !projection && model.stats.meshes !== 1 || !(material instanceof MeshPhongMaterial || material instanceof MeshLambertMaterial)) {
      throw new Error('FBX Preserve Appearance requires a single mesh with one Phong or Lambert material.');
    }
    if (!options.original && state.bake && model.uvAtlas) {
      sourceUv = flatten(model.uvAtlas.geometry, 'uv1', 2);
      for (const entry of state.bake.maps) {
        const bytes = entry.slot === 'map' ? state.paint?.png ?? entry.png : entry.png;
        maps.push(pngMap({ ...entry, png: bytes }, entry.slot === 'map' ? currentColor || undefined : undefined));
      }
    } else {
      sourceUv = flatten(geometry, 'uv', 2);
      if ((material.transparent || material.alphaTest > 0) && !model.alphaProfile) {
        throw new Error('This transparent FBX needs an explicit alpha profile for transfer.');
      }
      maps.push(...await originalFbxMaps(model, material, currentColor ? encodeImage(currentColor) : undefined, !scope || !Array.isArray(mesh.material)));
    }
  } else {
    for (const [slot, texture] of glbMaps(material)) {
      const image = model.images.get(texture.image as object);
      const uv = flatten(geometry, uvName(texture.channel), 2);
      if (!image || !uv || texture.flipY) throw new Error(`The GLB ${slot} requires an embedded image and a supported UV channel.`);
      if (texture.matrixAutoUpdate) texture.updateMatrix();
      const m = texture.matrix.elements;
      const uvTransform = [m[0], m[3], m[6], m[1], m[4], m[7]] as const;
      if (slot === 'normalMap' && (!uvTransform.every((v, i) => v === Number(i === 0 || i === 4)) ||
          !(material instanceof MeshStandardMaterial) || material.normalScale.x < 0 ||
          Math.abs(material.normalScale.x + material.normalScale.y) > 1e-6)) {
        throw new Error('The normal map requires identity sampling and a supported tangent-space scale.');
      }
      const data = slot === 'map' && currentColor ? currentColor : await decodeImage(image.blob);
      maps.push({ slot, source: image.name || slot, mode: encoding(slot), width: data.width, height: data.height,
        pixels: rgbaBytes(data), preserveAlpha: true, topDown: true, uv, uvTransform,
        wrapS: samplerWrap(texture.wrapS), wrapT: samplerWrap(texture.wrapT) });
    }
    sourceUv = maps[0]?.uv;
  }
  if (scope) {
    const select = (uv: Float32Array<ArrayBuffer>) => {
      const selected = new Float32Array(scope.triangles.length * 6);
      scope.triangles.forEach((face, i) => selected.set(uv.subarray(face * 6, face * 6 + 6), i * 6));
      return selected;
    };
    if (sourceUv) sourceUv = select(sourceUv);
    for (const map of maps) {
      if (map.uv) map.uv = select(map.uv);
      if (scope.clearUnused) map.preserveAlpha = true;
    }
  }
  const length = projection ? projection.input.sourceComponents.length * 6 : layout.uv.length;
  if (!sourceUv || sourceUv.length !== length || !maps.some(map => map.slot === 'map')) {
    throw new Error('Preserve Appearance requires linked Base Color and source UV correspondence.');
  }
  for (const map of maps) if (map.mode === 'normal') {
    const uv = map.uv ?? sourceUv;
    if (uv.some((value, i) => (value < -1e-6 || value > 1 + 1e-6) && !missing[Math.floor(i / 6)])) {
      throw new Error('Tangent-space transfer requires normal-map coordinates inside the source image.');
    }
  }
  if (projection) {
    const output = catalog.targets(state).find(target => target.binding.object === object);
    if (!output) throw new Error('The target needs a linked Base Color material before projecting maps.');
    const material = output.binding.material;
    const names = new Set(maps.map(map => map.slot));
    for (const [slot, texture] of Object.entries(material)) if (texture instanceof Texture) {
      const role = slot === 'metalnessMap' || slot === 'roughnessMap' ? 'metalRough' : slot;
      if (!names.has(role)) throw new Error(`The source has no ${role} map for the target material binding.`);
    }
    if (names.has('normalMap') && !(material instanceof MeshStandardMaterial || material instanceof MeshPhongMaterial)) {
      throw new Error('The target material does not support a tangent-space normal map.');
    }
    for (const map of maps) map.preserveAlpha = true;
  }
  const bake = await bakeInWorker({ width: options.size, height: options.size, padding: options.padding,
    position: surface.positions.slice(), normals: surface.normals.slice(), sourceUv, targetUv: layout.uv.slice(), maps,
    projection: projection?.input,
    direct: { sourceName: projection?.input.sourceName ?? (options.original ? 'Original import' : `Working revision ${revision}`),
      filter: options.filter, topDown: model.format === 'glb', missing, clearUnused: scope?.clearUnused },
  }, signal);
  return model.format === 'fbx' && !options.original && state.bake?.generated ? { ...bake, generated: true } : bake;
}

function pngMap(entry: TextureBake['maps'][number], image?: TextureImage, topDown = false): BakeMap {
  const data = image ?? decodePng(entry.png);
  return { slot: entry.slot, source: entry.source, mode: encoding(entry.slot), width: data.width, height: data.height,
    pixels: rgbaBytes(data), preserveAlpha: true, topDown, wrapS: 'clamp', wrapT: 'clamp' };
}

function encoding(slot: string): BakeMap['mode'] {
  return slot === 'map' || slot === 'emissiveMap' ? 'srgb' : slot === 'normalMap' ? 'normal' : 'linear';
}

function glbMaps(source: Material) {
  const material = source as unknown as Record<string, unknown>;
  const known = new Set(['map', 'normalMap', 'emissiveMap', 'aoMap', 'metalnessMap', 'roughnessMap']);
  const unsupported = Object.entries(material).find(([name, value]) => value instanceof Texture && !known.has(name));
  if (unsupported) throw new Error(`Direct transfer does not support the GLB ${unsupported[0]} slot.`);
  const maps: [string, Texture][] = [];
  for (const slot of ['map', 'normalMap', 'emissiveMap', 'aoMap']) {
    const texture = material[slot];
    if (texture instanceof Texture) maps.push([slot, texture]);
  }
  const { metalnessMap, roughnessMap } = material;
  if (metalnessMap || roughnessMap) {
    if (!(metalnessMap instanceof Texture) || metalnessMap !== roughnessMap) throw new Error('The GLB metallic and roughness slots must share one packed texture.');
    maps.push(['metalRough', metalnessMap]);
  }
  return maps;
}
