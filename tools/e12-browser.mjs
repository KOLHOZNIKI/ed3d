import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decode } from 'fast-png';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath, tripo = 'D:/downloads/Tripo', name = 'chrome'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const out = resolve('test-results/e12', name), fixtures = resolve('tools/e00/fixtures');
await mkdir(out, { recursive: true });
const server = await preview({ preview: { host: '127.0.0.1', port: 4297 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const errors = [], outside = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(strFromU8(bytes));
const bundle = bytes => {
  const entries = unzipSync(bytes), manifest = json(entries['manifest.json']);
  return { entries, manifest, rgb: entries[manifest.textures.find(map => map.semantic === 'BaseColor')?.file] };
};
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1250 } });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => {
    const address = new URL(request.url());
    if (['http:', 'https:'].includes(address.protocol) && !address.href.startsWith(url)) outside.push(address.href);
  });
  await page.addInitScript(() => {
    const SourceWorker = window.Worker;
    window.Worker = class extends SourceWorker {
      postMessage(...args) {
        if (sessionStorage.getItem('test-bake-failure') && /rebake-worker-/.test(this.url)) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { error: 'Injected bake worker failure.' } })));
        } else super.postMessage(...args);
      }
      constructor(url, options) { super(url, options); this.url = String(url); }
    };
  });
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const value = id => field(id).textContent();
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 180000 });
  const status = async pattern => assert.match(await value('status'), pattern);
  const run = async (id, pattern) => { await click(id); await ready(); await status(pattern); };
  const open = async (files, pattern, id = 'sources') => { await field(id).setInputFiles(files); await ready(); await status(pattern); };
  const choose = (id, option) => field(id).selectOption(option);
  const details = async id => {
    if ((await field(id).getAttribute('open')) === null) await field(id).locator(':scope > summary').click();
  };
  const download = async (id, filename) => {
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), click(id)]);
    await file.saveAs(join(out, filename));
    await ready();
    return readFile(join(out, filename));
  };
  const report = {};

  await open(join(fixtures, 'corpus/f16_non_manifold.glb'), /Non-manifold topology/);
  await details('asset-review');
  await run('asset-scan', /Asset scan complete/);
  assert.match(await value('asset-findings'), /more than two incident polygons/);
  await field('asset-findings').getByText('Focus').first().click();
  const initial = await value('project-status');
  const oversized = Buffer.from(await readFile(join(fixtures, 'corpus/identity.zip')));
  const centralEntry = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralEntry > 0);
  oversized.writeUInt32LE(129 * 1024 * 1024, centralEntry + 24);
  await open({ name: 'oversized.zip', mimeType: 'application/zip', buffer: oversized }, /expanded size limit/);
  assert.equal(await value('project-status'), initial);
  report.expansionLimitPreservedProject = true;
  await open(join(fixtures, 'corpus/f16_missing_texture.zip'), /Missing or ambiguous textures/);
  assert.equal(await value('project-status'), initial);
  const fold = join(resolve('test-results/e03'), 'paint_fold.zip');
  const original = await readFile(fold);
  const source = unzipSync(original);
  const map = Object.keys(source).find(path => /\.png$/.test(path));
  assert.ok(map);
  await field('texture-assignment-rows').locator('input[type=file]').first().setInputFiles({
    name: 'recovered.png', mimeType: 'image/png', buffer: Buffer.from(source[map]),
  });
  await run('texture-assignment-retry', /identity.*2 triangles/);
  const rebound = unzipSync(await download('save-project', 'assigned.assetfixer'));
  const archive = json(rebound['manifest.json']);
  assert.equal(archive.schemaVersion, 12);
  assert.equal(archive.textureAssignments.length, 1);
  const texture = archive.originals.find(source => source.name === archive.textureAssignments[0][1]);
  assert.equal(texture.hash, sha(source[map]));
  await open(join(out, 'assigned.assetfixer'), /Project restored/);
  assert.match(await value('asset-summary'), /1 maps/);
  report.manualTextureAssignment = true;

  const loose = join(out, 'loose-source');
  await mkdir(loose, { recursive: true });
  for (const [path, bytes] of Object.entries(source)) if (/\.(fbx|png|jpeg|jpg)$/i.test(path)) {
    const dest = join(loose, path);
    await mkdir(resolve(dest, '..'), { recursive: true });
    await writeFile(dest, bytes);
  }
  await open(loose, /10 triangles/, 'sources-folder');
  const looseArchive = json(unzipSync(await download('save-project', 'folder.assetfixer'))['manifest.json']);
  assert.ok(looseArchive.originals.every(file => file.name.startsWith('loose-source/')));
  await open(join(out, 'folder.assetfixer'), /Project restored/);
  report.folder = true;

  await open(join(fixtures, 'f13_wide_skin_morphs.fbx'), /morph channels detected/);
  await run('export', /cannot preserve the source morph targets/);
  const unchangedMorph = await download('export-original', 'original-morphs.fbx');
  assert.equal(sha(unchangedMorph), sha(await readFile(join(fixtures, 'f13_wide_skin_morphs.fbx'))));
  report.morphRefusal = true;

  await details('offline-panel');
  await click('offline-cache');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null &&
    document.querySelector('#offline-status').textContent.includes('ready'), null, { timeout: 30000 })
    .catch(async error => { throw new Error(await value('offline-status'), { cause: error }); });
  await context.setOffline(true);
  await page.reload();
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  await status(/Select a model/);
  await open(fold, /10 triangles/);
  assert.equal(sha(await download('export-original', 'original.zip')), sha(original));
  await choose('projection', { label: 'Orthographic' });
  await choose('view-direction', { label: 'Front' });
  await click('paint');
  await choose('paint-mode', 'screen');
  await field('paint-size').fill('90');
  await field('paint-hardness').fill('100');
  await field('paint-color').fill('#ff1010');
  const viewport = field('viewport');
  await viewport.scrollIntoViewIfNeeded();
  const bounds = await viewport.boundingBox();
  const x = bounds.x + .477 * bounds.width;
  await page.mouse.move(x, bounds.y + .557 * bounds.height);
  await page.mouse.down();
  await page.mouse.move(x, bounds.y + .60 * bounds.height, { steps: 12 });
  await page.mouse.up();
  await ready();
  await click('paint');
  const painted = bundle(await download('export', 'painted.zip'));
  const base = decode(source[map]), after = decode(painted.rgb);
  assert.notDeepEqual(after.data, base.data);
  const paintedRevision = await value('project-status');

  await click('uv-mode');
  await choose('uv-size', '256');
  await run('uv-unwrap', /Generated UVs in the draft/);
  await choose('uv-mode-select', 'preserve');
  await page.evaluate(() => { document.querySelector('#uv-apply').click(); document.querySelector('#cancel-job').click(); });
  await ready();
  await status(/Operation cancelled/);
  assert.equal(await value('project-status'), paintedRevision);
  await page.evaluate(() => sessionStorage.setItem('test-bake-failure', '1'));
  await run('uv-apply', /Injected bake worker failure/);
  assert.equal(await value('project-status'), paintedRevision);
  await page.evaluate(() => sessionStorage.removeItem('test-bake-failure'));
  await run('uv-apply', /UVs and 1 maps applied from Working revision .* 0 occupied texels/);
  const output = bundle(await download('export', 'static-final.zip'));
  assert.equal(output.manifest.meshes.triangles, 10);
  const final = decode(output.rgb);
  const paintedTexels = pixels => {
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 230 && pixels[i + 1] < 60 && pixels[i + 2] < 60) count++;
    return count;
  };
  assert.ok(paintedTexels(after.data) > paintedTexels(base.data));
  assert.ok(paintedTexels(final.data) > 100, 'The baked map lost the paint.');
  const sidecar = json(output.entries['report.json']);
  assert.deepEqual(sidecar.files.sort(), Object.keys(output.entries).sort());
  assert.equal(sidecar.originals[0].sha256, sha(original));
  assert.match(strFromU8(output.entries['report.txt']), /Pending independent reimport/);
  await download('save-project', 'static.assetfixer');
  await run('close-model', /Model closed/);
  await open(join(out, 'static.assetfixer'), /Project restored/);
  const restored = bundle(await download('export', 'static-reopened.zip'));
  assert.deepEqual(restored.rgb, output.rgb);
  await details('asset-review');
  const standalone = JSON.parse((await download('asset-report-json', 'static-report.json')).toString('utf8'));
  assert.equal(standalone.project.revision, sidecar.project.revision);
  report.static = { offline: true, paintTexels: paintedTexels(after.data), rebakedPaintTexels: paintedTexels(final.data),
    triangles: output.manifest.meshes.triangles, reopen: true, cancelled: true, workerFailurePreservedRevision: true };

  await open(join(tripo, 'ceramic plate 3d model.zip'), /ceramic.*triangles/i);
  const plate = bundle(await download('export', 'tripo-plate.zip'));
  assert.ok(plate.manifest.meshes.triangles > 1000 && plate.rgb.length > 0);
  await open(join(tripo, 'man character 3d model.glb'), /bones/);
  const glb = await download('export', 'tripo-character.glb');
  assert.equal(glb.readUInt32LE(0), 0x46546c67);
  await details('asset-review');
  const glbReport = JSON.parse((await download('asset-report-json', 'tripo-character-report.json')).toString('utf8'));
  assert.equal(glbReport.target.format, 'glb');
  assert.ok(glbReport.scene.bones > 0 && glbReport.scene.maps.length > 0);
  report.tripo = { plateTriangles: plate.manifest.meshes.triangles, characterGlbBytes: glb.length };
  report.browser = browser.version();
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
