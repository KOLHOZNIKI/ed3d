import { paddingSources } from '../e00/atlas-raster';
import { area, barycentric, bounds, brushStrength, dab, footprint, Projection, writable,
  type Bounds, type Dab, type Mode, type View } from './projection';
import type { UvTriangle } from '../texture/overlay';
import type { Point, Region } from '../texture/stroke';

export interface Brush {
  mode: Mode;
  radius: number;
  opacity: number;
  hardness: number;
  width: number;
  height: number;
  kind?: 'face' | 'island';
  mask?: Set<string>;
  region?: Region;
}

interface Input extends Brush {
  view: View;
  points: Point[];
  padding: number;
  occupied: UvTriangle[];
}

export type StrokeInput = Input;
export interface Coverage {
  pixels: Uint32Array<ArrayBuffer>;
  strength: Float32Array<ArrayBuffer>;
  padding: Uint32Array<ArrayBuffer>;
}

self.onmessage = ({ data }: MessageEvent<Input>) => {
  try {
    const result = coverage(data);
    self.postMessage(result, { transfer: [result.pixels.buffer, result.strength.buffer, result.padding.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

function coverage(input: Input): Coverage {
  const { view, width, height, radius, mode, opacity, hardness, mask, kind, region } = input;
  const projection = new Projection(view);
  const samples = new Map<number, Dab[]>();
  const plane = view.faces.map(face => face.uv && scaled(face.uv, width, height));
  const uvBins = mode === 'pixel' ? new UvBins(plane) : undefined;
  const add = (point: Point) => {
    const sample = dab(projection, point, radius, mode, width, height);
    if (!sample) return;
    let faces: Iterable<number>;
    if (mode === 'surface') faces = sample.unfolded.keys();
    else if (mode === 'screen') faces = projection.around(square(point, radius));
    else faces = uvBins!.around(square(sample.pixel, radius));
    for (const id of faces) {
      if (!writable(projection, id, mask, kind)) continue;
      if (mode === 'pixel' && view.faces[id].island !== view.faces[sample.hit.face].island) continue;
      const list = samples.get(id);
      if (list) list.push(sample);
      else samples.set(id, [sample]);
    }
  };
  add(input.points[0]);
  // Screen-space stepping keeps marks joined even when pointer events are sparse.
  // Surface dabs use at most one viewport pixel of travel between samples.
  const spacing = mode === 'screen' ? Math.min(2, radius / 4) : mode === 'pixel' ? .5 : 1;
  for (let i = 1; i < input.points.length; i++) {
    const a = input.points[i - 1], b = input.points[i];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing);
    for (let j = 1; j <= steps; j++) add({ x: a.x + (b.x - a.x) * j / steps, y: a.y + (b.y - a.y) * j / steps });
  }

  const painted = new Map<number, number>();
  for (const [id, dabs] of samples) {
    const triangle = plane[id]!;
    eachTexel(triangle, width, height, region, (pixel, w, uv) => {
      const point = projection.point(id, w);
      let strength = painted.get(pixel) ?? 0;
      for (const sample of dabs) {
        const d = footprint(sample, id, w, point, uv, mode, radius);
        strength = Math.max(strength, brushStrength(d, opacity, mode === 'pixel' ? 1 : hardness));
        if (strength === opacity) break;
      }
      if (strength > (painted.get(pixel) ?? 0) && projection.visible(id, point)) painted.set(pixel, strength);
    });
  }

  const gutter = painted.size && input.padding && mode !== 'pixel' && !mask && !region ? padding(input, painted, plane) : [];
  return { pixels: Uint32Array.from(painted.keys()), strength: Float32Array.from(painted.values()), padding: Uint32Array.from(gutter) };
}

function padding(input: Input, painted: ReadonlyMap<number, number>, plane: (UvTriangle | undefined)[]) {
  const { width, height, padding } = input;
  let x0 = width, x1 = 0, y0 = height, y1 = 0;
  for (const pixel of painted.keys()) {
    const x = pixel % width, y = Math.floor(pixel / width);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  // Twice the padding distance includes both destination gutter texels and
  // any closer chart that should retain ownership of their colors.
  const region = { x0: Math.max(0, x0 - 2 * padding), x1: Math.min(width, x1 + 2 * padding + 1),
    y0: Math.max(0, y0 - 2 * padding), y1: Math.min(height, y1 + 2 * padding + 1) };
  const columns = region.x1 - region.x0, rows = region.y1 - region.y0;
  const occupied = new Int32Array(columns * rows);
  const cover = (triangle: UvTriangle) => eachTexel(triangle, width, height, region, pixel => {
    const x = pixel % width - region.x0, y = Math.floor(pixel / width) - region.y0;
    occupied[y * columns + x] = 1;
  });
  for (const triangle of plane) if (triangle) cover(triangle);
  for (const uv of input.occupied) cover(scaled(uv, width, height));
  paddingSources(occupied, columns, padding);
  const global = (local: number) => (region.y0 + Math.floor(local / columns)) * width + region.x0 + local % columns;
  const gutter: number[] = [];
  for (const [i, value] of occupied.entries()) {
    if (value >= 0) continue;
    const source = global(-value - 1);
    if (painted.has(source)) gutter.push(global(i), source);
  }
  return gutter;
}

function square(p: Point, radius: number): Bounds {
  return { x0: p.x - radius, x1: p.x + radius, y0: p.y - radius, y1: p.y + radius };
}

function scaled([a, b, c]: UvTriangle, w: number, h: number): UvTriangle {
  return [{ x: a.x * w, y: a.y * h }, { x: b.x * w, y: b.y * h }, { x: c.x * w, y: c.y * h }];
}

function eachTexel(triangle: UvTriangle, width: number, height: number, region: Region | undefined,
  visit: (pixel: number, w: readonly [number, number, number], point: Point) => void) {
  const box = bounds(triangle), det = area(triangle);
  if (Math.abs(det) < 1e-12) return;
  const x0 = Math.max(0, region?.x0 ?? 0, Math.ceil(box.x0 - .5));
  const x1 = Math.min(width - 1, (region?.x1 ?? width) - 1, Math.floor(box.x1 - .5));
  const y0 = Math.max(0, region?.y0 ?? 0, Math.ceil(box.y0 - .5));
  const y1 = Math.min(height - 1, (region?.y1 ?? height) - 1, Math.floor(box.y1 - .5));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const w = barycentric(triangle, det, x + .5, y + .5);
    if (Math.min(...w) >= -1e-8) visit(y * width + x, w, { x: x + .5, y: y + .5 });
  }
}

class UvBins {
  #bins = new Map<string, number[]>();

  constructor(triangles: (UvTriangle | undefined)[]) {
    triangles.forEach((triangle, id) => {
      if (!triangle) return;
      this.#cells(bounds(triangle), key => {
        const bin = this.#bins.get(key);
        if (bin) bin.push(id);
        else this.#bins.set(key, [id]);
      });
    });
  }

  around(box: Bounds) {
    const matches = new Set<number>();
    this.#cells(box, key => { for (const id of this.#bins.get(key) ?? []) matches.add(id); });
    return matches;
  }

  #cells(box: Bounds, visit: (key: string) => void) {
    for (let y = Math.floor(box.y0 / 64); y <= Math.floor(box.y1 / 64); y++) {
      for (let x = Math.floor(box.x0 / 64); x <= Math.floor(box.x1 / 64); x++) visit(`${x}/${y}`);
    }
  }
}
