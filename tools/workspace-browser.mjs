import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decode } from 'fast-png';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath, outputName = 'chrome'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/workspace', outputName);
await mkdir(output, { recursive: true });
const app = await preview({ preview: { host: '127.0.0.1', port: 4300 } });
const url = `http://127.0.0.1:${app.httpServer.address().port}/`;
const tripo = 'D:/downloads/Tripo';
const plate = join(tripo, 'ceramic plate 3d model.zip');
const character = join(tripo, 'tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip');
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
  page.on('console', entry => { if (entry.type() === 'error' && /Shader|WebGL/i.test(entry.text())) errors.push(entry.text()); });
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
  const viewport = field('viewport');
  const stage = page.locator('.model-stage');
  const viewportFillsStage = async () => {
    assert.deepEqual(await viewport.boundingBox(), await stage.boundingBox());
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#viewport');
      const { width, height } = canvas.getBoundingClientRect();
      const scale = Math.min(devicePixelRatio, 2, 4096 / Math.max(width, height));
      return canvas.width === Math.round(width * scale) && canvas.height === Math.round(height * scale);
    });
  };
  await viewportFillsStage();
  const statusbar = page.locator('.statusbar');
  const statusHeight = (await statusbar.boundingBox()).height;
  const initialViewport = await viewport.boundingBox();
  const selectionDetails = field('selection-details');
  await field('scene-hierarchy').locator('button').first().click();
  assert.match(await field('status').textContent(), /9[\s,]?138 triangles/);
  assert.match(await field('scene-materials').textContent(), /Base Color/);
  const description = await selectionDetails.textContent();
  assert.match(description, /vertices.*faces/);
  assert.equal((await statusbar.boundingBox()).height, statusHeight);
  assert.deepEqual(await viewport.boundingBox(), initialViewport);
  await selectionDetails.evaluate(node => { node.textContent = node.textContent.repeat(40); });
  assert.ok(await statusbar.evaluate(node => node.scrollHeight > node.clientHeight));
  assert.equal((await statusbar.boundingBox()).height, statusHeight);
  assert.deepEqual(await viewport.boundingBox(), initialViewport);
  await selectionDetails.evaluate((node, value) => { node.textContent = value; }, description);
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
  for (const mode of ['textured', 'pbr', 'matcap-clay', 'matcap-graphite', 'matcap-metal', 'cartoon', 'sketch',
    'unlit', 'solid', 'wire', 'edges', 'checker', 'normals']) {
    await choose('view-display', mode);
    await ready();
    assert.equal(await field('view-display').inputValue(), mode);
    displays.push(digest(await viewport.screenshot()));
  }
  assert.equal(new Set(displays).size, displays.length, 'Each display mode should render a different image.');
  await details('view-options');
  await choose('view-display', 'matcap-clay');
  const bakedLight = digest(await viewport.screenshot());
  await field('view-exposure').fill('-1');
  assert.equal(digest(await viewport.screenshot()), bakedLight);
  await field('view-exposure').fill('0');
  await choose('view-direction', 'Right');
  assert.notEqual(digest(await viewport.screenshot()), bakedLight);
  await choose('view-direction', 'Oblique');
  await choose('view-display', 'textured');
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
  await viewportFillsStage();
  assert.equal(await field('model-view').getAttribute('data-compare'), 'split');
  assert.equal(await field('view-reference-label').textContent(), 'Original');
  await click('view-capture');
  await ready();
  assert.match(await field('view-reference-label').textContent(), /Snapshot · revision 0/);
  await click('object-visibility');
  await ready();
  assert.match(await field('project-status').textContent(), /Revision 2/i);
  await viewport.screenshot({ path: join(output, 'compare.png') });
  await choose('view-display', 'matcap-metal');
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
  await viewportFillsStage();
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

  await open(page, character);
  await choose('workspace-layout', 'model');
  await choose('view-display', 'pbr');
  await ready();
  const beforeMaps = digest(await viewport.screenshot());
  const pack = unzipSync(await readFile(character));
  const roughness = Object.keys(pack).find(path => path.endsWith('_roughness.jpg'));
  const metallic = Object.keys(pack).find(path => path.endsWith('_metallic.jpg'));
  assert.ok(roughness && metallic);
  [pack[roughness], pack[metallic]] = [pack[metallic], pack[roughness]];
  await open(page, { name: 'swapped-maps.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(pack)) });
  assert.match(await field('status').textContent(), /17[\s,]?623 triangles/);
  assert.equal(await field('view-display').inputValue(), 'pbr');
  assert.notEqual(digest(await viewport.screenshot()), beforeMaps);

  await open(page, skin);
  await choose('workspace-layout', 'model');
  await choose('view-display', 'cartoon');
  const restLook = digest(await viewport.screenshot());
  await details('scene-bones');
  await field('scene-bone-list').locator('button').first().click();
  assert.equal(await field('rig-mode').getAttribute('aria-pressed'), 'true');
  await choose('rig-edit-mode', 'pose');
  await field('rig-z').fill('24');
  await click('rig-apply');
  await ready();
  assert.match(await field('status').textContent(), /Rotate manual pose joint applied/);
  assert.notEqual(digest(await viewport.screenshot()), restLook);
  await choose('view-display', 'matcap-graphite');
  const posedMatcap = digest(await viewport.screenshot());
  await click('rig-reset-pose');
  await ready();
  assert.notEqual(digest(await viewport.screenshot()), posedMatcap);
  await choose('view-display', 'weights');
  assert.equal(await field('weights-mode').getAttribute('aria-pressed'), 'true');

  await open(page, resolve('tools/e00/fixtures/corpus/f08_material_bindings.glb'));
  await choose('projection', 'Orthographic');
  await choose('view-direction', 'Front');
  for (const id of ['view-grid', 'view-axes', 'view-bounds']) await field(id).uncheck();
  const silhouette = async mode => {
    await choose('view-display', mode);
    const { data, channels, width, height } = decode(await viewport.screenshot({
      style: '#view-compare-labels { visibility: hidden; }',
    }));
    const mask = new Uint8Array(width * height);
    // The partially covered outer pixels can include the panels beside the canvas.
    const background = (width * 2 + 2) * channels;
    for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
      const i = y * width + x;
      const offset = i * channels;
      mask[i] = +([0, 1, 2].some(channel => data[offset + channel] !== data[background + channel]));
    }
    return { mask, width, height };
  };
  const { mask: textured } = await silhouette('textured'), { mask: captured } = await silhouette('matcap-graphite');
  assert.equal(textured.length, captured.length);
  const visible = textured.reduce((count, value) => count + value, 0);
  assert.ok(visible > 10_000);
  assert.ok(textured.reduce((count, value, i) => count + +(value !== captured[i]), 0) < visible * .01);

  const checkProportions = ({ mask, width, height }, left, right) => {
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y++) for (let x = left; x < right; x++) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const shapeWidth = maxX - minX + 1, shapeHeight = maxY - minY + 1;
    assert.ok(shapeWidth > 100 && shapeHeight > 50 && Math.abs(shapeWidth / shapeHeight - 2) <= .04,
      `Expected a 2:1 silhouette, got ${shapeWidth} × ${shapeHeight}.`);
    assert.ok(Math.abs(minX + maxX + 1 - left - right) <= 2, 'The model should stay centered horizontally.');
    return { x: minX + shapeWidth / 4, y: minY + shapeHeight / 2 };
  };
  for (const width of [2600, 1280]) {
    await page.setViewportSize({ width, height: 1080 });
    await viewportFillsStage();
    for (const projection of ['Perspective', 'Orthographic']) {
      await choose('projection', projection);
      const shape = await silhouette('solid');
      const position = checkProportions(shape, 0, shape.width);
      await click('object-mode');
      await viewport.click({ position });
      assert.equal(await field('scene-hierarchy').getByRole('button', { name: 'CutoutPanel' }).getAttribute('aria-pressed'), 'true');
      await viewport.click({ position: { x: 2, y: 2 } });
      await choose('view-compare', 'split');
      await ready();
      await viewportFillsStage();
      const split = await silhouette('solid'), divider = Math.floor(split.width / 2);
      checkProportions(split, 0, divider);
      checkProportions(split, divider, split.width);
      await choose('view-compare', 'working');
    }
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

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
  await page.evaluate(() => window.scrollTo(0, 0));
  const compactStatus = await statusbar.boundingBox();
  assert.equal(compactStatus.height, statusHeight);
  assert.ok(compactStatus.y >= 0 && compactStatus.y + compactStatus.height <= 1000);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const report = { browser: browser.version(), viewportPixels: pixels, uniqueDisplays: displays.length, guides: true,
    comparison: true, preservedExportTextures: true, resizablePanels: true, restoredLayout: 'uv-only', shortcutSave: true, meshSelection: true,
    compactOverflow: overflow, statusHeight, stableViewportOnSelection: true, pbrCompanionMaps: true, stylizedSkinPose: true,
    matcapLighting: true, matcapOpacity: true, matcapSkinPose: true, responsiveViewport: true, local: true };
  await writeFile(join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await new Promise(resolve => app.httpServer.close(resolve));
}
