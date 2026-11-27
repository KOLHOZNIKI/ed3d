import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { ClampToEdgeWrapping, LoadingManager, Mesh, Texture, type Group } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { validateFbxAxes } from './fbx-profile';
import { offsetControlPointY, sourceMesh, useSourceTopology, type FbxSourceMesh } from './fbx-topology';
import { sceneStats } from './scene-stats';
import { blankPaintMesh, type TextureBake } from './rebake';
import type { TexturePaint } from './paint';
import type { RepairPatch } from './repair';
import type { UvAtlasEdit } from './uv-atlas';
import { inputLimit, pack, unpack, type Files } from './zip';
import { readAlphaProfile, type AlphaProfile } from './alpha-profile';

const imagePattern = /\.(png|jpe?g)$/i;
const emptyImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const textureSemantics: Record<string, string> = {
  map: 'BaseColor', emissiveMap: 'Emissive', normalMap: 'Normal', bumpMap: 'Bump',
  alphaMap: 'Alpha', specularMap: 'Specular', aoMap: 'AO',
  displacementMap: 'Displacement', envMap: 'Reflection',
};

type TextureEntry = { texture: Texture; fileName: string; slotName: string };
type ExportPlan = { meshes: Parameters<typeof useSourceTopology>[0][]; textures?: { textures: Map<Texture, TextureEntry> } };

export interface ImportedAsset {
  format: 'fbx';
  name: string;
  scene: Group;
  unitScale: number;
  stats: ReturnType<typeof sceneStats>;
  deformation: ReturnType<typeof sourceDeformation>;
  images: Files;
  imagePathsByUrl: Map<string, string>;
  alphaProfile?: AlphaProfile;
  positionEdit?: Readonly<{ geometry: Mesh['geometry']; positions: Float64Array; controlPoint: number; offsetY: number }>;
  repairPatch?: RepairPatch;
  uvAtlas?: UvAtlasEdit;
  textureBake?: TextureBake;
  texturePaint?: TexturePaint;
}

export async function importAsset(input: readonly File[]): Promise<ImportedAsset> {
  if (input.reduce((size, file) => size + file.size, 0) > inputLimit) {
    throw new Error('Input exceeds the 160 MiB limit.');
  }
  const archive = input.find(file => /\.zip$/i.test(file.name));
  if (archive && input.length !== 1) throw new Error('Open one ZIP at a time.');
  const files = archive
    ? await unpack(new Uint8Array(await archive.arrayBuffer()))
    : new Map(await Promise.all(input.map(async file => [file.name, new Uint8Array(await file.arrayBuffer())] as const)));
  if (!archive && files.size !== input.length) throw new Error('Two selected files share the same name.');
  const paths = [...files.keys()].filter(path => /\.fbx$/i.test(path));
  if (paths.length !== 1) throw new Error('Select exactly one FBX with its PNG/JPEG maps, or a ZIP containing them.');
  const [modelPath] = paths;
  const bytes = files.get(modelPath)!;
  validateFbxAxes(bytes);

  const images = new Map([...files].filter(([path]) => imagePattern.test(path)));
  const imagePathsByUrl = new Map<string, string>();
  const urls = new Map<string, string>();
  const embedded = new Set<string>();
  const broken = new Set<string>();
  const manager = new LoadingManager();
  let hasImages = false;
  manager.onStart = () => { hasImages = true; };
  const loaded = new Promise<void>(resolve => { manager.onLoad = resolve; });
  manager.onError = url => broken.add(imagePathsByUrl.get(url) ?? 'embedded image');

  manager.setURLModifier(request => {
    if (request.startsWith(`blob:${location.origin}/`)) {
      embedded.add(request);
      return request;
    }
    if (/^data:image\/(png|jpeg|webp|bmp);base64,/i.test(request)) return request;
    const path = resolveImage(request, modelPath, images);
    if (!path) {
      broken.add(request);
      return emptyImage;
    }
    const existing = urls.get(path);
    if (existing) return existing;
    const mime = path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const url = URL.createObjectURL(new Blob([images.get(path)!], { type: mime }));
    urls.set(path, url);
    imagePathsByUrl.set(url, path);
    return url;
  });

  try {
    const scene = new FBXLoader(manager).parse(bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer, '');
    if (hasImages) await loaded;
    if (broken.size) throw new Error(`Missing, ambiguous or unreadable textures: ${[...broken].join(', ')}`);

    const unitScale = scene.userData.unitScaleFactor;
    if (typeof unitScale !== 'number' || !Number.isFinite(unitScale) || unitScale <= 0) {
      throw new Error('FBX does not declare a valid unit scale.');
    }
    const stats = sceneStats(scene, 'FBX');
    const deformation = sourceDeformation(scene);
    const alphaProfile = readAlphaProfile(files.get('manifest.json'), modelPath, scene);
    return { format: 'fbx', name: basename(modelPath).slice(0, -4), scene, unitScale, stats, deformation, images, imagePathsByUrl, alphaProfile };
  } finally {
    for (const url of [...urls.values(), ...embedded]) URL.revokeObjectURL(url);
  }
}

export function sourceDeformation(scene: Group) {
  const result = { maxSkinInfluences: 0, pointsOverPreviewLimit: 0, morphChannels: 0, hasMorphTargets: false };
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const source = object.geometry.userData.assetFixerFbxSource as FbxSourceMesh | undefined;
    if (!source) return;
    result.maxSkinInfluences = Math.max(result.maxSkinInfluences, source.maxSkinInfluences);
    result.pointsOverPreviewLimit += source.pointsOverPreviewLimit;
    result.morphChannels += source.morphChannels;
    result.hasMorphTargets ||= source.hasMorphTargets;
  });
  return result;
}

export function moveControlPointY(asset: ImportedAsset, controlPoint: number, offsetY: number): ImportedAsset {
  const mesh = asset.scene.getObjectByProperty('isMesh', true);
  if (!(mesh instanceof Mesh) || asset.stats.meshes !== 1 || asset.positionEdit || asset.uvAtlas || asset.repairPatch) {
    throw new Error('The E00 position probe accepts one edit on a single mesh.');
  }
  const positions = offsetControlPointY(mesh.geometry, controlPoint, offsetY);
  return { ...asset, positionEdit: { geometry: mesh.geometry, positions, controlPoint, offsetY } };
}

export async function exportAsset(asset: ImportedAsset, sourceEdits?: ReadonlyMap<Texture, Uint8Array<ArrayBuffer>>,
  extract?: { layout: string; originAtZero: boolean; pivot: number[];
    auxiliary: { semantic: string; file: string; colorSpace: string; channel: string; png: Uint8Array<ArrayBuffer> }[] },
  transfers?: readonly { object: string; bake: TextureBake }[],
): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }> {
  if (asset.deformation.hasMorphTargets) {
    throw new Error('FBX export blocked. The current exporter cannot preserve source morph targets.');
  }
  const edit = asset.positionEdit;
  const atlas = asset.uvAtlas;
  const bake = asset.textureBake;
  const paint = asset.texturePaint;
  const repair = asset.repairPatch;
  const suffix = repair ? `_e00_${repair.metadata.method}` : paint ? '_e00_painted' : bake ? '_e00_baked'
    : atlas ? '_e00_atlas' : edit ? '_e00_edited' : '_e00';
  const name = asset.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) + (extract ? '' : suffix);
  const files: Files = new Map();
  const linked: { semantic: string; file: string; source: string | null; rebaked?: true }[] = [];
  const assigned = new Set<string>();
  const pending: Promise<void>[] = [];
  const writer = new FBXExporter().register((plan: ExportPlan) => {
    for (const mesh of plan.meshes) useSourceTopology(mesh, edit?.geometry === mesh.geometry ? edit.positions : undefined,
      atlas?.inputGeometry === mesh.geometry ? atlas : undefined, !!bake, repair?.inputGeometry === mesh.geometry ? repair : undefined);
    for (const entry of plan.textures?.textures.values() ?? []) {
      const image = entry.texture.image;
      if (!bake?.generated && (!(image instanceof HTMLImageElement) || !image.naturalWidth)) throw new Error('An FBX texture could not be decoded.');
      const source = image instanceof HTMLImageElement ? asset.imagePathsByUrl.get(image.src) ?? null : null;
      const baked = bake?.maps.find(map => map.slot === entry.slotName && (bake.generated || map.source === source));
      if (bake && !baked) throw new Error(`The atlas export has no baked ${entry.slotName} map.`);
      if (baked) {
        const semantic = textureSemantics[entry.slotName];
        const file = `${name}.fbm/${semantic}.png`;
        entry.fileName = file;
        // The atlas already contains the source sampling transform.
        entry.texture = entry.texture.clone();
        entry.texture.offset.set(0, 0);
        entry.texture.repeat.set(1, 1);
        entry.texture.center.set(0, 0);
        entry.texture.rotation = 0;
        entry.texture.matrix.identity();
        if (asset.alphaProfile || bake?.direct) entry.texture.wrapS = entry.texture.wrapT = ClampToEdgeWrapping;
        files.set(file, entry.slotName === 'map' && paint ? paint.png : baked.png);
        linked.push({ semantic, file, source: bake!.generated ? null : baked.source, rebaked: true });
        if (!bake!.generated) assigned.add(baked.source);
        continue;
      }
      const edited = sourceEdits?.get(entry.texture);
      const extension = edited ? 'png' : source?.match(imagePattern)?.[1].toLowerCase() ?? 'png';
      const location = `${name}.fbm/texture_${linked.length + 1}.${extension}`;
      entry.fileName = location;
      linked.push({ semantic: textureSemantics[entry.slotName], file: location, source });
      if (source) {
        assigned.add(source);
        files.set(location, edited ?? asset.images.get(source)!);
      } else if (image instanceof HTMLImageElement) {
        pending.push(encodePng(image).then(bytes => { files.set(location, bytes); }));
      }
    }
  });
  const generated = bake?.generated && blankPaintMesh(asset);
  if (bake?.generated && !generated) throw new Error('The source does not support a generated paint atlas.');
  let fbx: Uint8Array;
  try {
    if (generated) {
      const material = generated.material.clone();
      material.map = new Texture();
      generated.mesh.material = material;
    }
    fbx = writer.parseSync(asset.scene, {
      // This exporter encodes the Tripo +X/+Y/+Z metadata with its -Z option.
      preset: 'unity', axisForward: '-Z', unitScale: asset.unitScale, embedTextures: false, bakeSpaceTransform: false,
    });
  } finally {
    if (generated) {
      const material = generated.mesh.material as typeof generated.material;
      material.map?.dispose();
      material.dispose();
      generated.mesh.material = generated.material;
    }
  }
  await Promise.all(pending);

  const unassigned = [];
  const auxiliaryMaps = [];
  for (const [source, bytes] of asset.images) {
    if (assigned.has(source)) continue;
    const baked = !bake?.generated && bake?.maps.find(map => map.source === source);
    if (baked) {
      const file = `unassigned/${baked.slot}.png`;
      files.set(file, baked.png);
      auxiliaryMaps.push({ semantic: baked.slot, file, source, colorSpace: 'linear', channel: 'uv0' });
      continue;
    }
    const file = `unassigned/${source}`;
    unassigned.push({ source, file });
    files.set(file, bytes);
  }
  const extractMetadata = extract && { layout: extract.layout, originAtZero: extract.originAtZero, pivot: extract.pivot,
    auxiliaryMaps: extract.auxiliary.map(({ png, ...map }) => { files.set(map.file, png); return map; }) };
  const transferMetadata = transfers?.map(({ object, bake }) => ({
    object, channel: 'uv0', covered: bake.covered, projection: bake.projection,
    auxiliaryMaps: bake.maps.filter(map => map.slot === 'metallic' || map.slot === 'roughness').map(map => {
      const file = `rebaked/${object}/${map.slot}.png`;
      files.set(file, map.png);
      return { semantic: map.slot, file, colorSpace: 'linear' };
    }),
  }));
  const model = `${name}.fbx`;
  files.set(model, new Uint8Array(fbx));
  const cornerMap = repair ? 'repair-source-corners.bin' : 'uv-atlas-source-corners.bin';
  const sourceCorners = repair?.sourceCorners ?? atlas?.sourceCorners;
  const hadSourceUv = atlas && sourceMesh(atlas.inputGeometry).uvs.length > 0;
  if (sourceCorners) {
    const bytes = new Uint8Array(sourceCorners.byteLength);
    const view = new DataView(bytes.buffer);
    sourceCorners.forEach((corner, index) => view.setUint32(index * 4, corner, true));
    files.set(cornerMap, bytes);
  }
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify({
    stage: transferMetadata?.some(map => map.projection) ? 'E08' : extract ? 'E07' : 'E00',
    model, unitsInCentimeters: asset.unitScale, meshes: asset.stats, extract: extractMetadata, transfers: transferMetadata,
    skinInfluences: asset.deformation.pointsOverPreviewLimit > 0 ? {
      maxPerControlPoint: asset.deformation.maxSkinInfluences, pointsOverPreviewLimit: asset.deformation.pointsOverPreviewLimit, previewLimit: 4,
    } : undefined,
    assetFixerMaterial: asset.alphaProfile && { ...asset.alphaProfile, uvTransform: bake || extract ? undefined : asset.alphaProfile.uvTransform },
    positionEdit: edit && { controlPoint: edit.controlPoint, offsetY: edit.offsetY },
    repair: repair && { ...repair.metadata, sourceCornerMap: cornerMap },
    uvAtlas: atlas && { channel: bake || !hadSourceUv ? 'uv0' : atlas.channel, sourceCornerMap: cornerMap, ...atlas.metrics },
    textureBake: bake && {
      source: bake.direct?.sourceName ?? (bake.generated ? 'Generated Base Color' : bake.projection?.sourceName ?? 'Original import'),
      layout: 'uv1', exportedLayout: 'uv0', originalLayout: hadSourceUv ? 'uv1' : undefined,
      width: bake.width, height: bake.height, padding: bake.padding, covered: bake.covered,
      padded: bake.padded, boundaryOnlyTriangles: bake.boundaryOnlyTriangles, auxiliaryMaps, projection: bake.projection, direct: bake.direct,
    },
    texturePaint: paint && { semantic: 'BaseColor', channel: 'uv0', strokes: paint.strokes, lastStrokeTexels: paint.lastStrokeTexels },
    textures: linked, unassignedTextures: unassigned,
    warnings: [
      'Prototype export. FBX material properties and rig representation may change.',
      'Unassigned textures are carried as files and require manual assignment in Unity.',
      ...(asset.deformation.pointsOverPreviewLimit > 0
        ? ['The preview is approximate above four skin influences. Export retains all source skin weights.'] : []),
      ...(asset.alphaProfile ? ['Use assetFixerMaterial in this manifest to configure the Unity material alpha mode and cutoff.'] : []),
      ...(bake?.generated ? ['The generated Base Color uses the new UV0 atlas.']
        : bake ? ['Baked textures use the atlas in UV0 for Unity. The original UV layout is retained in UV1.']
        : atlas ? [hadSourceUv ? 'Atlas export writes triangles with UV1. Existing textures continue to use UV0.'
          : 'Atlas export writes triangles with the new UV0.'] : []),
    ],
  }, null, 2) + '\n'));
  return { name: `${name}.zip`, bytes: await pack(files) };
}

function basename(path: string): string {
  return path.split('/').at(-1)!;
}

function resolveImage(request: string, modelPath: string, images: Files): string | undefined {
  const reference = request.replaceAll('\\', '/').toLowerCase();
  const prefix = modelPath.slice(0, modelPath.lastIndexOf('/') + 1).toLowerCase();
  const paths = [...images.keys()];
  const exact = paths.find(path => path.toLowerCase() === prefix + reference);
  if (exact) return exact;
  const byName = paths.filter(path => basename(path).toLowerCase() === basename(reference));
  return byName.length === 1 ? byName[0] : undefined;
}

async function encodePng(image: HTMLImageElement): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cannot encode an embedded texture.');
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Cannot encode an embedded texture as PNG.');
  return new Uint8Array(await blob.arrayBuffer());
}
