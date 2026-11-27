import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath, outputName = 'chrome'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/workspace', outputName);
await mkdir(output, { recursive: true });
const app = await preview({ preview: { host: '127.0.0.1', port: 4300 } });
const url = `http://127.0.0.1:${app.httpServer.address().port}/`;
const plate = 'D:/downloads/Tripo/ceramic plate 3d model.zip';
const skin = resolve('tools/e00/fixtures/shared_skin.fbx');
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const errors = [], external = [];
  context.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(url)) external.push(request.url());
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const choose = (id, value) => field(id).selectOption(value);
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const open = async (target, path) => {
    await target.locator('#sources').setInputFiles(path);
    await target.waitForFunction(() => !document.querySelector('#sources').disabled);
  };
  const layout = async value => assert.equal(await field('workspace').getAttribute('data-layout'), value);
  const details = async id => {
    if ((await field(id).getAttribute('open')) === null) await field(id).locator(':scope > summary').click();
  };

  await page.screenshot({ path: join(output, 'empty.png') });
  await open(page, plate);
  await field('scene-hierarchy').locator('button').first().click();
  assert.match(await field('status').textContent(), /9[\s,]?138 triangles/);
  assert.match(await field('scene-materials').textContent(), /Base Color/);
  const viewport = field('viewport');
  const bounds = await viewport.boundingBox(), scene = await field('scene-panel').boundingBox();
  assert.ok(bounds.width >= 850 && bounds.height >= 600, JSON.stringify(bounds));
  assert.ok(bounds.x >= scene.x + scene.width);
  const pixels = await viewport.evaluate(canvas => [canvas.width, canvas.height]);
  assert.ok(pixels[0] >= 850 && pixels[1] >= 600, pixels);
  await page.screenshot({ path: join(output, '3d.png') });

  await field('workspace-scene-resize').press('ArrowRight');
  assert.equal((await field('scene-panel').boundingBox()).width, scene.width + 16);
  await click('workspace-scene-toggle');
  assert.equal(await field('scene-panel').isHidden(), true);
  await click('workspace-scene-toggle');
  await click('workspace-tools-toggle');
  assert.equal(await field('tools-panel').isHidden(), true);
  await click('workspace-tools-toggle');
  await click('object-isolate');
  assert.match(await field('object-isolate').textContent(), /Exit isolation/);
  await click('object-isolate');

  const project = await field('project-status').textContent();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const displays = [];
  for (const mode of ['textured', 'unlit', 'solid', 'wire', 'edges', 'checker', 'normals']) {
    await choose('view-display', mode);
    displays.push(digest(await viewport.screenshot()));
  }
  assert.equal(new Set(displays).size, displays.length, 'Each display mode should render a different image.');
  await choose('view-display', 'textured');
  await details('view-options');
  await field('view-grid').uncheck();
  const noGrid = digest(await viewport.screenshot());
  await field('view-grid').check();
  assert.notEqual(digest(await viewport.screenshot()), noGrid);
  await field('view-axes').check();
  await field('view-bounds').check();
  await field('view-exposure').fill('-1');
  assert.notEqual(digest(await viewport.screenshot()), displays[0]);
  await field('view-exposure').fill('0');
  await field('view-background').fill('#253246');
  assert.equal(await field('project-status').textContent(), project);
  await details('view-comparison');
  await choose('view-compare', 'split');
  await ready();
  assert.equal(await field('model-view').getAttribute('data-compare'), 'split');
  assert.equal(await field('view-reference-label').textContent(), 'Original');
  await click('view-capture');
  await ready();
  assert.match(await field('view-reference-label').textContent(), /Snapshot · revision 0/);
  await click('object-visibility');
  await ready();
  assert.match(await field('project-status').textContent(), /Revision 2/i);
  await viewport.screenshot({ path: join(output, 'compare.png') });
  await choose('view-display', 'wire');
  const [exported] = await Promise.all([page.waitForEvent('download'), click('export')]);
  const exportPath = join(output, 'plate.zip');
  await exported.saveAs(exportPath);
  await ready();
  const files = unzipSync(await readFile(exportPath)), source = unzipSync(await readFile(plate));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.meshes.triangles, 9138);
  assert.ok(manifest.textures.length > 0);
  for (const texture of manifest.textures) assert.deepEqual(files[texture.file], source[texture.source]);
  await choose('view-display', 'textured');
  await choose('view-compare', 'working');
  assert.equal(await field('model-view').getAttribute('data-compare'), null);
  await click('undo-stroke');
  await ready();
  await viewport.focus();
  const [saved] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  assert.match(saved.suggestedFilename(), /\.assetfixer$/);
  await ready();

  await choose('workspace-layout', 'texture');
  await layout('texture');
  assert.equal(await field('texture-panel').isVisible(), true);
  assert.equal(await viewport.isVisible(), true);
  await field('workspace-editor-resize').press('ArrowLeft');
  await choose('workspace-layout', 'uv');
  await layout('uv');
  await page.screenshot({ path: join(output, 'uv.png') });
  await choose('workspace-layout', 'uv-only');
  await layout('uv-only');
  assert.equal(await viewport.isHidden(), true);
  assert.equal(await field('uv-canvas').isVisible(), true);
  const reopened = await context.newPage();
  await reopened.goto(url);
  await open(reopened, plate);
  assert.equal(await reopened.locator('#workspace').getAttribute('data-layout'), 'uv-only');
  await reopened.close();

  await open(page, skin);
  await details('scene-bones');
  await field('scene-bone-list').locator('button').first().click();
  assert.equal(await field('rig-mode').getAttribute('aria-pressed'), 'true');
  await choose('view-display', 'weights');
  assert.equal(await field('weights-mode').getAttribute('aria-pressed'), 'true');

  await open(page, resolve('tools/e00/fixtures/corpus/f03_boundaries.glb'));
  await field('scene-hierarchy').locator('button').first().click();
  await click('mesh-mode');
  await field('mesh-tools').getByText('Selection commands', { exact: true }).click();
  await choose('mesh-kind', 'face');
  await click('mesh-select-all');
  assert.match(await field('mesh-info').textContent(), /^[1-9]\d* selected/);
  await click('mesh-select-invert');
  assert.match(await field('mesh-info').textContent(), /^0 selected/);
  await click('mesh-select-material');
  assert.match(await field('mesh-info').textContent(), /^[1-9]\d* selected/);
  await click('mesh-select-boundary');
  assert.match(await field('mesh-ids').inputValue(), /\d+\/\d+/);

  await page.setViewportSize({ width: 920, height: 1000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const report = { browser: browser.version(), viewportPixels: pixels, uniqueDisplays: displays.length, guides: true,
    comparison: true, preservedExportTextures: true, resizablePanels: true, restoredLayout: 'uv-only', shortcutSave: true, meshSelection: true,
    compactOverflow: overflow, local: true };
  await writeFile(join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await new Promise(resolve => app.httpServer.close(resolve));
}
