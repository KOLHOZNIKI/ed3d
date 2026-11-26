import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { preview } from 'vite';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const fixture = resolve('tools/e00/fixtures/meshy-gambit-pawn-lo.glb');
const directory = resolve('test-results/e00/f17');
await mkdir(directory, { recursive: true });
const app = await preview({ preview: { host: '127.0.0.1', port: 4282 } });
const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
let chrome;

try {
  chrome = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await chrome.newContext();
  const page = await context.newPage();
  const outsideRequests = [], offlineRequests = [], errors = [];
  let offline = false;
  page.on('pageerror', error => errors.push(error.message));
  await context.route(/^https?:/, route => {
    const url = route.request().url();
    if (offline) offlineRequests.push(url);
    if (new URL(url).origin !== origin) outsideRequests.push(url);
    return offline || new URL(url).origin !== origin ? route.abort() : route.continue();
  });
  await page.goto(origin);
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

  const report = { chrome: chrome.version(), imported, reimported, offline, outsideRequests, offlineRequests, refusal };
  await writeFile(join(directory, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await chrome?.close();
  await app.close();
}
