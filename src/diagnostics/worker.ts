import { scanMesh } from './scan';
import type { ScanMesh } from './state';

self.onmessage = ({ data }: MessageEvent<{ meshes: ScanMesh[]; global: boolean }>) => {
  try { self.postMessage(data.meshes.flatMap(mesh => scanMesh(mesh, data.global))); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
