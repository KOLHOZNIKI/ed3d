import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { encode } from 'fast-png';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';
import { glbFixture } from './e00/corpus-glb.mjs';

const [executablePath, tripo = 'D:/downloads/Tripo', scope = 'all'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const dir = resolve('test-results/e06');
await mkdir(dir, { recursive: true });
const fixture = glbFixture();
const pixels = new Uint8Array(32 * 32 * 4);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  pixels.set([x * 8, y * 8, 80, x < 16 ? 96 : 224], (y * 32 + x) * 4);
}
const image = fixture.png('Gradient', encode({ width: 32, height: 32, data: pixels, channels: 4 }));
fixture.doc.materials = [{ name: 'Gradient', alphaMode: 'BLEND', doubleSided: true,
  pbrMetallicRoughness: { baseColorTexture: { index: image }, metallicFactor: 0 } }];
fixture.mesh('Squares', [fixture.primitive({
  positions: [[-1,0,0],[0,0,0],[0,1,0],[-1,1,0],[1,0,0],[2,0,0],[2,1,0],[1,1,0]],
  indices: [0,1,2,0,2,3,4,5,6,4,6,7], uv: [[0,0],[1,0],[1,1],[0,1],[0,0],[1,0],[1,1],[0,1]], material: 0,
})]);
await writeFile(join(dir, 'squares.glb'), fixture.finish());

const server = await preview({ preview: { host: '127.0.0.1', port: 4289 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const errors = [], external = [], report = {};
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1500 } });
  await context.route(/^https?:/, route => {
    if (route.request().url().startsWith(url)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const text = id => field(id).textContent();
  const select = (id, value) => field(id).selectOption(value);
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 180000 });
  const status = async expected => assert.match(await text('status'), expected);
  const run = async (id, expected) => { await click(id); await ready(); await status(expected); };
  const open = async (path, expected) => { await field('sources').setInputFiles(path); await ready(); await status(expected); };
  const enter = async () => { if (await field('uv-tools').isHidden()) await click('uv-mode'); };
  const download = async (id, name) => {
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), click(id)]);
    const path = join(dir, name);
    await file.saveAs(path);
    await ready();
    return readFile(path);
  };
  const bundle = async name => {
    const zip = unzipSync(await download('export', name));
    return { zip, manifest: JSON.parse(strFromU8(zip['manifest.json'])) };
  };
  const map = ({ zip, manifest }) => zip[manifest.textures.find(map => map.semantic === 'BaseColor').file];
  const draft = () => page.waitForFunction(() => /^UV draft/.test(document.querySelector('#uv-info').textContent), null, { timeout: 180000 });
  const move = async (u, v) => {
    await select('uv-operation', 'move');
    await field('uv-u').fill(String(u));
    await field('uv-v').fill(String(v));
    await click('uv-run');
    await draft();
  };

  if (scope === 'all' || scope === 'glb') {
    await open(join(dir, 'squares.glb'), /4 triangles/);
    await enter();
    assert.match(await text('uv-diagnostics'), /2 islands · 0 outside · [1-9]\d* overlapping/);
    await click('uv-select-all');
    await move(0, 0);
    const conflicted = await text('project-status');
    await run('uv-apply', /overlapping triangles/);
    assert.equal(await text('project-status'), conflicted);
    await click('uv-cancel');

    const uv = await field('uv-canvas').boundingBox();
    const scale = 556 * 0.88;
    await page.mouse.click(uv.x + (768 - scale) / 2 / 768 * uv.width, uv.y + (556 - scale) / 2 / 556 * uv.height);
    await move(0.125, 0.0625);
    await select('uv-mode-select', 'mapping');
    await run('uv-apply', /Texture images are unchanged/);
    await download('export', 'squares-moved.glb');

    await select('uv-mode-select', 'preserve');
    await select('uv-size', '256');
    await click('uv-pack');
    await draft();
    assert.match(await text('uv-diagnostics'), /2 islands · 0 outside · 0 overlapping/);
    await run('uv-apply', /UVs and 1 maps applied from Working revision .* 0 occupied texels/);
    assert.match(await text('uv-info'), /Last bake used Working revision/);
    const packed = await download('export', 'squares-packed.glb');
    await download('save-project', 'squares.assetfixer');
    await open(join(dir, 'squares.assetfixer'), /Project restored/);
    const restored = await download('export', 'squares-restored.glb');
    assert.deepEqual(restored, packed);
    await enter();
    await select('uv-source', 'original');
    await click('uv-select-all');
    await move(0, 0);
    await run('uv-apply', /UVs and 1 maps applied from Original import\. 0 occupied texels/);
    await download('export', 'squares-original-source.glb');
    report.glb = { overlapRefused: true, reopenedExportByteIdentical: true, originalSourceAfterUvEdit: true };
  }

  if (scope === 'all' || scope === 'plate') {
    await open(join(tripo, 'ceramic plate 3d model.zip'), /triangles/);
    await run('unwrap', /Generated .* charts/);
    await run('rebake', /Rebaked .* maps/);
    await click('paint');
    await field('paint-size').fill('0.206');
    await field('paint-hardness').fill('100');
    const viewport = await field('viewport').boundingBox();
    const x = value => viewport.x + value / 640 * viewport.width;
    const y = value => viewport.y + value / 480 * viewport.height;
    await page.mouse.move(x(235), y(222));
    await page.mouse.down();
    await page.mouse.move(x(403), y(242), { steps: 32 });
    await page.mouse.up();
    await ready();
    await status(/Painted/);
    const painted = await bundle('plate-painted.zip');
    await enter();
    await select('uv-size', '2048');
    await run('uv-unwrap', /Generated UVs in the draft/);
    await draft();
    const baseline = await text('project-status');
    await page.evaluate(() => {
      document.querySelector('#uv-apply').click();
      document.querySelector('#cancel-job').click();
    });
    await ready();
    await status(/cancelled/);
    assert.equal(await text('project-status'), baseline);
    assert.deepEqual(map(await bundle('plate-cancelled.zip')), map(painted));
    await run('uv-apply', /UVs and \d maps applied from Working revision .* 0 occupied texels/);
    const baked = await bundle('plate-rebaked.zip');
    assert.notDeepEqual(map(baked), map(painted));
    await run('undo-stroke', /Undid/);
    assert.deepEqual(map(await bundle('plate-undo.zip')), map(painted));
    await run('redo', /Redid/);
    assert.deepEqual(map(await bundle('plate-redo.zip')), map(baked));
    await download('save-project', 'plate.assetfixer');
    await open(join(dir, 'plate.assetfixer'), /Project restored/);
    assert.deepEqual(map(await bundle('plate-restored.zip')), map(baked));
    report.plate = { cancelledUnchanged: true, undoRestoredPaint: true, redoRestoredBake: true, reopened: true, bake: baked.manifest.textureBake };
  }

  if (scope === 'all' || scope === 'skin') {
    await open(join(tripo, 'tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip'), /17\s?623 triangles · 67 bones/);
    await enter();
    await select('uv-size', '2048');
    await select('uv-map', 'normalMap');
    await run('uv-unwrap', /Generated UVs in the draft/);
    await draft();
    await run('uv-apply', /UVs and 4 maps applied from Working revision .* 0 occupied texels/);
    const baked = await bundle('skin-rebaked.zip');
    report.skin = { bake: baked.manifest.textureBake };
  }

  if (scope === 'all' || scope === 'normal') {
    await open(resolve('test-results/e00/normal-fixture/directional_normals.zip'), /directional_normals · 4 triangles/);
    await run('unwrap', /Generated 2 charts/);
    await enter();
    await select('uv-channel', '1');
    await select('uv-size', '1024');
    await select('uv-source', 'original');
    await click('uv-select-all');
    await move(0, 0);
    await run('uv-apply', /UVs and 2 maps applied from Original import\. 0 occupied texels/);
    const baked = await bundle('normal-rebaked.zip');
    report.normal = { bake: baked.manifest.textureBake };
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(join(dir, `browser-${scope}.json`), JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
