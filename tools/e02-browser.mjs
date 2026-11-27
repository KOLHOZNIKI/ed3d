import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decode, encode } from 'fast-png';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const dir = resolve('test-results/e02');
const source = resolve('tools/e00/fixtures/f15_source.zip');
const batch = resolve('tools/e00/fixtures/corpus/f07_shared_atlas.glb');
await mkdir(dir, { recursive: true });
const gradient = join(dir, 'gradient.png');
const rgba = new Uint8Array(64 * 64 * 4);
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
  rgba.set([x * 4, y * 4, 64 + ((x + y) % 16) * 8, x === 7 ? 0 : 255], 4 * (64 * y + x));
}
await writeFile(gradient, encode({ width: 64, height: 64, channels: 4, data: rgba }));
const reference = decode(await readFile(gradient));
const server = await preview({ preview: { host: '127.0.0.1', port: 4285 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
let browser;
const errors = [], offlineRequests = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pixel = (map, x, y) => Array.from(map.data.slice(4 * (y * map.width + x), 4 * (y * map.width + x) + 4));
const rgb = (map, x, y) => pixel(map, x, y).slice(0, 3);
const projectManifest = archive => JSON.parse(strFromU8(archive['manifest.json']));

async function start(offline = false) {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let localOnly = false;
  page.on('request', request => {
    if (localOnly && /^https?:/.test(request.url())) offlineRequests.push(request.url());
  });
  await page.goto(url);
  if (offline) { await context.setOffline(true); localOnly = true; }
  const open = async (filename, expected) => {
    await page.locator('#sources').setInputFiles(filename);
    await ready();
    assert.match(await page.getByRole('status').textContent(), expected);
  };
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const info = expected => page.waitForFunction(text => document.querySelector('#texture-info').textContent.includes(text), expected);
  const note = expected => page.waitForFunction(text => document.querySelector('#texture-status').textContent.includes(text), expected);
  const click = selector => page.locator(selector).click();
  const set = (selector, value) => page.locator(selector).fill(String(value));
  const tool = value => page.locator('#texture-tool').selectOption(value);
  const pickFile = (selector, file) => page.locator(selector).setInputFiles(file);
  const exportFile = async (selector, name) => {
    const [download] = await Promise.all([page.waitForEvent('download'), click(selector)]);
    const path = join(dir, name);
    await download.saveAs(path);
    await ready();
    return readFile(path);
  };
  const png = name => exportFile('#texture-export', name);
  const coords = async (x, y) => {
    const pane = page.locator('#texture-viewport');
    await pane.scrollIntoViewIfNeeded();
    return pane.evaluate((viewport, [x, y]) => {
      const canvas = document.querySelector('#texture-picture');
      const r = canvas.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
      const screen = [r.left + x * r.width / canvas.width, r.top + y * r.height / canvas.height];
      if (screen[0] < bounds.left || screen[0] >= bounds.right || screen[1] < bounds.top || screen[1] >= bounds.bottom) {
        throw new Error('The chosen texel is outside the visible viewport.');
      }
      return screen;
    }, [x, y]);
  };
  const stroke = async (a, b = a, options) => {
    const start = await coords(...a), end = await coords(...b);
    if (options?.alt) await page.keyboard.down('Alt');
    await page.mouse.move(...start);
    await page.mouse.down();
    await page.mouse.move(...end, { steps: options?.steps ?? 1 });
    await page.mouse.up();
    if (options?.alt) await page.keyboard.up('Alt');
    await ready();
  };
  return { page, open, ready, info, note, click, set, tool, stroke, pickFile, exportFile, png };
}

try {
  let work = await start();
  await work.open(source, /4 triangles/);
  await work.click('#toggle-texture');
  await work.info('Base Color');
  const jpeg = join(dir, 'replacement.jpg');
  const dataUrl = await work.page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgb(116, 33, 78)';
    context.fillRect(0, 0, 32, 16);
    return canvas.toDataURL('image/jpeg', 1);
  });
  await writeFile(jpeg, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await work.pickFile('#texture-import', jpeg);
  await work.info('32 × 16');
  const jpegAsPng = decode(await work.png('jpeg-as-png.png'));
  assert.deepEqual([jpegAsPng.width, jpegAsPng.height], [32,16]);
  const excessive = join(dir, 'oversize.png'), invalid = Buffer.from(await readFile(gradient));
  invalid.writeUInt32BE(4097, 16);
  await writeFile(excessive, invalid);
  await work.pickFile('#texture-import', excessive);
  await work.note('images up to 4096 × 4096');
  await work.pickFile('#texture-import', gradient);
  await work.note('Replace Base Color committed');
  await work.info('64 × 64');
  await work.click('#texture-unlit');
  await work.click('#texture-actual');
  await work.tool('eyedropper');
  await work.stroke([7.5, 25.5]);
  await work.note('Sampled RGBA 28, 100, 64, 0 at 7, 25');
  const screenshotBefore = await work.page.locator('#viewport').screenshot();
  await work.tool('brush');
  await work.set('#texture-color', '#ff2200');
  await work.set('#texture-size', 5);
  await work.set('#texture-hardness', 100);
  await work.stroke([7.5, 25.5], [25.5, 25.5]);
  await work.note('2D Brush committed');
  const brushBytes = await work.png('brush.png');
  const brush = decode(brushBytes);
  for (let x = 7; x <= 25; x++) assert.deepEqual(pixel(brush, x, 25), [255, 34, 0, x === 7 ? 0 : 255]);
  assert.deepEqual(pixel(brush, 11, 15), pixel(reference, 11, 15));
  const screenshotAfter = await work.page.locator('#viewport').screenshot();
  assert.notEqual(hash(screenshotAfter), hash(screenshotBefore));
  await writeFile(join(dir, 'preview-after.png'), screenshotAfter);
  await work.click('#texture-uv');
  assert.deepEqual(await work.png('overlay-off.png'), brushBytes);
  await work.click('#texture-uv');

  await work.set('#texture-opacity', 50);
  await work.set('#texture-color', '#ffffff');
  await work.set('#texture-size', 1);
  await work.stroke([10.5, 17.5], [28.5, 17.5]);
  const sparseEvents = await work.png('opacity-sparse.png');
  const decodeSrgb = value => value <= 10 ? value / 255 / 12.92 : ((value / 255 + .055) / 1.055) ** 2.4;
  const blendWithWhite = value => Math.round(255 * (1.055 * ((1 + decodeSrgb(value)) * .5) ** (1 / 2.4) - .055));
  assert.deepEqual(rgb(decode(sparseEvents), 17, 17), rgb(brush, 17, 17).map(blendWithWhite));
  await work.click('#undo-stroke');
  await work.ready();
  await work.stroke([10.5, 17.5], [28.5, 17.5], { steps: 24 });
  assert.deepEqual(await work.png('opacity-dense.png'), sparseEvents);
  await work.click('#undo-stroke');
  await work.ready();
  await work.set('#texture-opacity', 100);

  await work.tool('stamp');
  await work.set('#texture-size', 1);
  await work.stroke([10.5, 31.5], [10.5, 31.5], { alt: true });
  await work.stroke([12.5, 31.5], [30.5, 31.5], { steps: 18 });
  await work.note('Clone Stamp committed');
  const aligned = decode(await work.png('aligned.png'));
  for (let x = 12; x <= 30; x++) assert.deepEqual(rgb(aligned, x, 31), rgb(brush, x - 2, 31));
  await work.stroke([35.5, 31.5]);
  const retained = decode(await work.png('aligned-second.png'));
  assert.deepEqual(rgb(retained, 35, 31), rgb(aligned, 33, 31));
  await work.page.locator('#texture-stamp').selectOption('Fixed');
  await work.stroke([38.5, 31.5]);
  const fixed = decode(await work.png('fixed.png'));
  assert.deepEqual(rgb(fixed, 38, 31), rgb(retained, 10, 31));

  await work.tool('pixel');
  await work.set('#texture-size', 6);
  await work.set('#texture-color', '#00ff97');
  await work.click('#texture-out');
  assert.equal(await work.page.locator('#texture-zoom').textContent(), '50%');
  await work.stroke([32, 32]);
  const small = await work.png('pixel-50.png');
  const colored = decode(small);
  let changes = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const within = x >= 29 && x < 35 && y >= 29 && y < 35;
    if (within) {
      assert.deepEqual(rgb(colored, x, y), [0,255,151]);
      changes++;
    } else assert.deepEqual(pixel(colored, x, y), pixel(fixed, x, y));
  }
  assert.equal(changes, 36);
  await work.click('#undo-stroke');
  await work.ready();
  for (let i = 0; i < 3; i++) await work.click('#texture-in');
  assert.equal(await work.page.locator('#texture-zoom').textContent(), '400%');
  await work.stroke([32, 32]);
  assert.deepEqual(await work.png('pixel-400.png'), small);

  await work.click('#texture-actual');
  await work.tool('select');
  await work.stroke([4.5, 4.5], [8.5, 8.5]);
  await work.set('#texture-color', '#3500f0');
  await work.click('#texture-fill');
  await work.note('Fill texture selection committed');
  const filled = decode(await work.png('filled.png'));
  assert.deepEqual(pixel(filled, 7, 4), [53, 0, 240, 0]);
  assert.deepEqual(pixel(filled, 3, 4), pixel(colored, 3, 4));
  await work.click('#texture-clear');
  await work.tool('pixel');
  await work.set('#texture-size', 1);
  await work.click('#texture-alpha');
  await work.set('#texture-alpha-value', 128);
  await work.stroke([7.5, 4.5]);
  const alpha = await work.png('alpha.png');
  assert.deepEqual(pixel(decode(alpha), 7, 4), [53, 0, 240, 128]);
  await work.click('#texture-alpha');
  const rawFbx = unzipSync(await work.exportFile('#export', 'raw-edited.zip'));
  const rawManifest = projectManifest(rawFbx);
  assert.deepEqual(Buffer.from(rawFbx[rawManifest.textures[0].file]), alpha);

  await work.click('#unwrap');
  await work.ready();
  await work.click('#rebake');
  await work.ready();
  await work.info('Baked atlas');
  const baked = await work.png('atlas-base.png');
  await work.click('#texture-fit');
  await work.set('#texture-color', '#3624ff');
  await work.set('#texture-size', 40);
  const bakedInfo = decode(baked);
  await work.stroke([bakedInfo.width * .2, bakedInfo.height * .27]);
  const before3d = await work.png('atlas-2d.png');
  assert.notEqual(hash(before3d), hash(baked));
  await work.click('#paint');
  const view = work.page.locator('#viewport');
  await view.scrollIntoViewIfNeeded();
  const box = await view.boundingBox();
  await work.page.mouse.move(box.x + box.width * .49, box.y + box.height * .48);
  await work.page.mouse.down();
  await work.page.mouse.move(box.x + box.width * .49, box.y + box.height * .55, { steps: 12 });
  await work.page.mouse.up();
  await work.ready();
  assert.match(await work.page.getByRole('status').textContent(), /Painted .* Base Color texels/);
  const combined = await work.png('atlas-2d-and-3d.png');
  assert.notEqual(hash(combined), hash(before3d));
  await work.click('#undo-stroke');
  await work.ready();
  assert.deepEqual(await work.png('undo-3d.png'), before3d);
  await work.click('#undo-stroke');
  await work.ready();
  assert.deepEqual(await work.png('undo-2d.png'), baked);
  await work.click('#redo');
  await work.ready();
  await work.click('#redo');
  await work.ready();
  assert.deepEqual(await work.png('redo-both.png'), combined);
  const output = unzipSync(await work.exportFile('#export', 'combined-fbx.zip'));
  const restoredMap = projectManifest(output).textures[0].file;
  assert.deepEqual(Buffer.from(output[restoredMap]), combined);
  const savedBytes = await work.exportFile('#save-project', 'mixed.assetfixer');
  const saved = unzipSync(savedBytes), manifest = projectManifest(saved);
  const originalHash = hash(await readFile(source));
  assert.equal(manifest.originals[0].hash, originalHash);
  assert.equal(hash(saved[`blobs/${originalHash}`]), originalHash);
  assert.equal(manifest.schemaVersion, 4);
  await browser.close();

  work = await start(true);
  await work.open(join(dir, 'mixed.assetfixer'), /Project restored/);
  await work.click('#toggle-texture');
  await work.info('Baked atlas');
  assert.deepEqual(await work.png('restored.png'), combined);
  await work.open(batch, /8 triangles/);
  if (!(await work.page.locator('#texture-panel').isVisible())) await work.click('#toggle-texture');
  await work.info('Shared by 3 bindings');
  assert.ok(await work.page.locator('#texture-import').isDisabled());
  await work.click('#texture-copy');
  await work.note('Copy Base Color binding committed');
  await work.info('64 × 64');
  await work.click('#texture-actual');
  await work.tool('pixel');
  await work.set('#texture-size', 7);
  await work.set('#texture-color', '#ff00ef');
  await work.stroke([10.5, 16.5]);
  await work.note('Pixel Brush committed');
  const separate = await work.png('glb-copy.png');
  const glb = await work.exportFile('#export', 'glb-with-copy.glb');
  const glbJson = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  assert.equal(glbJson.images.length, 2);
  const embedded = glbJson.images.map(image => {
    const view = glbJson.bufferViews[image.bufferView], start = 28 + glb.readUInt32LE(12) + (view.byteOffset ?? 0);
    return hash(glb.subarray(start, start + view.byteLength));
  });
  assert.ok(embedded.includes(hash(separate)));
  assert.ok(embedded.includes('602a3d304d7080c1217c4f456e917fddc391326f04a2466f64555f65061b2272'));
  await work.click('#undo-stroke');
  await work.ready();
  await work.click('#undo-stroke');
  await work.ready();
  await work.info('Shared by 3 bindings');
  await work.click('#texture-edit-shared');
  await work.click('#texture-focus');
  await work.click('#texture-fit');
  await work.click('#texture-actual');
  await work.stroke([10.5, 16.5]);
  await work.note('Pixel Brush committed');
  const shared = await work.exportFile('#export', 'glb-shared-edit.glb');
  const sharedJson = JSON.parse(shared.subarray(20, 20 + shared.readUInt32LE(12)).toString());
  assert.equal(sharedJson.images.length, 1);
  const sharedView = sharedJson.bufferViews[sharedJson.images[0].bufferView];
  const sharedOffset = 28 + shared.readUInt32LE(12) + (sharedView.byteOffset ?? 0);
  assert.equal(hash(shared.subarray(sharedOffset, sharedOffset + sharedView.byteLength)), hash(separate));
  await work.exportFile('#save-project', 'shared-edit.assetfixer');
  await work.open(resolve('tools/e00/fixtures/meshy-gambit-pawn-lo.glb'), /28[\s,]*069 triangles/);
  await work.click('#toggle-texture');
  await work.info('1024 × 1024');
  await work.tool('pixel');
  await work.set('#texture-size', 11);
  await work.stroke([512.5, 512.5]);
  await work.note('Pixel Brush committed');
  await work.png('meshy-base-color.png');
  const meshy = await work.exportFile('#export', 'meshy-webp-edit.glb');
  const meshyJson = JSON.parse(meshy.subarray(20, 20 + meshy.readUInt32LE(12)).toString());
  assert.deepEqual(meshyJson.images.map(image => image.mimeType).sort(), ['image/png', 'image/webp', 'image/webp']);
  assert.deepEqual(errors, []);
  assert.deepEqual(offlineRequests, []);
  const report = { chrome: browser.version(), brush: hash(brushBytes), stampOverlap: 19, exactPixelZoomTexels: changes, combined: hash(combined), originalHash,
    atlas: [bakedInfo.width, bakedInfo.height], copiedGlbImages: embedded, equalOpacityAcrossEventCounts: true, offlineRequests };
  await writeFile(join(dir, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
