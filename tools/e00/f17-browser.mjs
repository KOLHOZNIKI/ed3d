import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer, preview } from 'vite';

const { values, positionals: [executablePath] } = parseArgs({ allowPositionals: true, options: { edited: { type: 'boolean' } } });
const edit = values.edited ? JSON.parse(await readFile(new URL('./f17-position-edit.json', import.meta.url), 'utf8')) : undefined;
const { chromium } = await import('../../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const fixture = resolve('tools/e00/fixtures/meshy-gambit-pawn-lo.glb');
const directory = resolve('test-results/e00/f17');
await mkdir(directory, { recursive: true });
const address = { host: '127.0.0.1', port: 4282 };
const app = edit ? await createServer({ server: { ...address, hmr: false, ws: false }, optimizeDeps: { include: ['xatlas-wasm'] } })
  : await preview({ preview: address });
let chrome;

try {
  if (edit) await app.listen();
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  chrome = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await chrome.newContext();
  const page = await context.newPage();
  const outsideRequests = [], offlineRequests = [], websockets = [], errors = [];
  // Load the same app entry without Vite injecting its development WebSocket client.
  const editPage = edit && await readFile('index.html', 'utf8');
  let offline = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => websockets.push(socket.url()));
  await context.route(/^https?:/, route => {
    const url = route.request().url();
    if (offline) offlineRequests.push(url);
    const outside = new URL(url).origin !== origin;
    if (outside) outsideRequests.push(url);
    if (offline || outside) return route.abort();
    if (editPage && url === `${origin}/`) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: editPage });
    return route.continue();
  });
  await page.goto(origin);
  const editExport = edit && await preloadPositionEdit(page);
  await context.setOffline(true);
  offline = true;
  assert.equal(await page.evaluate(() => navigator.onLine), false);

  const input = page.locator('#sources'), status = page.getByRole('status');
  const button = page.getByRole('button', { name: 'Export GLB' });
  const open = async (file) => {
    await input.setInputFiles(file);
    await page.waitForFunction(() => !document.querySelector('#sources').disabled);
    return status.textContent();
  };
  const checkModel = async (path) => {
    const message = await open(path);
    const [name, triangles, bones, clips] = message.split(' · ');
    assert.equal(name, basename(path, '.glb'));
    assert.equal(Number(triangles.replace(/\D/g, '')), 28069);
    assert.equal(bones, '0 bones');
    assert.equal(clips, '0 clips');
    assert.ok(await page.locator('#viewport').isVisible());
    return message;
  };
  const imported = await checkModel(fixture);
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  assert.equal(download.suggestedFilename(), 'meshy-gambit-pawn-lo_e00.glb');
  const exported = join(directory, download.suggestedFilename());
  await download.saveAs(exported);
  const reimported = await checkModel(exported);
  let editedReimport;
  if (editExport) {
    await page.locator('#f17-edit-source').setInputFiles(fixture);
    const [editedDownload] = await Promise.all([page.waitForEvent('download'), editExport.evaluate((run, input) => run(input), edit)]);
    assert.equal(editedDownload.suggestedFilename(), 'meshy-gambit-pawn-lo_e00_edited.glb');
    const editedFile = join(directory, editedDownload.suggestedFilename());
    await editedDownload.saveAs(editedFile);
    editedReimport = await checkModel(editedFile);
  }

  // Change only the offset of the first compressed stream.
  const bytes = await readFile(fixture);
  const jsonSize = bytes.readUInt32LE(12);
  const text = bytes.subarray(20, 20 + jsonSize).toString('utf8');
  const invalid = text.replace(/("EXT_meshopt_compression"\s*:\s*\{[^{}]*?"byteOffset"\s*:\s*)(\d+)/,
    (_, prefix, digits) => prefix + '9'.repeat(digits.length));
  assert.notEqual(invalid, text);
  assert.equal(Buffer.byteLength(invalid), jsonSize);
  bytes.write(invalid, 20, jsonSize, 'utf8');
  const refusal = await open({ name: 'invalid-meshopt.glb', mimeType: 'model/gltf-binary', buffer: bytes });
  assert.equal(refusal, 'Invalid GLB Meshopt buffer view.');
  assert.ok(await button.isEnabled());
  assert.deepEqual(errors, []);
  assert.deepEqual(outsideRequests, []);
  assert.deepEqual(offlineRequests, []);
  assert.deepEqual(websockets, []);

  const report = { chrome: chrome.version(), imported, reimported, edit, editedReimport, offline, outsideRequests, offlineRequests,
    websockets, refusal };
  await writeFile(join(directory, edit ? 'browser-edited-report.json' : 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await chrome?.close();
  await app.close();
}

async function preloadPositionEdit(page) {
  return page.evaluateHandle(async () => {
    const { importGlb, exportGlb } = await import('/src/e00/glb-round-trip.ts');
    const input = document.createElement('input');
    input.id = 'f17-edit-source';
    input.type = 'file';
    input.hidden = true;
    document.body.append(input);
    return async ({ vertex, deltaYSteps }) => {
      const asset = await importGlb(input.files[0]);
      const mesh = asset.scene.getObjectByProperty('isMesh', true);
      const positions = mesh?.geometry.getAttribute('position');
      if (asset.stats.meshes !== 1 || positions?.itemSize !== 3 || !positions.normalized ||
          !(positions.array instanceof Int16Array) || !Number.isInteger(vertex) || vertex < 0 || vertex >= positions.count ||
          !Number.isInteger(deltaYSteps) || !deltaYSteps) throw new Error('Expected one valid quantized position edit.');
      const y = Math.round(positions.getY(vertex) * 32767);
      const moved = y + deltaYSteps;
      if (moved < -32767 || moved > 32767) throw new Error('The edit would exceed the signed normalized range.');
      positions.setY(vertex, moved / 32767);
      const { name, bytes } = await exportGlb(asset);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name.replace(/\.glb$/, '_edited.glb');
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  });
}
