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

export function paddingSources(faces: Int32Array, width: number, distance = Infinity, valid?: (pixel: number) => boolean): number {
  const queue = new Int32Array(faces.length);
  let tail = 0, head = 0, padded = 0;
  const adjacent = (pixel: number, visit: (neighbor: number) => void) => {
    if (pixel % width !== 0) visit(pixel - 1);
    if ((pixel + 1) % width !== 0) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel + width < faces.length) visit(pixel + width);
  };
  const seed = (pixel: number) => {
    if (!faces[pixel] || valid && !valid(pixel)) return;
    let edge = false;
    adjacent(pixel, neighbor => { if (!faces[neighbor]) edge = true; });
    if (edge) queue[tail++] = pixel;
  };
  for (let p = 0; p < faces.length; p++) seed(p);
  // Empty texels take one nearest source. Painting can preserve the rest of the
  // baked gutter by limiting the number of wavefront steps.
  for (let ring = 0; ring < distance && head < tail; ring++) {
    const end = tail;
    while (head < end) {
      const pixel = queue[head++];
      const source = faces[pixel] < 0 ? faces[pixel] : -(pixel + 1);
      adjacent(pixel, neighbor => {
        if (faces[neighbor] !== 0) return;
        faces[neighbor] = source;
        queue[tail++] = neighbor;
        padded++;
      });
    }
  }
  return padded;
}
