import type { BufferGeometry } from 'three';
import type { TextureTarget } from './bindings';
import type { Point } from './stroke';

export type UvTriangle = readonly [Point, Point, Point];

export function textureFaces(target: TextureTarget, atlas?: BufferGeometry): Map<number, UvTriangle> {
  const { binding } = target;
  const geometry = target.atlas ? atlas : binding.mesh.geometry;
  const result = new Map<number, UvTriangle>();
  if (!geometry) return result;
  const map = binding.texture;
  const channel = target.atlas ? 1 : target.transfer?.channel ?? map.channel;
  const uv = geometry.getAttribute(channel ? `uv${channel}` : 'uv');
  if (!uv) return result;
  if (map.matrixAutoUpdate) map.updateMatrix();
  const m = map.matrix.elements;
  const index = geometry.index;
  const count = index?.count ?? uv.count;
  const ranges = geometry.groups.length ? geometry.groups.filter(group => group.materialIndex === binding.slot) : [{ start: 0, count }];
  const sample = (corner: number) => {
    const vertex = index?.getX(corner) ?? corner;
    const u = uv.getX(vertex), v = uv.getY(vertex);
    if (target.atlas) return { x: u, y: 1 - v };
    if (target.transfer) return { x: u, y: v };
    const y = m[1] * u + m[4] * v + m[7];
    return { x: m[0] * u + m[3] * v + m[6], y: map.flipY ? 1 - y : y };
  };
  for (const range of ranges) {
    const end = Math.min(count, range.start + range.count);
    for (let i = range.start; i + 2 < end; i += 3) result.set(i / 3, [sample(i), sample(i + 1), sample(i + 2)]);
  }
  return result;
}

export function uvOverlay(target: TextureTarget, atlas?: BufferGeometry) {
  const faces = [...textureFaces(target, atlas).values()];
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const face of faces) for (const point of face) {
    x0 = Math.max(0, Math.min(x0, point.x)); y0 = Math.max(0, Math.min(y0, point.y));
    x1 = Math.min(1, Math.max(x1, point.x)); y1 = Math.min(1, Math.max(y1, point.y));
  }
  const edges = new Map<string, { a: Point; b: Point; count: number }>();
  const pointKey = (point: Point) => `${point.x.toFixed(7)},${point.y.toFixed(7)}`;
  for (const face of faces) for (let i = 0; i < 3; i++) {
    const a = face[i], b = face[(i + 1) % 3];
    const ka = pointKey(a), kb = pointKey(b), key = ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`;
    const edge = edges.get(key);
    if (edge) edge.count++;
    else edges.set(key, { a, b, count: 1 });
  }
  const boundary = new Path2D(), interior = new Path2D();
  for (const edge of edges.values()) {
    const path = edge.count === 1 ? boundary : interior;
    path.moveTo(edge.a.x, edge.a.y);
    path.lineTo(edge.b.x, edge.b.y);
  }
  return { boundary, interior, overlaps: textureOverlap(target, atlas),
    bounds: x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : undefined };
}

export function textureOverlap(target: TextureTarget, atlas?: BufferGeometry) {
  return !target.atlas && detectOverlap(target.shared.flatMap(binding => [...textureFaces({ ...target, binding }, atlas).values()]));
}

// An advisory coverage probe at a bounded resolution keeps the overlay responsive on large meshes.
function detectOverlap(faces: UvTriangle[]) {
  const size = 256, occupied = new Uint8Array(size * size);
  for (const [a, b, c] of faces) {
    const dx = b.x - a.x, dy = b.y - a.y, ex = c.x - a.x, ey = c.y - a.y;
    const determinant = dx * ey - dy * ex;
    if (Math.abs(determinant) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(size * Math.min(a.x, b.x, c.x))), x1 = Math.min(size, Math.ceil(size * Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(size * Math.min(a.y, b.y, c.y))), y1 = Math.min(size, Math.ceil(size * Math.max(a.y, b.y, c.y)));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const px = (x + .5) / size - a.x, py = (y + .5) / size - a.y;
      const u = (px * ey - py * ex) / determinant, v = (dx * py - dy * px) / determinant;
      if (Math.min(u, v, 1 - u - v) <= 1e-5) continue;
      if (occupied[y * size + x]) return true;
      occupied[y * size + x] = 1;
    }
  }
  return false;
}
