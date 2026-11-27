import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, ws: false } });
try {
  const { boundaryContours } = await server.ssrLoadModule('/src/repair/boundaries.ts');
  const { fillBoundary } = await server.ssrLoadModule('/src/repair/fill.ts');
  const { applyMeshEdit } = await server.ssrLoadModule('/src/mesh/edit.ts');
  const inner = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  const outer = inner.map(point => point.map(x => 2 * x));
  const ring = inner.map((_, i) => [(i + 1) % 4, i, i + 4, 4 + (i + 1) % 4]);
  const obstruction = geometry([...inner, ...outer, [0, -.5, -1], [0, -.5, 1], [0, .7, 0]], [...ring, [8, 9, 10]]);
  const hole = boundaryContours(obstruction).find(contour => contour.id === 'B0');
  assert.equal(hole.kind, 'loop');
  assert.throws(() => fillBoundary(obstruction, hole, { id: hole.id, method: 'planar', tolerance: .025, project: false }),
    /intersects existing face 4/);
  assert.equal(obstruction.faces.length, 5);

  const triangle = Array.from({ length: 3 }, (_, i) => [Math.cos(2 * Math.PI * i / 3), Math.sin(2 * Math.PI * i / 3), 0]);
  const frame = geometry([...triangle, ...triangle.map(point => point.map(x => 1.5 * x))],
    triangle.map((_, i) => [(i + 1) % 3, i, i + 3, 3 + (i + 1) % 3]));
  assert.equal(applyMeshEdit(frame, { type: 'create', object: 'object-0', vertices: [0, 1, 2], material: 0, project: false })
    .mesh.faces.length, 4);
  const split = applyMeshEdit(frame, { type: 'splitEdge', object: 'object-0', edge: '0/1', fraction: .25 });
  assert.deepEqual(split.topology.vertexSources.get(6), [[0, .75], [1, .25]]);
  assert.deepEqual(split.topology.edges.get('0/1'), ['0/6', '1/6']);
  const aperture = boundaryContours(frame).find(contour => contour.id === 'B0');
  const fan = applyMeshEdit(frame, { type: 'repair', object: 'object-0', patches: [{ id: aperture.id, method: 'fan', tolerance: .025, project: false }] });
  assert.equal(fan.topology.vertexSources.get(6).length, 3);
  assert.equal(fan.topology.addedFaces.length, 3);

  const touching = geometry([...inner, ...inner.slice(0, 2), [0, -2, 0]], [[0, 1, 2, 3], [5, 4, 6]]);
  assert.ok(boundaryContours(touching).every(contour => contour.kind === 'ambiguous' && /coincides/.test(contour.reason)));
  const branch = geometry([[0, 0, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], [[0, 1, 2], [0, 3, 4]]);
  assert.equal(boundaryContours(branch)[0].kind, 'branch');
  const bowtie = geometry([inner[0], inner[2], inner[1], inner[3], ...outer], ring);
  assert.equal(boundaryContours(bowtie).find(contour => contour.id === 'B0').kind, 'ambiguous');

  const capOverSheet = geometry(inner, [[0, 1, 2], [0, 2, 3]]);
  assert.throws(() => applyMeshEdit(capOverSheet, {
    type: 'create', object: 'object-0', vertices: [0, 3, 2, 1], material: 0, project: false,
  }), /intersects existing face/);
  console.log('Verified an obstructed cap, a coincident split seam, branching and crossing contours, and Manual Face overlap rejection.');
} finally {
  await server.close();
}

function geometry(points, polygons) {
  const faces = polygons.map((vertices, id) => ({
    id, material: 0, corners: vertices.map(vertex => ({ vertex, attributes: [[0, 0, 1]] })),
    triangles: vertices.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3],
  }));
  return { positions: Float64Array.from(points.flat()), faces, channels: [{ name: 'normal', size: 3 }],
    materialCount: 1, nextFace: faces.length, glb: false };
}
