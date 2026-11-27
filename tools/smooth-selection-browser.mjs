import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/smooth-selection');
const regionFaces = [10, 11, 12, 13, 18, 19, 20, 21], regionVertices = [6, 7, 8, 11, 12, 13, 16, 17, 18];
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
  const click = id => field(id).click();
  const choose = (id, value) => field(id).selectOption(value);
  const fill = async (id, value) => { await field(id).fill(String(value)); await field(id).press('Tab'); };
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const open = async (source, expected) => {
    await field('sources').setInputFiles(resolve(source));
    await ready();
    assert.match(await field('status').textContent(), expected);
  };
  const pick = async (kind, ids) => { await choose('mesh-kind', kind); await fill('mesh-ids', ids.join(', ')); };
  const checkPreview = async expected => {
    await click('mesh-preview');
    assert.match(await field('mesh-info').textContent(), expected);
  };
  const apply = async () => { await click('mesh-apply'); await ready(); assert.match(await field('status').textContent(), /Smooth Selection applied/); };
  const download = async (button, name) => {
    const path = join(output, name);
    const [file] = await Promise.all([page.waitForEvent('download'), click(button)]);
    await file.saveAs(path);
    await ready();
    return unzipSync(await readFile(path));
  };
  const fbx = files => files[Object.keys(files).find(path => path.endsWith('.fbx'))];
  const exportFbx = async name => {
    const files = await download('export', `${name}.zip`);
    await writeFile(join(output, `${name}.fbx`), fbx(files));
    return { files, manifest: JSON.parse(strFromU8(files['manifest.json'])) };
  };

  for (const name of ['static', 'skinned']) {
    const source = `test-results/e03/smooth_selection_${name}.zip`;
    const original = unzipSync(await readFile(source));
    await writeFile(join(output, `${name}-original.fbx`), fbx(original));
    await open(source, /32 triangles/);
    await choose('object-selection', { index: 1 });
    await click('mesh-mode');
    await choose('mesh-operation', 'smoothSelection');
    assert.equal(await field('mesh-smooth-boundary').isChecked(), true);
    await fill('mesh-smooth-iterations', 2);
    if (name === 'static') {
      await pick('face', [10]);
      await checkPreview(/no movable interior vertices/);
      assert.equal(await field('mesh-apply').isDisabled(), true);
      await pick('face', Array.from({ length: 32 }, (_, i) => i));
      await checkPreview(/16 pinned boundary vertices/);
      await pick('vertex', regionVertices);
      await checkPreview(/1 moved · 8 pinned boundary vertices/);
      await pick('edge', ['6/7']);
      await checkPreview(/no movable interior vertices/);
      await pick('face', regionFaces);
      await fill('mesh-smooth-strength', 0);
      await checkPreview(/strength greater than 0/);
      await fill('mesh-smooth-strength', .5);
    } else await pick('face', regionFaces);
    await checkPreview(/1 moved · 8 pinned boundary vertices/);
    await click('mesh-cancel');
    assert.equal(await field('undo-stroke').isDisabled(), true);
    await checkPreview(/1 moved · 8 pinned boundary vertices/);
    await apply();
    const { files, manifest } = await exportFbx(name);
    assert.equal(manifest.meshes.triangles, 32);
    assert.deepEqual(files[manifest.textures[0].file], original[manifest.textures[0].source]);
    assert.equal(manifest.meshes.bones, name === 'static' ? 0 : 2);
    assert.equal(manifest.meshes.clips, name === 'static' ? 0 : 1);

    await click('undo-stroke'); await ready();
    await exportFbx(`${name}-undo`);
    await click('redo'); await ready();
    const saved = await download('save-project', `${name}.assetfixer`);
    const project = JSON.parse(strFromU8(saved['manifest.json']));
    assert.equal(project.schemaVersion, 16);
    assert.equal(project.settings.operations['mesh-smooth-iterations'], '2');
    assert.deepEqual(JSON.parse(strFromU8(saved[`blobs/${project.working.meshEdits}`]).trim()), {
      type: 'smoothSelection', object: 'object-0', settings: { strength: .5, iterations: 2, fixBoundary: true }, faces: regionFaces,
    });
    await context.setOffline(true);
    await open(join(output, `${name}.assetfixer`), /Project restored/);
    assert.equal(await field('mesh-smooth-iterations').inputValue(), '2');
    await exportFbx(`${name}-reopened`);
    await context.setOffline(false);
  }

  await open('test-results/e03/smooth_selection_static.zip', /32 triangles/);
  await choose('object-selection', { index: 1 });
  await click('mesh-mode');
  await choose('mesh-operation', 'smoothSelection');
  await pick('face', regionFaces);
  await field('mesh-smooth-boundary').uncheck();
  await checkPreview(/[2-9] moved · 0 pinned boundary vertices/);
  await apply();
  await exportFbx('static-unpinned');
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log('Smooth Selection passed for a fixed face region, an open rim, vertex and edge selections, Undo and offline replay.');
} finally {
  await browser?.close();
  await app.close();
}
