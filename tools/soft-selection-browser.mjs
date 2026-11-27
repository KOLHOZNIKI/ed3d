import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/soft-selection');
await mkdir(output, { recursive: true });
const app = await preview({ preview: { host: '127.0.0.1', port: 0 } });
const url = `http://127.0.0.1:${app.httpServer.address().port}/`;
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
  const externalRequests = [];
  await context.route(/^https?:/, route => {
    if (route.request().url().startsWith(url)) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const click = id => field(id).click();
  const fill = async (id, value) => { await field(id).fill(String(value)); await field(id).press('Tab'); };
  const choose = (id, value) => field(id).selectOption(value);
  const open = async (source, expected) => {
    await field('sources').setInputFiles(resolve(source));
    await ready();
    assert.match(await field('status').textContent(), expected);
  };
  const start = async () => {
    await choose('object-selection', { index: 1 });
    await click('mesh-mode');
    await choose('mesh-kind', 'vertex');
    await fill('mesh-ids', 0);
    await choose('mesh-operation', 'move');
  };
  const checkPreview = async expected => {
    await click('mesh-preview');
    assert.match(await field('mesh-info').textContent(), expected);
  };
  const download = async (button, name) => {
    const path = join(output, name);
    const [file] = await Promise.all([page.waitForEvent('download'), click(button)]);
    await file.saveAs(path);
    await ready();
    return unzipSync(await readFile(path));
  };
  const fbx = files => files[Object.keys(files).find(path => path.endsWith('.fbx'))];
  const staticFixture = 'tools/e00/fixtures/topology_seams.zip', skinFixture = 'test-results/e03/paint_elbow.zip';
  const report = {};

  for (const [label, fixture, status, radius] of [
    ['static', staticFixture, /13 triangles/, 1.5], ['skinned', skinFixture, /2 bones · 1 clips/, 1.25],
  ]) {
    await open(fixture, status);
    await start();
    await field('mesh-soft').check();
    await choose('mesh-soft-falloff', 'linear');
    await fill('mesh-soft-radius', radius);
    await fill('mesh-y', .03125);
    await checkPreview(/Preview · .* · [1-9]\d* neighboring vertices in radius/);

    if (label === 'static') {
      await field('viewport').screenshot({ path: join(output, 'preview.png') });
      await click('mesh-cancel');
      assert.equal(await field('mesh-apply').isDisabled(), true);
      await fill('mesh-soft-radius', 0);
      await checkPreview(/positive Soft Selection radius/);
      await fill('mesh-soft-radius', radius);
      await checkPreview(/Preview/);
    }
    await click('mesh-apply'); await ready();
    assert.match(await field('status').textContent(), /Move applied/);
    const exported = await download('export', `${label}.zip`);
    await writeFile(join(output, `${label}.fbx`), fbx(exported));
    const manifest = JSON.parse(strFromU8(exported['manifest.json']));
    const original = unzipSync(await readFile(fixture));
    assert.deepEqual(exported[manifest.textures[0].file], original[manifest.textures[0].source]);

    await click('undo-stroke'); await ready();
    const undone = await download('export', `${label}-undone.zip`);
    await writeFile(join(output, `${label}-undone.fbx`), fbx(undone));
    await click('redo'); await ready();
    const saved = await download('save-project', `${label}.assetfixer`);
    const project = JSON.parse(strFromU8(saved['manifest.json']));
    assert.equal(project.schemaVersion, 15);
    assert.deepEqual(project.settings.operations['mesh-soft-falloff'], 'linear');
    assert.equal(project.settings.operations['mesh-soft'], true);
    assert.equal(Number(project.settings.operations['mesh-soft-radius']), radius);
    const [edit] = strFromU8(saved[`blobs/${project.working.meshEdits}`]).trim().split('\n').map(JSON.parse);
    assert.equal(edit.type, 'softTransform');
    assert.deepEqual(edit.soft, { radius, falloff: 'linear' });
    await context.setOffline(true);
    await open(join(output, `${label}.assetfixer`), /Project restored/);
    const reopened = await download('export', `${label}-reopened.zip`);
    await writeFile(join(output, `${label}-reopened.fbx`), fbx(reopened));
    assert.deepEqual(JSON.parse(strFromU8(reopened['manifest.json'])).meshes, manifest.meshes);
    await context.setOffline(false);
    report[label] = { triangles: manifest.meshes.triangles, bones: manifest.meshes.bones, clips: manifest.meshes.clips, offlineReopen: true };
  }

  await start();
  for (const [mode, axis, value, falloff] of [['rotate', 'z', 3, 'smooth'], ['scale', 'x', 1.1, 'sharp']]) {
    await choose('mesh-operation', mode);
    await choose('mesh-soft-falloff', falloff);
    await fill(`mesh-${axis}`, value);
    await checkPreview(/neighboring vertices in radius/);
    await click('mesh-apply'); await ready();
    assert.match(await field('status').textContent(), /applied/);
    await click('undo-stroke'); await ready();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await app.close();
}
