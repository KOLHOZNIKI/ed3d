import { BufferAttribute, BufferGeometry, Mesh, type TypedArray } from 'three';
import { renderControlPoints, sourceMesh, type FbxSourceMesh } from './fbx-topology';
import { faceComponents } from './topology-components';
import type { ImportedAsset } from './round-trip';
import type { AtlasInput, AtlasOutput } from './xatlas-worker';
import { finishWorker } from '../project/worker';

export interface UvAtlasEdit {
  inputGeometry: BufferGeometry;
  geometry: BufferGeometry;
  sourceCorners: Uint32Array<ArrayBuffer>;
  faceComponents: Uint32Array<ArrayBuffer>;
  channel: 'uv1';
  seams?: readonly string[];
  metrics: {
    width: number; height: number; charts: number; separatedFaces: number; milliseconds: number;
    controlPoints: number; chartVertices: number; renderVertices: number; splitControlPoints: number;
  };
}

export async function unwrapAsset(asset: ImportedAsset, signal?: AbortSignal): Promise<ImportedAsset> {
  signal?.throwIfAborted();
  const mesh = asset.scene.getObjectByProperty('isMesh', true);
  if (!(mesh instanceof Mesh) || asset.stats.meshes !== 1 || asset.positionEdit || asset.uvAtlas || asset.repairPatch) {
    throw new Error('The E00 atlas probe requires one unedited FBX mesh.');
  }
  const geometry = mesh.geometry;
  const source = sourceMesh(geometry);
  if (source.hasMorphTargets || source.uvs.length > 1 || geometry.index || !source.renderCorners
    || source.renderCorners.length !== geometry.getAttribute('position').count || geometry.hasAttribute('tangent')) {
    throw new Error('The atlas requires at most one source UV set and a non-indexed FBX preview with source corners.');
  }
  const positions = Float32Array.from(source.positions);
  const controlPoints = renderControlPoints(source);
  const faceMaterialData = new Uint32Array(controlPoints.length / 3);
  for (const group of geometry.groups) {
    faceMaterialData.fill(group.materialIndex ?? 0, group.start / 3, (group.start + group.count) / 3);
  }
  const atlas = await generateAtlas({ positions, indices: controlPoints.slice(), faceMaterialData }, signal);
  return { ...asset, uvAtlas: remap(geometry, source, controlPoints, atlas) };
}

export async function generateAtlas(input: AtlasInput, signal?: AbortSignal): Promise<AtlasOutput> {
  const worker = new Worker(new URL('./xatlas-worker.ts', import.meta.url), { type: 'module' });
  return finishWorker(worker, input, [input.positions.buffer, input.indices.buffer, input.faceMaterialData.buffer], signal);
}

function remap(input: BufferGeometry, source: FbxSourceMesh, controlPoints: Uint32Array, atlas: AtlasOutput): UvAtlasEdit {
  if (atlas.indices.length !== controlPoints.length) throw new Error('xatlas changed the source triangle count.');
  const attributes = Object.entries(input.attributes).map(([name, attribute]) => {
    if (!(attribute instanceof BufferAttribute)) throw new Error(`Unsupported interleaved FBX attribute: ${name}.`);
    return { name, attribute };
  });
  const index = new Uint32Array(controlPoints.length);
  const sourcePreviewVertices: number[] = [];
  const atlasVertices: number[] = [];
  const splits = new Map<string, number>();
  for (let corner = 0; corner < index.length; corner++) {
    const atlasIndex = atlas.indices[corner];
    if (atlas.xrefs[atlasIndex] !== controlPoints[corner]) throw new Error('xatlas broke triangle corner correspondence.');
    // One control point can already have multiple authored corner normals or UVs.
    // Share an atlas vertex only when its entire original render tuple matches.
    const key = [atlasIndex];
    for (const { attribute } of attributes) {
      for (let k = 0; k < attribute.itemSize; k++) key.push(attribute.array[corner * attribute.itemSize + k]);
    }
    const signature = key.map(value => Object.is(value, -0) ? '-0' : String(value)).join(',');
    let output = splits.get(signature);
    if (output === undefined) {
      output = sourcePreviewVertices.length;
      splits.set(signature, output);
      sourcePreviewVertices.push(corner);
      atlasVertices.push(atlasIndex);
    }
    index[corner] = output;
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(index, 1));
  const uv = new Float32Array(atlasVertices.length * 2);
  atlasVertices.forEach((vertex, i) => { uv.set(atlas.uv.subarray(vertex * 2, vertex * 2 + 2), i * 2); });
  geometry.setAttribute('uv1', new BufferAttribute(uv, 2));
  for (const { name, attribute } of attributes) {
    const size = attribute.itemSize;
    const ArrayType = attribute.array.constructor as new (length: number) => TypedArray;
    const values = new ArrayType(sourcePreviewVertices.length * size);
    sourcePreviewVertices.forEach((sourceIndex, i) => {
      values.set(attribute.array.subarray(sourceIndex * size, sourceIndex * size + size), i * size);
    });
    for (let corner = 0; corner < index.length; corner++) {
      for (let k = 0; k < size; k++) {
        if (!Object.is(values[index[corner] * size + k], attribute.array[corner * size + k])) {
          throw new Error(`xatlas changed the source ${name} attribute.`);
        }
      }
    }
    geometry.setAttribute(name, new BufferAttribute(values, size, attribute.normalized));
  }
  for (const group of input.groups) geometry.addGroup(group.start, group.count, group.materialIndex);

  const vertexCounts = new Uint32Array(source.positions.length / 3);
  for (const xref of atlas.xrefs) vertexCounts[xref]++;
  const metrics = {
    width: atlas.width, height: atlas.height, charts: atlas.charts, separatedFaces: atlas.separatedFaces, milliseconds: atlas.milliseconds,
    controlPoints: vertexCounts.length, chartVertices: atlas.xrefs.length, renderVertices: sourcePreviewVertices.length,
    splitControlPoints: vertexCounts.reduce((count, vertices) => count + Number(vertices > 1), 0),
  };
  return { inputGeometry: input, geometry, sourceCorners: source.renderCorners.slice(), faceComponents: faceComponents(controlPoints), channel: 'uv1', metrics };
}
