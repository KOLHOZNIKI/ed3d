import { pixelOffset, readPixel, tileIndex, tileSize, type Rgba, type TextureImage } from './image';

export interface Point { x: number; y: number }
export interface Region { x0: number; x1: number; y0: number; y1: number }
export interface BrushSettings {
  tool: 'brush' | 'stamp' | 'pixel';
  size: number;
  opacity: number;
  hardness: number;
  square: boolean;
  color: Rgba;
  alpha: boolean;
  channel?: 0 | 1 | 2 | 'rgb';
  region?: Region;
  sourceOffset?: Point;
}

const linear = Float32Array.from({ length: 256 }, (_, value) => {
  const srgb = value / 255;
  return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
});

function mix(old: number, replacement: number, strength: number, alpha: boolean) {
  if (strength === 1 || old === replacement) return replacement;
  if (alpha) return old * (1 - strength) + replacement * strength;
  const value = linear[old] * (1 - strength) + linear[replacement] * strength;
  return 255 * (value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055);
}

export class TextureStroke {
  readonly base: TextureImage;
  readonly settings: BrushSettings;
  readonly tiles = new Map<number, Uint8ClampedArray<ArrayBuffer>>();
  #coverage = new Map<number, Float32Array>();

  constructor(base: TextureImage, settings: BrushSettings) {
    this.base = base;
    this.settings = settings;
  }

  segment(start: Point, end: Point): Set<number> {
    const { tool, size, opacity, hardness, square } = this.settings;
    const pixel = tool === 'pixel';
    if (pixel) {
      const center = (point: Point) => ({ x: Math.floor(point.x) + (size % 2 ? .5 : 0), y: Math.floor(point.y) + (size % 2 ? .5 : 0) });
      start = center(start);
      end = center(end);
    }
    const radius = size / 2;
    const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
    const bounds = this.#bounds({ x0: Math.floor(Math.min(start.x, end.x) - radius), y0: Math.floor(Math.min(start.y, end.y) - radius),
      x1: Math.ceil(Math.max(start.x, end.x) + radius), y1: Math.ceil(Math.max(start.y, end.y) + radius) });
    const changed = new Set<number>();
    for (let y = bounds.y0; y < bounds.y1; y++) for (let x = bounds.x0; x < bounds.x1; x++) {
      const px = x + .5 - start.x, py = y + .5 - start.y;
      const t = length ? Math.min(1, Math.max(0, (px * dx + py * dy) / length)) : 0;
      const cx = px - dx * t, cy = py - dy * t;
      const distance = pixel && square ? Math.max(Math.abs(cx), Math.abs(cy)) : Math.hypot(cx, cy);
      if (distance >= radius) continue;
      const edge = pixel || distance <= radius * hardness ? 1 : (1 - distance / radius) / (1 - hardness);
      this.#write(x, y, opacity * edge, changed);
    }
    return changed;
  }

  fill(): Set<number> {
    const { region, opacity } = this.settings;
    const changed = new Set<number>();
    if (!region) return changed;
    const bounds = this.#bounds(region);
    for (let y = bounds.y0; y < bounds.y1; y++) for (let x = bounds.x0; x < bounds.x1; x++) this.#write(x, y, opacity, changed);
    return changed;
  }

  applyCoverage(pixels: Uint32Array, strength: Float32Array, padding: Uint32Array): number {
    const size = this.base.width * this.base.height;
    if (pixels.length !== strength.length || padding.length % 2) throw new Error('The brush returned invalid coverage.');
    const changed = new Set<number>();
    let count = 0;
    for (const [i, pixel] of pixels.entries()) {
      if (pixel >= size || !(strength[i] > 0 && strength[i] <= 1)) throw new Error('The brush returned invalid coverage.');
      if (this.#write(pixel % this.base.width, Math.floor(pixel / this.base.width), strength[i], changed)) count++;
    }
    for (let i = 0; i < padding.length; i += 2) {
      const pixel = padding[i], source = padding[i + 1];
      if (pixel >= size || source >= size) throw new Error('The brush returned invalid padding.');
      const x = pixel % this.base.width, y = Math.floor(pixel / this.base.width);
      const sx = source % this.base.width, sy = Math.floor(source / this.base.width);
      const from = this.tiles.get(tileIndex(this.base, sx, sy));
      if (!from) continue;
      const index = tileIndex(this.base, x, y), offset = pixelOffset(x, y), src = pixelOffset(sx, sy);
      const original = this.tiles.get(index) ?? this.base.tiles[index];
      if (original[offset] === from[src] && original[offset + 1] === from[src + 1] && original[offset + 2] === from[src + 2]) continue;
      const tile = this.tiles.get(index) ?? original.slice();
      tile.set(from.subarray(src, src + 3), offset);
      this.tiles.set(index, tile);
    }
    return count;
  }

  finish(): TextureImage {
    if (!this.tiles.size) return this.base;
    const tiles = this.base.tiles.slice();
    for (const [index, tile] of this.tiles) tiles[index] = tile;
    return { ...this.base, tiles };
  }

  #bounds(bounds: Region): Region {
    const mask = this.settings.region;
    return { x0: Math.max(0, bounds.x0, mask?.x0 ?? 0), y0: Math.max(0, bounds.y0, mask?.y0 ?? 0),
      x1: Math.min(this.base.width, bounds.x1, mask?.x1 ?? this.base.width),
      y1: Math.min(this.base.height, bounds.y1, mask?.y1 ?? this.base.height) };
  }

  #write(x: number, y: number, strength: number, changed: Set<number>) {
    if (strength <= 0) return;
    const { sourceOffset, alpha, channel: scalar, color } = this.settings;
    let replacement = color;
    if (sourceOffset) {
      const sx = x + sourceOffset.x, sy = y + sourceOffset.y;
      if (sx < 0 || sy < 0 || sx >= this.base.width || sy >= this.base.height) return;
      // Stamp reads the immutable pre-stroke tiles even when source and destination overlap.
      replacement = readPixel(this.base, sx, sy);
    }
    const index = tileIndex(this.base, x, y), offset = pixelOffset(x, y);
    let coverage = this.#coverage.get(index);
    if (coverage && coverage[offset / 4] >= strength - 1e-7) return;
    if (!coverage) {
      coverage = new Float32Array(tileSize * tileSize);
      this.#coverage.set(index, coverage);
    }
    coverage[offset / 4] = strength;
    const original = this.base.tiles[index];
    let tile = this.tiles.get(index);
    let wrote = false;
    const component = typeof scalar === 'number' ? scalar : undefined;
    for (let channel = component ?? (alpha ? 3 : 0); channel < (component === undefined ? alpha ? 4 : 3 : component + 1); channel++) {
      const value = Math.round(mix(original[offset + channel], replacement[scalar === 'rgb' ? 0 : channel], strength, alpha || scalar !== undefined));
      if (value === (tile ?? original)[offset + channel]) continue;
      if (!tile) {
        tile = original.slice();
        this.tiles.set(index, tile);
      }
      tile[offset + channel] = value;
      changed.add(index);
      wrote = true;
    }
    return wrote;
  }
}
