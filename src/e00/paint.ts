import { FrontSide, Matrix4, Mesh, MeshLambertMaterial, MeshPhongMaterial, SkinnedMesh, Vector4, type Camera } from 'three';
import type { PaintInput, StrokeResult } from './paint-worker';
import type { ImportedAsset } from './round-trip';

export interface TexturePaint {
  png: Uint8Array<ArrayBuffer>;
  strokes: number;
  lastStrokeTexels: number;
}

export const brushRadius = 12;

export function paintableMesh(asset: ImportedAsset) {
  const mesh = asset.scene.getObjectByProperty('isMesh', true);
  const material = mesh instanceof Mesh ? mesh.material : null;
  if (asset.textureBake?.maps.length === 1 && asset.uvAtlas && mesh instanceof Mesh && !(mesh instanceof SkinnedMesh)
      && (material instanceof MeshPhongMaterial || material instanceof MeshLambertMaterial) && material.side === FrontSide) return mesh;
}

export async function paintStroke(asset: ImportedAsset, camera: Camera, screenWidth: number, screenHeight: number,
  points: PaintInput['points'], color: string): Promise<TexturePaint | undefined> {
  const mesh = paintableMesh(asset);
  const atlas = asset.uvAtlas;
  const bake = asset.textureBake;
  const map = bake?.maps.find(map => map.slot === 'map');
  const index = atlas?.geometry.index;
  if (!mesh || !atlas || !index || !bake || !map) throw new Error('Rebake a static FBX with one color map before painting.');
  const { position, uv1 } = atlas.geometry.attributes;
  const clip = new Float64Array(index.count * 4), targetUv = new Float32Array(index.count * 2);
  camera.updateMatrixWorld();
  mesh.updateWorldMatrix(true, false);
  const projection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
  const corner = new Vector4();
  for (let i = 0; i < index.count; i++) {
    const vertex = index.getX(i);
    corner.set(position.getX(vertex), position.getY(vertex), position.getZ(vertex), 1).applyMatrix4(projection).toArray(clip, i * 4);
    targetUv[i * 2] = uv1.getX(vertex);
    targetUv[i * 2 + 1] = uv1.getY(vertex);
  }
  const png = (asset.texturePaint?.png ?? map.png).slice();
  const input: PaintInput = {
    png, width: bake.width, height: bake.height, screenWidth, screenHeight, clip, targetUv,
    winding: Math.sign(mesh.matrixWorld.determinant()), points, color, radius: brushRadius, padding: bake.padding,
  };
  const worker = new Worker(new URL('./paint-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<StrokeResult>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<StrokeResult | { error: string }>) => {
        if ('error' in data) reject(new Error(data.error));
        else resolve(data);
      };
      worker.onerror = event => reject(new Error(event.message || 'Could not run the 3D brush worker.'));
      worker.postMessage(input, [png.buffer, clip.buffer, targetUv.buffer]);
    });
    if (result.texels) return { png: result.png, strokes: (asset.texturePaint?.strokes ?? 0) + 1, lastStrokeTexels: result.texels };
  } finally {
    worker.terminate();
  }
}
