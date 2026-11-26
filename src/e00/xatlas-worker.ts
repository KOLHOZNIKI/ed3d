import createXAtlas from 'xatlas-wasm';
import { bakeScale, chartPadding, rasterize } from './atlas-raster';

export interface AtlasInput {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  faceMaterialData: Uint32Array<ArrayBuffer>;
}

export interface AtlasOutput {
  width: number;
  height: number;
  charts: number;
  separatedFaces: number;
  xrefs: Uint32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  uv: Float32Array<ArrayBuffer>;
  milliseconds: number;
}

self.onmessage = async ({ data }: MessageEvent<AtlasInput>) => {
  try {
    const output = await generate(data);
    self.postMessage(output, { transfer: [output.xrefs.buffer, output.indices.buffer, output.uv.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

async function generate(data: AtlasInput): Promise<AtlasOutput> {
  const module = await createXAtlas();
  const start = performance.now();
  let firstUniqueMaterial = 0;
  for (const material of data.faceMaterialData) firstUniqueMaterial = Math.max(firstUniqueMaterial, material + 1);
  let nextMaterial = firstUniqueMaterial;
  for (let attempt = 0; attempt < 5; attempt++) {
    const atlas = module.createAtlas();
    try {
      const error = atlas.addMesh(data);
      if (error !== 0) throw new Error(`xatlas rejected the indexed mesh (${error}).`);
      atlas.generate({}, { resolution: 1024, padding: chartPadding });
      const { width, height, chartCount } = atlas;
      if (atlas.atlasCount !== 1 || !width || !height || !chartCount) throw new Error('xatlas did not create a single nonempty atlas.');
      const mesh = atlas.getMesh(0);
      const indices = Uint32Array.from(mesh.indices);
      const xrefs = new Uint32Array(mesh.vertexCount);
      const uv = new Float32Array(mesh.vertexCount * 2);
      mesh.vertices.forEach((vertex, index) => {
        const u = vertex.uv[0] / width;
        const v = vertex.uv[1] / height;
        if (vertex.atlasIndex !== 0 || vertex.chartIndex < 0 || !(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
          throw new Error('xatlas returned an uncharted vertex or an out-of-range UV.');
        }
        xrefs[index] = vertex.xref;
        uv.set([u, v], index * 2);
      });
      const corners = new Float32Array(indices.length * 2);
      indices.forEach((index, i) => corners.set(uv.subarray(index * 2, index * 2 + 2), i * 2));
      const { overlaps } = rasterize(width * bakeScale, height * bakeScale, corners);
      if (!overlaps.size) return {
        width, height, charts: chartCount, separatedFaces: nextMaterial - firstUniqueMaterial,
        xrefs, indices, uv, milliseconds: performance.now() - start,
      };
      // Force each conflicting face into its own chart for the next packing attempt.
      // These IDs constrain xatlas only. Source material assignments are unchanged.
      let changed = false;
      for (const face of overlaps) {
        if (data.faceMaterialData[face] >= firstUniqueMaterial) continue;
        data.faceMaterialData[face] = nextMaterial++;
        changed = true;
      }
      if (!changed) break;
    } finally {
      atlas.destroy();
    }
  }
  throw new Error('xatlas could not pack the charts without conflicting texel coverage.');
}
