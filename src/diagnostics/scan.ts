import { scanIntersections } from '../repair/intersections';
import type { Issue, IssueSample, ScanMesh, Severity } from './state';

const areaEpsilon = 1e-22;

export function scanMesh(mesh: ScanMesh, global: boolean) {
  const issues: Issue[] = [];
  const put = (code: string, severity: Severity, message: string, count: number, kind?: IssueSample['kind'], index = 0) => {
    if (count) issues.push({ code, severity, message, count, object: mesh.object, sample: kind ? { kind, index } : undefined });
  };
  const { positions, corners, faceEnds, edges, edgeFaceEnds, edgeFaces, triangleCorners, triangleFaces, attributes, skin } = mesh;
  const vertices = positions.length / 3;
  let invalid = 0, unused = 0, coincident = 0, firstInvalid = 0, firstUnused = 0, firstCoincident = 0;
  const used = new Uint8Array(vertices), points = new Map<string, number>();
  for (const id of corners) {
    if (id >= vertices) invalid++;
    else used[id] = 1;
  }
  for (let id = 0; id < vertices; id++) {
    const i = id * 3, x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (![x, y, z].every(Number.isFinite)) { if (!invalid++) firstInvalid = id; continue; }
    if (!used[id]) { if (!unused++) firstUnused = id; continue; }
    const key = `${x}/${y}/${z}`;
    if (points.has(key)) { if (!coincident++) firstCoincident = id; }
    else points.set(key, id);
  }
  put('invalid-geometry', 'Error', 'Geometry has invalid indices or coordinates.', invalid, 'vertex', firstInvalid);
  put('unused-vertices', 'Info', 'Some stored vertices are unused by polygons.', unused, 'vertex', firstUnused);
  put('coincident-vertices', 'Info', 'Distinct vertices share coordinates. Review their topology before welding.', coincident, 'vertex', firstCoincident);
  if (invalid) return issues;

  let duplicate = 0, firstDuplicate = 0, open = 0, firstOpen = 0, nonManifold = 0, firstNonManifold = 0;
  const faces = new Set<string>();
  for (const [id, end] of faceEnds.entries()) {
    const key = corners.slice(faceEnds[id - 1] ?? 0, end).sort().join('/');
    if (faces.has(key)) { if (!duplicate++) firstDuplicate = id; }
    else faces.add(key);
  }
  put('duplicate-faces', 'Warning', 'Some polygons use the same logical vertices.', duplicate, 'face', firstDuplicate);
  const components = Uint32Array.from(faceEnds, (_, i) => i);
  const fans = Uint32Array.from(corners, (_, i) => i);
  let reversed = 0, firstReversed = 0;
  for (const [id, end] of edgeFaceEnds.entries()) {
    const start = edgeFaceEnds[id - 1] ?? 0;
    if (end - start === 1) { if (!open++) firstOpen = id; }
    if (end - start > 2) { if (!nonManifold++) firstNonManifold = id; }
    if (end === start) continue;
    const a = edges[id * 2], b = edges[id * 2 + 1];
    const first = edgeCorners(corners, faceEnds, edgeFaces[start], a, b);
    for (let i = start + 1; i < end; i++) {
      components[root(components, edgeFaces[i])] = root(components, edgeFaces[start]);
      const adjacent = edgeCorners(corners, faceEnds, edgeFaces[i], a, b);
      if (!first || !adjacent) continue;
      fans[root(fans, adjacent.a)] = root(fans, first.a);
      fans[root(fans, adjacent.b)] = root(fans, first.b);
      if (end - start === 2 && first.forward === adjacent.forward && !reversed++) firstReversed = id;
    }
  }
  const groups = new Set(components.map(id => root(components, id)));
  const firstFan = new Int32Array(vertices).fill(-1), split = new Set<number>();
  for (const [id, vertex] of corners.entries()) {
    const fan = root(fans, id);
    if (firstFan[vertex] < 0) firstFan[vertex] = fan;
    else if (firstFan[vertex] !== fan) split.add(vertex);
  }
  put('open-boundaries', 'Info', 'Open boundary edges can be intentional. Inspect them in Repair.', open, 'edge', firstOpen);
  put('non-manifold-edges', 'Warning', 'Edges have more than two incident polygons.', nonManifold, 'edge', firstNonManifold);
  put('non-manifold-vertices', 'Warning', 'Vertices join separate incident polygon fans.', split.size, 'vertex', split.values().next().value);
  put('inconsistent-winding', 'Warning', 'Adjacent polygons traverse their common edge in the same direction.', reversed, 'edge', firstReversed);
  if (groups.size > 1) put('components', 'Info', `${groups.size} face components are disconnected by logical edges.`, groups.size);

  const geometry = Uint32Array.from(triangleCorners, index => corners[index]);
  let zero = 0, firstZero = 0;
  for (let i = 0; i < geometry.length; i += 3) {
    const a = geometry[i] * 3, b = geometry[i + 1] * 3, c = geometry[i + 2] * 3;
    const x = positions[b] - positions[a], y = positions[b + 1] - positions[a + 1], z = positions[b + 2] - positions[a + 2];
    const u = positions[c] - positions[a], v = positions[c + 1] - positions[a + 1], w = positions[c + 2] - positions[a + 2];
    if ((y * w - z * v) ** 2 + (z * u - x * w) ** 2 + (x * v - y * u) ** 2 <= areaEpsilon && !zero++) firstZero = triangleFaces[i / 3];
  }
  put('zero-area-triangles', 'Warning', 'The triangulation contains zero-area triangles.', zero, 'face', firstZero);

  const normal = attributes.find(attribute => attribute.name === 'normal');
  if (!normal) put('missing-normals', 'Info', 'The mesh has no source normals.', 1);
  else {
    let degenerate = 0, first = 0;
    for (let i = 0; i < normal.values.length; i += normal.size) {
      const length = Math.hypot(normal.values[i], normal.values[i + 1], normal.values[i + 2]);
      if ((!Number.isFinite(length) || length < 1e-9) && !degenerate++) first = faceOfCorner(faceEnds, i / normal.size);
    }
    put('invalid-normals', 'Warning', 'Some normals are degenerate or invalid.', degenerate, 'face', first);
  }
  const uv = attributes.filter(attribute => /^uv\d*$/.test(attribute.name));
  if (!uv.length) put('missing-uv', 'Info', 'The mesh has no UV channel.', 1);
  for (const { name, values, size } of uv) {
    const { outside, unmapped, overlap, firstOutside, firstUnmapped } = uvIssues(values, size, triangleCorners, triangleFaces);
    put('uv-outside', 'Info', `${name} contains coordinates outside 0–1. Repeated or mirrored sampling may be intentional.`, outside, 'face', firstOutside);
    put('uv-degenerate', 'Warning', `${name} contains zero-area UV triangles.`, unmapped, 'face', firstUnmapped);
    if (overlap !== undefined) put('uv-overlap', 'Warning', `${name} has overlapping interior samples in the unit tile. Bake validates overlap at its target resolution.`, 1, 'face', overlap);
  }
  if (skin) skinIssues(mesh, skin, put);
  if (global) {
    const result = scanIntersections(positions, geometry);
    if (result.triangle !== undefined) put('self-intersection', 'Warning', 'A triangle intersects another surface. Inspect the first detected contact.', 1, 'face', triangleFaces[result.triangle]);
    else if (result.reachedLimit) put('intersection-limit', 'Info', 'The self-intersection search reached its comparison budget.', 1);
  }
  return issues;
}

function root(links: Uint32Array, id: number): number {
  while (links[id] !== id) {
    links[id] = links[links[id]];
    id = links[id];
  }
  return id;
}

function edgeCorners(corners: Uint32Array, ends: Uint32Array, face: number, a: number, b: number) {
  const start = ends[face - 1] ?? 0, end = ends[face];
  for (let i = start; i < end; i++) {
    const next = i + 1 < end ? i + 1 : start;
    if (corners[i] === a && corners[next] === b) return { a: i, b: next, forward: true };
    if (corners[i] === b && corners[next] === a) return { a: next, b: i, forward: false };
  }
}

function faceOfCorner(ends: Uint32Array, corner: number) {
  let lo = 0, hi = ends.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ends[mid] <= corner) lo = mid + 1; else hi = mid; }
  return lo;
}

function uvIssues(values: Float64Array, size: number, triangles: Uint32Array, faces: Uint32Array) {
  let outside = 0, unmapped = 0, firstOutside = 0, firstUnmapped = 0, overlap: number | undefined;
  const resolution = 64, pixels = new Uint8Array(resolution ** 2);
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i] * size, b = triangles[i + 1] * size, c = triangles[i + 2] * size;
    const x = values[a], y = values[a + 1], u = values[b], v = values[b + 1], k = values[c], l = values[c + 1];
    if ([x, y, u, v, k, l].some(n => n < -1e-6 || n > 1 + 1e-6) && !outside++) firstOutside = faces[i / 3];
    const dx = u - x, dy = v - y, ex = k - x, ey = l - y, det = dx * ey - dy * ex;
    if (Math.abs(det) < 1e-12) { if (!unmapped++) firstUnmapped = faces[i / 3]; continue; }
    if (overlap !== undefined) continue;
    const x0 = Math.max(0, Math.floor(resolution * Math.min(x, u, k))), x1 = Math.min(resolution, Math.ceil(resolution * Math.max(x, u, k)));
    const y0 = Math.max(0, Math.floor(resolution * Math.min(y, v, l))), y1 = Math.min(resolution, Math.ceil(resolution * Math.max(y, v, l)));
    for (let j = y0; j < y1 && overlap === undefined; j++) for (let p = x0; p < x1; p++) {
      const px = (p + .5) / resolution - x, py = (j + .5) / resolution - y;
      const s = (px * ey - py * ex) / det, t = (dx * py - dy * px) / det;
      if (Math.min(s, t, 1 - s - t) > 1e-6 && pixels[j * resolution + p]++) { overlap = faces[i / 3]; break; }
    }
  }
  return { outside, unmapped, overlap, firstOutside, firstUnmapped };
}

function skinIssues(mesh: ScanMesh, skin: NonNullable<ScanMesh['skin']>, put: (code: string, severity: Severity, message: string,
  count: number, kind: IssueSample['kind'], index: number) => void) {
  const sum = new Float64Array(skin.vertexCount), influences = new Uint16Array(skin.vertexCount);
  let invalid = 0, first = 0, zero = 0, firstZero = 0, off = 0, firstOff = 0, wide = 0, firstWide = 0;
  for (let i = 0; i < skin.entries.length; i += 3) {
    const [id, joint, weight] = skin.entries.subarray(i, i + 3);
    if (id < 0 || id >= sum.length || joint < 0 || joint >= skin.joints || !Number.isInteger(joint) || !Number.isFinite(weight) || weight < 0) {
      if (!invalid++) first = id;
    } else if (weight > 0) { sum[id] += weight; influences[id]++; }
  }
  for (const id of new Set(mesh.corners)) {
    if (sum[id] === 0) { if (!zero++) firstZero = id; }
    else if (Math.abs(sum[id] - 1) > 1e-5 && !off++) firstOff = id;
    if (influences[id] > 4 && !wide++) firstWide = id;
  }
  put('invalid-weights', 'Error', 'Weights or joint indices are invalid.', invalid, 'vertex', first);
  put('zero-weights', 'Warning', 'Some vertices have no source influence. Choose a valid fallback in Weight Paint.', zero, 'vertex', firstZero);
  put('weight-sum', 'Warning', 'Some source weight sums differ from one.', off, 'vertex', firstOff);
  put('wide-weights', 'Warning', 'The viewport previews four influences. FBX retains the full weights.', wide, 'vertex', firstWide);
}
