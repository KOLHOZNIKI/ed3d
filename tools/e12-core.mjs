import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { inspectLayout } = await vite.ssrLoadModule('/src/uv/layout.ts');
  const { AssetDocument, defaultHistoryBudget } = await vite.ssrLoadModule('/src/project/document.ts');
  const triangle = (x, y, size) => [x, y, x + size, y, x, y + size];
  const uv = (...parts) => Float32Array.from(parts.flat());
  const initial = triangle(0, 0, 1);
  assert.equal(inspectLayout(uv(initial, [1, 0, 1, 1, 0, 1]), false).conflicts.size, 0, 'A shared edge is valid.');
  assert.equal(inspectLayout(uv(initial, triangle(.1, .1, .2)), false).conflicts.size, 2, 'An interior overlap marks both faces.');
  let seed = 7;
  const number = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 12; run++) {
    const parts = Array.from({ length: 48 }, () => triangle(number() * 2 - 1, number() * 2 - 1, number() * .35 + .01));
    const expected = new Set();
    for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
      if (inspectLayout(uv(parts[a], parts[b]), false).conflicts.size) { expected.add(a); expected.add(b); }
    }
    assert.deepEqual(inspectLayout(uv(...parts), false).conflicts, expected);
  }
  const doc = new AssetDocument({ id: 'test', name: 'Mesh', revision: 0, state: { value: 0 },
    originals: [], scene: [], topology: new Map(), historyBudget: defaultHistoryBudget }, () => []);
  const command = (revision, value) => ({ id: String(revision), label: 'Edit', baseRevision: revision, affectedResources: [], state: { value } });
  doc.execute(command(0, 1));
  assert.throws(() => doc.execute(command(0, 2)), /document changed/);
  assert.equal(doc.revision, 1);
  assert.deepEqual(doc.state, { value: 1 });
  assert.equal(doc.undoDepth, 1);
  console.log('UV hierarchy matches all isolated pair comparisons. Stale command left state and Undo unchanged.');
} finally {
  await vite.close();
}
