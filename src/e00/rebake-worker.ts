import { generateTangents } from 'three/addons/libs/mikktspace.module.js';
import { Vector3 } from 'three';
import type { TextureBake } from './rebake';
import { rasterize } from './atlas-raster';

export interface BakeMap {
  slot: string;
  source: string;
  mode: 'srgb' | 'linear' | 'normal';
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

export interface BakeInput {
  width: number;
  height: number;
  padding: number;
  position: Float32Array<ArrayBuffer>;
  normals: Float32Array<ArrayBuffer>;
  sourceUv: Float32Array<ArrayBuffer>;
  targetUv: Float32Array<ArrayBuffer>;
  maps: BakeMap[];
}

export type BakeOutput = TextureBake;

self.onmessage = async ({ data }: MessageEvent<BakeInput>) => {
  try {
    const output = await bake(data);
    self.postMessage(output, { transfer: output.maps.map(map => map.png.buffer) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

const srgb = Float32Array.from({ length: 256 }, (_, i) => {
  const x = i / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
});

function encodeSrgb(x: number): number {
  return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
}

function paddingSources(faces: Int32Array, width: number): number {
  const queue = new Int32Array(faces.length);
  let tail = 0, head = 0, padded = 0;
  const adjacent = (pixel: number, visit: (neighbor: number) => void) => {
    if (pixel % width !== 0) visit(pixel - 1);
    if ((pixel + 1) % width !== 0) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel + width < faces.length) visit(pixel + width);
  };
  const seed = (pixel: number) => {
    if (!faces[pixel]) return;
    let edge = false;
    adjacent(pixel, neighbor => { if (!faces[neighbor]) edge = true; });
    if (edge) queue[tail++] = pixel;
  };
  for (let p = 0; p < faces.length; p++) seed(p);
  // Extend edge colors through the unused atlas so coarse mip levels never sample black voids.
  // Each empty texel gets exactly one source. Padding never overwrites triangle samples.
  while (head < tail) {
    const pixel = queue[head++];
    const source = faces[pixel] < 0 ? faces[pixel] : -(pixel + 1);
    adjacent(pixel, neighbor => {
      if (faces[neighbor] !== 0) return;
      faces[neighbor] = source;
      queue[tail++] = neighbor;
      padded++;
    });
  }
  return padded;
}

const lerpAttribute = (attr: Float32Array, stride: number, i: number, j: number, a: number, b: number, c: number) =>
  a * attr[i * stride + j] + b * attr[(i + 1) * stride + j] + c * attr[(i + 2) * stride + j];

async function bake(input: BakeInput): Promise<BakeOutput> {
  const { width, height, normals, position, targetUv, sourceUv, padding } = input;
  const { faces, wb, wc, covered, boundaryOnlyTriangles, overlaps } = rasterize(width, height, targetUv);
  if (overlaps.size) throw new Error('The target atlas has conflicting triangle coverage.');
  if (!covered) throw new Error('The atlas has no covered texels.');
  const padded = paddingSources(faces, width);
  const hasNormals = input.maps.some(map => map.mode === 'normal');
  const sourceTangent = hasNormals ? generateTangents(position, normals, sourceUv) : null;
  const targetTangent = hasNormals ? generateTangents(position, normals, targetUv) : null;
  const n = new Vector3(), ts = new Vector3(), tt = new Vector3(), cross = new Vector3();
  const color = [0, 0, 0, 0];
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  const maps: BakeOutput['maps'] = [];
  for (const map of input.maps) {
    const image = context.createImageData(width, height);
    const pixels = image.data;
    for (let pixel = 0; pixel < faces.length; pixel++) {
      const face = faces[pixel];
      pixels[pixel * 4 + 3] = 255;
      if (face <= 0) continue;
      const i = (face - 1) * 3;
      const b = wb[pixel], c = wc[pixel], a = 1 - b - c;
      const u = lerpAttribute(sourceUv, 2, i, 0, a, b, c), v = lerpAttribute(sourceUv, 2, i, 1, a, b, c);
      sample(map, u, v, color);
      if (map.mode === 'normal' && sourceTangent && targetTangent) {
        const basis = (attr: Float32Array, stride: number, out: Vector3) => out.set(
          lerpAttribute(attr, stride, i, 0, a, b, c), lerpAttribute(attr, stride, i, 1, a, b, c),
          lerpAttribute(attr, stride, i, 2, a, b, c));
        basis(normals, 3, n).normalize();
        basis(sourceTangent, 4, ts).addScaledVector(n, -ts.dot(n)).normalize();
        basis(targetTangent, 4, tt).addScaledVector(n, -tt.dot(n)).normalize();
        const sourceSign = sourceTangent[i * 4 + 3], targetSign = targetTangent[i * 4 + 3];
        if (n.lengthSq() < 0.99 || ts.lengthSq() < 0.99 || tt.lengthSq() < 0.99 ||
            Math.abs(sourceSign) !== 1 || Math.abs(targetSign) !== 1) {
          throw new Error(`A normal map requires valid source and target tangents on face ${face}.`);
        }
        const cos = ts.dot(tt), sin = cross.crossVectors(n, ts).dot(tt);
        const x = color[0] / 127.5 - 1, y = (color[1] / 127.5 - 1) * sourceSign, z = color[2] / 127.5 - 1;
        const length = Math.hypot(x, y, z);
        if (length < 1e-5) throw new Error('The source normal map contains a zero-length vector.');
        color[0] = 127.5 * (1 + (cos * x + sin * y) / length);
        color[1] = 127.5 * (1 + targetSign * (cos * y - sin * x) / length);
        color[2] = 127.5 * (1 + z / length);
      }
      pixels.set(color, pixel * 4);
    }
    for (let pixel = 0; pixel < faces.length; pixel++) {
      const face = faces[pixel];
      if (face >= 0) continue;
      const source = (-face - 1) * 4;
      pixels.copyWithin(pixel * 4, source, source + 4);
    }
    context.putImageData(image, 0, 0);
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    maps.push({ slot: map.slot, source: map.source, png });
  }
  return { width, height, padding, covered, padded, boundaryOnlyTriangles, maps };
}

function sample({ width, height, pixels, mode }: BakeMap, u: number, v: number, out: number[]) {
  const x = (u - Math.floor(u)) * width - 0.5, y = (-v - Math.floor(-v)) * height - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y);
  const x0 = (ix + width) % width, x1 = (x0 + 1) % width;
  const y0 = (iy + height) % height, y1 = (y0 + 1) % height;
  const fx = x - ix, fy = y - iy;
  const a = 4 * (y0 * width + x0), b = 4 * (y0 * width + x1), c = 4 * (y1 * width + x0), d = 4 * (y1 * width + x1);
  for (let k = 0; k < 4; k++) {
    const useSrgb = mode === 'srgb' && k < 3;
    const lookup = useSrgb ? srgb : pixels;
    const s0 = useSrgb ? lookup[pixels[a + k]] : lookup[a + k];
    const s1 = useSrgb ? lookup[pixels[b + k]] : lookup[b + k];
    const s2 = useSrgb ? lookup[pixels[c + k]] : lookup[c + k];
    const s3 = useSrgb ? lookup[pixels[d + k]] : lookup[d + k];
    const value = (1 - fy) * ((1 - fx) * s0 + fx * s1) + fy * ((1 - fx) * s2 + fx * s3);
    out[k] = useSrgb ? encodeSrgb(value) : value;
  }
}
