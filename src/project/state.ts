import type { TextureBake } from '../e00/rebake';
import type { TexturePaint } from '../e00/paint';
import type { UvAtlasEdit } from '../e00/uv-atlas';
import type { ObjectOverrides } from './document';
import type { TextureImage } from '../texture/image';

export const atlasColor = 'atlas-color';

export interface TextureEdit {
  readonly image: TextureImage;
  readonly paint?: Omit<TexturePaint, 'png'>;
}

export interface AtlasState {
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly uv: Float32Array<ArrayBuffer>;
  readonly sourceCorners: Uint32Array<ArrayBuffer>;
  readonly faceComponents: Uint32Array<ArrayBuffer>;
  readonly metrics: UvAtlasEdit['metrics'];
  readonly seams?: readonly string[];
}

export interface UvBake {
  readonly channel: number;
  readonly bake: TextureBake;
}

export interface ExtractedAsset {
  readonly source: string;
  readonly layout: 'keep' | 'pack' | 'unwrap';
  readonly zeroOrigin: boolean;
  readonly bakes: Readonly<Record<number, UvBake>>;
}

export interface WorkingState {
  readonly objects: ObjectOverrides;
  readonly atlas?: AtlasState;
  readonly bake?: TextureBake;
  readonly paint?: TexturePaint;
  readonly textures?: Readonly<Record<string, TextureEdit>>;
  readonly meshEdits?: readonly Uint8Array<ArrayBuffer>[];
  readonly keepOpen?: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  readonly uvBakes?: Readonly<Record<string, UvBake>>;
  readonly extracts?: Readonly<Record<string, ExtractedAsset>>;
}

export function* workingBuffers(state: WorkingState): Iterable<ArrayBuffer> {
  if (state.atlas) {
    yield state.atlas.indices.buffer;
    yield state.atlas.uv.buffer;
    yield state.atlas.sourceCorners.buffer;
    yield state.atlas.faceComponents.buffer;
  }
  for (const map of state.bake?.maps ?? []) yield map.png.buffer;
  if (state.bake?.coverage) yield state.bake.coverage.buffer;
  for (const { bake } of Object.values(state.uvBakes ?? {})) {
    for (const map of bake.maps) yield map.png.buffer;
    if (bake.coverage) yield bake.coverage.buffer;
  }
  for (const { bakes } of Object.values(state.extracts ?? {})) for (const { bake } of Object.values(bakes)) {
    for (const map of bake.maps) yield map.png.buffer;
    if (bake.coverage) yield bake.coverage.buffer;
  }
  if (state.paint) yield state.paint.png.buffer;
  for (const edit of Object.values(state.textures ?? {})) for (const tile of edit.image.tiles) yield tile.buffer;
  for (const edit of state.meshEdits ?? []) yield edit.buffer;
}
