import type { BufferGeometry } from 'three';
import type { ModelAdapter } from '../project/adapter';
import { groups } from '../uv/layout';
import { uvTopology } from '../uv/surface';
import type { TextureTarget } from './bindings';
import { textureFaces, type UvTriangle } from './overlay';
import type { Point, Region } from './stroke';

export type MaskKind = 'face' | 'island';

export function maskRegions(adapter: ModelAdapter, target: TextureTarget, atlas?: BufferGeometry, atlasSeams?: readonly string[]) {
  const { object, texture } = target.binding;
  const { points, faces } = uvTopology(adapter, object);
  const channel = target.atlas ? 1 : target.transfer?.channel ?? texture.channel;
  const seams = target.atlas ? atlasSeams
    : adapter.mesh.render.get(object)?.state.mesh.uvSeams?.[channel];
  const triangles = [...textureFaces(target, atlas)];
  const localPoints = new Uint32Array(triangles.length * 3), uv = new Float32Array(triangles.length * 6);
  for (const [i, [triangle, corners]] of triangles.entries()) {
    localPoints.set(points.subarray(triangle * 3, triangle * 3 + 3), i * 3);
    for (const [corner, { x, y }] of corners.entries()) uv.set([x, y], (i * 3 + corner) * 2);
  }
  const charts = groups({ points: localPoints }, { uv, seams: seams ?? [] });
  const regions = { face: new Map<number, UvTriangle[]>(), island: new Map<number, UvTriangle[]>() };
  const add = (kind: MaskKind, id: number, triangle: UvTriangle) => {
    const list = regions[kind].get(id);
    if (list) list.push(triangle);
    else regions[kind].set(id, [triangle]);
  };
  for (const [i, [triangle, corners]] of triangles.entries()) {
    add('face', faces[triangle], corners);
    add('island', charts.islandOf(i * 3), corners);
  }
  return regions;
}

function inside([a, b, c]: UvTriangle) {
  const dx = b.x - a.x, dy = b.y - a.y, ex = c.x - a.x, ey = c.y - a.y;
  const det = dx * ey - dy * ex;
  return (x: number, y: number) => {
    if (Math.abs(det) < 1e-14) return false;
    const px = x - a.x, py = y - a.y;
    const u = (px * ey - py * ex) / det, v = (dx * py - dy * px) / det;
    return Math.min(u, v, 1 - u - v) >= -1e-7;
  };
}

export function pickMask(regions: ReadonlyMap<number, readonly UvTriangle[]>, point: Point) {
  return [...regions].filter(([, triangles]) => triangles.some(triangle => inside(triangle)(point.x, point.y))).map(([id]) => id);
}

export function rasterMask(triangles: readonly UvTriangle[], width: number, height: number) {
  const bits = new Uint8Array(Math.ceil(width * height / 8));
  const region: Region = { x0: width, y0: height, x1: 0, y1: 0 };
  for (const triangle of triangles) {
    const covers = inside(triangle);
    const x = triangle.map(point => point.x * width), y = triangle.map(point => point.y * height);
    const left = Math.max(0, Math.ceil(Math.min(...x) - .5)), right = Math.min(width, Math.floor(Math.max(...x) + .5));
    const top = Math.max(0, Math.ceil(Math.min(...y) - .5)), bottom = Math.min(height, Math.floor(Math.max(...y) + .5));
    for (let row = top; row < bottom; row++) for (let column = left; column < right; column++) {
      if (!covers((column + .5) / width, (row + .5) / height)) continue;
      const offset = row * width + column;
      bits[offset >> 3] |= 1 << (offset & 7);
      region.x0 = Math.min(region.x0, column); region.x1 = Math.max(region.x1, column + 1);
      region.y0 = Math.min(region.y0, row); region.y1 = Math.max(region.y1, row + 1);
    }
  }
  return { region, allows(x: number, y: number) { const offset = y * width + x; return !!(bits[offset >> 3] & (1 << (offset & 7))); } };
}
