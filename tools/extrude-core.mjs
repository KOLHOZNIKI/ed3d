import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, ws: false } });
try {
  const { applyMeshEdit } = await server.ssrLoadModule('/src/mesh/edit.ts');
  const { edgesOf } = await server.ssrLoadModule('/src/mesh/data.ts');
  const { inspectLayout } = await server.ssrLoadModule('/src/uv/layout.ts');
  const { boundaryContours, remapOpenBoundaryFlags } = await server.ssrLoadModule('/src/repair/boundaries.ts');
  const sheet = (uv, glb = false) => ({ positions: Float64Array.of(0,0,0, 1,0,0, 1,1,0, 0,1,0),
    faces: [{ id: 0, material: 0, triangles: [0, 1, 2, 0, 2, 3], corners: uv.map((value, vertex) => ({ vertex, attributes: [value, [0, 0, 1]] })) }],
    channels: [{ name: glb ? 'uv' : 'uv0', size: 2 }, { name: 'normal', size: 3 }], glb, materialCount: 1, nextFace: 1 });
  const command = { object: 'object-0', type: 'extrude', direction: 'z', depth: .25 };
  const full = sheet([[0,0], [1,0], [1,1], [0,1]]);
  const vertices = [0, 1, 2, 3];
  const moved = applyMeshEdit(full, { ...command, selection: { faces: [0] } });
  assert.equal(moved.mesh.faces.length, 5);
  assert.equal(moved.extrusion.projected, false);
  assert.deepEqual(moved.mesh.faces[0].corners.map(corner => corner.vertex), [4, 5, 6, 7]);
  assert.deepEqual([...moved.topology.vertexSources], vertices.map(id => [id + 4, [[id, 1]]]));
  assert.ok(moved.mesh.faces.slice(1).every(face => face.created && face.needsUv));

  const atlas = sheet([[.125,.125], [.625,.125], [.625,.625], [.125,.625]]);
  const loop = ['0/1', '1/2', '2/3', '0/3'];
  const extruded = applyMeshEdit(atlas, { ...command, selection: { edges: loop } });
  assert.equal(extruded.extrusion.projected, true);
  assert.equal(edgesOf(extruded.mesh).get('0/1').length, 2);
  assert.equal(edgesOf(extruded.mesh).get('4/5').length, 1);
  assert.equal(boundaryContours(extruded.mesh).filter(item => item.kind === 'loop').length, 1);
  assert.deepEqual(remapOpenBoundaryFlags(atlas, extruded.mesh, extruded.topology.edges, { B0: true }, undefined), { B4: true });
  const uv = Float32Array.from(extruded.mesh.faces.flatMap(face => face.triangles.flatMap(i => face.corners[i].attributes[0])));
  assert.equal(inspectLayout(uv, false).conflicts.size, 0);
  assert.throws(() => applyMeshEdit(extruded.mesh, { ...command, selection: { edges: ['0/1'] } }), /requires open boundary edges/);
  assert.throws(() => applyMeshEdit(atlas, { ...command, selection: { edges: ['0/1', '2/3'] } }), /one connected/);
  assert.throws(() => applyMeshEdit(atlas, { ...command, direction: 'x', selection: { edges: ['0/1'] } }), /collapsed/);
  assert.throws(() => applyMeshEdit({ ...atlas, weights: [] }, { ...command, selection: { faces: [0] } }), /static meshes/);

  const blocker = { ...atlas, positions: Float64Array.from([...atlas.positions, .25,.25,.25, .75,.25,.25, .25,.75,.25]), nextFace: 2,
    faces: [...atlas.faces, { ...atlas.faces[0], id: 1, triangles: [0, 1, 2], corners: atlas.faces[0].corners.slice(0, 3)
      .map((corner, i) => ({ ...corner, vertex: i + 4 })) }] };
  assert.throws(() => applyMeshEdit(blocker, { ...command, selection: { faces: [0] } }), /intersects existing face/);
  const glb = sheet([[.125,.625], [.625,.625], [.625,.125], [.125,.125]], true);
  const strip = applyMeshEdit(glb, { ...command, selection: { edges: ['0/1'] } }).mesh.faces[1];
  const [[u0, v0], [u1, v1], [u2, v2]] = strip.corners.map(corner => corner.attributes[0]);
  assert.ok((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0) < 0);
  console.log('Extrude preserved cap and rim provenance, open-boundary flags, atlas isolation and GLB UV orientation. Invalid candidates were refused.');
} finally { await server.close(); }
