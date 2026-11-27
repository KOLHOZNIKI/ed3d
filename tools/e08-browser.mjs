import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath, scope = 'all', tripo = 'D:/downloads/Tripo'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const dir = resolve('test-results/e08'), corpus = resolve('tools/e00/fixtures/corpus');
const server = await preview({ preview: { host: '127.0.0.1', port: 4292 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const external = [], errors = [], report = {};
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1550, height: 1550 } });
  await context.route(/^https?:/, route => {
    const requested = route.request().url();
    if (requested.startsWith(url)) return route.continue();
    external.push(requested);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const text = id => field(id).textContent();
  const choose = (id, value) => field(id).selectOption(value);
  const fill = (id, value) => field(id).fill(String(value));
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 120000 });
  const status = async pattern => assert.match(await text('status'), pattern);
  const run = async (id, pattern) => { await click(id); await ready(); await status(pattern); };
  const open = async (path, pattern) => { await field('sources').setInputFiles(path); await ready(); await status(pattern); };
  async function select(id, name) {
    const rows = await field(id).locator('option').evaluateAll(options => options.map(option => ({ name: option.textContent, value: option.value })));
    const row = rows.find(row => row.name.replaceAll('_', ' ') === name);
    assert.ok(row, `Missing ${name} in ${rows.map(row => row.name).join(', ')}`);
    await choose(id, row.value);
  }
  const enter = async id => { if (await field(`${id}-tools`).isHidden()) await click(`${id}-mode`); };
  const contours = () => field('repair-contours').locator('tr').evaluateAll(rows => rows.map(row => row.dataset.contour));
  const download = async (id, name) => {
    const [result] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), click(id)]);
    const path = join(dir, name);
    await result.saveAs(path);
    await ready();
    return readFile(path);
  };
  const bundle = async name => {
    const zip = unzipSync(await download('export', name));
    return JSON.parse(strFromU8(zip['manifest.json']));
  };
  const previewRepair = async (method, id, pattern) => {
    await choose('repair-method', method);
    if (id) await field(`pick-${id}`).check();
    await click('repair-preview');
    assert.match(await text('repair-info'), pattern);
  };
  const applyRepair = () => run('repair-apply', /Fill boundar.* applied/);

  if (scope === 'all' || scope === 'geometry') {
    await open(join(corpus, 'f03_boundaries.glb'), /80 triangles/);
    await select('object-selection', 'NonPlanar');
    await enter('repair');
    await previewRepair('smooth', 'B8', /1 to fill/);
    const revision = await text('project-status');
    assert.match(revision, /Revision 0\b/);
    await click('repair-cancel');
    assert.equal(await text('project-status'), revision);
    await previewRepair('smooth', 'B8', /1 to fill/);
    await applyRepair();
    assert.deepEqual(await contours(), []);
    await download('export', 'f03-smooth.glb');
    await run('undo-stroke', /Undid/);
    assert.deepEqual(await contours(), ['B8']);
    await run('redo', /Redid/);

    await open(join(corpus, 'f05_grid_bridge.glb'), /64 triangles/);
    await select('object-selection', 'GridRing');
    await enter('repair');
    await choose('repair-method', 'grid');
    await fill('repair-grid-corners', '0,1,2,3');
    await previewRepair('grid', 'B4', /0 to fill/);
    assert.match(await text('repair-contours'), /four distinct vertices/);
    await fill('repair-grid-corners', '');
    await previewRepair('grid', 'B4', /1 to fill/);
    await applyRepair();
    assert.deepEqual(await contours(), []);
    await select('object-selection', 'BridgeEnds');
    assert.deepEqual(await contours(), ['B8', 'B16']);
    await choose('repair-method', 'bridge');
    await fill('repair-segments', 3);
    await previewRepair('bridge', 'B8', /exactly two/);
    await previewRepair('bridge', 'B16', /1 to fill/);
    await applyRepair();
    assert.deepEqual(await contours(), []);
    await download('export', 'f05-grid-bridge.glb');
    await run('undo-stroke', /Undid/);
    await fill('repair-twist', 1);
    await previewRepair('bridge', 'B8', /exactly two/);
    await previewRepair('bridge', 'B16', /1 to fill/);
    await applyRepair();
    await download('export', 'f05-twisted.glb');
    await run('undo-stroke', /Undid/);
    await fill('repair-twist', 0);
    await fill('repair-span', 3);
    await previewRepair('bridge', 'B8', /exactly two/);
    await previewRepair('bridge', 'B16', /1 to fill/);
    await applyRepair();
    assert.equal((await contours()).length, 1);
    await download('export', 'f05-bridge-spans.glb');
    report.geometry = { smoothUndoRedo: true, grid: true, bridge: true, twist: 1, segments: 3, span: 3 };
  }

  if (scope === 'all' || scope === 'fbx') {
    await open(join(dir, 'patch.zip'), /32 triangles/);
    await choose('object-selection', { index: 1 });
    await enter('mesh');
    await choose('mesh-kind', 'face');
    await choose('mesh-operation', 'delete');
    await fill('mesh-ids', '5, 6, 9, 10');
    await click('mesh-preview');
    await run('mesh-apply', /applied/);
    await enter('repair');
    await choose('repair-method', 'grid');
    await fill('repair-grid-corners', '');
    const rim = (await contours()).find(id => id !== 'B0');
    assert.equal(rim, 'B6');
    await previewRepair('grid', rim, /1 to fill/);
    await applyRepair();
    assert.equal((await bundle('patch-grid.zip')).meshes.triangles, 32);
    await run('undo-stroke', /Undid/);
    await previewRepair('smooth', rim, /1 to fill/);
    await applyRepair();
    const smoothed = await bundle('patch-smooth.zip');
    assert.ok(smoothed.meshes.triangles > 32);
    await enter('uv');
    await choose('uv-size', '256');
    await run('uv-unwrap', /Generated UVs in the draft/);
    await choose('uv-mode-select', 'projection');
    await choose('uv-source', 'original');
    await fill('uv-projection-pairs', '');
    await fill('uv-projection-distance', '.3');
    await run('uv-apply', /UVs and 1 maps applied from Original import .* 0 occupied texels/);
    const projected = await bundle('patch-projected.zip');
    assert.equal(projected.meshes.triangles, smoothed.meshes.triangles);
    assert.equal(projected.stage, 'E08');
    assert.equal(projected.transfers[0].projection.misses, 0);
    await download('save-project', 'patch-projected.assetfixer');
    await open(join(dir, 'patch-projected.assetfixer'), /Project restored/);
    assert.equal((await bundle('patch-restored.zip')).meshes.triangles, smoothed.meshes.triangles);
    report.fbx = { gridTriangles: 32, smoothTriangles: smoothed.meshes.triangles, projectionMisses: 0, reopened: true };
  }

  if (scope === 'all' || scope === 'projection') {
    await open(join(dir, 'projection.glb'), /6 triangles/);
    await select('object-selection', 'Changed target');
    await enter('uv');
    await choose('uv-size', '256');
    await choose('uv-mode-select', 'projection');
    await select('uv-projection-object', 'Source surfaces');
    await choose('uv-source', 'working');
    assert.match(await text('uv-projection-components'), /Source components 1 .*, 2 /);
    await fill('uv-projection-pairs', '');
    const revision = await text('project-status');
    await run('uv-apply', /Assign each target component/);
    assert.equal(await text('project-status'), revision);
    await fill('uv-projection-pairs', '1=1');
    await fill('uv-projection-distance', '.1');
    await page.evaluate(() => { document.querySelector('#uv-apply').click(); document.querySelector('#cancel-job').click(); });
    await ready();
    await status(/cancelled/);
    assert.equal(await text('project-status'), revision);
    await run('uv-apply', /UVs and 2 maps .* 0 occupied texels/);
    const projected = await download('export', 'projection-red.glb');
    await download('save-project', 'projection.assetfixer');
    await open(join(dir, 'projection.assetfixer'), /Project restored/);
    assert.deepEqual(await download('export', 'projection-restored.glb'), projected);
    await select('object-selection', 'Changed target');
    await enter('uv');
    await select('uv-projection-object', 'Source surfaces');
    await fill('uv-projection-pairs', '1=1');
    await fill('uv-projection-distance', '.01');
    await run('uv-apply', /[1-9]\d* occupied texels/);
    await download('export', 'projection-miss.glb');
    await choose('uv-projection-fallback', 'color');
    await fill('uv-projection-color', '#ee1188');
    await run('uv-apply', /[1-9]\d* occupied texels/);
    await download('export', 'projection-filled.glb');
    await fill('uv-projection-distance', '.1');
    await choose('uv-projection-direction', 'forward');
    await choose('uv-projection-fallback', 'nearest');
    await run('uv-apply', /0 occupied texels/);
    assert.match(await text('uv-info'), /[1-9]\d* texels used the nearest/);
    await download('export', 'projection-nearest.glb');
    await download('save-project', 'projection-nearest.assetfixer');
    report.projection = { refusedImplicitMatch: true, cancelledUnchanged: true, restoredExportIdentical: true, nearest: true };
  }
  if (scope === 'tripo') {
    const reference = unzipSync(await readFile(resolve('test-results/e00/exports/ceramic_plate_3d_model_e00_smooth.zip')));
    const repair = JSON.parse(strFromU8(reference['manifest.json'])).repair;
    await open(join(tripo, 'ceramic plate 3d model.zip'), /9\s?138 triangles/);
    await choose('object-selection', { index: 1 });
    await enter('mesh');
    await choose('mesh-kind', 'face');
    await choose('mesh-operation', 'delete');
    await fill('mesh-ids', repair.removed.map(face => face.face).join(','));
    await click('mesh-preview');
    await run('mesh-apply', /applied/);
    await enter('repair');
    const rim = `B${Math.min(...repair.boundary)}`;
    assert.ok((await contours()).includes(rim));
    await choose('repair-method', 'grid');
    await fill('repair-grid-corners', repair.boundary.filter((_, i) => i % 2 === 1).join(','));
    await previewRepair('grid', rim, /1 to fill/);
    await applyRepair();
    assert.equal((await bundle('tripo-grid.zip')).meshes.triangles, 9138);
    await run('undo-stroke', /Undid/);
    await previewRepair('smooth', rim, /1 to fill/);
    await applyRepair();
    report.tripo = { gridTriangles: 9138, smoothTriangles: (await bundle('tripo-smooth.zip')).meshes.triangles };
  }
  if (scope === 'skin') {
    await open(resolve('test-results/e05/skinned-bottle.zip'), /2 bones/);
    await choose('object-selection', { index: 1 });
    await enter('repair');
    await previewRepair('smooth', 'B12', /1 to fill/);
    await applyRepair();
    const { meshes } = await bundle('skinned-smooth.zip');
    assert.equal(meshes.bones, 2);
    assert.equal(meshes.clips, 1);
    report.skin = meshes;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(join(dir, `browser-${scope}.json`), JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
