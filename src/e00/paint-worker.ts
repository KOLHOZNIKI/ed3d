import { paddingSources, rasterize } from './atlas-raster';
import { decode, encode } from 'fast-png';

export interface PaintInput {
  png: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  clip: Float64Array<ArrayBuffer>;
  targetUv: Float32Array<ArrayBuffer>;
  components: Uint32Array<ArrayBuffer>;
  winding: number;
  points: [number, number][];
  color: string;
  radius: number;
  padding: number;
}

export interface StrokeResult {
  png: Uint8Array<ArrayBuffer>;
  texels: number;
}

self.onmessage = async ({ data }: MessageEvent<PaintInput>) => {
  try {
    const result = await paint(data);
    self.postMessage(result, { transfer: [result.png.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

function strokeMask(input: PaintInput, width: number, height: number) {
  const context = new OffscreenCanvas(width, height).getContext('2d')!;
  context.scale(2, 2);
  context.fillStyle = context.strokeStyle = input.color;
  context.lineWidth = 2 * input.radius;
  context.lineCap = context.lineJoin = 'round';
  const [x, y] = input.points[0];
  context.beginPath();
  context.arc(x, y, input.radius, 0, 2 * Math.PI);
  context.fill();
  if (input.points.length > 1) {
    context.beginPath();
    context.moveTo(x, y);
    for (const [x, y] of input.points.slice(1)) context.lineTo(x, y);
    context.stroke();
  }
  return context.getImageData(0, 0, width, height).data;
}

function visibility({ clip, winding }: PaintInput, width: number, height: number) {
  const tile = 12;
  const cols = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const bins: number[][] = Array.from({ length: rows * cols }, () => []);
  const faces: ({ ax: number; ay: number; inv: number; dx1: number; dy1: number; dx2: number; dy2: number;
    origin: number; slopeX: number; slopeY: number } | undefined)[] = [];
  const vx = (i: number) => (0.5 + 0.5 * clip[i] / clip[i + 3]) * width;
  const vy = (i: number) => (0.5 - 0.5 * clip[i + 1] / clip[i + 3]) * height;
  const vz = (i: number) => clip[i + 2] / clip[i + 3];
  for (let face = 0; face < clip.length / 12; face++) {
    const i = face * 12;
    if (clip[i + 3] <= 0 || clip[i + 7] <= 0 || clip[i + 11] <= 0) continue;
    const ax = vx(i), bx = vx(i + 4), cx = vx(i + 8);
    const ay = vy(i), by = vy(i + 4), cy = vy(i + 8);
    const az = vz(i), bz = vz(i + 4), cz = vz(i + 8);
    const dx1 = bx - ax, dx2 = cx - ax, dy1 = by - ay, dy2 = cy - ay;
    const det = dx1 * dy2 - dx2 * dy1;
    if (det * winding >= -1e-9) continue;
    const slopeX = ((bz - az) * dy2 - (cz - az) * dy1) / det;
    const slopeY = ((cz - az) * dx1 - (bz - az) * dx2) / det;
    const origin = az - slopeX * ax - slopeY * ay;
    faces[face] = { ax, ay, dx1, dy1, dx2, dy2, origin, slopeX, slopeY, inv: 1 / det };
    const xMin = Math.max(0, Math.floor(Math.min(ax, bx, cx) / tile));
    const yMin = Math.max(0, Math.floor(Math.min(ay, by, cy) / tile));
    const xMax = Math.min(cols - 1, Math.floor(Math.max(ax, bx, cx) / tile));
    const yMax = Math.min(rows - 1, Math.floor(Math.max(ay, by, cy) / tile));
    for (let y = yMin; y <= yMax; y++) for (let x = xMin; x <= xMax; x++) bins[y * cols + x].push(face);
  }
  const contains = (face: NonNullable<typeof faces[number]>, x: number, y: number) => {
    const dx = x - face.ax, dy = y - face.ay;
    const b = (dx * face.dy2 - face.dx2 * dy) * face.inv;
    const c = (face.dx1 * dy - dx * face.dy1) * face.inv;
    return Math.min(b, c, 1 - b - c) >= -1e-8;
  };
  const faceAt = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return -1;
    let nearest = -1, bestDepth = 1;
    for (const candidate of bins[Math.floor(y / tile) * cols + Math.floor(x / tile)]) {
      const face = faces[candidate]!;
      const depth = face.origin + face.slopeX * x + face.slopeY * y;
      if (depth >= -1 && depth < bestDepth && contains(face, x, y)) {
        bestDepth = depth;
        nearest = candidate;
      }
    }
    return nearest;
  };
  // Evaluate occluders at the texel's exact projected point. Extending the depth
  // of a neighboring screen pixel across a triangle edge can remove seam texels.
  const obscured = (face: number, x: number, y: number, z: number) => {
    const bin = bins[Math.floor(y / tile) * cols + Math.floor(x / tile)];
    for (const candidate of bin) {
      if (candidate === face) continue;
      const other = faces[candidate]!;
      const depth = other.origin + other.slopeX * x + other.slopeY * y;
      // Keep sub-texel surface folds in the same brush footprint, including
      // nearby chart edges that interpolate to slightly different depths.
      if (depth < -1 || depth >= z - 2e-5) continue;
      if (contains(other, x, y)) return true;
    }
    return false;
  };
  return { faces, obscured, faceAt };
}

async function paint(input: PaintInput): Promise<StrokeResult> {
  const { width, height, targetUv, clip } = input;
  const screenWidth = input.screenWidth * 2, screenHeight = input.screenHeight * 2;
  const projection = visibility(input, screenWidth, screenHeight);
  // Keep a stroke on the first surface hit by its center, including that surface's UV seams.
  let hit = -1;
  for (const [x, y] of input.points) {
    hit = projection.faceAt(x * 2, y * 2);
    if (hit >= 0) break;
  }
  if (hit < 0) return { png: input.png, texels: 0 };
  const component = input.components[hit];
  const mask = strokeMask(input, screenWidth, screenHeight);
  const { faces, wb, wc, overlaps } = rasterize(width, height, targetUv);
  if (overlaps.size) throw new Error('Painting requires an atlas without conflicting texel coverage.');
  const image = decode(input.png);
  if (image.width !== width || image.height !== height || image.depth !== 8 || (image.channels !== 3 && image.channels !== 4)) {
    throw new Error('The brush requires an RGB or RGBA atlas with matching dimensions.');
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (image.channels === 4) pixels.set(image.data);
  else for (let i = 0, j = 0; i < image.data.length; i += 3, j += 4) {
    pixels[j] = image.data[i];
    pixels[j + 1] = image.data[i + 1];
    pixels[j + 2] = image.data[i + 2];
    pixels[j + 3] = 255;
  }
  const changed = new Uint8Array(faces.length);
  let texels = 0;
  for (let p = 0; p < faces.length; p++) {
    const face = faces[p] - 1;
    if (face < 0 || !projection.faces[face] || input.components[face] !== component) continue;
    const i = face * 12;
    const b = wb[p], c = wc[p], a = 1 - b - c;
    const w = a * clip[i + 3] + b * clip[i + 7] + c * clip[i + 11];
    const x = (0.5 + 0.5 * (a * clip[i] + b * clip[i + 4] + c * clip[i + 8]) / w) * screenWidth;
    const y = (0.5 - 0.5 * (a * clip[i + 1] + b * clip[i + 5] + c * clip[i + 9]) / w) * screenHeight;
    if (x < 0 || y < 0 || x >= screenWidth || y >= screenHeight) continue;
    const screenPixel = Math.floor(y) * screenWidth + Math.floor(x);
    const j = 4 * screenPixel;
    const alpha = mask[j + 3] / 255;
    if (!alpha) continue;
    const z = (a * clip[i + 2] + b * clip[i + 6] + c * clip[i + 10]) / w;
    if (z < -1 || z > 1 || projection.obscured(face, x, y, z)) continue;
    for (let k = 0; k < 3; k++) pixels[4 * p + k] = pixels[4 * p + k] * (1 - alpha) + mask[j + k] * alpha;
    changed[p] = 1;
    texels++;
  }
  if (!texels) return { png: input.png, texels };

  paddingSources(faces, width, input.padding);
  for (let p = 0; p < faces.length; p++) {
    if (faces[p] >= 0) continue;
    const source = -faces[p] - 1;
    if (changed[source]) pixels.copyWithin(p * 4, source * 4, source * 4 + 3);
  }
  const png = new Uint8Array(encode({ width, height, channels: 4, data: pixels }));
  return { png, texels };
}
