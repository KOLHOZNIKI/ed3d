import type { Vec3 } from './data';
import type { Fill } from '../repair/fill';
import { validWeightEdits, type WeightEditRow } from '../weights/data';
import { falloffs, type SoftSelection } from './soft-selection';
import { validSmoothSelection, type SmoothSelectionSettings } from './smooth-selection';
import type { FlattenPlane } from './flatten-selection';

export type TransformMode = 'move' | 'rotate' | 'scale';
type TransformInput = { vertices: number[]; value: Vec3; pivot?: Vec3 };

export type MeshEdit = { object: string } & (
  (TransformInput & ({ type: TransformMode } | { type: 'softTransform'; mode: TransformMode; soft: SoftSelection })) |
  ({ type: 'smoothSelection'; settings: SmoothSelectionSettings } & ({ faces: number[]; vertices?: never } | { vertices: number[]; faces?: never })) |
  { type: 'flattenSelection'; vertices: number[]; plane: FlattenPlane } |
  { type: 'mirrorMove'; vertices: number[]; value: Vec3; axis: number; offset: number; tolerance: number } |
  { type: 'subdivide'; faces: number[] } |
  { type: 'delete' | 'recalculate' | 'flipNormals'; faces: number[] } |
  { type: 'separate'; faces: number[]; piece: string } |
  { type: 'extract'; faces: number[]; piece: string; cut: boolean; pivot: Vec3; rotation: Vec3; scale: number } |
  { type: 'create'; vertices: number[]; material: number; project: boolean } |
  { type: 'weld'; vertices: number[]; mode: 'first' | 'average' | 'tolerance'; tolerance: number } |
  { type: 'splitEdge'; edge: string; fraction: number } |
  { type: 'splitFace'; face: number; diagonal: number[] } |
  { type: 'dissolve' | 'flipEdge'; edge: string } |
  { type: 'repair'; patches: Fill[] } |
  { type: 'weights'; rows: WeightEditRow[] } |
  { type: 'uv'; channel: number; coordinates: number[]; seams: string[]; suppliesTexture?: true }
);

const names = new Set(['move', 'rotate', 'scale', 'softTransform', 'smoothSelection', 'flattenSelection', 'mirrorMove', 'subdivide', 'delete', 'recalculate', 'flipNormals', 'separate',
  'create', 'weld', 'splitEdge', 'splitFace', 'dissolve', 'flipEdge', 'repair', 'uv', 'extract', 'weights']);
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const types = new WeakMap<Uint8Array, MeshEdit['type']>();
const id = (value: unknown) => typeof value === 'string' && /^object-(0|[1-9]\d{0,7})$/.test(value);
const index = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0x7fffffff;
const indices = (value: unknown, min: number) => Array.isArray(value) && value.length >= min && value.length <= 200000 &&
  value.every(index) && new Set(value).size === value.length;
const vec = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const edge = (value: unknown) => typeof value === 'string' && /^\d{1,10}\/\d{1,10}$/.test(value);
export const boundaryId = (value: unknown): value is string => typeof value === 'string' && /^B(0|[1-9]\d{0,9})$/.test(value);

export function encodeEdit(edit: MeshEdit) {
  const bytes = encoder.encode(JSON.stringify(edit));
  types.set(bytes, edit.type);
  return bytes;
}

export const editType = (data: Uint8Array) => types.get(data) ?? decodeEdit(data).type;

export function decodeEdit(data: Uint8Array) {
  const value: unknown = JSON.parse(decoder.decode(data));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const o = value as Record<string, unknown>, t = o.type as string;
  if (!names.has(t) || !id(o.object)) throw invalid();
  let valid: boolean;
  switch (t) {
    case 'move': case 'rotate': case 'scale':
      valid = indices(o.vertices, 1) && vec(o.value) && (o.pivot === undefined || vec(o.pivot)); break;
    case 'softTransform': {
      const soft = o.soft as Partial<SoftSelection> | undefined;
      valid = (o.mode === 'move' || o.mode === 'rotate' || o.mode === 'scale') &&
        indices(o.vertices, 1) && vec(o.value) && (o.pivot === undefined || vec(o.pivot)) &&
        typeof soft?.radius === 'number' && Number.isFinite(soft.radius) && soft.radius > 0 &&
        soft.falloff !== undefined && falloffs.includes(soft.falloff);
      break;
    }
    case 'smoothSelection':
      valid = (o.vertices === undefined ? indices(o.faces, 1) : o.faces === undefined && indices(o.vertices, 1)) &&
        validSmoothSelection(o.settings as Partial<SmoothSelectionSettings> | undefined); break;
    case 'flattenSelection': {
      const plane = o.plane as { mode?: unknown; normal?: unknown; offset?: unknown } | undefined;
      valid = indices(o.vertices, 1) && (plane?.mode === 'bestFit' || plane?.mode === 'specified' &&
        vec(plane.normal) && (plane.normal as number[]).some(value => value !== 0) && Number.isFinite(plane.offset));
      break;
    }
    case 'mirrorMove':
      valid = indices(o.vertices, 1) && vec(o.value) && index(o.axis) && Number(o.axis) <= 2 && Number.isFinite(o.offset) &&
        Number.isFinite(o.tolerance) && Number(o.tolerance) > 1e-8; break;
    case 'delete': case 'recalculate': case 'flipNormals': case 'subdivide':
      valid = indices(o.faces, 1); break;
    case 'separate':
      valid = indices(o.faces, 1) && id(o.piece) && o.piece !== o.object; break;
    case 'extract':
      valid = indices(o.faces, 1) && id(o.piece) && o.piece !== o.object && typeof o.cut === 'boolean' &&
        vec(o.pivot) && vec(o.rotation) && typeof o.scale === 'number' && Number.isFinite(o.scale) && o.scale > 0; break;
    case 'create':
      valid = indices(o.vertices, 3) && index(o.material) && typeof o.project === 'boolean'; break;
    case 'weld':
      valid = indices(o.vertices, 2) && ['first', 'average', 'tolerance'].includes(String(o.mode)) &&
        Number.isFinite(o.tolerance) && Number(o.tolerance) > 0; break;
    case 'splitEdge':
      valid = edge(o.edge) && typeof o.fraction === 'number' && o.fraction > 0 && o.fraction < 1; break;
    case 'splitFace':
      valid = index(o.face) && indices(o.diagonal, 2) && (o.diagonal as number[]).length === 2; break;
    case 'repair':
      valid = Array.isArray(o.patches) && !!o.patches.length && o.patches.every(isFill) &&
        new Set(o.patches.map(fill => fill.id)).size === o.patches.length; break;
    case 'weights': valid = validWeightEdits(o.rows); break;
    case 'uv':
      valid = index(o.channel) && Number(o.channel) <= 3 && Array.isArray(o.coordinates) && !!o.coordinates.length &&
        o.coordinates.every(value => typeof value === 'number' && Number.isFinite(Math.fround(value))) &&
        (o.suppliesTexture === undefined || o.suppliesTexture === true) &&
        Array.isArray(o.seams) && o.seams.every(edge) && new Set(o.seams).size === o.seams.length; break;
    default:
      valid = edge(o.edge);
  }
  if (!valid) throw invalid();
  types.set(data, t as MeshEdit['type']);
  return o as MeshEdit;
}

function isFill(value: unknown): value is Fill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fill = value as Record<string, unknown>;
  if (!boundaryId(fill.id) || typeof fill.project !== 'boolean' || typeof fill.tolerance !== 'number' ||
      fill.tolerance < 0 || fill.tolerance > 1 || fill.material !== undefined && !index(fill.material)) return false;
  const range = (value: unknown, low: number, high: number) => Number.isInteger(value) && Number(value) >= low && Number(value) <= high;
  switch (fill.method) {
    case 'planar': return fill.center === undefined;
    case 'fan': return fill.center === undefined || vec(fill.center);
    case 'smooth': {
      const config = fill.smooth as Record<string, unknown> | undefined;
      return !!config && range(config.density, 1, 3) && range(config.iterations, 0, 50);
    }
    case 'grid': {
      const config = fill.grid as Record<string, unknown> | undefined;
      return !!config && (config.corners === undefined || Array.isArray(config.corners) && config.corners.length === 4 && indices(config.corners, 4));
    }
    case 'bridge': {
      const config = fill.bridge as Record<string, unknown> | undefined;
      return !!config && boundaryId(config.other) && config.other !== fill.id && range(config.startA, 0, 255) &&
        (config.startB === undefined || range(config.startB, 0, 255)) && range(config.twist, -255, 255) &&
        range(config.segments, 1, 16) && (config.span === undefined || range(config.span, 0, 255)) && typeof config.reverse === 'boolean';
    }
    default: return false;
  }
}

function invalid() { return new Error('Invalid saved mesh edit.'); }
