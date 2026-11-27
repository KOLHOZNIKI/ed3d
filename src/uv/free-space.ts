import type { MeshData } from '../mesh/data';
import type { Box } from './layout';

export function freeUvBox(mesh: MeshData, channels: readonly number[]): Box | undefined {
  const size = 32, stride = size + 1;
  const grid = new Int32Array(stride ** 2);
  // Reserve the bounding boxes of existing charts' triangles and leave a texel gutter inside the free rectangle.
  for (const face of mesh.faces) for (const channel of channels) {
    for (let i = 0; i < face.triangles.length; i += 3) {
      const [a, b, c] = face.triangles.slice(i, i + 3).map(j => face.corners[j].attributes[channel]);
      if ([...a, ...b, ...c].some(v => !Number.isFinite(v) || v < 0 || v > 1)) return;
      const x0 = Math.min(size - 1, Math.floor(Math.min(a[0], b[0], c[0]) * size));
      const y0 = Math.min(size - 1, Math.floor(Math.min(a[1], b[1], c[1]) * size));
      const x1 = Math.min(size, Math.floor(Math.max(a[0], b[0], c[0]) * size) + 1);
      const y1 = Math.min(size, Math.floor(Math.max(a[1], b[1], c[1]) * size) + 1);
      grid[y0 * stride + x0]++; grid[y0 * stride + x1]--;
      grid[y1 * stride + x0]--; grid[y1 * stride + x1]++;
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * stride + x;
    grid[i] += (x ? grid[i - 1] : 0) + (y ? grid[i - stride] : 0) - (x && y ? grid[i - stride - 1] : 0);
  }
  const pad = 1 / 256, blocked = new Uint8Array(size);
  let best: Box | undefined, area = 0;
  for (let y0 = 0; y0 < size; y0++) {
    blocked.fill(0);
    for (let y = y0; y < size; y++) {
      let start = 0;
      for (let x = 0; x <= size; x++) {
        if (x < size && grid[y * stride + x]) blocked[x] = 1;
        if (x < size && !blocked[x]) continue;
        const candidate = (x - start) * (y - y0 + 1);
        if (candidate > area) {
          area = candidate;
          best = { x0: start / size + pad, x1: x / size - pad, y0: y0 / size + pad, y1: (y + 1) / size - pad };
        }
        start = x + 1;
      }
    }
  }
  return best;
}
