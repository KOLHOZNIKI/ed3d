import type { Point } from '../texture/stroke';
import type { UvTriangle } from '../texture/overlay';

export type Triple<T> = readonly [T, T, T];
export type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];
export type Mode = 'surface' | 'screen' | 'pixel';

export interface Face {
  readonly world: Triple<Vec3>;
  readonly clip: Triple<Vec4>;
  readonly uv?: UvTriangle;
  readonly edges: Triple<readonly Link[]>;
  readonly island: string;
  readonly source: string;
  readonly material: string;
  readonly orientation: number;
  readonly side: number;
  readonly vertices?: Triple<number>;
}

export interface Link { face: number; a: number; b: number }
export interface View { faces: readonly Face[]; width: number; height: number }
export interface Dab { point: Point; hit: Hit; pixel: Point; unfolded: Map<number, Unfolded[]> }
interface Hit { face: number; weights: Vec3 }
interface Unfolded {
  triangle: Triple<Point>;
  gates: ReadonlyArray<readonly [Point, Point]>;
  window?: readonly [number, number];
  visited: readonly number[];
}
interface ScreenFace {
  readonly triangle: Triple<Point>;
  readonly front: boolean;
  readonly bounds: Bounds;
  readonly det: number;
  readonly z: Vec3;
}
export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export const corners = [0, 1, 2] as const;
const cell = 16;
const cross = (x: number, y: number, u: number, v: number) => x * v - y * u;
const blend = (w: Vec3, a: number, b: number, c: number) => w[0] * a + w[1] * b + w[2] * c;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mix2 = ([a, b, c]: Triple<Point>, w: Vec3) => ({ x: blend(w, a.x, b.x, c.x), y: blend(w, a.y, b.y, c.y) });

export function bounds([a, b, c]: Triple<Point>): Bounds {
  return { x0: Math.min(a.x, b.x, c.x), x1: Math.max(a.x, b.x, c.x), y0: Math.min(a.y, b.y, c.y), y1: Math.max(a.y, b.y, c.y) };
}

export function area([a, b, c]: Triple<Point>) {
  return cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
}

export function barycentric([a, b, c]: Triple<Point>, det: number, x: number, y: number): Vec3 {
  const u = cross(x - a.x, y - a.y, c.x - a.x, c.y - a.y) / det;
  const v = cross(b.x - a.x, b.y - a.y, x - a.x, y - a.y) / det;
  return [1 - u - v, u, v];
}

export class Projection {
  readonly screen: (ScreenFace | undefined)[];
  #bins: number[][];
  #cols: number;
  #rows: number;

  constructor(readonly view: View) {
    this.#cols = Math.ceil(view.width / cell);
    this.#rows = Math.ceil(view.height / cell);
    this.#bins = Array.from({ length: this.#cols * this.#rows }, () => []);
    this.screen = view.faces.map(({ clip: [a, b, c], side, orientation }, id) => {
      if (Math.min(a[3], b[3], c[3]) <= 0) return;
      const screen = (v: Vec4) => ({ x: (.5 + .5 * v[0] / v[3]) * view.width, y: (.5 - .5 * v[1] / v[3]) * view.height });
      const triangle = [screen(a), screen(b), screen(c)] as const;
      const det = area(triangle), front = det * orientation < 0;
      if (Math.abs(det) < 1e-12 || (front && side === 1) || (!front && side === 0)) return;
      const box = bounds(triangle);
      this.#cells(box, bin => bin.push(id));
      return { triangle, front, det, bounds: box, z: [a[2] / a[3], b[2] / b[3], c[2] / c[3]] };
    });
  }

  around(box: Bounds): Set<number> {
    const result = new Set<number>();
    this.#cells(box, bin => { for (const id of bin) result.add(id); });
    return result;
  }

  hit(x: number, y: number): Hit | undefined {
    let result: Hit | undefined, nearest = 1;
    for (const id of this.#bin(x, y)) {
      const face = this.screen[id]!;
      const w = barycentric(face.triangle, face.det, x, y);
      if (Math.min(...w) < -1e-8) continue;
      const depth = blend(w, ...face.z);
      if (depth < -1 || depth >= nearest) continue;
      nearest = depth;
      const clip = this.view.faces[id].clip;
      const a = w[0] / clip[0][3], b = w[1] / clip[1][3], c = w[2] / clip[2][3], sum = a + b + c;
      result = { face: id, weights: [a / sum, b / sum, c / sum] };
    }
    return result;
  }

  point(id: number, w: Vec3) {
    const [a, b, c] = this.view.faces[id].clip;
    const k = blend(w, a[3], b[3], c[3]);
    return { x: (.5 + .5 * blend(w, a[0], b[0], c[0]) / k) * this.view.width,
      y: (.5 - .5 * blend(w, a[1], b[1], c[1]) / k) * this.view.height,
      z: blend(w, a[2], b[2], c[2]) / k };
  }

  visible(id: number, p: Point & { z: number }) {
    if (p.z < -1 || p.z > 1 || p.x < 0 || p.y < 0 || p.x >= this.view.width || p.y >= this.view.height) return false;
    for (const candidate of this.#bin(p.x, p.y)) {
      if (candidate === id) continue;
      const face = this.screen[candidate]!;
      const w = barycentric(face.triangle, face.det, p.x, p.y);
      if (Math.min(...w) < -1e-8) continue;
      const depth = blend(w, ...face.z);
      if (depth >= -1 && (depth < p.z - 1e-7 || (Math.abs(depth - p.z) <= 1e-9 && candidate < id && Math.min(...w) > 1e-6))) return false;
    }
    return true;
  }

  #bin(x: number, y: number): readonly number[] {
    if (x < 0 || y < 0 || x >= this.view.width || y >= this.view.height) return [];
    return this.#bins[Math.floor(y / cell) * this.#cols + Math.floor(x / cell)];
  }

  #cells(box: Bounds, visit: (bin: number[]) => void) {
    for (let y = Math.max(0, Math.floor(box.y0 / cell)); y <= Math.min(this.#rows - 1, Math.floor(box.y1 / cell)); y++) {
      for (let x = Math.max(0, Math.floor(box.x0 / cell)); x <= Math.min(this.#cols - 1, Math.floor(box.x1 / cell)); x++) {
        visit(this.#bins[y * this.#cols + x]);
      }
    }
  }
}

export function writable(projection: Projection, id: number, mask?: ReadonlySet<string>, kind?: 'face' | 'island') {
  const face = projection.view.faces[id];
  return !!projection.screen[id]?.front && !!face.uv && (!mask || mask.has(kind === 'island' ? face.island : face.source));
}

export function dab(projection: Projection, point: Point, radius: number, mode: Mode, width: number, height: number): Dab | undefined {
  const hit = projection.hit(point.x, point.y);
  if (!hit || !writable(projection, hit.face)) return;
  const uv = mix2(projection.view.faces[hit.face].uv!, hit.weights);
  const snap = (value: number, size: number) => Math.min(size - 1, Math.max(0, Math.floor(value * size))) + (radius % 1 ? .5 : 0);
  return { hit, point, pixel: { x: snap(uv.x, width), y: snap(uv.y, height) },
    unfolded: mode === 'surface' ? unfold(projection, hit, radius) : new Map() };
}

export function footprint(sample: Dab, id: number, w: Vec3, point: Point, uv: Point, mode: Mode, radius: number): number {
  if (mode === 'screen') return Math.hypot(point.x - sample.point.x, point.y - sample.point.y) / radius;
  if (mode === 'pixel') return Math.max(Math.abs(uv.x - sample.pixel.x), Math.abs(uv.y - sample.pixel.y)) / radius;
  let best = Infinity;
  for (const plane of sample.unfolded.get(id) ?? []) {
    const p = mix2(plane.triangle, w), r = Math.hypot(p.x, p.y);
    if (r <= radius && crosses(p, plane.gates)) best = Math.min(best, r / radius);
  }
  return best;
}

export function sampleUv(uv: UvTriangle, w: Vec3, width: number, height: number): Point {
  const p = mix2(uv, w);
  return { x: width * p.x, y: height * p.y };
}

export function brushStrength(distance: number, opacity: number, hardness: number) {
  if (distance >= 1) return 0;
  return opacity * (distance <= hardness ? 1 : (1 - distance) / (1 - hardness));
}

// Lay adjacent faces flat about their common edge. A straight path in the
// unfolded plane is valid only if it crosses the shared edges in order.
function unfold(projection: Projection, hit: Hit, radius: number) {
  const faces = projection.view.faces;
  const start = faces[hit.face];
  const first = triangleOnEdge({ x: 0, y: 0 }, { x: distance(start.world[0], start.world[1]), y: 0 }, start.world, 0, 1, 1);
  const result = new Map<number, Unfolded[]>();
  if (!first) return result;
  const origin = mix2(first, hit.weights);
  const shifted = first.map(p => ({ x: p.x - origin.x, y: p.y - origin.y })) as unknown as Triple<Point>;
  const seed = { triangle: shifted, gates: [], visited: [hit.face] };
  result.set(hit.face, [seed]);
  const pending: { id: number; path: Unfolded }[] = [{ id: hit.face, path: seed }];
  for (let next = 0; next < pending.length; next++) {
    const { id, path } = pending[next], { triangle, gates, visited } = path;
    for (const i of corners) {
      const a = triangle[i], b = triangle[(i + 1) % 3], c = triangle[(i + 2) % 3];
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy)));
      const closest = Math.hypot(a.x + t * dx, a.y + t * dy);
      if (closest > radius + 1e-9) continue;
      const window = closest < 1e-10 ? path.window : edgeWindow(a, b, path.window);
      if (window === null) continue;
      for (const link of faces[id].edges[i]) {
        const alternatives = result.get(link.face) ?? [];
        if (alternatives.length >= 4 || visited.includes(link.face) || !faces[link.face].uv) continue;
        const side = -Math.sign(cross(dx, dy, c.x - a.x, c.y - a.y));
        const flat = triangleOnEdge(a, b, faces[link.face].world, link.a, link.b, side);
        if (!flat) continue;
        const path = { triangle: flat, gates: [...gates, [a, b] as const], window, visited: [...visited, link.face] };
        alternatives.push(path);
        result.set(link.face, alternatives);
        pending.push({ id: link.face, path });
      }
    }
  }
  return result;
}

function edgeWindow(a: Point, b: Point, window?: Unfolded['window']): Unfolded['window'] | null {
  const start = Math.atan2(a.y, a.x);
  const turn = Math.atan2(cross(a.x, a.y, b.x, b.y), a.x * b.x + a.y * b.y);
  const low = start + Math.min(0, turn), high = start + Math.max(0, turn);
  if (!window) return [low, high];
  for (const offset of [-2 * Math.PI, 0, 2 * Math.PI]) {
    const min = Math.max(window[0], low + offset), max = Math.min(window[1], high + offset);
    if (min <= max + 1e-9) return [min, max];
  }
  return null;
}

function triangleOnEdge(a: Point, b: Point, world: Triple<Vec3>, i: number, j: number, side: number): Triple<Point> | undefined {
  const k = 3 - i - j, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (!(length > 1e-12)) return;
  const ac = distance(world[i], world[k]), bc = distance(world[j], world[k]);
  const x = (ac * ac + length * length - bc * bc) / (2 * length);
  const y = side * Math.sqrt(Math.max(0, ac * ac - x * x));
  if (y === 0) return;
  const triangle: [Point, Point, Point] = [a, a, a];
  triangle[i] = a;
  triangle[j] = b;
  triangle[k] = { x: a.x + (x * dx - y * dy) / length, y: a.y + (x * dy + y * dx) / length };
  return triangle;
}

function crosses(p: Point, gates: Unfolded['gates']) {
  let previous = 0;
  for (const [a, b] of gates) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const det = cross(p.x, p.y, dx, dy);
    if (Math.abs(det) < 1e-16) {
      if (Math.abs(cross(a.x, a.y, dx, dy)) > 1e-10) return false;
      continue;
    }
    const along = cross(a.x, a.y, dx, dy) / det, edge = cross(a.x, a.y, p.x, p.y) / det;
    if (along < previous - 1e-7 || along > 1 + 1e-7 || edge < -1e-7 || edge > 1 + 1e-7) return false;
    previous = along;
  }
  return true;
}
