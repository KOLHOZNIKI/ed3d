import { LoadingManager, SkinnedMesh, Texture, type BufferAttribute, type Group, type InterleavedBufferAttribute, type Object3D } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { sceneStats } from './scene-stats';
import { inputLimit } from './zip';

const ngon = 'FB_ngon_encoding';
const meshopt = 'EXT_meshopt_compression';
const webp = 'EXT_texture_webp';
const supportedExtensions = new Set([
  ngon, meshopt, webp, 'KHR_mesh_quantization', 'KHR_materials_volume', 'KHR_materials_transmission', 'KHR_texture_transform',
]);

type EmbeddedImage = { bufferView: number; mimeType: string; name?: string; uri?: string };
type SourceTexture = { source?: number; extensions?: { [webp]?: { source: number } } };
type SourceBuffer = { byteLength: number; uri?: string };
type MeshoptView = { buffer: number; byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string };
type SourceBufferView = {
  buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: { [meshopt]?: MeshoptView };
};
type SkinInfo = { name?: string; skeleton?: number };
type SourceNode = { skin?: number };
type Primitive = { mode?: number; indices?: number; attributes: Record<string, number>; extensions?: Record<string, unknown> };
type SourceDocument = {
  buffers: SourceBuffer[];
  bufferViews?: SourceBufferView[];
  images?: EmbeddedImage[];
  textures?: SourceTexture[];
  meshes?: { primitives: Primitive[] }[];
  nodes?: SourceNode[];
  skins?: SkinInfo[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  scenes: unknown[];
};

type ImagePayload = { blob: Blob; name?: string };
type OutputImage = { bufferView?: number; mimeType: string; name?: string };
type ImportedSkin = { name?: string; skeleton?: Object3D };

export interface ImportedGlb {
  format: 'glb';
  name: string;
  scene: Group;
  stats: ReturnType<typeof sceneStats>;
  affineCorrections: number;
  images: Map<object, ImagePayload>;
  skins: Map<SkinnedMesh, ImportedSkin>;
}

export async function importGlb(file: File): Promise<ImportedGlb> {
  if (file.size > inputLimit) throw new Error('GLB exceeds the 160 MiB input limit.');
  const buffer = await file.arrayBuffer();
  const source = readGlbProfile(buffer);
  const manager = new LoadingManager();
  const localPrefix = `blob:${location.origin}/`;
  manager.setURLModifier(uri => {
    if (!uri.startsWith(localPrefix)) throw new Error('GLB resources must be embedded in the file.');
    return uri;
  });
  const loader = Object.assign(new GLTFLoader(manager), { assetFixerPreserveSkinWeights: true });
  if (source.extensionsUsed?.includes(meshopt)) loader.setMeshoptDecoder(MeshoptDecoder);
  const { scene, animations, parser } = await loader.parseAsync(buffer, '');
  scene.animations = animations;
  const images = new Map<object, ImagePayload>();
  for (const [object, reference] of parser.associations) {
    if (!(object instanceof Texture) || reference.textures === undefined) continue;
    const texture = source.textures?.[reference.textures];
    const imageIndex = texture?.extensions?.[webp]?.source ?? texture?.source;
    const image = imageIndex === undefined ? undefined : source.images?.[imageIndex];
    const decoded: unknown = object.image;
    if (!image || !decoded || typeof decoded !== 'object' || images.has(decoded)) continue;
    const data = await parser.getDependency('bufferView', image.bufferView) as ArrayBuffer;
    images.set(decoded, { blob: new Blob([data], { type: image.mimeType }), name: image.name });
  }
  const nodes = new Map<number, Object3D>();
  for (const [object, reference] of parser.associations) {
    if (reference.nodes !== undefined && !(object instanceof Texture) && 'isObject3D' in object) nodes.set(reference.nodes, object);
  }
  const skins = new Map<SkinnedMesh, ImportedSkin>();
  let affineCorrections = 0;
  scene.traverse(object => {
    if (!(object instanceof SkinnedMesh)) return;
    const reference = parser.associations.get(object);
    const skinIndex = reference?.nodes === undefined ? undefined : source.nodes?.[reference.nodes]?.skin;
    const skin = skinIndex === undefined ? undefined : source.skins?.[skinIndex];
    if (!skin) throw new Error('The skinned GLB mesh has no source skin.');
    const skeleton = skin.skeleton === undefined ? undefined : nodes.get(skin.skeleton);
    if (skin.skeleton !== undefined && !skeleton) throw new Error('The GLB skeleton root is missing from the imported scene.');
    skins.set(object, { name: skin.name, skeleton });
    validateSkinWeights(object);
    for (const { elements } of object.skeleton.boneInverses) {
      const error = Math.max(Math.abs(elements[3]), Math.abs(elements[7]), Math.abs(elements[11]), Math.abs(elements[15] - 1));
      if (!elements.every(Number.isFinite) || error > 1e-6) throw new Error('The GLB contains a non-affine inverse bind matrix.');
      if (error === 0) continue;
      // The affine row is required in glTF, even when source float rounding
      // has made its homogeneous component slightly different from one.
      elements[3] = elements[7] = elements[11] = 0;
      elements[15] = 1;
      affineCorrections++;
    }
  });
  return { format: 'glb', name: file.name.slice(0, -4), scene, stats: sceneStats(scene, 'GLB'), affineCorrections, images, skins };
}

interface BinaryWriter {
  json: { images?: OutputImage[]; nodes?: SourceNode[]; skins?: SkinInfo[]; bufferViews: { byteLength: number }[] };
  nodeMap: Map<Object3D, number>;
  pending: Promise<void>[];
  processBufferViewImage(blob: Blob): Promise<number>;
  processImage(image: object, format: number, flipY: boolean): number;
  isNormalizedNormalAttribute(normal: BufferAttribute | InterleavedBufferAttribute): boolean;
}

export async function exportGlb(asset: ImportedGlb): Promise<{ name: string; bytes: ArrayBuffer }> {
  const exporter = new GLTFExporter().register(writer => {
    const binaryWriter = writer as typeof writer & BinaryWriter;
    const imageIndices = new Map<object, number>();
    const checkNormal = binaryWriter.isNormalizedNormalAttribute.bind(binaryWriter);
    // KHR_mesh_quantization permits non-unit quantized normals. Keep the encoded components for lighting to normalize.
    binaryWriter.isNormalizedNormalAttribute = normal =>
      (normal.normalized && (normal.array instanceof Int8Array || normal.array instanceof Int16Array)) || checkNormal(normal);
    // The pinned writer normally encodes every image through a canvas. The
    // original embedded payload remains authoritative for unchanged textures.
    binaryWriter.processImage = (image, _format, flipY) => {
      const payload = asset.images.get(image);
      if (!payload || flipY) throw new Error('The GLB contains a texture that cannot be exported unchanged.');
      const existing = imageIndices.get(image);
      if (existing !== undefined) return existing;
      const images = binaryWriter.json.images ??= [];
      const output: OutputImage = { mimeType: payload.blob.type, name: payload.name };
      const index = images.push(output) - 1;
      imageIndices.set(image, index);
      binaryWriter.pending.push(binaryWriter.processBufferViewImage(payload.blob).then(view => {
        output.bufferView = view;
        // Alignment bytes belong to the container, outside the image view.
        binaryWriter.json.bufferViews[view].byteLength = payload.blob.size;
      }));
      return index;
    };
    return {
      writeMesh(mesh, definition) {
        if (!mesh.userData.gltfExtensions?.[ngon]) return;
        const [primitive] = definition.primitives as Primitive[];
        (primitive.extensions ??= {})[ngon] = mesh.userData.gltfExtensions[ngon];
        writer.extensionsUsed[ngon] = true;
      },
      writeNode(_object, definition) {
        // GLTFLoader puts primitive metadata on the preview object. The node
        // exporter would otherwise emit a second copy at the wrong location.
        const extensions = definition.extensions as Record<string, unknown> | undefined;
        if (!extensions || !(ngon in extensions)) return;
        delete extensions[ngon];
        if (!Object.keys(extensions).length) delete definition.extensions;
      },
      afterParse() {
        for (const [mesh, inputSkin] of asset.skins) {
          const nodeIndex = binaryWriter.nodeMap.get(mesh);
          const skinIndex = nodeIndex === undefined ? undefined : binaryWriter.json.nodes?.[nodeIndex]?.skin;
          const output = skinIndex === undefined ? undefined : binaryWriter.json.skins?.[skinIndex];
          if (!output) throw new Error('The GLB exporter did not write the imported skin.');
          if (inputSkin.name !== undefined) output.name = inputSkin.name;
          if (inputSkin.skeleton) {
            const root = binaryWriter.nodeMap.get(inputSkin.skeleton);
            if (root === undefined) throw new Error('The GLB exporter did not write the imported skeleton root.');
            output.skeleton = root;
          } else {
            delete output.skeleton;
          }
        }
      },
    };
  });
  const bytes = await exporter.parseAsync(asset.scene, { binary: true, animations: asset.scene.animations, includeCustomExtensions: true });
  if (!(bytes instanceof ArrayBuffer)) throw new Error('The exporter did not return a binary GLB.');
  return { name: `${asset.name}_e00.glb`, bytes };
}

function readGlbProfile(buffer: ArrayBuffer): SourceDocument {
  if (buffer.byteLength < 20) throw new Error('Incomplete GLB header.');
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== buffer.byteLength || view.getUint32(16, true) !== 0x4e4f534a
    || jsonLength % 4 !== 0 || jsonLength > buffer.byteLength - 20) {
    throw new Error('Expected a complete GLB version 2 file.');
  }
  const source = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as SourceDocument;
  if (source.scenes?.length !== 1
    || (source.images ?? []).some(image => image.uri !== undefined || !Number.isInteger(image.bufferView)
      || (image.mimeType !== 'image/jpeg' && image.mimeType !== 'image/png' && image.mimeType !== 'image/webp'))) {
    throw new Error('E00 supports a single GLB scene with embedded JPEG, PNG, or WebP maps.');
  }
  const unsupported = [...(source.extensionsUsed ?? []), ...(source.extensionsRequired ?? [])]
    .find(extension => !supportedExtensions.has(extension));
  if (unsupported) throw new Error(`Unsupported GLB extension: ${unsupported}.`);
  if (source.extensionsUsed?.includes(meshopt)) {
    validateMeshoptBuffers(view, 20 + jsonLength, source);
  } else if (source.buffers?.length !== 1 || source.buffers[0].uri !== undefined) {
    throw new Error('The GLB requires a single embedded buffer.');
  }
  for (const texture of source.textures ?? []) {
    const webpSource = texture.extensions?.[webp];
    if (webpSource && (texture.source !== undefined || source.images?.[webpSource.source]?.mimeType !== 'image/webp' ||
        !source.extensionsUsed?.includes(webp) || !source.extensionsRequired?.includes(webp))) {
      throw new Error('E00 supports embedded WebP textures declared as required, without alternate fallback images.');
    }
  }
  if ((source.meshes ?? []).some(mesh => mesh.primitives.length !== 1 || mesh.primitives.some(primitive =>
    (primitive.mode ?? 4) !== 4 || primitive.indices === undefined || primitive.attributes.JOINTS_1 !== undefined
    || primitive.attributes.WEIGHTS_1 !== undefined))) {
    throw new Error('E00 supports one indexed triangle primitive per GLB mesh and up to four skin influences.');
  }
  return source;
}

function validateMeshoptBuffers(container: DataView, chunk: number, source: SourceDocument): void {
  const buffers = source.buffers ?? [];
  if (buffers.length < 1 || buffers.length > 2 || buffers.some(buffer => buffer.uri !== undefined ||
      !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength <= 0 || buffer.byteLength > inputLimit) ||
      (buffers.length === 2 && !source.extensionsRequired?.includes(meshopt))) {
    throw new Error('GLB requires an embedded buffer and may declare one Meshopt fallback buffer.');
  }
  if (chunk > container.byteLength - 8 || container.getUint32(chunk + 4, true) !== 0x004e4942) {
    throw new Error('The GLB binary chunk is missing.');
  }
  const binaryLength = container.getUint32(chunk, true);
  if (binaryLength % 4 !== 0 || chunk + 8 + binaryLength > container.byteLength || binaryLength < buffers[0].byteLength ||
      binaryLength > buffers[0].byteLength + 3) {
    throw new Error('The GLB binary chunk length does not match its buffer.');
  }

  let decodedBytes = 0;
  for (const view of source.bufferViews ?? []) {
    const buffer = buffers[view.buffer];
    const compressed = view.extensions?.[meshopt];
    if (!buffer || !fitsBuffer(view.byteOffset ?? 0, view.byteLength, buffer.byteLength) ||
        (view.buffer === 1 && !compressed)) throw new Error('Invalid GLB buffer view range.');
    if (!compressed) continue;
    const { buffer: index, byteOffset = 0, byteLength, byteStride, count, mode, filter = 'NONE' } = compressed;
    const attribute = mode === 'ATTRIBUTES';
    const strideValid = attribute ? byteStride > 0 && byteStride <= 256 && byteStride % 4 === 0
      : (mode === 'INDICES' || mode === 'TRIANGLES') && (byteStride === 2 || byteStride === 4);
    const filterValid = filter === 'NONE' || (attribute && (
      filter === 'EXPONENTIAL' || (filter === 'OCTAHEDRAL' && (byteStride === 4 || byteStride === 8)) ||
      (filter === 'QUATERNION' && byteStride === 8)));
    if (index !== 0 || !fitsBuffer(byteOffset, byteLength, buffers[0].byteLength) ||
        !strideValid || (view.byteStride !== undefined && view.byteStride !== byteStride) ||
        !Number.isSafeInteger(count) || count <= 0 || count * byteStride !== view.byteLength ||
        (mode === 'TRIANGLES' && count % 3 !== 0) || !filterValid) {
      throw new Error('Invalid GLB Meshopt buffer view.');
    }
    decodedBytes += view.byteLength;
    if (decodedBytes > inputLimit) throw new Error('GLB Meshopt data exceeds the 160 MiB decoded limit.');
  }
}

function fitsBuffer(offset: number, length: number, bufferLength: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length > 0 && offset + length <= bufferLength;
}

function validateSkinWeights(mesh: SkinnedMesh): void {
  const joints = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  if (joints?.itemSize !== 4 || weights?.itemSize !== 4 || joints.count !== weights.count
    || weights.count !== mesh.geometry.getAttribute('position').count) {
    throw new Error('The GLB skin requires four joint and weight components per vertex.');
  }
  const boneCount = mesh.skeleton.bones.length;
  for (let vertex = 0; vertex < weights.count; vertex++) {
    let sum = 0;
    for (let component = 0; component < 4; component++) {
      const joint = joints.getComponent(vertex, component);
      const weight = weights.getComponent(vertex, component);
      if (!Number.isInteger(joint) || joint < 0 || joint >= boneCount || !Number.isFinite(weight) || weight < 0) {
        throw new Error('The GLB contains an invalid skin joint or weight.');
      }
      sum += weight;
    }
    if (Math.abs(sum - 1) > 1e-5) throw new Error('The GLB contains skin weights that are not normalized.');
  }
}
