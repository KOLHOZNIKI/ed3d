import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { groups } = await vite.ssrLoadModule('/src/uv/layout.ts');
  const { stitchEdge } = await vite.ssrLoadModule('/src/uv/stitch.ts');
  const surface = {
    points: Uint32Array.of(0, 1, 2, 1, 3, 2, 3, 4, 2, 5, 6, 7),
    faces: Uint32Array.of(0, 1, 2, 3),
    slots: new Uint32Array(4),
  };
  const uv = Float32Array.of(
    .125, .125, .375, .125, .375, .5,
    .625, .125, .875, .125, .625, .5,
    .875, .125, .875, .5, .625, .5,
    .375, .125, .25, .03125, .5, .03125,
  );
  const edge = { key: '1/2', triangle: 0 };
  const layout = { uv, seams: ['1/2'] };
  const run = (value = layout, mesh = surface, side = edge) => stitchEdge(mesh, value, side, groups(mesh, value));
  const stitched = run();
  const expected = uv.slice();
  for (const corner of [3, 5, 8]) expected[corner * 2] = .375;
  assert.deepEqual(stitched.uv, expected);
  assert.deepEqual(stitched.seams, []);
  assert.equal(groups(surface, stitched).islands.size, 2);
  assert.equal(uv[6], .625);
  assert.throws(() => run(stitched), /already continuous/);
  assert.throws(() => run(layout, surface, { key: '0/1', triangle: 0 }), /exactly two faces/);
  assert.throws(() => run(layout, { ...surface, slots: Uint32Array.of(0, 1, 1, 0) }), /same material/);
  assert.throws(() => run(layout, { ...surface, slots: Uint32Array.of(0, 0, 1, 0) }), /another material/);
  assert.throws(() => run(layout, { ...surface, faces: Uint32Array.of(0, 0, 2, 3) }), /distinct mesh faces/);
  const coincident = surface.points.slice();
  coincident.set([5, 3, 7], 3);
  assert.throws(() => run(layout, { ...surface, points: coincident }), /exactly two faces/);

  const overlap = uv.slice();
  overlap.set([.43, .20, .50, .20, .43, .28], 18);
  assert.throws(() => run({ ...layout, uv: overlap }), /overlapping UVs/);
  const flip = uv.slice();
  flip[2] = flip[4] = .9375;
  assert.throws(() => run({ ...layout, uv: flip }), /collapse or flip/);

  const marked = run({ ...stitched, seams: ['1/2'] });
  assert.equal(marked.uv, stitched.uv);
  assert.deepEqual(marked.seams, []);
  const adjacent = uv.slice();
  adjacent[16] = .375;
  const kept = run({ ...layout, uv: adjacent });
  assert.deepEqual(kept.uv, expected);
  assert.deepEqual(kept.seams, ['2/3']);
  assert.equal(groups(surface, kept).islands.size, 3);
  const reverse = run(layout, surface, { ...edge, triangle: 1 });
  assert.deepEqual(reverse.uv.subarray(6), uv.subarray(6));
  assert.deepEqual([reverse.uv[2], reverse.uv[4]], [.625, .625]);
  console.log('UV stitch preserved corner identity, changed exactly three occurrences and rejected incompatible boundaries.');
} finally {
  await vite.close();
}
