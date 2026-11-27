import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/flatten-selection');
const region = [6, 7, 8, 11, 12, 13, 16, 17, 18];
const faces = [10, 11, 12, 13, 18, 19, 20, 21];
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
  const apply = async () => { await click('mesh-apply'); await ready(); assert.match(await field('status').textContent(), /Flatten Selection applied/); };
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

  for (const [name, source, mode] of [
    ['custom', 'test-results/e03/smooth_selection_static.zip', 'custom'],
    ['best', 'test-results/e03/flatten_selection_skinned.zip', 'bestFit'],
  ]) {
    const original = unzipSync(await readFile(source));
    await writeFile(join(output, `${name}-original.fbx`), fbx(original));
    await open(source, /32 triangles/);
    await choose('object-selection', { index: 1 });
    await click('mesh-mode');
    await choose('mesh-operation', 'flattenSelection');
    await choose('mesh-flatten-plane', 'bestFit');
    if (name === 'custom') {
      await pick('vertex', [0, 1, 2]);
      await checkPreview(/at least three non-collinear vertices/);
      assert.equal(await field('mesh-apply').isDisabled(), true);
      await pick('face', [0]);
      await choose('mesh-flatten-plane', 'x');
      await checkPreview(/would collapse a triangle/);
      assert.equal(await field('mesh-apply').isDisabled(), true);
      await pick('edge', ['6/7']);
      await choose('mesh-flatten-plane', 'y');
      await fill('mesh-flatten-offset', .25);
      await checkPreview(/2 vertices on the specified plane/);
      await apply();
      await exportFbx('axis');
      await click('undo-stroke'); await ready();

      await pick('face', faces);
      await choose('mesh-flatten-plane', mode);
      await fill('mesh-flatten-ny', 0);
      await checkPreview(/nonzero plane normal/);
      await fill('mesh-flatten-nx', 1);
      await fill('mesh-flatten-ny', 3);
      await fill('mesh-flatten-nz', 1);
      await fill('mesh-flatten-offset', .75);
    } else await pick('vertex', region.slice().reverse());
    const plane = name === 'custom' ? /9 vertices on the specified plane/ : /9 vertices on the best-fit plane/;
    await checkPreview(plane);
    await click('mesh-cancel');
    assert.equal(await field('undo-stroke').isDisabled(), true);
    await checkPreview(plane);
    await apply();
    const { files, manifest } = await exportFbx(name);
    assert.equal(manifest.meshes.triangles, 32);
    assert.deepEqual(files[manifest.textures[0].file], original[manifest.textures[0].source]);
    assert.equal(manifest.meshes.bones, name === 'custom' ? 0 : 2);
    assert.equal(manifest.meshes.clips, name === 'custom' ? 0 : 1);

    await click('undo-stroke'); await ready();
    await exportFbx(`${name}-undo`);
    await click('redo'); await ready();
    const saved = await download('save-project', `${name}.assetfixer`);
    const project = JSON.parse(strFromU8(saved['manifest.json']));
    assert.equal(project.schemaVersion, 17);
    const edit = JSON.parse(strFromU8(saved[`blobs/${project.working.meshEdits}`]).trim());
    assert.equal(edit.type, 'flattenSelection');
    assert.deepEqual(edit.vertices.slice().sort((a, b) => a - b), region);
    assert.deepEqual(edit.plane, name === 'custom' ? { mode: 'specified', normal: [1, 3, 1], offset: .75 } : { mode: 'bestFit' });
    await context.setOffline(true);
    await open(join(output, `${name}.assetfixer`), /Project restored/);
    assert.equal(await field('mesh-flatten-plane').inputValue(), mode);
    if (mode === 'custom') assert.equal(await field('mesh-flatten-offset').inputValue(), '0.75');
    await exportFbx(`${name}-reopened`);
    await context.setOffline(false);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log('Flatten Selection passed for edge, face and vertex selections, validation, Undo and offline replay.');
} finally {
  await browser?.close();
  await app.close();
}
