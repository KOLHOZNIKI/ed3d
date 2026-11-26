import { Mesh, MeshPhongMaterial, MeshLambertMaterial, RepeatWrapping, type Texture } from 'three';
import type { ImportedAsset } from './round-trip';
import type { BakeInput, BakeMap, BakeOutput } from './rebake-worker';
import { bakeScale, chartPadding } from './atlas-raster';

export interface TextureBake {
  maps: { slot: string; source: string; png: Uint8Array<ArrayBuffer> }[];
  width: number;
  height: number;
  covered: number;
  padded: number;
  padding: number;
  boundaryOnlyTriangles: number;
}

export async function rebakeAsset(asset: ImportedAsset): Promise<ImportedAsset> {
  const atlas = asset.uvAtlas;
  const mesh = asset.scene.getObjectByProperty('isMesh', true);
  if (!atlas || !(mesh instanceof Mesh) || atlas.inputGeometry !== mesh.geometry || asset.textureBake) {
    throw new Error('Generate a UV atlas before rebaking textures.');
  }
  const material = mesh.material;
  if (!(material instanceof MeshPhongMaterial || material instanceof MeshLambertMaterial) || !material.map ||
      material.transparent || material.alphaTest > 0) {
    throw new Error('The E00 bake requires one opaque textured FBX material.');
  }
  const normal = material instanceof MeshPhongMaterial ? material.normalMap : null;
  for (const [slot, value] of Object.entries(material)) {
    if (value?.isTexture && slot !== 'map' && slot !== 'normalMap') {
      throw new Error(`The E00 bake does not support the ${slot} texture slot.`);
    }
  }
  const slots = [['map', material.map], ...(normal ? [['normalMap', normal]] as const : [])] as const;
  const maps = await Promise.all(slots.map(([slot, texture]) => readLinkedMap(asset, slot, texture)));
  for (const [source, bytes] of asset.images) {
    if (maps.some(map => map.source === source)) continue;
    const slot = /_(roughness|metallic)\.(jpg|jpeg|png)$/i.exec(source)?.[1].toLowerCase();
    if (!slot) continue;
    if (maps.some(map => map.slot === slot)) throw new Error(`Multiple Tripo ${slot} maps were found.`);
    maps.push({ slot, source, mode: 'linear', ...await readPixels(bytes) });
  }

  const { position, normal: normals, uv } = mesh.geometry.attributes;
  const target = atlas.geometry.getAttribute(atlas.channel);
  const index = atlas.geometry.index!;
  const targetUv = new Float32Array(index.count * 2);
  for (let i = 0; i < index.count; i++) {
    const k = index.getX(i);
    targetUv[i * 2] = target.getX(k);
    targetUv[i * 2 + 1] = target.getY(k);
  }
  const output = await bakeInWorker({
    width: atlas.metrics.width * bakeScale, height: atlas.metrics.height * bakeScale, padding: chartPadding * bakeScale,
    position: Float32Array.from(position.array), normals: Float32Array.from(normals.array),
    sourceUv: Float32Array.from(uv.array), targetUv, maps,
  });
  return { ...asset, textureBake: output };
}

async function readLinkedMap(asset: ImportedAsset, slot: string, texture: Texture): Promise<BakeMap> {
  const image = texture.image;
  const source = image instanceof HTMLImageElement && asset.imagePathsByUrl.get(image.src);
  if (!source || texture.channel !== 0 || !texture.flipY || texture.repeat.x !== 1 || texture.repeat.y !== 1 ||
      texture.offset.x !== 0 || texture.offset.y !== 0 || texture.rotation !== 0 ||
      texture.wrapS !== RepeatWrapping || texture.wrapT !== RepeatWrapping) {
    throw new Error('The E00 bake requires a local UV0 texture with default mapping and repeat wrap.');
  }
  return { slot, source, mode: slot === 'normalMap' ? 'normal' : 'srgb', ...await readPixels(asset.images.get(source)!) };
}

async function readPixels(bytes: Uint8Array<ArrayBuffer>) {
  const image = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, pixels: ctx.getImageData(0, 0, image.width, image.height).data };
  } finally {
    image.close();
  }
}

async function bakeInWorker(input: BakeInput): Promise<TextureBake> {
  const worker = new Worker(new URL('./rebake-worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<TextureBake>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<BakeOutput | { error: string }>) => {
        if ('error' in data) reject(new Error(data.error));
        else resolve(data);
      };
      worker.onerror = event => reject(new Error(event.message || 'Could not run the rebake worker.'));
      worker.postMessage(input, [input.position.buffer, input.normals.buffer, input.sourceUv.buffer, input.targetUv.buffer,
        ...input.maps.map(map => map.pixels.buffer)]);
    });
  } finally {
    worker.terminate();
  }
}
