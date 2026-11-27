import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decode } from 'fast-png';
import { unzipSync } from 'fflate';
import { createServer } from 'vite';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const dir = resolve('test-results/e00/f15');
const sourceFile = resolve('tools/e00/fixtures/f15_source.zip');
const targetFile = resolve('tools/e00/fixtures/f15_target.zip');
await mkdir(dir, { recursive: true });
const app = await createServer({ server: { host: '127.0.0.1', port: 4282 }, optimizeDeps: { include: ['xatlas-wasm'] } });
let chrome;
try {
  await app.listen();
  chrome = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await chrome.newPage(), errors = [], external = [];
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') external.push(url.href);
  });
  await page.goto(`http://127.0.0.1:${app.httpServer.address().port}`);
  await page.evaluate(() => {
    for (const id of ['source', 'target', 'read']) {
      const file = document.createElement('input');
      file.id = `f15-${id}`;
      file.type = 'file';
      file.hidden = true;
      document.body.append(file);
    }
  });
  await page.locator('#f15-source').setInputFiles(sourceFile);
  await page.locator('#f15-target').setInputFiles(targetFile);

  const probe = await page.evaluateHandle(async () => {
    const { Box3, PerspectiveCamera, Vector3 } = await import('/node_modules/three/build/three.module.js');
    const { importAsset, exportAsset } = await import('/src/e00/round-trip.ts');
    const { unwrapAsset } = await import('/src/e00/uv-atlas.ts');
    const { rebakeAsset, projectBaseColor } = await import('/src/e00/rebake.ts');
    const { paintStroke } = await import('/src/e00/paint.ts');
    const load = id => importAsset([...document.querySelector(`#f15-${id}`).files]);
    const source = await load('source');
    const target = await unwrapAsset(await load('target'));
    const canvas = document.querySelector('#viewport');
    const { width, height } = canvas;
    const bounds = new Box3().setFromObject(source.scene);
    const center = bounds.getCenter(new Vector3()), radius = bounds.getSize(new Vector3()).length() / 2;
    const camera = new PerspectiveCamera(40, width / height, radius / 100, radius * 100);
    camera.position.copy(center).addScaledVector(new Vector3(0.6, 0.45, 1).normalize(), 3.5 * radius);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const points = [-0.12, 0.12].map(y => {
      const p = new Vector3(0.033, y, 0.0078125).project(camera);
      return [(0.5 + p.x / 2) * width, (0.5 - p.y / 2) * height];
    });
    const color = '#20ff39';
    const save = async (asset, name) => {
      const result = await exportAsset(asset);
      const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name ?? result.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return {
      stroke: { points, color, width, height },
      async unrestrictedBrush() {
        const baseline = await rebakeAsset(await unwrapAsset(source));
        const uvAtlas = { ...baseline.uvAtlas, faceComponents: new Uint32Array(baseline.uvAtlas.faceComponents.length) };
        const working = { ...baseline, uvAtlas };
        const texturePaint = await paintStroke(working, camera, width, height, points, color);
        if (!texturePaint) throw new Error('The brush control did not hit the model.');
        await save({ ...working, texturePaint }, 'f15_brush_unrestricted.zip');
      },
      async projection(restricted) {
        const eligible = restricted ? [[0], [1]] : [[0, 1], [0, 1]];
        const working = await projectBaseColor(source, target, eligible, 0.02);
        await save(working, restricted ? undefined : 'f15_projection_unrestricted.zip');
      },
      async read() {
        const asset = await load('read');
        const { geometry } = asset.scene.getObjectByProperty('isMesh', true);
        return { xyz: Array.from(geometry.getAttribute('position').array), uv: Array.from(geometry.getAttribute('uv').array) };
      },
    };
  });

  const sources = page.locator('#sources'), status = page.getByRole('status');
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  await sources.setInputFiles(sourceFile);
  await ready();
  await page.locator('#unwrap').click();
  await ready();
  assert.match(await status.textContent(), /^Generated 2 charts/);
  await page.locator('#rebake').click();
  await ready();
  assert.match(await status.textContent(), /^Rebaked 1 map/);
  const capture = async (action) => {
    const [download] = await Promise.all([page.waitForEvent('download'), action()]);
    const path = join(dir, download.suggestedFilename());
    await download.saveAs(path);
    await ready();
    await page.locator('#f15-read').setInputFiles(path);
    const geometry = await probe.evaluate(api => api.read());
    const files = unzipSync(await readFile(path));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    const tex = manifest.textures.find(texture => texture.semantic === 'BaseColor');
    return { path, geometry, manifest, image: decode(files[tex.file]) };
  };
  const exportModel = () => page.getByRole('button', { name: 'Export FBX ZIP' }).click();
  const baseline = await capture(exportModel);
  const stroke = await probe.evaluate(api => api.stroke);
  await page.locator('#paint').click();
  await page.locator('#paint-color').fill(stroke.color);
  const canvas = page.locator('#viewport');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + stroke.points[0][0] * box.width / stroke.width, box.y + stroke.points[0][1] * box.height / stroke.height);
  await page.mouse.down();
  await page.mouse.move(box.x + stroke.points[1][0] * box.width / stroke.width, box.y + stroke.points[1][1] * box.height / stroke.height, { steps: 45 });
  await page.mouse.up();
  await ready();
  assert.match(await status.textContent(), /^Painted .* Base Color texels/);
  const painted = await capture(exportModel);
  const unrestricted = await capture(() => probe.evaluate(api => api.unrestrictedBrush()));
  assert.deepEqual(painted.geometry, baseline.geometry);
  assert.deepEqual(unrestricted.geometry, baseline.geometry);
  const brush = [painted, unrestricted].map(output => {
    const changed = [0, 0], coverage = [0, 0];
    onAtlas(output, 0.0078125, (pixel, sheet) => {
      coverage[sheet]++;
      if (rgb(output.image, pixel).some((value, i) => value !== rgb(baseline.image, pixel)[i])) changed[sheet]++;
    });
    return { changed, coverage };
  });
  assert.ok(brush[0].changed[0] > 100 && brush[1].changed[1] > 100, JSON.stringify(brush));
  assert.equal(brush[0].changed[1], 0);

  const projected = await capture(() => probe.evaluate(api => api.projection(true)));
  const unrestrictedProjection = await capture(() => probe.evaluate(api => api.projection(false)));
  assert.deepEqual(projected.geometry, unrestrictedProjection.geometry);
  const pixels = unzipSync(await readFile(sourceFile));
  const sourceAtlas = decode(pixels['f15_source.fbm/BaseColor.png']);
  const projection = [projected, unrestrictedProjection].map(output => projectionStats(output, sourceAtlas));
  assert.deepEqual(projected.manifest.textureBake.projection.eligibleSources, [[0], [1]]);
  assert.equal(projected.manifest.textureBake.projection.maxDistance, 0.02);
  assert.equal(projected.manifest.textureBake.projection.misses, projection[0][0].miss + projection[0][1].miss);
  assert.ok(projection[0][0].warm > 100 && projection[0][0].miss > 100 && projection[0][1].cool > 100);
  assert.equal(projection[0][0].cool + projection[0][1].warm + projection[0][1].miss, 0);
  assert.ok(projection[1][0].cool > 100, JSON.stringify(projection));
  for (const sheet of projection[0]) {
    assert.ok(sheet.patternSamples > 100);
    assert.equal(sheet.other + sheet.unexpectedMiss + sheet.incorrectPattern, 0);
  }
  await sources.setInputFiles(projected.path);
  await ready();
  assert.match(await status.textContent(), /^f15_target_e00_baked · 4 triangles/);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const report = { browser: chrome.version(), brush: { restricted: brush[0], unrestricted: brush[1] },
    projection: { restricted: projection[0], unrestricted: projection[1], manifest: projected.manifest.textureBake.projection } };
  await writeFile(join(dir, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await chrome?.close();
  await app.close();
}

function rgb(image, pixel) {
  const offset = pixel * image.channels;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function onAtlas({ geometry: { xyz, uv }, image }, firstZ, visit) {
  const { width, height } = image;
  for (let f = 0; f < uv.length / 6; f++) {
    const i = f * 6, j = f * 9;
    const [u0, v0, u1, v1, u2, v2] = uv.slice(i, i + 6);
    const sheet = Math.abs(xyz[j + 2] - firstZ) < 1e-6 ? 0 : 1;
    const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2) * width));
    const maxX = Math.min(width, Math.ceil(Math.max(u0, u1, u2) * width));
    const minY = Math.max(0, Math.floor((1 - Math.max(v0, v1, v2)) * height));
    const maxY = Math.min(height, Math.ceil((1 - Math.min(v0, v1, v2)) * height));
    const denom = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    for (let y = minY; y < maxY; y++) {
      const v = 1 - (y + 0.5) / height;
      for (let x = minX; x < maxX; x++) {
        const u = (x + 0.5) / width;
        const a = ((v1 - v2) * (u - u2) + (u2 - u1) * (v - v2)) / denom;
        const b = ((v2 - v0) * (u - u2) + (u0 - u2) * (v - v2)) / denom;
        const c = 1 - a - b;
        if (Math.min(a, b, c) <= 1e-7) continue;
        visit(y * width + x, sheet, a * xyz[j] + b * xyz[j + 3] + c * xyz[j + 6],
          a * xyz[j + 1] + b * xyz[j + 4] + c * xyz[j + 7]);
      }
    }
  }
}

function projectionStats(output, source) {
  const counts = [0, 1].map(() => ({ warm: 0, cool: 0, miss: 0, other: 0, unexpectedMiss: 0, patternSamples: 0, incorrectPattern: 0 }));
  onAtlas(output, -0.00390625, (pixel, sheet, x, y) => {
    const sample = rgb(output.image, pixel);
    const [r, g, b] = sample;
    const kind = r === 255 && g === 0 && b === 255 ? 'miss'
      : r >= 198 && b === 24 ? 'warm' : r === 24 && b >= 192 ? 'cool' : 'other';
    const count = counts[sheet];
    count[kind]++;
    const left = sheet === 0 ? -0.484375 : -0.015625, right = sheet === 0 ? 0.0390625 : 0.515625;
    if (Math.abs(x - right) > 1e-6 && (kind === 'miss') !== (x > right)) count.unexpectedMiss++;
    if (x > right || kind === 'miss') return;
    const u = sheet / 2 + 0.03125 + 0.4375 * (x - left) / (right - left);
    const v = 0.03125 + 0.9375 * (y + 0.25) / 0.5;
    const ix = Math.floor(u * source.width - 0.5), iy = Math.floor((1 - v) * source.height - 0.5);
    const p = iy * source.width + ix;
    const expected = rgb(source, p);
    if (![p + 1, p + source.width, p + source.width + 1].every(q => rgb(source, q).every((value, i) => value === expected[i]))) return;
    count.patternSamples++;
    if (sample.some((value, i) => value !== expected[i])) count.incorrectPattern++;
  });
  return counts;
}
