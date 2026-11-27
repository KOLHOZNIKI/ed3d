import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { decode } from 'fast-png';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/v1-plus-tools');
await mkdir(output, { recursive: true });
const url = 'http://localhost/';
const build = resolve('dist');
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
  const external = [], errors = [];
  await context.route(/^https?:/, route => {
    if (route.request().url().startsWith(url)) {
      const path = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      return route.fulfill({ path: join(build, path) });
    }
    external.push(route.request().url());
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
  const open = async (source, expected = /32 triangles/) => {
    await field('sources').setInputFiles(resolve(source));
    await ready();
    assert.match(await read('status'), expected);
  };
  const enter = async mode => { await choose('object-selection', { index: 1 }); if (await field(`${mode}-tools`).isHidden()) await click(`${mode}-mode`); };
  const pick = async (kind, values) => { await choose('mesh-kind', kind); await fill('mesh-ids', values.join(', ')); };
  const previewMesh = async pattern => { await click('mesh-preview'); assert.match(await read('mesh-info'), pattern); };
  const act = async (id, pattern) => { await click(id); await ready(); if (pattern) assert.match(await read('status'), pattern); };
  const download = async (button, file) => {
    const path = join(output, file);
    const [event] = await Promise.all([page.waitForEvent('download'), click(button)]);
    await event.saveAs(path);
    await ready();
    return unzipSync(await readFile(path));
  };
  const fbx = files => files[Object.keys(files).find(path => path.endsWith('.fbx'))];
  const exportFbx = async (name, triangles, original) => {
    const files = await download('export', `${name}.zip`);
    await writeFile(join(output, `${name}.fbx`), fbx(files));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    assert.equal(manifest.meshes.triangles, triangles);
    const map = files[manifest.textures.find(entry => entry.semantic === 'BaseColor').file];
    if (original) assert.deepEqual(map, original[Object.keys(original).find(path => path.endsWith('.png'))]);
    return map;
  };
  const reopen = async (name, version, triangles, original) => {
    const file = `${name}.assetfixer`, saved = await download('save-project', file);
    assert.equal(JSON.parse(strFromU8(saved['manifest.json'])).schemaVersion, version);
    await context.setOffline(true);
    await open(join(output, file), /Project restored/);
    await exportFbx(`${name}-reopened`, triangles, original);
    await context.setOffline(false);
  };
  const pickUv = async (u, v) => {
    const canvas = field('uv-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const rect = await canvas.boundingBox(), zoom = .88 * 556;
    await page.mouse.click(rect.x + ((768 - zoom) / 2 + u * zoom) / 768 * rect.width,
      rect.y + ((556 - zoom) / 2 + (1 - v) * zoom) / 556 * rect.height);
  };

  for (const kind of ['static', 'skinned']) {
    const name = `relax-${kind}`, source = `test-results/e03/relax_source_${kind}.zip`;
    const original = unzipSync(await readFile(source));
    await writeFile(join(output, `${name}-original.fbx`), fbx(original));
    await open(source);
    await enter('uv');
    await choose('uv-kind', 'vertex');
    await choose('uv-operation', 'relax');
    await pickUv(.49, .24);
    await click('uv-pin');
    assert.match(await read('uv-pin-status'), /1 pinned UV vertices/);
    await click('uv-unwrap');
    assert.match(await read('uv-info'), /Clear pins first/);
    await click('uv-pack');
    assert.match(await read('uv-info'), /Select an unpinned island/);
    await click('uv-select-all');
    await fill('uv-relax-iterations', 3);
    await click('uv-run');
    assert.match(await read('uv-info'), /Relaxed [1-8] UV vertices\. 17 fixed vertices/);
    assert.match(await read('uv-diagnostics'), /0 overlapping/);
    await choose('uv-mode-select', 'mapping');
    await act('uv-apply', /Texture images are unchanged/);
    await exportFbx(name, 32, original);
    await act('undo-stroke', /Undid/);
    await exportFbx(`${name}-undo`, 32, original);
    await act('redo', /Redid/);
    await reopen(name, 18, 32, original);

    if (kind === 'static') {
      await open(source);
      await enter('uv');
      await choose('uv-operation', 'relax');
      await click('uv-select-all');
      await click('uv-run');
      assert.match(await read('uv-info'), /Relaxed .*16 fixed vertices/);
      await choose('uv-mode-select', 'preserve');
      await choose('uv-size', '256');
      await act('uv-apply', /UVs and 1 maps applied .*0 occupied texels/);
      const image = decode(await exportFbx('relax-preserved', 32));
      assert.deepEqual([image.width, image.height], [256, 256]);
      assert.ok(image.data[(128 * 256 + 128) * image.channels] > 80);
    }
  }

  await open('tools/e00/fixtures/topology_seams.zip', /13 triangles/);
  await enter('mesh');
  await pick('vertex', [0]);
  await choose('mesh-operation', 'mirrorMove');
  await fill('mesh-y', .0625);
  await previewMesh(/1 \[0\] ambiguous/);
  assert.equal(await field('mesh-apply').isDisabled(), true);

  for (const kind of ['static', 'skinned']) {
    const source = `test-results/e03/smooth_selection_${kind}.zip`;
    const original = unzipSync(await readFile(source));
    await writeFile(join(output, `${kind}-original.fbx`), fbx(original));
    await open(source);
    await enter('mesh');
    await choose('mesh-operation', 'mirrorMove');
    await fill('mesh-x', .125);
    await fill('mesh-y', .0625);
    if (kind === 'static') {
      await pick('vertex', [11, 13]);
      await previewMesh(/2 \[11, 13\] with both sides selected/);
      await pick('vertex', [11, 12]);
      await fill('mesh-mirror-offset', .125);
      await previewMesh(/2 \[11, 12\] unmatched/);
      await fill('mesh-mirror-offset', 0);
    } else await pick('vertex', [11, 12]);
    await previewMesh(/1 mirrored pairs · 1 plane vertices · 0 unmatched/);
    await act('mesh-apply', /Mirror Move applied/);
    await exportFbx(`mirror-${kind}`, 32, original);
    await act('undo-stroke', /Undid/);
    await exportFbx(`mirror-${kind}-undo`, 32, original);
    await act('redo', /Redid/);
    await reopen(`mirror-${kind}`, 18, 32, original);

    await open(source);
    await enter('mesh');
    await pick('face', [10]);
    await choose('mesh-operation', 'subdivide');
    await previewMesh(/32 → 35 faces · 3 new vertices/);
    await act('mesh-apply', /Subdivide applied/);
    await exportFbx(`subdivide-${kind}`, 38, original);
    await act('undo-stroke', /Undid/);
    await exportFbx(`subdivide-${kind}-undo`, 32, original);
    await act('redo', /Redid/);
    await reopen(`subdivide-${kind}`, 18, 38, original);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('UV Relax, Mirror Move and Subdivide passed in Chrome for static and skinned FBX.');
} finally {
  await browser?.close();
}
