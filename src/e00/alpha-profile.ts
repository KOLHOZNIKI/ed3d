import { Mesh, MeshLambertMaterial, MeshPhongMaterial, type Group } from 'three';

export type UvTransform = readonly [number, number, number, number, number, number];

export interface AlphaProfile {
  alphaMode: 'mask' | 'blend';
  alphaCutoff?: number;
  uvTransform?: UvTransform;
}

export function readAlphaProfile(manifest: Uint8Array | undefined, model: string, scene: Group): AlphaProfile | undefined {
  if (!manifest) return;
  let data: { stage?: unknown; model?: unknown; assetFixerMaterial?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(manifest));
  } catch {
    return;
  }
  if (data?.stage !== 'E00' || data.assetFixerMaterial === undefined) return;
  const profile = data.assetFixerMaterial as Partial<AlphaProfile> | null;
  if (data.model !== model || !profile || (profile.alphaMode !== 'mask' && profile.alphaMode !== 'blend')) {
    throw new Error('Invalid E00 alpha material profile.');
  }
  if (profile.alphaMode === 'mask' && !(Number.isFinite(profile.alphaCutoff) && profile.alphaCutoff! > 0 && profile.alphaCutoff! < 1)) {
    throw new Error('The E00 alpha mask requires a cutoff strictly between zero and one.');
  }
  const transform = profile.uvTransform;
  if (transform !== undefined) {
    if (!Array.isArray(transform) || transform.length !== 6 ||
        !transform.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) {
      throw new Error('The E00 alpha profile requires a finite six-component UV transform.');
    }
    const determinant = transform[0] * transform[4] - transform[1] * transform[3];
    if (Math.abs(determinant) < 1e-10) throw new Error('The E00 alpha profile requires an invertible UV transform.');
  }
  const meshes: Mesh[] = [];
  scene.traverse(object => { if (object instanceof Mesh) meshes.push(object); });
  const material = meshes[0]?.material;
  if (meshes.length !== 1 || !(material instanceof MeshPhongMaterial || material instanceof MeshLambertMaterial) ||
      !material.map || material.alphaMap || material.opacity !== 1) {
    throw new Error('The E00 alpha profile requires one material using only the Base Color alpha channel.');
  }
  material.transparent = profile.alphaMode === 'blend';
  material.depthWrite = !material.transparent;
  material.alphaTest = profile.alphaMode === 'mask' ? profile.alphaCutoff! : 0;
  if (transform) {
    const [a, b, c, d, e, f] = transform;
    material.map.matrix.set(a, b, c, d, e, f, 0, 0, 1);
    material.map.matrixAutoUpdate = false;
  }
  return { alphaMode: profile.alphaMode, alphaCutoff: profile.alphaMode === 'mask' ? profile.alphaCutoff : undefined, uvTransform: transform };
}
