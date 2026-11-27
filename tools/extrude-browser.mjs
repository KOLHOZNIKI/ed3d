import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/extrude'), build = resolve('dist');
const source = resolve('test-results/e03/extrude_source.zip'), original = unzipSync(await readFile(source));
const fileOf = (files, extension) => files[Object.keys(files).find(path => path.endsWith(extension))];
await mkdir(output, { recursive: true });
await writeFile(join(output, 'source.fbx'), fileOf(original, '.fbx'));

let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
  const url = 'http://localhost/', errors = [], external = [];
  await context.route(/^https?:/, route => {
    const request = route.request().url();
    if (request.startsWith(url)) return route.fulfill({ path: join(build, new URL(request).pathname.slice(1) || 'index.html') });
    external.push(request);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const choose = (id, value) => field(id).selectOption(value);
  const read = id => field(id).textContent();
  const fill = async (id, value) => { await field(id).fill(String(value)); await field(id).press('Tab'); };
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const open = async (path, message) => {
    await field('sources').setInputFiles(path);
    await ready();
    assert.match(await read('status'), message);
  };
  const enter = async kind => {
    await choose('object-selection', { index: 1 });
    await click('mesh-mode');
    await choose('mesh-kind', kind);
    await choose('mesh-operation', 'extrude');
  };
  const preview = async expected => { await click('mesh-preview'); assert.match(await read('mesh-info'), expected); };
  const act = async (id, expected) => { await click(id); await ready(); assert.match(await read('status'), expected); };
  const download = async (button, name) => {
    const path = join(output, name);
    const [event] = await Promise.all([page.waitForEvent('download'), click(button)]);
    await event.saveAs(path);
    await ready();
    return unzipSync(await readFile(path));
  };
  const exportFbx = async (name, triangles) => {
    const files = await download('export', `${name}.zip`);
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    assert.equal(manifest.meshes.triangles, triangles);
    assert.deepEqual(fileOf(files, '.png'), fileOf(original, '.png'));
    await writeFile(join(output, `${name}.fbx`), fileOf(files, '.fbx'));
  };

  for (const [mode, kind, ids, direction, depth, walls, triangles] of [
    ['edge', 'edge', '0/1, 1/2', 'z', -.25, 2, 36], ['region', 'face', '10, 11', 'normal', .125, 4, 40],
  ]) {
    await open(source, /32 triangles/);
    await enter(kind);
    if (mode === 'edge') {
      await fill('mesh-ids', '6/7');
      await preview(/requires open boundary edges/);
      assert.equal(await field('mesh-apply').isDisabled(), true);
    }
    await fill('mesh-ids', ids);
    await choose('mesh-extrude-direction', direction);
    await fill('mesh-extrude-depth', 0);
    await preview(/finite, nonzero depth/);
    await fill('mesh-extrude-depth', depth);
    const expected = new RegExp(`${walls} side faces with projected UVs`);
    await preview(expected);
    await click('mesh-cancel');
    assert.equal(await field('undo-stroke').isDisabled(), true);
    await preview(expected);
    await act('mesh-apply', /Extrude applied/);
    if (mode === 'edge') assert.match(await field('mesh-ids').inputValue(), /25\/26, 26\/27/);
    else assert.equal(await field('mesh-ids').inputValue(), '10, 11');
    await exportFbx(mode, triangles);
    await click('paint');
    await choose('paint-mask', 'created');
    assert.match(await read('paint-info'), new RegExp(`${walls} new faces with paintable UVs`));
    await act('undo-stroke', /Undid/);
    await exportFbx(`${mode}-undo`, 32);
    await act('redo', /Redid/);
    const name = `${mode}.assetfixer`, project = await download('save-project', name);
    const manifest = JSON.parse(strFromU8(project['manifest.json']));
    assert.equal(manifest.schemaVersion, 19);
    assert.equal(manifest.settings.operations['mesh-extrude-depth'], String(depth));
    await context.setOffline(true);
    await open(join(output, name), /Project restored/);
    await exportFbx(`${mode}-reopened`, triangles);
    await context.setOffline(false);
  }

  await open(resolve('test-results/e03/smooth_selection_static.zip'), /32 triangles/);
  await enter('face');
  await fill('mesh-ids', '10');
  await fill('mesh-extrude-depth', .05);
  await preview(/Side UVs need unwrapping or packing/);
  await click('mesh-cancel');
  await open(resolve('test-results/e03/smooth_selection_skinned.zip'), /2 bones/);
  await enter('face');
  await fill('mesh-ids', '10');
  await preview(/static meshes only/);
  assert.equal(await field('mesh-apply').isDisabled(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('Extrude passed in Chrome for connected faces and open edges, side UVs, the new-face paint mask, Undo and offline replay.');
} finally { await browser?.close(); }
