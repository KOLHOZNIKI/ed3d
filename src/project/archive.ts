import { inputLimit, pack, readPackage, validLocalPath, type Files } from '../e00/zip';
import { AssetDocument, defaultHistoryBudget, type ObjectOverrides, type OriginalFile, type SceneEntry, type TextureAssignments } from './document';
import { atlasColor, maxPinnedSnapshots, type AtlasState, type ExtractedAsset, type TextureEdit, type WorkingState } from './state';
import { decodePng, encodeImage, textureHeader, tileSize } from '../texture/image';
import { validatedTransform } from './object-transform';
import { readOperationSettings, type OperationSettings } from './operation-settings';
import { boundaryId, decodeEdit } from '../mesh/commands';
import type { TextureBake } from '../e00/rebake';
import { glbSlots } from '../uv/transfer';
import type { Joint, Pose, PoseState, PoseTranslations, Quat, RigClip, RigState } from '../rig/state';
import { roles, type HumanoidProfile, type HumanoidState, type MotionId, type Role } from '../humanoid/profile';
import { motions } from '../humanoid/motions';
import type { Vec3 } from '../mesh/data';

const MiB = 1024 * 1024;
export const projectLimit = 512 * MiB;
const limits = { input: projectLimit, entry: inputLimit, total: projectLimit - MiB, entries: 512 };
const hashPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const objectId = /^object-\d+$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function workingImageBudget() {
  let used = 0;
  return (width: number, height: number) => {
    used += Math.ceil(width / tileSize) * Math.ceil(height / tileSize) * tileSize ** 2 * 4;
    if (used > projectLimit) throw new Error('The combined working and pinned images exceed the 512 MiB decode budget.');
  };
}

export interface ProjectData {
  id: string;
  name: string;
  revision: number;
  originals: readonly OriginalFile[];
  textureAssignments?: TextureAssignments;
  scene: readonly SceneEntry[];
  historyBudget: number;
  operations?: OperationSettings;
  state: WorkingState;
}

async function digest(bytes: Uint8Array<ArrayBuffer>) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function captureOriginals(files: readonly File[]): Promise<OriginalFile[]> {
  if (!files.length || files.length > 256 || files.reduce((size, file) => size + file.size, 0) > inputLimit) {
    throw new Error('Originals exceed the source file count or size limit.');
  }
  const original: OriginalFile[] = [];
  const owned = new Map<string, Blob>();
  const names = new Set<string>();
  for (const file of files) {
    const name = fileName(file.webkitRelativePath || file.name, true);
    if (names.has(name.toLowerCase())) throw new Error(`Two original files share the same path: ${name}.`);
    names.add(name.toLowerCase());
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await digest(bytes);
    const data = owned.get(hash) ?? new Blob([bytes]);
    owned.set(hash, data);
    original.push({ name, hash, data });
  }
  return original;
}

export async function writeProject(document: AssetDocument<WorkingState>, options?: { id: string; name: string },
  checkpoint?: import('./document').HistoryCheckpoint<WorkingState>): Promise<Blob> {
  // Capture committed, immutable resources before the first asynchronous read.
  const { scene, originals, operations } = document;
  const { state, revision, historyBudget } = checkpoint ?? document;
  const files: Files = new Map();
  const resources: { hash: string; size: number }[] = [];
  let expanded = 0;
  const retain = async (bytes: Uint8Array<ArrayBuffer>, knownHash?: string) => {
    const hash = knownHash ?? await digest(bytes);
    const path = `blobs/${hash}`;
    if (!files.has(path)) {
      expanded += bytes.byteLength;
      if (expanded > limits.total || bytes.byteLength > limits.entry || files.size >= limits.entries - 1) {
        throw new Error('The project exceeds its resource count or size limit.');
      }
      resources.push({ hash, size: bytes.byteLength });
      files.set(path, bytes);
    }
    return hash;
  };
  const originalRefs = [];
  for (const original of originals) {
    const hash = `blobs/${original.hash}`;
    if (!files.has(hash)) await retain(new Uint8Array(await original.data.arrayBuffer()), original.hash);
    originalRefs.push({ name: original.name, hash: original.hash });
  }
  const images = new WeakMap<TextureEdit['image'], string>();
  const pins = state.snapshots ?? [];
  const countedImages = new Set<string>(), checkImageBudget = pins.length ? workingImageBudget() : undefined;
  const writeWorking = async (state: Omit<WorkingState, 'snapshots'>) => {
    const atlas = state.atlas;
    const geometry = atlas && {
      indices: await retain(new Uint8Array(atlas.indices.buffer)), uv: await retain(new Uint8Array(atlas.uv.buffer)),
      sourceCorners: await retain(new Uint8Array(atlas.sourceCorners.buffer)), faceComponents: await retain(new Uint8Array(atlas.faceComponents.buffer)),
      metrics: atlas.metrics, seams: atlas.seams,
    };
    const retainBake = async ({ maps, coverage, ...metadata }: TextureBake) => ({ ...metadata,
      maps: await Promise.all(maps.map(async ({ png, ...map }) => ({ ...map, hash: await retain(png) }))),
      coverage: coverage && await retain(coverage) });
    const bake = state.bake && await retainBake(state.bake);
    const uvBakes = state.uvBakes && Object.fromEntries(await Promise.all(Object.entries(state.uvBakes).map(async ([id, value]) =>
      [id, { channel: value.channel, bake: await retainBake(value.bake) }])));
    const extracts = state.extracts && Object.fromEntries(await Promise.all(Object.entries(state.extracts).map(async ([id, asset]) =>
      [id, { ...asset, bakes: Object.fromEntries(await Promise.all(Object.entries(asset.bakes).map(async ([slot, value]) =>
        [slot, { channel: value.channel, bake: await retainBake(value.bake) }]))) }])));
    let paint;
    if (state.paint) {
      const { png, ...metadata } = state.paint;
      paint = { ...metadata, hash: await retain(png) };
    }
    const textures = [];
    for (const [key, edit] of Object.entries(state.textures ?? {})) {
      let hash = images.get(edit.image);
      if (!hash) { hash = await retain(encodeImage(edit.image)); images.set(edit.image, hash); }
      if (checkImageBudget && !countedImages.has(hash)) {
        checkImageBudget(edit.image.width, edit.image.height);
        countedImages.add(hash);
      }
      textures.push({ key, hash, paint: edit.paint });
    }
    let meshEdits;
    if (state.meshEdits?.length) {
      const bytes = new Uint8Array(state.meshEdits.reduce((length, edit) => length + edit.length + 1, 0));
      let offset = 0;
      for (const edit of state.meshEdits) {
        bytes.set(edit, offset);
        offset += edit.length;
        bytes[offset++] = 10;
      }
      meshEdits = await retain(bytes);
    }
    return { objects: state.objects, objectTransforms: state.objectTransforms, geometry, bake, paint, textures, meshEdits,
      keepOpen: state.keepOpen, uvBakes, extracts, rig: state.rig, poses: state.poses, weightLocks: state.weightLocks, humanoid: state.humanoid };
  };
  const working = await writeWorking(state);
  const snapshots = [];
  for (const snapshot of pins) snapshots.push({ id: snapshot.id, revision: snapshot.revision, working: await writeWorking(snapshot.state) });
  const schemaVersion = snapshots.length ? 14 : working.objectTransforms && Object.keys(working.objectTransforms).length ||
    working.textures.some(texture => texture.key.split('/').length > 3) ? 13 : 12;
  const manifest = encoder.encode(JSON.stringify({ format: 'AssetFixer', schemaVersion, id: options?.id ?? document.id,
    name: options?.name ?? document.name, revision, settings: { historyBudget, operations }, scene, originals: originalRefs,
    textureAssignments: document.textureAssignments && Object.entries(document.textureAssignments), resources, working,
    snapshots: snapshots.length ? snapshots : undefined }));
  if (manifest.byteLength > MiB || expanded + manifest.byteLength > limits.total) throw new Error('The project manifest exceeds its size limit.');
  files.set('manifest.json', manifest);
  const bytes = await pack(files);
  if (bytes.byteLength > projectLimit) throw new Error('The project exceeds the 512 MiB file limit.');
  return new Blob([bytes], { type: 'application/zip' });
}

export async function readProject(blob: Blob): Promise<ProjectData> {
  if (blob.size > projectLimit) throw new Error('The project exceeds the 512 MiB file limit.');
  const files = await readPackage(new Uint8Array(await blob.arrayBuffer()), limits,
    (path, size) => (path === 'manifest.json' && size <= MiB) || /^blobs\/[0-9a-f]{64}$/.test(path));
  const encoded = files.get('manifest.json');
  if (!encoded) throw new Error('The project has no readable manifest.');
  const manifest = record(JSON.parse(decoder.decode(encoded)));
  if (manifest.format !== 'AssetFixer') throw new Error('This file is not an AssetFixer project.');
  const version = integer(manifest.schemaVersion, 1);
  if (version > 14) throw new Error(`Project schema ${version} is newer than this application supports.`);
  // Version 1 had a fixed history budget. Version 2 persists the project setting.
  const settings = version === 1 ? undefined : record(manifest.settings);
  const historyBudget = settings ? integer(settings.historyBudget, MiB, projectLimit) : defaultHistoryBudget;
  const operations = readOperationSettings(settings?.operations);
  if (historyBudget % MiB) throw new Error('Invalid project history budget.');
  const available = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const value of list(manifest.resources, limits.entries)) {
    const entry = record(value), hash = text(entry.hash, 64);
    const bytes = files.get(`blobs/${hash}`);
    if (!hashPattern.test(hash) || available.has(hash) || !bytes || bytes.byteLength !== entry.size || await digest(bytes) !== hash) {
      throw new Error(`Invalid project resource hash or size: ${hash}.`);
    }
    available.set(hash, bytes);
  }
  if (files.size !== available.size + 1) throw new Error('The project has unlisted resources.');
  const used = new Set<string>();
  const resource = (key: unknown) => {
    const hash = text(key, 64), bytes = available.get(hash);
    if (!bytes) throw new Error(`The project is missing resource ${hash}.`);
    used.add(hash);
    return bytes;
  };
  const originalNames = new Set<string>(), originals: OriginalFile[] = [];
  let originalBytes = 0;
  for (const entry of list(manifest.originals, 256).map(record)) {
    const name = fileName(entry.name, version >= 12), hash = text(entry.hash, 64), bytes = resource(hash);
    const key = version >= 12 ? name.toLowerCase() : name;
    originalBytes += bytes.byteLength;
    if (originalNames.has(key) || originalBytes > inputLimit) throw new Error('Invalid original files in project.');
    originalNames.add(key);
    originals.push({ name, hash, data: new Blob([bytes]) });
  }
  if (!originals.length) throw new Error('The project has no original files.');
  const assignments = new Map<string, string>();
  if (version >= 12 && manifest.textureAssignments !== undefined) {
    for (const value of list(manifest.textureAssignments, 256)) {
      const pair = list(value, 2), key = text(pair[0], 4096), path = fileName(pair[1], true);
      if (assignments.has(key) || !/\.(png|jpe?g)$/i.test(path)) throw new Error('Invalid project texture assignment.');
      assignments.set(key, path);
    }
  }
  const entries = new Set<string>();
  const scene = list(manifest.scene, 10000).map(value => {
    const node = record(value), id = text(node.id, 32), parent = node.parent === null ? null : text(node.parent, 32);
    if (!objectId.test(id) || entries.has(id) || (parent !== null && !entries.has(parent))) throw new Error('Invalid project object hierarchy.');
    entries.add(id);
    const transform = list(node.transform, 16).map(value => finite(value));
    if (transform.length !== 16) throw new Error('Invalid object transform.');
    return { id, parent, transform, name: text(node.name, 1024), mesh: bool(node.mesh), visible: bool(node.visible) };
  });
  const images = new WeakMap<Uint8Array, TextureEdit['image']>();
  const checkImageBudget = version >= 14 ? workingImageBudget() : undefined;
  const readWorking = (value: unknown): Omit<WorkingState, 'snapshots'> => {
    const working = record(value), entries = new Set(scene.map(entry => entry.id));
    const extracted = new Map<string, string>();
    let meshEdits: Uint8Array<ArrayBuffer>[] | undefined;
    if (version >= 4 && working.meshEdits !== undefined) {
      const bytes = resource(working.meshEdits);
      meshEdits = [];
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        const row = bytes.slice(start, i), edit = decodeEdit(row);
        if (!entries.has(edit.object)) throw new Error('A saved mesh edit refers to an unknown object.');
        if (edit.type === 'separate' || edit.type === 'extract') {
          if (entries.has(edit.piece)) throw new Error('A saved separate operation reuses an object ID.');
          entries.add(edit.piece);
          if (edit.type === 'extract') extracted.set(edit.piece, edit.object);
        }
        meshEdits.push(row);
        start = i + 1;
      }
      if (!meshEdits.length || start !== bytes.length) throw new Error('The saved mesh edit log is incomplete.');
    }
    const objects: Record<string, ObjectOverrides[string]> = Object.create(null);
    for (const [id, value] of Object.entries(record(working.objects))) {
      if (!entries.has(id)) throw new Error('The project refers to an unknown object.');
      const node = record(value);
      objects[id] = { name: text(node.name, 1024), visible: bool(node.visible) };
    }
    const objectTransforms: Record<string, number[]> = Object.create(null);
    if (version >= 13 && working.objectTransforms !== undefined) for (const [id, value] of Object.entries(record(working.objectTransforms))) {
      if (!entries.has(id)) throw new Error('A saved transform refers to an unknown object.');
      const matrix = list(value, 16).map(finite);
      validatedTransform(matrix);
      objectTransforms[id] = matrix;
    }
    let keepOpen: Record<string, Record<string, boolean>> | undefined;
    if (version >= 5 && working.keepOpen !== undefined) {
      keepOpen = Object.create(null) as Record<string, Record<string, boolean>>;
      for (const [object, flags] of Object.entries(record(working.keepOpen))) {
        if (!entries.has(object)) throw new Error('A protected boundary refers to an unknown object.');
        const saved: Record<string, boolean> = Object.create(null);
        for (const [key, flag] of Object.entries(record(flags))) {
          if (!boundaryId(key)) throw new Error('Invalid protected boundary ID.');
          saved[key] = bool(flag);
        }
        keepOpen[object] = saved;
      }
    }

    let atlas: AtlasState | undefined;
    if (working.geometry) {
      const data = record(working.geometry), m = record(data.metrics);
      const asWords = (key: unknown) => {
        const bytes = resource(key);
        if (!bytes.byteLength || bytes.byteLength % 4) throw new Error('Invalid saved atlas buffer size.');
        return Uint8Array.from(bytes).buffer;
      };
      atlas = {
        indices: new Uint32Array(asWords(data.indices)), uv: new Float32Array(asWords(data.uv)),
        sourceCorners: new Uint32Array(asWords(data.sourceCorners)), faceComponents: new Uint32Array(asWords(data.faceComponents)),
        seams: data.seams === undefined ? undefined : list(data.seams, 1_000_000).map(value => {
          const seam = text(value, 32);
          if (!/^\d{1,10}\/\d{1,10}$/.test(seam)) throw new Error('Invalid saved UV seam.');
          return seam;
        }),
        metrics: {
          width: integer(m.width, 1, 8192), height: integer(m.height, 1, 8192), charts: integer(m.charts, 1),
          separatedFaces: integer(m.separatedFaces), milliseconds: finite(m.milliseconds), controlPoints: integer(m.controlPoints, 1),
          chartVertices: integer(m.chartVertices, 1), renderVertices: integer(m.renderVertices, 1), splitControlPoints: integer(m.splitControlPoints),
        },
      };
    }
    const readBake = (value: unknown, target?: AtlasState, extracting = false): TextureBake => {
      const data = record(value), width = integer(data.width, 1, 16384), height = integer(data.height, 1, 16384);
      const scale = data.direct === undefined ? 2 : 1;
      if (target && (width !== target.metrics.width * scale || height !== target.metrics.height * scale) || width * height > 16_777_216 * 4) {
        throw new Error('Saved baked images do not match the atlas dimensions.');
      }
      const slots: readonly string[] = target || extracting || !originals.some(file => /\.glb$/i.test(file.name)) ?
        [...glbSlots, 'alphaMap', 'roughness', 'metallic'] : glbSlots;
      const maps = list(data.maps, slots.length).map(value => {
        const map = record(value), slot = text(map.slot, 32), source = text(map.source, 2048), png = resource(map.hash);
        if (!slots.includes(slot)) throw new Error('Unknown project bake map slot.');
        validatePng(png, width, height);
        return { slot, source, png };
      });
      if (!maps.some(map => map.slot === 'map') || new Set(maps.map(map => map.slot)).size !== maps.length) {
        throw new Error('Invalid saved bake map set.');
      }
      if (data.generated !== undefined && (data.generated !== true || maps.length !== 1 || maps[0].source !== 'Generated Base Color')) {
        throw new Error('Invalid generated paint atlas.');
      }
      const covered = integer(data.covered, 1, width * height);
      let direct: TextureBake['direct'], coverage: TextureBake['coverage'];
      if (data.direct !== undefined) {
        const info = record(data.direct);
        if (info.filter !== 'linear' && info.filter !== 'nearest') throw new Error('Invalid UV sampling filter.');
        direct = { sourceName: text(info.sourceName, 160), filter: info.filter, misses: integer(info.misses, 0, covered) };
        coverage = resource(data.coverage);
        validatePng(coverage, width, height);
      } else if (!target || data.coverage !== undefined) throw new Error('A UV transfer requires coverage diagnostics.');
      let projection: TextureBake['projection'];
      if (data.projection !== undefined) {
        const info = record(data.projection), maxDistance = finite(info.maxDistance);
        if (!(maxDistance > 0)) throw new Error('Invalid saved projection distance.');
        projection = { sourceName: text(info.sourceName, 160), maxDistance, misses: integer(info.misses, 0, covered),
          eligibleSources: list(info.eligibleSources, 250000).map(group => list(group, 250000).map(id => integer(id))),
          nearest: info.nearest === undefined ? undefined : integer(info.nearest, 0, covered) };
        if (projection.misses + (projection.nearest ?? 0) > covered) throw new Error('Invalid saved projection coverage.');
      }
      return { maps, width, height, padding: integer(data.padding), covered, projection,
        padded: integer(data.padded, 0, width * height), boundaryOnlyTriangles: integer(data.boundaryOnlyTriangles), generated: data.generated, direct, coverage };
    };
    if (working.bake && !atlas) throw new Error('The saved bake has no target atlas.');
    const bake = working.bake ? readBake(working.bake, atlas) : undefined;
    let uvBakes: Record<string, { channel: number; bake: TextureBake }> | undefined;
    if (version >= 6 && working.uvBakes !== undefined) {
      uvBakes = Object.create(null) as NonNullable<typeof uvBakes>;
      for (const [object, value] of Object.entries(record(working.uvBakes))) {
        if (!entries.has(object)) throw new Error('A UV transfer refers to an unknown object.');
        const item = record(value);
        uvBakes[object] = { channel: integer(item.channel, 0, 3), bake: readBake(item.bake) };
      }
    }
    let extracts: Record<string, ExtractedAsset> | undefined;
    if (version >= 7 && working.extracts !== undefined) {
      extracts = Object.create(null) as Record<string, ExtractedAsset>;
      for (const [object, value] of Object.entries(record(working.extracts))) {
        const asset = record(value), source = text(asset.source, 32), layout = asset.layout;
        if (extracted.get(object) !== source || layout !== 'keep' && layout !== 'pack' && layout !== 'unwrap') {
          throw new Error('Invalid saved independent asset.');
        }
        const bakes: Record<number, NonNullable<WorkingState['uvBakes']>[string]> = Object.create(null);
        for (const [slot, entry] of Object.entries(record(asset.bakes))) {
          if (!/^(0|[1-9]\d{0,4})$/.test(slot)) throw new Error('Invalid extracted material slot.');
          const item = record(entry);
          bakes[Number(slot)] = { channel: integer(item.channel, 0, 3), bake: readBake(item.bake, undefined, true) };
        }
        extracts[object] = { source, layout, bakes, zeroOrigin: bool(asset.zeroOrigin) };
      }
    }
    let paint: WorkingState['paint'];
    if (working.paint) {
      if (!bake || bake.maps.length !== 1) throw new Error('The saved paint has no single-map target bake.');
      const data = record(working.paint), png = resource(data.hash);
      validatePng(png, bake.width, bake.height);
      paint = { png, strokes: integer(data.strokes, 1), lastStrokeTexels: integer(data.lastStrokeTexels, 1, bake.width * bake.height) };
    }
    const textures: Record<string, TextureEdit> = Object.create(null);
    if (version >= 3) for (const value of list(working.textures, 256)) {
      const entry = record(value), key = text(entry.key, 100);
      if ((key !== atlasColor && !/^(slot|base)\/object-\d+\/\d+(\/(metalRough|aoMap|roughness|metallic)(\/atlas)?)?$/.test(key)) || Object.hasOwn(textures, key)) {
        throw new Error('Invalid project texture binding ID.');
      }
      if (key === atlasColor && paint) throw new Error('The project contains two versions of the active atlas image.');
      const bytes = resource(entry.hash);
      let image = images.get(bytes);
      if (!image) {
        if (checkImageBudget) {
          const { width, height } = textureHeader(bytes);
          checkImageBudget(width, height);
        }
        image = decodePng(bytes);
        images.set(bytes, image);
      }
      const info = entry.paint === undefined ? undefined : record(entry.paint);
      const strokes = info ? { strokes: integer(info.strokes, 1), lastStrokeTexels: integer(info.lastStrokeTexels, 1, image.width * image.height) } : undefined;
      textures[key] = { image, paint: strokes };
    }
    const rig = version >= 9 && working.rig !== undefined ? readRig(working.rig) : undefined;
    const poses = version >= 9 && working.poses !== undefined ? readPoses(working.poses) : undefined;
    const weightLocks = version >= 10 && working.weightLocks !== undefined ? list(working.weightLocks, 2048).map(readJointId) : undefined;
    if (weightLocks && new Set(weightLocks).size !== weightLocks.length) throw new Error('Duplicate saved weight lock.');
    const humanoid = version >= 11 && working.humanoid !== undefined ? readHumanoid(working.humanoid) : undefined;
    return { objects, objectTransforms: Object.keys(objectTransforms).length ? objectTransforms : undefined,
      atlas, bake, paint, textures, meshEdits, keepOpen, uvBakes, extracts, rig, poses, weightLocks, humanoid };
  };
  const state = readWorking(manifest.working);
  const id = text(manifest.id, 36), revision = integer(manifest.revision, 0, 1e12);
  if (!uuidPattern.test(id)) throw new Error('Invalid project identifier.');
  const snapshotIds = new Set<string>();
  const snapshots = version < 14 || manifest.snapshots === undefined ? [] : list(manifest.snapshots, maxPinnedSnapshots).map(value => {
    const saved = record(value), id = text(saved.id, 36);
    if (!uuidPattern.test(id) || snapshotIds.has(id)) throw new Error('Invalid pinned snapshot identifier.');
    snapshotIds.add(id);
    return { id, revision: integer(saved.revision, 0, revision), state: readWorking(saved.working) };
  });
  if (used.size !== available.size) throw new Error('The project contains unused resources.');
  return { id, name: text(manifest.name, 160), revision, originals, historyBudget, operations, scene,
    textureAssignments: assignments.size ? Object.fromEntries(assignments) : undefined,
    state: { ...state, snapshots: snapshots.length ? snapshots : undefined } };
}

function readJointId(value: unknown) {
  const id = text(value, 42);
  if (!objectId.test(id) && !(id.startsWith('joint-') && uuidPattern.test(id.slice(6)))) throw new Error('Invalid saved joint ID.');
  return id;
}

function readVector(value: unknown, size: 3): Vec3;
function readVector(value: unknown, size: 4): Quat;
function readVector(value: unknown, size: 3 | 4) {
  const result = list(value, size).map(finite);
  if (result.length !== size || !result.every(n => Number.isFinite(Math.fround(n))) ||
      size === 4 && Math.abs(Math.hypot(...result) - 1) > 1e-5) throw new Error('Invalid saved joint transform.');
  return result as unknown as Vec3 | Quat;
}

function readPose(value: unknown): Pose {
  const rows = Object.entries(record(value));
  if (rows.length > 2048) throw new Error('The saved pose has too many joints.');
  return Object.fromEntries(rows.map(([id, rotation]) => [readJointId(id), readVector(rotation, 4)]));
}

function readBasis(value: unknown) {
  if (value === '') return value;
  const id = text(value, 36);
  if (!uuidPattern.test(id)) throw new Error('Invalid rig revision.');
  return id;
}

function readRig(value: unknown): RigState {
  const data = record(value);
  const joints: Joint[] = list(data.joints, 2048).map(row => {
    const joint = record(row);
    return { id: readJointId(joint.id), group: readJointId(joint.group),
      parent: joint.parent === null ? null : readJointId(joint.parent),
      name: joint.name === '' ? '' : text(joint.name, 1024),
      position: readVector(joint.position, 3), rotation: readVector(joint.rotation, 4), scale: readVector(joint.scale, 3) };
  });
  const transfers = Object.fromEntries(Object.entries(record(data.transfers)).map(([source, target]) =>
    [readJointId(source), readJointId(target)]));
  const clips: Record<number, RigClip> = {};
  for (const [id, info] of Object.entries(record(data.clips))) {
    const item = record(info), mode = item.mode;
    if (!/^\d{1,5}$/.test(id) || mode !== 'original' && mode !== 'exclude' && mode !== 'adapted') throw new Error('Invalid saved clip setting.');
    clips[Number(id)] = mode === 'adapted' ? { mode, name: text(item.name, 160), basis: readBasis(item.basis),
      offsets: item.offsets === undefined ? undefined : readPose(item.offsets), translationOffsets: readPoseTranslations(item.translationOffsets) } : { mode };
  }
  return { joints, transfers, clips, rebind: list(data.rebind, 2048).map(readJointId), basis: readBasis(data.basis) };
}

function readPoseTranslations(value: unknown): PoseTranslations | undefined {
  if (value === undefined) return;
  const entries = Object.entries(record(value));
  if (entries.length > 2048) throw new Error('Invalid saved pose translation count.');
  return Object.fromEntries(entries.map(([id, vector]) => [readJointId(id), readVector(vector, 3)]));
}

function readPoses(value: unknown): PoseState {
  const data = record(value), ids = new Set<string>();
  const saved = list(data.saved, 128).map(row => {
    const item = record(row), id = text(item.id, 36);
    if (!uuidPattern.test(id) || ids.has(id)) throw new Error('Invalid saved pose ID.');
    ids.add(id);
    return { id, name: text(item.name, 120), rotations: readPose(item.rotations), translations: readPoseTranslations(item.translations) };
  });
  return { current: readPose(data.current), translations: readPoseTranslations(data.translations), saved };
}

function readHumanoidProfile(value: unknown): HumanoidProfile {
  const data = record(value), corrections = record(data.corrections);
  const roleEntries = <T>(value: unknown, read: (item: unknown) => T) => Object.fromEntries(Object.entries(record(value)).map(([role, item]) => {
    if (!(roles as readonly string[]).includes(role)) throw new Error('Invalid saved humanoid role.');
    return [role as Role, read(item)];
  }));
  const angles = (value: unknown) => {
    const angle = finite(value);
    if (Math.abs(angle) > 180) throw new Error('Invalid saved humanoid angle.');
    return angle;
  };
  const c = data.calibration === undefined ? undefined : record(data.calibration);
  if (c && c.kind !== 'A' && c.kind !== 'T') throw new Error('Invalid saved calibration reference.');
  return { group: readJointId(data.group), mapping: roleEntries(data.mapping, readJointId),
    axes: roleEntries(data.axes, item => { const axis = readVector(item, 3); axis.forEach(angles); return axis; }),
    reverseForward: bool(data.reverseForward),
    corrections: { armAbduction: angles(corrections.armAbduction), legSpacing: angles(corrections.legSpacing), pelvis: readVector(corrections.pelvis, 3) },
    calibration: c ? { kind: c.kind as 'A' | 'T', basis: readBasis(c.basis), mapping: text(c.mapping, 2048), rotations: readPose(c.rotations) } : undefined };
}

function readHumanoid(value: unknown): HumanoidState {
  const data = record(value), names = new Set<string>();
  const published = list(data.published, 24).map(row => {
    const item = record(row), name = text(item.name, 120), motion = item.motion as MotionId;
    if (!motions.some(clip => clip.id === motion) || names.has(name) || !/^[\p{L}\p{N}_ -]+$/u.test(name)) throw new Error('Invalid published diagnostic clip.');
    names.add(name);
    return { name, motion, basis: readBasis(item.basis), profile: readHumanoidProfile(item.profile),
      corrected: bool(item.corrected), rootMotion: bool(item.rootMotion) };
  });
  return { profile: readHumanoidProfile(data.profile), published };
}

function validatePng(png: Uint8Array<ArrayBuffer>, width: number, height: number) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.byteLength < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
    view.getUint32(12) !== 0x49484452 || view.getUint32(16) !== width || view.getUint32(20) !== height) {
    throw new Error('A saved map has invalid PNG dimensions.');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project manifest object.');
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid project manifest array.');
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new Error('Invalid project text value.');
  return value;
}
function fileName(value: unknown, paths: boolean): string {
  const name = text(value, paths ? 1024 : 255);
  const valid = paths ? validLocalPath(name) : !/[\\/\x00-\x1f]/.test(name) && name !== '.' && name !== '..';
  if (!valid) throw new Error('Invalid original filename.');
  return name;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid project boolean value.');
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid project number.');
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const number = finite(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('Invalid project integer.');
  return number;
}
