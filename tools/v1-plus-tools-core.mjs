import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, ws: false } });
try {
  const { applyMeshEdit } = await server.ssrLoadModule('/src/mesh/edit.ts');
  const { edgesOf, edgeKey } = await server.ssrLoadModule('/src/mesh/data.ts');
  const { groups } = await server.ssrLoadModule('/src/uv/layout.ts');
  const { relaxUv } = await server.ssrLoadModule('/src/uv/relax.ts');
  const face = (id, vertices, shift) => ({ id, material: id, triangles: [0, 1, 2, 0, 2, 3],
    corners: vertices.map((vertex, k) => ({ vertex, attributes: [[shift + k / 16, k % 2], [0, 0, vertex / 8]] })) });
  const mesh = { positions: Float64Array.of(0,0,0, 1,0,0, 1,1,0, 0,1,0, 2,0,0, 2,1,0),
    faces: [face(0, [0, 1, 2, 3], 0), face(1, [1, 4, 5, 2], .5)],
    channels: [{ name: 'uv', size: 2 }, { name: 'morph:position:0', size: 3 }], uvSeams: { 0: ['1/2'] },
    weights: Array.from({ length: 6 }, (_, id) => [[id % 2, 1]]), materialCount: 2, nextFace: 2, glb: true };
  const refined = applyMeshEdit(mesh, { object: 'object-0', type: 'subdivide', faces: [0] });
  const midpoint = [...refined.topology.vertexSources].find(([, row]) => row.map(([id]) => id).sort().join('/') === '1/2')[0];
  const halves = [edgeKey(1, midpoint), edgeKey(2, midpoint)], incidence = edgesOf(refined.mesh);
  assert.equal(refined.mesh.positions.length / 3, 11);
  assert.equal(refined.topology.faces.get(0).length, 8);
  assert.equal(refined.mesh.faces.find(value => value.id === 1).triangles.length, 9);
  assert.ok(!incidence.has('1/2') && halves.every(edge => incidence.get(edge).length === 2));
  assert.deepEqual(refined.mesh.uvSeams[0].sort(), halves.sort());
  const corner = slot => refined.mesh.faces.find(value => value.material === slot && value.corners.some(c => c.vertex === midpoint))
    .corners.find(c => c.vertex === midpoint);
  assert.notDeepEqual(corner(0).attributes[0], corner(1).attributes[0]);
  assert.deepEqual(corner(0).attributes[1], [0, 0, .1875]);
  assert.deepEqual(corner(1).attributes[1], [0, 0, .1875]);
  assert.deepEqual(refined.mesh.weights[midpoint], [[0, .5], [1, .5]]);

  const surface = { positions: Float32Array.of(0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1),
    points: Uint32Array.of(0,1,2, 3,4,5), normals: new Float32Array(18), faces: Uint32Array.of(0,1), slots: Uint32Array.of(0,0) };
  const layout = { uv: Float32Array.of(0,0, 1,0, 0,1, 0,0, 1,0, 0,1), seams: [] };
  assert.throws(() => relaxUv(surface, layout, groups(surface, layout), new Set([0, 1, 2]), new Set(),
    { strength: .2, iterations: 1, fixBoundary: false }), /overlapping triangles/);
  const isolated = { ...surface, positions: surface.positions.slice(0, 9), points: surface.points.slice(0, 3) };
  const triangle = { ...layout, uv: layout.uv.slice(0, 6) };
  assert.throws(() => relaxUv(isolated, triangle, groups(isolated, triangle), new Set([0]), new Set(),
    { strength: 1, iterations: 1, fixBoundary: false }), /collapse or flip/);
  console.log('Subdivide preserved an n-gon seam, GLB morph interpolation, skin weights and adjacency. UV Relax refused overlaps and inversions.');
} finally { await server.close(); }
