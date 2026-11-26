export const bakeScale = 2;
export const chartPadding = 8;

export function rasterize(width: number, height: number, targetUv: Float32Array) {
  const faces = new Int32Array(width * height);
  const wb = new Float32Array(faces.length), wc = new Float32Array(faces.length);
  const smallTriangles: { face: number; pixel: number }[] = [];
  const overlaps = new Set<number>();
  let covered = 0;
  for (let i = 0; i < targetUv.length; i += 6) {
    const ax = targetUv[i] * width, ay = (1 - targetUv[i + 1]) * height;
    const bx = targetUv[i + 2] * width, by = (1 - targetUv[i + 3]) * height;
    const cx = targetUv[i + 4] * width, cy = (1 - targetUv[i + 5]) * height;
    const dx1 = bx - ax, dy1 = by - ay, dx2 = cx - ax, dy2 = cy - ay;
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (!Number.isFinite(determinant) || determinant === 0) throw new Error('The target atlas has a degenerate UV triangle.');
    const face = i / 6 + 1;
    let touched = false;
    for (let y = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)); y < height && y + 0.5 <= Math.max(ay, by, cy); y++) {
      for (let x = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)); x < width && x + 0.5 <= Math.max(ax, bx, cx); x++) {
        const dx = x + 0.5 - ax, dy = y + 0.5 - ay;
        const b = (dx * dy2 - dx2 * dy) / determinant, c = (dx1 * dy - dx * dy1) / determinant;
        const interior = Math.min(b, c, 1 - b - c);
        if (interior < -1e-7) continue;
        const pixel = y * width + x;
        const occupied = faces[pixel] > 0;
        if (occupied && interior > 1e-5 && Math.min(wb[pixel], wc[pixel], 1 - wb[pixel] - wc[pixel]) > 1e-5) {
          overlaps.add(face - 1);
        }
        if (!occupied) {
          faces[pixel] = face;
          wb[pixel] = b;
          wc[pixel] = c;
          covered++;
        }
        touched = true;
      }
    }
    if (!touched) smallTriangles.push({ face, pixel: Math.floor((ay + by + cy) / 3) * width + Math.floor((ax + bx + cx) / 3) });
  }
  // Give subpixel triangles a sample only where they cannot overwrite interior coverage.
  for (const { face, pixel } of smallTriangles) {
    if (faces[pixel] !== 0) continue;
    faces[pixel] = face;
    wb[pixel] = wc[pixel] = 1 / 3;
    covered++;
  }
  return { faces, wb, wc, covered, boundaryOnlyTriangles: smallTriangles.length, overlaps };
}
