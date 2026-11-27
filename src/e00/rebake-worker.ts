import { generateTangents } from 'three/addons/libs/mikktspace.module.js';
import { Vector3 } from 'three';
import { encode } from 'fast-png';
import type { TextureBake } from './rebake';
import type { UvTransform } from './alpha-profile';
import { paddingSources, rasterize } from './atlas-raster';
import { projectTextureCoordinates, type ProjectionInput } from './projection-rays';

export interface BakeMap {
  slot: string;
  source: string;
  mode: 'srgb' | 'linear' | 'normal';
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  uvTransform?: UvTransform;
  wrapS?: 'repeat' | 'clamp' | 'mirror';
  wrapT?: 'repeat' | 'clamp' | 'mirror';
  preserveAlpha?: boolean;
  topDown?: boolean;
  uv?: Float32Array<ArrayBuffer>;
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
  projection?: ProjectionInput;
  direct?: { sourceName: string; filter: 'nearest' | 'linear'; topDown: boolean; missing?: Uint8Array<ArrayBuffer>; clearUnused?: boolean };
}

export type BakeOutput = TextureBake;

self.onmessage = async ({ data }: MessageEvent<BakeInput>) => {
  try {
    const output = await bake(data);
    self.postMessage(output, { transfer: [...output.maps.map(map => map.png.buffer), ...(output.coverage ? [output.coverage.buffer] : [])] });
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

const lerpAttribute = (attr: Float32Array, stride: number, i: number, j: number, a: number, b: number, c: number) =>
  a * attr[i * stride + j] + b * attr[(i + 1) * stride + j] + c * attr[(i + 2) * stride + j];

async function bake(input: BakeInput): Promise<BakeOutput> {
  const { width, height, normals, position, targetUv, sourceUv, padding, direct } = input;
  const rasterUv = direct?.topDown ? targetUv.map((value, i) => i % 2 ? 1 - value : value) : targetUv;
  const { faces, wb, wc, covered, boundaryOnlyTriangles, overlaps } = rasterize(width, height, rasterUv);
  if (overlaps.size) throw new Error('The target atlas has conflicting triangle coverage.');
  if (!covered) throw new Error('The atlas has no covered texels.');
  let directMisses = 0, coverage: Uint8Array<ArrayBuffer> | undefined;
  if (direct) {
    const mask = new Uint8Array(width * height * 4);
    for (let p = 0; p < faces.length; p++) {
      if (!faces[p]) continue;
      const missing = !!direct.missing?.[faces[p] - 1];
      if (missing) directMisses++;
      mask.set(missing ? [245, 65, 189, 255] : [48, 189, 161, 255], p * 4);
    }
    coverage = new Uint8Array(encode({ width, height, data: mask, channels: 4 }));
  }
  // Keep every chart's nearest-source gutter populated for mip levels whose
  // filter footprint extends past the requested chart spacing.
  const padded = paddingSources(faces, width, direct?.clearUnused ? padding : Infinity);
  const normalMap = input.maps.find(map => map.mode === 'normal');
  const sourceTangent = normalMap ? generateTangents(position, normals, normalMap.uv ?? sourceUv) : null;
  const targetTangent = normalMap ? generateTangents(position, normals, targetUv) : null;
  const n = new Vector3(), ts = new Vector3(), tt = new Vector3(), cross = new Vector3();
  const color = [0, 0, 0, 0];
  const projection = input.projection && projectTextureCoordinates(input.projection, position, normals, sourceUv);
  const projectedUv: [number, number] = [0, 0];
  const missColor = [255, 0, 255, 255];
  let misses = 0;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  const maps: BakeOutput['maps'] = [];
  for (const map of input.maps) {
    const uv = map.uv ?? sourceUv;
    const image = context.createImageData(width, height);
    const pixels = image.data;
    const neutral = map.slot === 'map' ? [128, 128, 128, 255] :
      map.mode === 'normal' ? [128, 128, 255, 255] :
      map.slot === 'metalRough' ? [255, 255, 0, 255] :
      map.slot === 'emissiveMap' || map.slot === 'metallic' ? [0, 0, 0, 255] : [255, 255, 255, 255];
    for (let pixel = 0; pixel < faces.length; pixel++) {
      const face = faces[pixel];
      pixels[pixel * 4 + 3] = map.preserveAlpha ? 0 : 255;
      if (face <= 0) continue;
      if (direct?.missing?.[face - 1]) {
        pixels.set(neutral, pixel * 4);
        continue;
      }
      const i = (face - 1) * 3;
      const b = wb[pixel], c = wc[pixel], a = 1 - b - c;
      if (projection) {
        if (!projection(face - 1, a, b, c, projectedUv)) {
          pixels.set(missColor, pixel * 4);
          misses++;
          continue;
        }
        sample(map, projectedUv[0], projectedUv[1], color);
      } else {
        sample(map, lerpAttribute(uv, 2, i, 0, a, b, c), lerpAttribute(uv, 2, i, 1, a, b, c), color, direct?.filter === 'nearest');
      }
      if (map.mode === 'normal' && sourceTangent && targetTangent) {
        const basis = (attr: Float32Array, stride: number, out: Vector3) => out.set(
          lerpAttribute(attr, stride, i, 0, a, b, c), lerpAttribute(attr, stride, i, 1, a, b, c),
          lerpAttribute(attr, stride, i, 2, a, b, c));
        basis(normals, 3, n).normalize();
        basis(sourceTangent, 4, ts).addScaledVector(n, -ts.dot(n)).normalize();
        basis(targetTangent, 4, tt).addScaledVector(n, -tt.dot(n)).normalize();
        // glTF uses the opposite tangent sign convention from MikkTSpace.
        const convention = direct?.topDown ? -1 : 1;
        const sourceSign = convention * sourceTangent[i * 4 + 3], targetSign = convention * targetTangent[i * 4 + 3];
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
    let png: Uint8Array<ArrayBuffer>;
    if (map.preserveAlpha) {
      png = new Uint8Array(encode({ width, height, data: new Uint8Array(pixels.buffer), channels: 4 }));
    } else {
      context.putImageData(image, 0, 0);
      png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    }
    maps.push({ slot: map.slot, source: map.source, png });
  }
  return { width, height, padding, covered, padded, boundaryOnlyTriangles, maps, coverage,
    direct: direct && { sourceName: direct.sourceName, filter: direct.filter, misses: directMisses },
    projection: input.projection && { sourceName: input.projection.sourceName, misses, maxDistance: input.projection.maxDistance,
      eligibleSources: input.projection.eligibleSources } };
}

function sample({ width, height, pixels, mode, uvTransform, wrapS, wrapT, topDown }: BakeMap, u: number, v: number, out: number[], nearest = false) {
  if (uvTransform) {
    const [a, b, c, d, e, f] = uvTransform;
    [u, v] = [a * u + b * v + c, d * u + e * v + f];
  }
  const x = u * width - 0.5, y = (topDown ? v : 1 - v) * height - 0.5;
  if (nearest) {
    const i = 4 * (wrapIndex(Math.floor(y + .5), height, wrapT) * width + wrapIndex(Math.floor(x + .5), width, wrapS));
    for (let k = 0; k < 4; k++) out[k] = pixels[i + k];
    return;
  }
  const ix = Math.floor(x), iy = Math.floor(y);
  const x0 = wrapIndex(ix, width, wrapS), x1 = wrapIndex(ix + 1, width, wrapS);
  const y0 = wrapIndex(iy, height, wrapT), y1 = wrapIndex(iy + 1, height, wrapT);
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

function wrapIndex(index: number, size: number, wrap: BakeMap['wrapS']): number {
  if (wrap === 'clamp') return Math.min(size - 1, Math.max(0, index));
  if (wrap === 'mirror') {
    const i = index - Math.floor(index / (2 * size)) * (2 * size);
    return i < size ? i : 2 * size - 1 - i;
  }
  return index - Math.floor(index / size) * size;
}
