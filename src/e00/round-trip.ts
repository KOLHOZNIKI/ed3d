import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { LoadingManager, Mesh, SkinnedMesh, type Group, type Texture } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { validateFbxAxes } from './fbx-profile';
import { inputLimit, pack, unpack, type Files } from './zip';

const imagePattern = /\.(png|jpe?g)$/i;
const emptyImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const textureSemantics: Record<string, string> = {
  map: 'BaseColor', emissiveMap: 'Emissive', normalMap: 'Normal', bumpMap: 'Bump',
  alphaMap: 'Alpha', specularMap: 'Specular', aoMap: 'AO',
  displacementMap: 'Displacement', envMap: 'Reflection',
};

type TextureEntry = { texture: Texture; fileName: string; slotName: string };
type TexturePlan = { textures?: { textures: Map<Texture, TextureEntry> } };

export interface ImportedAsset {
  name: string;
  scene: Group;
  unitScale: number;
  stats: { meshes: number; triangles: number; bones: number; clips: number };
  images: Files;
  imagePathsByUrl: Map<string, string>;
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
    const stats = { meshes: 0, triangles: 0, bones: 0, clips: scene.animations.length };
    const bones = new Set();
    scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      stats.meshes++;
      stats.triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
      if (object instanceof SkinnedMesh) {
        for (const bone of object.skeleton.bones) bones.add(bone);
      }
    });
    if (!stats.meshes) throw new Error('The FBX contains no meshes.');
    stats.bones = bones.size;
    return { name: basename(modelPath).slice(0, -4), scene, unitScale, stats, images, imagePathsByUrl };
  } finally {
    for (const url of [...urls.values(), ...embedded]) URL.revokeObjectURL(url);
  }
}

export async function exportAsset(asset: ImportedAsset): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }> {
  const name = asset.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) + '_e00';
  const files: Files = new Map();
  const linked: { semantic: string; file: string; source: string | null }[] = [];
  const assigned = new Set<string>();
  const pending: Promise<void>[] = [];
  const fbx = new FBXExporter().register((plan: TexturePlan) => {
    for (const entry of plan.textures?.textures.values() ?? []) {
      const image = entry.texture.image;
      if (!(image instanceof HTMLImageElement) || !image.naturalWidth) throw new Error('An FBX texture could not be decoded.');
      const source = asset.imagePathsByUrl.get(image.src) ?? null;
      const extension = source?.match(imagePattern)?.[1].toLowerCase() ?? 'png';
      const location = `${name}.fbm/texture_${linked.length + 1}.${extension}`;
      entry.fileName = location;
      linked.push({ semantic: textureSemantics[entry.slotName], file: location, source });
      if (source) {
        assigned.add(source);
        files.set(location, asset.images.get(source)!);
      } else {
        pending.push(encodePng(image).then(bytes => { files.set(location, bytes); }));
      }
    }
  }).parseSync(asset.scene, {
    // This exporter encodes the Tripo +X/+Y/+Z metadata with its -Z option.
    preset: 'unity', axisForward: '-Z', unitScale: asset.unitScale, embedTextures: false, bakeSpaceTransform: false,
  });
  await Promise.all(pending);

  const unassigned = [];
  for (const [source, bytes] of asset.images) {
    if (assigned.has(source)) continue;
    const file = `unassigned/${source}`;
    unassigned.push({ source, file });
    files.set(file, bytes);
  }
  const model = `${name}.fbx`;
  files.set(model, new Uint8Array(fbx));
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify({
    stage: 'E00', model, unitsInCentimeters: asset.unitScale, meshes: asset.stats,
    textures: linked, unassignedTextures: unassigned,
    warnings: [
      'Prototype export. FBX material properties, rig transforms and render-vertex connectivity may change.',
      'Unassigned textures are carried as files and require manual assignment in Unity.',
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
