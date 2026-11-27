import { inputLimit, pack, readPackage, type Files } from '../e00/zip';
import { AssetDocument, defaultHistoryBudget, type ObjectOverrides, type OriginalFile, type SceneEntry } from './document';
import { atlasColor, type AtlasState, type TextureEdit, type WorkingState } from './state';
import { decodePng, encodeImage } from '../texture/image';

const MiB = 1024 * 1024;
export const projectLimit = 512 * MiB;
const limits = { input: projectLimit, entry: inputLimit, total: projectLimit - MiB, entries: 512 };
const hashPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const objectId = /^object-\d+$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export interface ProjectData {
  id: string;
  name: string;
  revision: number;
  originals: readonly OriginalFile[];
  scene: readonly SceneEntry[];
  historyBudget: number;
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
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await digest(bytes);
    const data = owned.get(hash) ?? new Blob([bytes]);
    owned.set(hash, data);
    original.push({ name: fileName(file.name), hash, data });
  }
  return original;
}

export async function writeProject(document: AssetDocument<WorkingState>, options?: { id: string; name: string }): Promise<Blob> {
  // Capture committed, immutable resources before the first asynchronous read.
  const { state, scene, revision, originals, historyBudget } = document;
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
  const atlas = state.atlas;
  const geometry = atlas && {
    indices: await retain(new Uint8Array(atlas.indices.buffer)), uv: await retain(new Uint8Array(atlas.uv.buffer)),
    sourceCorners: await retain(new Uint8Array(atlas.sourceCorners.buffer)), faceComponents: await retain(new Uint8Array(atlas.faceComponents.buffer)),
    metrics: atlas.metrics,
  };
  let bake;
  if (state.bake) {
    const { maps, ...metadata } = state.bake;
    bake = { ...metadata, maps: await Promise.all(maps.map(async ({ png, ...map }) => ({ ...map, hash: await retain(png) }))) };
  }
  let paint;
  if (state.paint) {
    const { png, ...metadata } = state.paint;
    paint = { ...metadata, hash: await retain(png) };
  }
  const textures = [];
  for (const [key, edit] of Object.entries(state.textures ?? {})) {
    textures.push({ key, hash: await retain(encodeImage(edit.image)), paint: edit.paint });
  }
  const manifest = encoder.encode(JSON.stringify({ format: 'AssetFixer', schemaVersion: 3, id: options?.id ?? document.id,
    name: options?.name ?? document.name, revision, settings: { historyBudget }, scene, originals: originalRefs,
    resources, working: { objects: state.objects, geometry, bake, paint, textures } }));
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
  if (version > 3) throw new Error(`Project schema ${version} is newer than this application supports.`);
  // Version 1 had a fixed history budget. Version 2 persists the project setting.
  const historyBudget = version === 1 ? defaultHistoryBudget : integer(record(manifest.settings).historyBudget, MiB, projectLimit);
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
    const name = fileName(entry.name), hash = text(entry.hash, 64), bytes = resource(hash);
    originalBytes += bytes.byteLength;
    if (originalNames.has(name) || originalBytes > inputLimit) throw new Error('Invalid original files in project.');
    originalNames.add(name);
    originals.push({ name, hash, data: new Blob([bytes]) });
  }
  if (!originals.length) throw new Error('The project has no original files.');
  const entries = new Set<string>();
  const scene = list(manifest.scene, 10000).map(value => {
    const node = record(value), id = text(node.id, 32), parent = node.parent === null ? null : text(node.parent, 32);
    if (!objectId.test(id) || entries.has(id) || (parent !== null && !entries.has(parent))) throw new Error('Invalid project object hierarchy.');
    entries.add(id);
    const transform = list(node.transform, 16).map(value => finite(value));
    if (transform.length !== 16) throw new Error('Invalid object transform.');
    return { id, parent, transform, name: text(node.name, 1024), mesh: bool(node.mesh), visible: bool(node.visible) };
  });
  const working = record(manifest.working);
  const objects: Record<string, ObjectOverrides[string]> = Object.create(null);
  for (const [id, value] of Object.entries(record(working.objects))) {
    if (!entries.has(id)) throw new Error('The project refers to an unknown object.');
    const node = record(value);
    objects[id] = { name: text(node.name, 1024), visible: bool(node.visible) };
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
      metrics: {
        width: integer(m.width, 1, 8192), height: integer(m.height, 1, 8192), charts: integer(m.charts, 1),
        separatedFaces: integer(m.separatedFaces), milliseconds: finite(m.milliseconds), controlPoints: integer(m.controlPoints, 1),
        chartVertices: integer(m.chartVertices, 1), renderVertices: integer(m.renderVertices, 1), splitControlPoints: integer(m.splitControlPoints),
      },
    };
  }
  let bake: WorkingState['bake'];
  if (working.bake) {
    if (!atlas) throw new Error('The saved bake has no target atlas.');
    const data = record(working.bake), width = integer(data.width, 1, 16384), height = integer(data.height, 1, 16384);
    if (width !== atlas.metrics.width * 2 || height !== atlas.metrics.height * 2 || width * height > 16_777_216 * 4) {
      throw new Error('Saved baked images do not match the atlas dimensions.');
    }
    const maps = list(data.maps, 4).map(value => {
      const map = record(value), slot = text(map.slot, 32), source = text(map.source, 2048), png = resource(map.hash);
      if (!['map', 'normalMap', 'roughness', 'metallic'].includes(slot)) throw new Error('Unknown project bake map slot.');
      validatePng(png, width, height);
      return { slot, source, png };
    });
    if (!maps.some(map => map.slot === 'map') || new Set(maps.map(map => map.slot)).size !== maps.length) {
      throw new Error('Invalid saved bake map set.');
    }
    bake = { maps, width, height, padding: integer(data.padding), covered: integer(data.covered, 1, width * height),
      padded: integer(data.padded, 0, width * height), boundaryOnlyTriangles: integer(data.boundaryOnlyTriangles) };
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
    if ((key !== atlasColor && !/^(slot|base)\/object-\d+\/\d+$/.test(key)) || Object.hasOwn(textures, key)) {
      throw new Error('Invalid project texture binding ID.');
    }
    if (key === atlasColor && paint) throw new Error('The project contains two versions of the active atlas image.');
    const image = decodePng(resource(entry.hash));
    const info = entry.paint === undefined ? undefined : record(entry.paint);
    const strokes = info ? { strokes: integer(info.strokes, 1), lastStrokeTexels: integer(info.lastStrokeTexels, 1, image.width * image.height) } : undefined;
    textures[key] = { image, paint: strokes };
  }
  if (used.size !== available.size) throw new Error('The project contains unused resources.');
  const id = text(manifest.id, 36);
  if (!uuidPattern.test(id)) throw new Error('Invalid project identifier.');
  return { id, name: text(manifest.name, 160), revision: integer(manifest.revision, 0, 1e12), originals, historyBudget, scene,
    state: { objects, atlas, bake, paint, textures } };
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
function fileName(value: unknown): string {
  const name = text(value, 255);
  if (/[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('Invalid original filename.');
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
