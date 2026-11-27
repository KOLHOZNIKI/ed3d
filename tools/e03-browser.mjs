import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decode } from 'fast-png';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath, tripo = 'D:/downloads/Tripo'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const directory = resolve('test-results/e03');
const server = await preview({ preview: { host: '127.0.0.1', port: 4286 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const errors = [], outside = [];
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1250 } });
  await context.route(/^https?:/, route => {
    if (route.request().url().startsWith(url)) return route.continue();
    outside.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const click = id => page.locator(`#${id}`).click();
  const set = (id, value) => page.locator(`#${id}`).fill(String(value));
  const select = (id, value) => page.locator(`#${id}`).selectOption(value);
  const match = (id, value) => page.waitForFunction(([key, text]) => document.getElementById(key).textContent.includes(text), [id, value]);
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const open = async (name, status) => {
    await page.locator('#sources').setInputFiles(name);
    await ready();
    const actual = await page.locator('#status').textContent();
    assert.ok(actual.includes(status), `${name}: expected ${status}, got ${actual}`);
  };
  const activate = async () => {
    await click('paint');
    await match('paint-info', 'Drag to paint');
    await set('paint-hardness', 100);
  };
  const front = async () => { await select('projection', { label: 'Orthographic' }); await select('view-direction', { label: 'Front' }); };
  const viewport = page.locator('#viewport');
  const move = async (p, options) => {
    await viewport.scrollIntoViewIfNeeded();
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x + p[0] * box.width, box.y + p[1] * box.height, options);
  };
  const stroke = async (a, b = a) => {
    await move(a);
    await page.mouse.down();
    await move(b, { steps: 12 });
    await page.mouse.up();
    await ready();
  };
  const cursor = () => page.locator('#paint-cursor').evaluate(canvas => {
    const { width, height } = canvas, data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let pixels = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) pixels++;
    return pixels;
  });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const download = async (id, name) => {
    const [file] = await Promise.all([page.waitForEvent('download'), click(id)]);
    const path = join(directory, name);
    await file.saveAs(path);
    await ready();
    return readFile(path);
  };
  const paintImage = async name => decode(color(await download('export', name)));
  const undo = async () => { await click('undo-stroke'); await ready(); };
  const rendered = async point => { await move([point[0] + .005, point[1]]); await move(point); await frame(); return cursor(); };
  const parts = (base, work) => counts(base, work, x => x > 105 ? 2 : x / work.width < .38 ? 0 : 1);

  const folded = join(directory, 'paint_fold.zip');
  const base = decode(color(await readFile(folded)));
  await open(folded, '10 triangles');
  await front();
  await activate();
  assert.equal(await page.locator('#paint-mode').inputValue(), 'surface');
  const beforeOrbit = await viewport.screenshot();
  await move([.50, .5]);
  await page.mouse.down({ button: 'right' });
  await move([.59, .55], { steps: 8 });
  await page.mouse.up({ button: 'right' });
  assert.notDeepEqual(await viewport.screenshot(), beforeOrbit);
  assert.equal(await page.locator('#paint').getAttribute('aria-pressed'), 'true');
  await click('frame-all');
  await set('paint-size', .34);
  const center = [.477, .557];
  const surfaceCursor = await rendered(center);
  assert.ok(surfaceCursor > 100, surfaceCursor);
  await stroke(center, [.477, .60]);
  const surface = parts(base, await paintImage('fold-surface.zip'));
  assert.ok(surface[0] > 100, surface);
  assert.deepEqual(surface.slice(1), [0, 0]);
  await undo();
  assert.deepEqual((await paintImage('fold-undone.zip')).data, base.data);

  await select('paint-mode', 'screen');
  await set('paint-size', 90 * (await viewport.boundingBox()).width / 640);
  const screenCursor = await rendered(center);
  assert.ok(screenCursor > surfaceCursor, [screenCursor, surfaceCursor]);
  await stroke(center, [.477, .60]);
  const screen = parts(base, await paintImage('fold-screen.zip'));
  assert.ok(screen[0] > 100 && screen[1] > 100, screen);
  assert.equal(screen[2], 0);
  await undo();

  await select('paint-mask', 'face');
  await click('paint-select');
  await stroke(center);
  await match('paint-info', '1 selected faces');
  await click('paint-select');
  await stroke([.50, .557], [.52, .60]);
  const face = parts(base, await paintImage('fold-face-mask.zip'));
  assert.ok(face[0] > 100, face);
  assert.deepEqual(face.slice(1), [0, 0]);
  await undo();

  await select('paint-mask', 'island');
  await click('paint-select');
  await stroke(center);
  await match('paint-info', '1 selected islands');
  await click('paint-select');
  await select('paint-mode', 'pixel');
  await set('paint-size', 1);
  await stroke(center);
  const pixel = parts(base, await paintImage('fold-one-texel.zip'));
  assert.deepEqual(pixel, [1, 0, 0]);
  const project = await download('save-project', 'fold.assetfixer');
  assert.ok(project.length);
  await click('close-model');
  await open(join(directory, 'fold.assetfixer'), 'Project restored');
  assert.deepEqual(parts(base, await paintImage('fold-reopened.zip')), pixel);
  await viewport.evaluate(canvas => {
    window.losePreview = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    window.losePreview.loseContext();
  });
  await match('status', 'WebGL context lost');
  assert.deepEqual(parts(base, await paintImage('fold-context-lost.zip')), pixel);
  await page.evaluate(() => { window.losePreview.restoreContext(); delete window.losePreview; });
  await match('status', 'WebGL preview restored');

  await open(join(directory, 'paint_overlap.zip'), '10 triangles');
  await activate();
  await match('paint-info', 'Overlapping UVs detected');

  await open(join(directory, 'paint_elbow.zip'), '1 clips');
  await front();
  await activate();
  await select('paint-mode', 'surface');
  await set('paint-size', .15);
  const bend = [.371, .228];
  assert.equal(await rendered(bend), 0);
  await viewport.screenshot({ path: join(directory, 'elbow-rest.png') });
  await select('paint-clip', '0');
  await set('paint-seconds', .25);
  await page.locator('#paint-seconds').press('Tab');
  const elbowCursor = await rendered(bend);
  await viewport.screenshot({ path: join(directory, 'elbow-bent.png') });
  assert.ok(elbowCursor > 100, JSON.stringify({ elbowCursor, errors }));
  await move(bend);
  await page.mouse.down();
  assert.ok(await page.locator('#paint-seconds').isDisabled());
  const frozen = await viewport.screenshot();
  await frame();
  assert.deepEqual(await viewport.screenshot(), frozen);
  await page.mouse.up();
  await ready();
  await match('status', 'Painted ');
  const elbow = parts(base, await paintImage('elbow-painted.zip'));
  assert.ok(elbow.reduce((a, b) => a + b, 0) > 20, elbow);
  await click('toggle-texture');
  await match('texture-info', 'RGBA8');
  assert.deepEqual(await download('texture-export', 'elbow-editor.png'), color(await readFile(join(directory, 'elbow-painted.zip'))));
  await download('save-project', 'elbow.assetfixer');
  await open(join(directory, 'elbow.assetfixer'), 'Project restored');
  assert.deepEqual(color(await download('export', 'elbow-reopened.zip')), color(await readFile(join(directory, 'elbow-painted.zip'))));

  await open(join(directory, 'paint_no_uv.zip'), '1 clips');
  await click('paint');
  await click('paint-unwrap');
  await ready();
  await match('status', 'Created a blank Base Color');
  await front();
  await set('paint-size', .15);
  await stroke([.50, .4]);
  await match('status', 'Painted ');
  const generated = unzipSync(await download('export', 'no-uv-painted.zip'));
  assert.equal(JSON.parse(strFromU8(generated['manifest.json'])).textureBake.source, 'Generated Base Color');
  await download('save-project', 'no-uv.assetfixer');
  await open(join(directory, 'no-uv.assetfixer'), 'Project restored');
  assert.deepEqual(color(await download('export', 'no-uv-reopened.zip')), color(generated));

  await open(join(tripo, 'man character 3d model.glb'), 'bones');
  await activate();
  await select('paint-mode', 'screen');
  await set('paint-size', 24);
  let point;
  for (const candidate of [[.50, .40], [.5, .5], [.46, .50], [.54, .50], [.5, .35]]) {
    if (await rendered(candidate)) { point = candidate; break; }
  }
  assert.ok(point, 'The Tripo GLB viewport has no pickable Base Color at the probe points.');
  await stroke(point);
  await match('status', 'Painted ');
  if (await page.locator('#texture-panel').isHidden()) await click('toggle-texture');
  await match('texture-info', 'RGBA8');
  await download('texture-export', 'tripo-painted.png');
  await download('export', 'tripo-painted.glb');
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  const report = { chrome: browser.version(), surface, screen, face, pixel, cursor: { surfaceCursor, screenCursor, elbowCursor },
    elbowChanged: elbow.reduce((a, b) => a + b, 0), unchangedAfterReopen: true, unchangedDuringContextLoss: true, outside };
  await writeFile(join(directory, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}

function color(bytes) {
  const files = bytes instanceof Uint8Array ? unzipSync(bytes) : bytes;
  const manifest = files['manifest.json'] && JSON.parse(strFromU8(files['manifest.json']));
  return Buffer.from(files[manifest?.textures.find(entry => entry.semantic === 'BaseColor').file ?? Object.keys(files).find(name => name.endsWith('.png'))]);
}

function counts(before, after, partition) {
  assert.equal(before.width, after.width);
  assert.equal(before.height, after.height);
  const result = [0, 0, 0];
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
    const a = (y * before.width + x) * before.channels, b = (y * after.width + x) * after.channels;
    if (after.channels === 4) assert.equal(after.data[b + 3], before.channels === 4 ? before.data[a + 3] : 255);
    if ([0, 1, 2].some(c => before.data[a + c] !== after.data[b + c])) result[partition(x, y)]++;
  }
  return result;
}
