import type { Vec3 } from './data';
import type { Fill } from '../repair/fill';

export type MeshEdit = { object: string } & (
  { type: 'move' | 'rotate' | 'scale'; vertices: number[]; value: Vec3; pivot?: Vec3 } |
  { type: 'delete' | 'recalculate' | 'flipNormals'; faces: number[] } |
  { type: 'separate'; faces: number[]; piece: string } |
  { type: 'create'; vertices: number[]; material: number; project: boolean } |
  { type: 'weld'; vertices: number[]; mode: 'first' | 'average' | 'tolerance'; tolerance: number } |
  { type: 'splitEdge'; edge: string; fraction: number } |
  { type: 'splitFace'; face: number; diagonal: number[] } |
  { type: 'dissolve' | 'flipEdge'; edge: string } |
  { type: 'repair'; patches: Fill[] }
);

const names = new Set(['move', 'rotate', 'scale', 'delete', 'recalculate', 'flipNormals', 'separate',
  'create', 'weld', 'splitEdge', 'splitFace', 'dissolve', 'flipEdge', 'repair']);
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const id = (value: unknown) => typeof value === 'string' && /^object-(0|[1-9]\d{0,7})$/.test(value);
const index = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0x7fffffff;
const indices = (value: unknown, min: number) => Array.isArray(value) && value.length >= min && value.length <= 200000 &&
  value.every(index) && new Set(value).size === value.length;
const vec = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const edge = (value: unknown) => typeof value === 'string' && /^\d{1,10}\/\d{1,10}$/.test(value);
export const boundaryId = (value: unknown): value is string => typeof value === 'string' && /^B(0|[1-9]\d{0,9})$/.test(value);

export function encodeEdit(edit: MeshEdit) {
  return encoder.encode(JSON.stringify(edit));
}

export function decodeEdit(data: Uint8Array) {
  const value: unknown = JSON.parse(decoder.decode(data));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const o = value as Record<string, unknown>, t = o.type as string;
  if (!names.has(t) || !id(o.object)) throw invalid();
  let valid: boolean;
  switch (t) {
    case 'move': case 'rotate': case 'scale':
      valid = indices(o.vertices, 1) && vec(o.value) && (o.pivot === undefined || vec(o.pivot)); break;
    case 'delete': case 'recalculate': case 'flipNormals':
      valid = indices(o.faces, 1); break;
    case 'separate':
      valid = indices(o.faces, 1) && id(o.piece) && o.piece !== o.object; break;
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
    default:
      valid = edge(o.edge);
  }
  if (!valid) throw invalid();
  return o as MeshEdit;
}

function isFill(value: unknown): value is Fill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fill = value as Record<string, unknown>;
  return boundaryId(fill.id) && (fill.method === 'planar' || fill.method === 'fan') && typeof fill.project === 'boolean' &&
    typeof fill.tolerance === 'number' && fill.tolerance >= 0 && fill.tolerance <= 1 &&
    (fill.center === undefined || fill.method === 'fan' && vec(fill.center)) && (fill.material === undefined || index(fill.material));
}

function invalid() { return new Error('Invalid saved mesh edit.'); }
