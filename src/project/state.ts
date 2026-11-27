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
}

export interface WorkingState {
  readonly objects: ObjectOverrides;
  readonly atlas?: AtlasState;
  readonly bake?: TextureBake;
  readonly paint?: TexturePaint;
  readonly textures?: Readonly<Record<string, TextureEdit>>;
}

export function* workingBuffers(state: WorkingState): Iterable<ArrayBuffer> {
  if (state.atlas) {
    yield state.atlas.indices.buffer;
    yield state.atlas.uv.buffer;
    yield state.atlas.sourceCorners.buffer;
    yield state.atlas.faceComponents.buffer;
  }
  for (const map of state.bake?.maps ?? []) yield map.png.buffer;
  if (state.paint) yield state.paint.png.buffer;
  for (const edit of Object.values(state.textures ?? {})) for (const tile of edit.image.tiles) yield tile.buffer;
}
