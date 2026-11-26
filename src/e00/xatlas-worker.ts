import createXAtlas from 'xatlas-wasm';

export interface AtlasInput {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  faceMaterialData: Uint32Array<ArrayBuffer>;
}

export interface AtlasOutput {
  width: number;
  height: number;
  charts: number;
  xrefs: Uint32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  uv: Float32Array<ArrayBuffer>;
  milliseconds: number;
}

self.onmessage = async ({ data }: MessageEvent<AtlasInput>) => {
  try {
    const module = await createXAtlas();
    const atlas = module.createAtlas();
    try {
      const start = performance.now();
      const error = atlas.addMesh(data);
      if (error !== 0) throw new Error(`xatlas rejected the indexed mesh (${error}).`);
      atlas.generate({}, { resolution: 1024, padding: 4 });
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
      const output: AtlasOutput = { width, height, charts: chartCount, xrefs, indices, uv, milliseconds: performance.now() - start };
      self.postMessage(output, { transfer: [xrefs.buffer, indices.buffer, uv.buffer] });
    } finally {
      atlas.destroy();
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
