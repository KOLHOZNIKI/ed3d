import { convertIndexedToRgb, decode, encode, hasPngSignature } from 'fast-png';

export const tileSize = 32;
const tileBytes = tileSize * tileSize * 4;
const limit = 4096;

export type Rgba = readonly [number, number, number, number];
export interface TextureImage {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly Uint8ClampedArray<ArrayBuffer>[];
}

function checkSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > limit || height > limit) {
    throw new Error(`Texture editing supports images up to ${limit} × ${limit} without resizing.`);
  }
}

export async function decodeImage(blob: Blob, previous?: TextureImage): Promise<TextureImage> {
  if (blob.size > 96 * 1024 * 1024) throw new Error('The texture file exceeds the 96 MiB editing limit.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (hasPngSignature(bytes)) return decodePng(bytes, previous);
  const view = new DataView(bytes.buffer);
  const webp = bytes.length >= 12 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!webp && !jpeg) throw new Error('Choose an encoded PNG, JPEG or WebP image.');
  const type = webp ? 'image/webp' : 'image/jpeg';
  const size = webp ? webpSize(view) : jpegSize(view);
  if (!size) throw new Error('The texture has an invalid image header.');
  checkSize(...size);
  const image = await createImageBitmap(new Blob([bytes], { type }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    checkSize(image.width, image.height);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return tileImage(image.width, image.height, context.getImageData(0, 0, image.width, image.height).data, previous);
  } finally {
    image.close();
  }
}

function jpegSize(view: DataView): [number, number] | undefined {
  for (let offset = 2; offset + 4 <= view.byteLength;) {
    if (view.getUint8(offset++) !== 0xff) return;
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset++;
    if (offset + 3 > view.byteLength) return;
    const marker = view.getUint8(offset++);
    if (marker === 0xda || marker === 0xd9) return;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength) return;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length >= 7) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      return;
    }
    offset += length;
  }
}

function webpSize(view: DataView): [number, number] | undefined {
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const format = view.getUint32(offset), length = view.getUint32(offset + 4, true), data = offset + 8;
    if (data + length > view.byteLength) return;
    if (format === 0x56503858 && length >= 10) {
      const read24 = (a: number) => view.getUint16(a, true) + 65536 * view.getUint8(a + 2);
      return [1 + read24(data + 4), 1 + read24(data + 7)];
    }
    if (format === 0x5650384c && length >= 5 && view.getUint8(data) === 0x2f) {
      const dimensions = view.getUint32(data + 1, true);
      return [1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff)];
    }
    if (format === 0x56503820 && length >= 10 && view.getUint8(data + 3) === 0x9d) {
      return [view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff];
    }
    offset = data + length + (length & 1);
  }
}

export function decodePng(bytes: Uint8Array, previous?: TextureImage): TextureImage {
  if (!hasPngSignature(bytes) || bytes.length < 33) throw new Error('Invalid texture PNG.');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  checkSize(header.getUint32(16), header.getUint32(20));
  const png = decode(bytes, { checkCrc: true });
  if (png.depth !== 8 && !png.palette) throw new Error('Use an 8-bit PNG or an indexed PNG for texture editing.');
  const source = png.palette ? convertIndexedToRgb(png) : png.data;
  const channels = png.palette?.[0].length ?? png.channels;
  const transparent = png.transparency;
  if (channels === 4) return tileImage(png.width, png.height, source, previous);
  const rgba = new Uint8ClampedArray(png.width * png.height * 4);
  for (let i = 0, j = 0; i < source.length; i += channels, j += 4) {
    const gray = channels <= 2;
    rgba[j] = source[i];
    rgba[j + 1] = source[i + (gray ? 0 : 1)];
    rgba[j + 2] = source[i + (gray ? 0 : 2)];
    const transparentKey = transparent && transparent[0] === rgba[j] &&
      (gray || (transparent[1] === rgba[j + 1] && transparent[2] === rgba[j + 2]));
    rgba[j + 3] = channels === 2 ? source[i + 1] : transparentKey ? 0 : 255;
  }
  return tileImage(png.width, png.height, rgba, previous);
}

export function tileImage(width: number, height: number, pixels: ArrayLike<number>, previous?: TextureImage): TextureImage {
  checkSize(width, height);
  if (pixels.length !== width * height * 4) throw new Error('Invalid RGBA image size.');
  if (previous?.width !== width || previous.height !== height) previous = undefined;
  const tiles: Uint8ClampedArray<ArrayBuffer>[] = [];
  for (let y = 0; y < height; y += tileSize) for (let x = 0; x < width; x += tileSize) {
    const original = previous?.tiles[tiles.length];
    const tile = new Uint8ClampedArray(tileBytes);
    let same = !!original;
    for (let row = 0; row < Math.min(tileSize, height - y); row++) {
      const start = ((y + row) * width + x) * 4;
      for (let column = 0; column < Math.min(tileSize, width - x) * 4; column++) {
        const index = row * tileSize * 4 + column;
        tile[index] = pixels[start + column];
        if (same && tile[index] !== original![index]) same = false;
      }
    }
    tiles.push(same ? original! : tile);
  }
  return previous && tiles.every((tile, i) => tile === previous.tiles[i]) ? previous : { width, height, tiles };
}

export function pixelOffset(x: number, y: number) {
  return ((y % tileSize) * tileSize + x % tileSize) * 4;
}

export function tileIndex(image: TextureImage, x: number, y: number) {
  return Math.floor(y / tileSize) * Math.ceil(image.width / tileSize) + Math.floor(x / tileSize);
}

export function readPixel(image: TextureImage, x: number, y: number): Rgba {
  const tile = image.tiles[tileIndex(image, x, y)], offset = pixelOffset(x, y);
  return [tile[offset], tile[offset + 1], tile[offset + 2], tile[offset + 3]];
}

export function drawTile(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, image: TextureImage, index: number,
  tile = image.tiles[index]) {
  const columns = Math.ceil(image.width / tileSize);
  context.putImageData(new ImageData(tile, tileSize, tileSize), index % columns * tileSize, Math.floor(index / columns) * tileSize);
}

export function drawImage(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, image: TextureImage) {
  image.tiles.forEach((tile, index) => drawTile(context, image, index, tile));
}

export function rgbaBytes(image: TextureImage): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, tiles } = image;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const columns = Math.ceil(width / tileSize);
  for (let i = 0; i < tiles.length; i++) {
    const x = i % columns * tileSize, y = Math.floor(i / columns) * tileSize;
    const bytes = Math.min(tileSize, width - x) * 4;
    for (let row = 0; row < Math.min(tileSize, height - y); row++) {
      const start = row * tileSize * 4;
      rgba.set(tiles[i].subarray(start, start + bytes), ((y + row) * width + x) * 4);
    }
  }
  return rgba;
}

export function encodeImage(image: TextureImage): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encode({ width: image.width, height: image.height, channels: 4, data: rgbaBytes(image) }));
}
