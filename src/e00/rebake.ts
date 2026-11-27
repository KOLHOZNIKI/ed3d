import { BufferAttribute, ClampToEdgeWrapping, Matrix3, Mesh, MeshPhongMaterial, MeshLambertMaterial,
  MirroredRepeatWrapping, RepeatWrapping, SkinnedMesh, type Texture, type Wrapping } from 'three';
import { decode } from 'fast-png';
import type { ImportedAsset } from './round-trip';
import type { BakeInput, BakeMap } from './rebake-worker';
import { finishWorker } from '../project/worker';
import { bakeScale, chartPadding } from './atlas-raster';
import { renderControlPoints, sourceMesh } from './fbx-topology';
import { faceComponents } from './topology-components';
import type { UvAtlasEdit } from './uv-atlas';

export interface TextureBake {
  maps: { slot: string; source: string; png: Uint8Array<ArrayBuffer> }[];
  width: number;
  height: number;
  covered: number;
  padded: number;
  padding: number;
  boundaryOnlyTriangles: number;
  generated?: true;
  direct?: { sourceName: string; filter: 'nearest' | 'linear'; misses: number };
  coverage?: Uint8Array<ArrayBuffer>;
  projection?: { sourceName: string; misses: number; maxDistance: number; eligibleSources: number[][]; nearest?: number };
}

export function blankPaintMesh(asset: ImportedAsset) {
  const mesh = asset.scene.getObjectByProperty('isMesh', true);
  if (asset.stats.meshes !== 1 || !(mesh instanceof Mesh) || asset.alphaProfile) return;
  const material = mesh.material;
  if (!(material instanceof MeshLambertMaterial || material instanceof MeshPhongMaterial) || material.transparent || material.alphaTest > 0 ||
      Object.entries(material).some(([slot, value]) => slot !== 'map' && value?.isTexture)) return;
  const source = sourceMesh(mesh.geometry);
  if (!source.hasMorphTargets && source.uvs.length === 0) return { mesh, material };
}

export async function createPaintAtlas(asset: ImportedAsset, signal?: AbortSignal): Promise<TextureBake> {
  const atlas = asset.uvAtlas, target = blankPaintMesh(asset);
  if (!atlas || !target) throw new Error('A blank paint atlas requires one FBX mesh without source UVs or additional texture maps.');
  const { position, normal } = target.mesh.geometry.attributes;
  const bake = await bakeInWorker({
    ...bakeTarget(atlas), position: Float32Array.from(position.array), normals: Float32Array.from(normal.array),
    sourceUv: new Float32Array(position.count * 2),
    maps: [{ slot: 'map', source: 'Generated Base Color', mode: 'srgb', width: 1, height: 1,
      pixels: new Uint8ClampedArray([255, 255, 255, 255]) }],
  }, signal);
  return { ...bake, generated: true };
}

export async function rebakeAsset(asset: ImportedAsset, signal?: AbortSignal, baseColor?: Uint8Array<ArrayBuffer>): Promise<ImportedAsset> {
  signal?.throwIfAborted();
  const atlas = asset.uvAtlas;
  const mesh = asset.scene.getObjectByProperty('isMesh', true);
  if (!atlas || !(mesh instanceof Mesh) || atlas.inputGeometry !== mesh.geometry || asset.textureBake) {
    throw new Error('Generate a UV atlas before rebaking textures.');
  }
  const material = mesh.material;
  if (!(material instanceof MeshPhongMaterial || material instanceof MeshLambertMaterial) || !material.map ||
      ((material.transparent || material.alphaTest > 0) && !asset.alphaProfile)) {
    throw new Error('The E00 bake requires one textured FBX material and an explicit profile for alpha.');
  }
  const maps = await originalFbxMaps(asset, material, baseColor);
  const { position, normal: normals, uv } = mesh.geometry.attributes;
  const output = await bakeInWorker({
    ...bakeTarget(atlas), position: Float32Array.from(position.array), normals: Float32Array.from(normals.array),
    sourceUv: Float32Array.from(uv.array), maps,
  }, signal);
  return { ...asset, textureBake: output };
}

export async function originalFbxMaps(asset: ImportedAsset, material: MeshPhongMaterial | MeshLambertMaterial,
  baseColor?: Uint8Array<ArrayBuffer>, auxiliary = true) {
  if (!material.map) throw new Error('The FBX material has no linked Base Color.');
  const normal = material instanceof MeshPhongMaterial ? material.normalMap : null;
  for (const [slot, value] of Object.entries(material)) {
    if (value?.isTexture && slot !== 'map' && slot !== 'normalMap') {
      throw new Error(`The E00 bake does not support the ${slot} texture slot.`);
    }
  }
  const slots = [['map', material.map], ...(normal ? [['normalMap', normal]] as const : [])] as const;
  const maps = await Promise.all(slots.map(([slot, texture]) => readLinkedMap(asset, slot, texture, slot === 'map' ? baseColor : undefined)));
  if (!auxiliary) return maps;
  for (const [source, bytes] of asset.images) {
    if (maps.some(map => map.source === source)) continue;
    const slot = /_(roughness|metallic)\.(jpg|jpeg|png)$/i.exec(source)?.[1].toLowerCase();
    if (!slot) continue;
    if (asset.stats.meshes > 1 && source.replace(/_(roughness|metallic)\.[^.]+$/i, '') !== maps[0].source.replace(/_basecolor\.[^.]+$/i, '')) continue;
    if (maps.some(map => map.slot === slot)) throw new Error(`Multiple Tripo ${slot} maps were found.`);
    maps.push({ slot, source, mode: 'linear', ...await readPixels(bytes) });
  }

  return maps;
}

export async function projectBaseColor(source: ImportedAsset, target: ImportedAsset, eligibleSources: number[][],
  maxDistance: number): Promise<ImportedAsset> {
  const sourceObject = source.scene.getObjectByProperty('isMesh', true);
  const targetObject = target.scene.getObjectByProperty('isMesh', true);
  const atlas = target.uvAtlas;
  if (!(sourceObject instanceof Mesh) || sourceObject instanceof SkinnedMesh || source.stats.meshes !== 1 ||
      !(targetObject instanceof Mesh) || targetObject instanceof SkinnedMesh || target.stats.meshes !== 1 ||
      source.deformation.hasMorphTargets || source.positionEdit || source.repairPatch || source.uvAtlas ||
      !atlas || atlas.inputGeometry !== targetObject.geometry || target.textureBake ||
      !Number.isFinite(maxDistance) || maxDistance <= 0) {
    throw new Error('Projection requires an unedited static FBX source, a static FBX with a fresh target atlas and a positive distance.');
  }
  const sourceMaterial = sourceObject.material, targetMaterial = targetObject.material;
  if (!(sourceMaterial instanceof MeshPhongMaterial || sourceMaterial instanceof MeshLambertMaterial) || !sourceMaterial.map ||
      !(targetMaterial instanceof MeshPhongMaterial || targetMaterial instanceof MeshLambertMaterial) || !targetMaterial.map ||
      sourceMaterial.transparent || targetMaterial.transparent || sourceMaterial.alphaTest || targetMaterial.alphaTest ||
      source.alphaProfile || target.alphaProfile ||
      Object.entries(targetMaterial).some(([slot, texture]) => slot !== 'map' && texture?.isTexture)) {
    throw new Error('The E00 projection requires opaque meshes and a Base Color-only target material.');
  }
  const image = targetMaterial.map.image;
  const targetPath = image instanceof HTMLImageElement && target.imagePathsByUrl.get(image.src);
  if (!targetPath) throw new Error('Projection requires a local target Base Color map.');
  const sourceComponents = faceComponents(renderControlPoints(sourceMesh(sourceObject.geometry)));
  const sourceIds = new Set(sourceComponents);
  const targetComponents = atlas.faceComponents.slice();
  const sourceUv = sourceObject.geometry.getAttribute('uv');
  if (!sourceUv || sourceUv.count !== sourceComponents.length * 3 || targetComponents.length !== atlas.geometry.index!.count / 3 ||
      eligibleSources.length !== new Set(targetComponents).size ||
      eligibleSources.some(ids => !ids.length || ids.some(id => !sourceIds.has(id)))) {
    throw new Error('Projection requires an explicit eligible source set for every target surface and source UVs.');
  }
  sourceObject.updateWorldMatrix(true, false);
  targetObject.updateWorldMatrix(true, false);
  const worldPositions = (mesh: Mesh) => {
    const points = Float32Array.from(mesh.geometry.getAttribute('position').array);
    new BufferAttribute(points, 3).applyMatrix4(mesh.matrixWorld);
    return points;
  };
  const normals = Float32Array.from(targetObject.geometry.getAttribute('normal').array);
  new BufferAttribute(normals, 3).applyNormalMatrix(new Matrix3().getNormalMatrix(targetObject.matrixWorld));
  const map = await readLinkedMap(source, 'map', sourceMaterial.map);
  const output = await bakeInWorker({
    ...bakeTarget(atlas), position: worldPositions(targetObject), normals, sourceUv: Float32Array.from(sourceUv.array),
    maps: [{ ...map, source: targetPath }],
    projection: { sourceName: source.name, sourcePosition: worldPositions(sourceObject), sourceComponents, targetComponents,
      eligibleSources: eligibleSources.map(ids => [...ids]), maxDistance },
  });
  return { ...target, textureBake: output };
}

function bakeTarget(atlas: UvAtlasEdit) {
  const target = atlas.geometry.getAttribute(atlas.channel);
  const index = atlas.geometry.index!;
  const targetUv = new Float32Array(index.count * 2);
  for (let i = 0; i < index.count; i++) {
    const k = index.getX(i);
    targetUv[i * 2] = target.getX(k);
    targetUv[i * 2 + 1] = target.getY(k);
  }
  return { width: atlas.metrics.width * bakeScale, height: atlas.metrics.height * bakeScale,
    padding: chartPadding * bakeScale, targetUv };
}

async function readLinkedMap(asset: ImportedAsset, slot: string, texture: Texture, edited?: Uint8Array<ArrayBuffer>): Promise<BakeMap> {
  const image = texture.image;
  const source = image instanceof HTMLImageElement && asset.imagePathsByUrl.get(image.src);
  if (!source || texture.channel !== 0 || !texture.flipY) {
    throw new Error('The E00 bake requires a local UV0 texture with the FBX image orientation.');
  }
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  const m = texture.matrix.elements;
  const uvTransform = [m[0], m[3], m[6], m[1], m[4], m[7]] as const;
  if (!uvTransform.every(Number.isFinite)) throw new Error('The source UV transform contains non-finite values.');
  if (slot === 'normalMap' && uvTransform.some((value, i) => value !== Number(i === 0 || i === 4))) {
    throw new Error('The E00 bake does not yet support a normal map with its own UV transform.');
  }
  const bytes = edited ?? asset.images.get(source)!;
  const preserveAlpha = slot === 'map' && (!!asset.alphaProfile || !!edited);
  const imageData = preserveAlpha ? readRgbaPng(bytes) : await readPixels(bytes);
  return { slot, source, mode: slot === 'normalMap' ? 'normal' : 'srgb', uvTransform, preserveAlpha,
    wrapS: samplerWrap(texture.wrapS), wrapT: samplerWrap(texture.wrapT), ...imageData };
}

export function samplerWrap(wrap: Wrapping): NonNullable<BakeMap['wrapS']> {
  if (wrap === RepeatWrapping) return 'repeat';
  if (wrap === MirroredRepeatWrapping) return 'mirror';
  if (wrap === ClampToEdgeWrapping) return 'clamp';
  throw new Error('Unsupported source texture wrapping.');
}

function readRgbaPng(bytes: Uint8Array<ArrayBuffer>) {
  const image = decode(bytes);
  if (image.depth !== 8 || image.channels !== 4 || image.palette) {
    throw new Error('The E00 alpha profile requires an 8-bit RGBA PNG Base Color.');
  }
  // Canvas 2D loses RGB at zero alpha through premultiplication.
  return { width: image.width, height: image.height, pixels: new Uint8ClampedArray(image.data) };
}

async function readPixels(bytes: Uint8Array<ArrayBuffer>) {
  const image = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, pixels: ctx.getImageData(0, 0, image.width, image.height).data };
  } finally {
    image.close();
  }
}

export async function bakeInWorker(input: BakeInput, signal?: AbortSignal): Promise<TextureBake> {
  const worker = new Worker(new URL('./rebake-worker.ts', import.meta.url), { type: 'module' });
  const projection = input.projection;
  const spatial = projection?.spatial;
  return finishWorker(worker, input, [...new Set([input.position.buffer, input.normals.buffer, input.sourceUv.buffer, input.targetUv.buffer,
    ...input.maps.flatMap(map => [map.pixels.buffer, ...(map.uv ? [map.uv.buffer] : [])]),
    ...(input.direct?.missing ? [input.direct.missing.buffer] : []), ...(projection ? [projection.sourcePosition.buffer,
      projection.sourceComponents.buffer, projection.targetComponents.buffer] : []),
    ...(spatial ? [spatial.targetPosition.buffer, spatial.targetNormal.buffer, spatial.sourceLocalPosition.buffer, spatial.sourceLocalNormal.buffer,
      spatial.sourceWorldNormal.buffer, ...(spatial.directFaces ? [spatial.directFaces.buffer] : []),
      ...(spatial.excluded ? [spatial.excluded.buffer] : [])] : [])])], signal);
}
