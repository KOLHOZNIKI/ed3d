import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decode, encode } from 'fast-png';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath, target = 'chrome', outDir = 'dist'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/v1', target);
await mkdir(output, { recursive: true });

function glbFixture(oversize = false) {
  const views = [], accessors = [], chunks = [];
  let length = 0;
  const view = bytes => {
    const padding = Buffer.alloc((4 - bytes.length % 4) % 4);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(bytes, padding);
    length += bytes.length + padding.length;
    return views.length - 1;
  };
  const attr = (data, itemSize, dimensions) => {
    const type = data instanceof Uint16Array ? 5123 : 5126;
    const bufferView = view(Buffer.from(data.buffer));
    accessors.push({ bufferView, componentType: type, count: data.length / itemSize,
      type: ['SCALAR', 'VEC2', 'VEC3'][itemSize - 1], ...dimensions });
    return accessors.length - 1;
  };
  const png = (rgba, invalid = false) => {
    const bytes = Buffer.from(encode({ width: 8, height: 8, channels: 4, data: Uint8Array.from({ length: 256 }, (_, i) => rgba[i % 4]) }));
    if (invalid) bytes.writeUInt32BE(8193, 16);
    return { mimeType: 'image/png', bufferView: view(bytes) };
  };
  const attributes = { POSITION: attr(Float32Array.of(-.5,-.5,0, .5,-.5,0, -.5,.5,0, .5,.5,0), 3, { min: [-.5,-.5,0], max: [.5,.5,0] }),
    NORMAL: attr(Float32Array.of(0,0,1, 0,0,1, 0,0,1, 0,0,1), 3), TEXCOORD_0: attr(Float32Array.of(0,0, 1,0, 0,1, 1,1), 2) };
  const indices = attr(Uint16Array.of(0,1,2, 2,1,3), 1);
  const images = [png([91, 82, 73, 240], oversize), png([23, 100, 151, 255]), png([140, 17, 20, 255]), png([220, 60, 40, 255])];
  const material = base => ({ pbrMetallicRoughness: { baseColorTexture: { index: base }, metallicRoughnessTexture: { index: 1 },
    metallicFactor: 1, roughnessFactor: 1 }, occlusionTexture: { index: 2 }, alphaMode: 'BLEND' });
  const data = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Assembly', children: [1, 2, 3] }, { name: 'Front', mesh: 0, translation: [0,0,.5] },
      { name: 'Back', mesh: 1, translation: [0,0,-.5] }, { name: 'Side', mesh: 1, translation: [2,0,0] }],
    meshes: [0, 1].map(material => ({ primitives: [{ attributes, indices, material }] })), materials: [material(0), material(3)],
    textures: images.map((_, source) => ({ source })), images, buffers: [{ byteLength: length }], bufferViews: views, accessors }));
  const json = Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(20), bin = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + length, 8);
  header.writeUInt32LE(json.length, 12); header.write('JSON', 16); bin.writeUInt32LE(length); bin.write('BIN\0', 4);
  return Buffer.concat([header, json, bin, ...chunks]);
}

function readGlb(bytes) {
  const jsonSize = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + jsonSize).toString());
  const map = info => {
    const view = json.bufferViews[json.images[json.textures[info.index].source].bufferView];
    const offset = 28 + jsonSize + (view.byteOffset ?? 0);
    return decode(bytes.subarray(offset, offset + view.byteLength));
  };
  return { json, map };
}

const app = await preview({ build: { outDir }, preview: { host: '127.0.0.1', port: 4301 } });
const url = `http://127.0.0.1:${app.httpServer.address().port}/`;
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1700, height: 1110 } });
  const page = await context.newPage(), errors = [], external = [];
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(url)) external.push(request.url()); });
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const choose = (id, value) => field(id).selectOption(value);
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const push = async (file, match) => {
    await field('sources').setInputFiles(file);
    await ready();
    assert.match(await field('status').textContent(), match);
  };
  const download = async (button, name) => {
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), click(button)]);
    const path = join(output, name);
    await file.saveAs(path);
    await ready();
    return readFile(path);
  };
  const tree = name => field('scene-hierarchy').getByRole('button', { name, exact: true });
  const picked = async () => field('scene-hierarchy').locator('button[aria-pressed=true]').allTextContents();
  const asset = { name: 'assembly.glb', mimeType: 'model/gltf-binary', buffer: glbFixture() };
  const report = {};
  await writeFile(join(output, asset.name), asset.buffer);
  await push(asset, /6 triangles/);
  const before = await field('project-status').textContent();
  await push({ ...asset, buffer: glbFixture(true) }, /within 8192 × 8192/);
  const bad = unzipSync(await readFile('tools/e00/fixtures/f15_source.zip'));
  const imagePath = Object.keys(bad).find(name => /\.png$/i.test(name));
  const png = Buffer.from(bad[imagePath]);
  png.writeUInt32BE(8193, 16);
  bad[imagePath] = png;
  await push({ name: 'oversized.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(bad)) }, /within 8192 × 8192/);
  assert.equal(await field('project-status').textContent(), before);
  report.predecodeRefusalPreservedProject = true;

  await choose('projection', { label: 'Orthographic' });
  await choose('view-direction', { label: 'Front' });
  const viewport = await field('viewport').boundingBox();
  async function gesture(box, points) {
    const mouse = page.mouse;
    const move = ([u, v]) => mouse.move(box.x + box.width * u, box.y + box.height * v, { steps: 4 });
    await move(points[0]); await mouse.down();
    for (const point of points.slice(1)) await move(point);
    await mouse.up();
  }
  await choose('view-selection-mode', 'rectangle');
  await gesture(viewport, [[.04,.04],[.96,.96]]);
  assert.deepEqual((await picked()).sort(), ['Front', 'Side']);
  await field('view-selection-through').check();
  await choose('view-selection-mode', 'lasso');
  await gesture(viewport, [[.04,.04],[.96,.04],[.96,.96],[.04,.96],[.04,.04]]);
  assert.deepEqual((await picked()).sort(), ['Back', 'Front', 'Side']);
  await click('object-isolate');
  assert.match(await field('object-isolate').textContent(), /Exit isolation/);
  await click('object-isolate');
  report.screenSelection = ['visible-only rectangle', 'through-surface lasso', 'multi-object isolation'];

  await tree('Front').click();
  await click('mesh-mode');
  await choose('mesh-kind', 'face');
  await choose('view-selection-mode', 'rectangle');
  await gesture(viewport, [[.04,.04],[.96,.96]]);
  assert.match(await field('mesh-info').textContent(), /2 selected/);
  await click('uv-mode');
  await choose('uv-kind', 'island');
  await choose('uv-selection-shape', 'lasso');
  const uv = await field('uv-canvas').boundingBox();
  await gesture(uv, [[.01,.01],[.99,.01],[.99,.99],[.01,.99],[.01,.01]]);
  assert.match(await field('uv-diagnostics').textContent(), /6 selected corners/);
  await click('object-mode');

  await tree('Front').click();
  await tree('Side').click({ modifiers: ['Shift'] });
  assert.deepEqual((await picked()).sort(), ['Front', 'Side']);
  await field('object-delta-y').fill('2');
  await click('object-apply-transform'); await ready();
  await click('undo-stroke'); await ready();
  await click('redo'); await ready();
  await choose('object-operation', 'scale');
  await choose('object-pivot', 'active');
  for (const axis of ['x', 'y', 'z']) await field(`object-delta-${axis}`).fill('2');
  await click('object-apply-transform'); await ready();
  await choose('object-operation', 'rotate');
  await choose('object-pivot', 'cursor');
  await field('object-delta-z').fill('90');
  await click('object-apply-transform'); await ready();
  const selection = readGlb(await download('export-selection', 'transformed-selection.glb')).json;
  assert.equal(selection.meshes.length, 2);
  assert.deepEqual(selection.nodes.flatMap(node => node.name ?? []).sort(), ['Assembly', 'Front', 'Side']);
  assert.equal(selection.images.length, 4);
  const front = selection.nodes.find(node => node.name === 'Front');
  const side = selection.nodes.find(node => node.name === 'Side');
  const position = node => node.translation ?? node.matrix.slice(12, 15);
  assert.deepEqual(position(front).map(Math.round), [-2, -2, 1]);
  assert.deepEqual(position(side).map(Math.round), [-2, 2, 0]);
  const scale = front.scale ?? [0, 4, 8].map(start => Math.hypot(...front.matrix.slice(start, start + 3)));
  assert.ok(scale.every(value => Math.abs(value - 2) < 1e-6));
  await download('save-project', 'transforms.assetfixer');
  await push(join(output, 'transforms.assetfixer'), /Project restored/);
  await tree('Front').click();
  const restored = readGlb(await download('export-selection', 'single-selection.glb')).json;
  assert.equal(restored.meshes.length, 1);
  assert.equal(restored.images.length, 3);
  assert.deepEqual(position(restored.nodes.find(node => node.name === 'Front')), position(front));
  await choose('object-operation', 'move');
  await choose('object-axes', 'local');
  await field('object-delta-x').fill('1');
  await click('object-apply-transform'); await ready();
  const local = readGlb(await download('export-selection', 'local-axis.glb')).json.nodes.find(node => node.name === 'Front');
  assert.deepEqual(position(local).map(Math.round), [-2, -1, 1]);
  report.transformsAndDependencies = true;

  await push(asset, /6 triangles/);
  await tree('Front').click();
  await click('toggle-texture');
  const selectMap = async pattern => {
    const options = await field('texture-target').locator('option').evaluateAll(options => options.map(item => [item.textContent, item.value]));
    await choose('texture-target', options.find(([label]) => pattern.test(label))[1]);
    await page.waitForFunction(() => /8 × 8/.test(document.querySelector('#texture-info').textContent));
  };
  const pixel = async value => {
    await choose('texture-tool', 'pixel');
    await field('texture-size').fill('1');
    await field('texture-scalar').fill(String(value));
    const box = await field('texture-picture').boundingBox();
    await page.mouse.click(box.x + box.width * 3.5 / 8, box.y + box.height * 3.5 / 8);
    await ready();
  };
  await selectMap(/Front.*Roughness/);
  await click('texture-copy'); await ready();
  await choose('texture-channel', '1'); await pixel(39);
  await choose('texture-channel', '2'); await pixel(178);
  await selectMap(/Front.*AO/);
  await click('texture-copy'); await ready(); await pixel(76);
  const painted = readGlb(await download('export-selection', 'painted-scalar.glb'));
  const mat = painted.json.materials[0];
  const colors = (image, x, y) => Array.from(image.data.subarray(4 * (y * image.width + x), 4 * (y * image.width + x + 1)));
  assert.deepEqual(colors(painted.map(mat.pbrMetallicRoughness.metallicRoughnessTexture), 3, 3), [23,39,178,255]);
  assert.deepEqual(colors(painted.map(mat.occlusionTexture), 3, 3), [76,17,20,255]);
  await download('save-project', 'scalar.assetfixer');
  await push(join(output, 'scalar.assetfixer'), /Project restored/);
  await tree('Front').click();
  const pngAgain = readGlb(await download('export-selection', 'painted-restored.glb'));
  assert.deepEqual(colors(pngAgain.map(pngAgain.json.materials[0].occlusionTexture), 3, 3), [76,17,20,255]);
  report.numericChannelsSavedAndExported = true;

  if (await field('texture-panel').isHidden()) await click('toggle-texture');
  await selectMap(/Front.*Base Color/);
  await field('texture-resize').locator('xpath=ancestor::details[1]/summary').click();
  async function resize(width, height, filter) {
    await field('texture-width').fill(String(width)); await field('texture-height').fill(String(height));
    await choose('texture-filter', filter); await click('texture-resize'); await ready();
    await page.waitForFunction(size => document.querySelector('#texture-info').textContent.includes(size), `${width} × ${height}`);
  }
  await field('project-settings').locator('summary').click();
  await field('history-budget').fill('1'); await field('history-budget').press('Tab'); await ready();
  await resize(1024, 1024, 'nearest');
  const savedState = await field('project-status').textContent();
  const savedHistory = await field('history-status').textContent();
  await page.evaluate(() => {
    window.previousEstimate = navigator.storage.estimate;
    navigator.storage.estimate = async () => ({ quota: 0, usage: 0 });
  });
  await field('texture-width').fill('16'); await field('texture-height').fill('12');
  await click('texture-resize'); await ready();
  assert.match(await field('texture-status').textContent(), /History was kept/);
  assert.equal(await field('project-status').textContent(), savedState);
  assert.equal(await field('history-status').textContent(), savedHistory);
  await page.evaluate(() => { navigator.storage.estimate = window.previousEstimate; });
  await resize(16, 12, 'bilinear');
  assert.match(await field('autosave-status').textContent(), /Saved history checkpoint/);
  assert.match(await field('history-status').textContent(), /Undo available: 0/);
  const checkpoint = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('assetfixer-workspace', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const all = await new Promise(resolve => {
      const request = db.transaction('checkpoints').objectStore('checkpoints').getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    const current = all.sort((a, b) => b.savedAt - a.savedAt)[0];
    return { revision: current.revision, archive: Array.from(new Uint8Array(await current.archive.arrayBuffer())) };
  });
  const manifest = JSON.parse(strFromU8(unzipSync(Uint8Array.from(checkpoint.archive))['manifest.json']));
  assert.equal(checkpoint.revision, manifest.revision);
  assert.match(await field('project-status').textContent(), new RegExp(`Revision ${manifest.revision}\\b`));
  report.resizeAndDurableCheckpoint = true;

  await push(asset, /6 triangles/);
  await tree('Front').click();
  if (await field('texture-panel').isHidden()) await click('toggle-texture');
  await selectMap(/Front.*Base Color/);
  const texel = async (x, y, modifiers = []) => {
    const box = await field('texture-picture').boundingBox();
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    await page.mouse.click(box.x + box.width * (x + .5) / 8, box.y + box.height * (y + .5) / 8, { delay: 20 });
    for (const modifier of modifiers) await page.keyboard.up(modifier);
    await ready();
  };
  async function texture(name) { return decode(await download('texture-export', name)); }
  await choose('texture-tool', 'select-face');
  await texel(1, 1);
  assert.match(await field('texture-info').textContent(), /1 selected faces/);
  await field('texture-color').fill('#ed2514');
  await click('texture-fill'); await ready();
  const face = await texture('face-mask.png');
  assert.deepEqual(colors(face, 1, 1), [237,37,20,240]);
  assert.deepEqual(colors(face, 6, 6), [91,82,73,240]);
  await choose('texture-tool', 'stamp');
  await field('texture-size').fill('1');
  await texel(6, 6, ['Alt']); await texel(2, 2);
  assert.deepEqual(colors(await texture('masked-clone.png'), 2, 2), [91,82,73,240], 'Stamp reads outside its write mask.');
  await click('undo-stroke'); await ready();
  assert.deepEqual(colors(await texture('undo-mask.png'), 2, 2), [237,37,20,240]);

  await field('view-comparison').locator('summary').click();
  await click('view-capture'); await ready();
  const firstPin = await field('view-reference').inputValue();
  await choose('texture-tool', 'select-island');
  await texel(6, 6);
  assert.match(await field('texture-info').textContent(), /1 selected UV islands/);
  await field('texture-color').fill('#32bf45');
  await click('texture-fill'); await ready();
  const island = await texture('island-mask.png');
  assert.deepEqual(colors(island, 1, 1), [50,191,69,240]);
  assert.deepEqual(colors(island, 6, 6), [50,191,69,240]);
  await click('view-capture'); await ready();
  const secondPin = await field('view-reference').inputValue();
  assert.notEqual(firstPin, secondPin);
  const pinnedPath = join(output, 'pinned.assetfixer');
  const pinned = unzipSync(await download('save-project', 'pinned.assetfixer'));
  const pinManifest = JSON.parse(strFromU8(pinned['manifest.json']));
  assert.equal(pinManifest.schemaVersion, 14);
  assert.deepEqual(pinManifest.snapshots.map(snapshot => snapshot.id), [firstPin, secondPin]);
  const pixelsAtPin = pin => decode(pinned[`blobs/${pinManifest.snapshots.find(snapshot => snapshot.id === pin).working.textures[0].hash}`]);
  assert.deepEqual(colors(pixelsAtPin(firstPin), 6, 6), [91,82,73,240]);
  assert.deepEqual(colors(pixelsAtPin(secondPin), 6, 6), [50,191,69,240]);
  assert.equal(pinManifest.snapshots[1].working.textures[0].hash, pinManifest.working.textures[0].hash);
  assert.equal(pinManifest.settings.operations['texture-color'], '#32bf45');
  assert.equal(pinManifest.settings.operations['texture-tool'], 'select-island');
  await context.setOffline(true);
  await push(pinnedPath, /Project restored/);
  assert.equal(await field('texture-tool').inputValue(), 'select-island');
  if (await field('view-comparison').getAttribute('open') === null) await field('view-comparison').locator('summary').click();
  await choose('view-reference', firstPin);
  await choose('view-compare', 'split'); await ready();
  assert.match(await field('view-reference-label').textContent(), new RegExp(`revision ${pinManifest.snapshots[0].revision}\\b`));
  await choose('view-compare', 'working');
  await click('view-remove-snapshot'); await ready();
  assert.equal(await field('view-reference').locator(`option[value="${firstPin}"]`).count(), 0);
  await click('undo-stroke'); await ready();
  assert.equal(await field('view-reference').locator(`option[value="${firstPin}"]`).count(), 1);
  await context.setOffline(false);
  report.faceIslandMasksAndOfflinePins = true;

  await click('shortcuts-open');
  const move = page.getByRole('textbox', { name: 'Move shortcut' });
  await move.press('G');
  await field('shortcuts-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await push(asset, /6 triangles/);
  await tree('Front').click();
  await choose('object-operation', 'rotate');
  await field('viewport').press('g');
  assert.equal(await field('object-operation').inputValue(), 'move');
  await field('object-label').press('e');
  assert.equal(await field('object-operation').inputValue(), 'move');
  report.persistedRemappingRespectsFocus = true;

  await push(resolve('tools/e00/fixtures/shared_skin.fbx'), /3 bones · 1 clips/);
  const meshes = await field('object-selection').locator('option').evaluateAll(rows => rows.filter(item => item.value).map(item => item.textContent));
  await choose('object-selection', { label: meshes[0] });
  assert.equal(await field('object-apply-transform').isDisabled(), true);
  const skin = unzipSync(await download('export-selection', 'skinned-selection.zip'));
  assert.equal(await field('job-progress').getAttribute('data-status'), 'completed');
  assert.match(await field('job-progress').getAttribute('data-job-id'), /^[0-9a-f-]{36}$/);
  assert.match(await field('job-progress').getAttribute('data-input-hashes'), /^[0-9a-f]{64}/);
  const skinManifest = JSON.parse(strFromU8(skin['manifest.json']));
  assert.equal(skinManifest.meshes.meshes, 1);
  assert.equal(skinManifest.meshes.bones, 3);
  assert.equal(skinManifest.meshes.clips, 1);
  const fbx = Object.keys(skin).find(path => /\.fbx$/i.test(path));
  await writeFile(join(output, 'selected.fbx'), skin[fbx]);
  await download('export', 'skinned-full.zip');
  const full = unzipSync(await readFile(join(output, 'skinned-full.zip')));
  await writeFile(join(output, 'full.fbx'), full[Object.keys(full).find(path => /\.fbx$/i.test(path))]);
  report.fbxSelectedSkin = skinManifest.meshes;

  for (const [name, input, modelStatus] of [
    ['plate', 'ceramic plate 3d model.zip', /9[,\s]?138 triangles/],
    ['character', 'tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip', /bones/],
  ]) {
    const path = `D:/downloads/Tripo/${input}`;
    await push(path, modelStatus);
    await choose('fbx-texture-files', 'png');
    const bundle = unzipSync(await download('export', `${name}-external-png.zip`));
    const manifest = JSON.parse(strFromU8(bundle['manifest.json']));
    assert.equal(manifest.textureFiles, 'png');
    assert.ok(manifest.textureConversions.length);
    assert.equal(Object.keys(bundle).filter(name => /\.jpe?g$/i.test(name)).length, 0);
    for (const map of [...manifest.textures, ...manifest.unassignedTextures]) {
      assert.match(map.file, /\.png$/i);
      assert.deepEqual([...bundle[map.file].subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    }
    await push(join(output, `${name}-external-png.zip`), modelStatus);
  }
  report.fbxExternalPngReimport = true;

  await push(resolve('test-results/e00/ufbx/data/maya_kenney_character_7700_binary.fbx'), /45 bones · 1 clips/);
  const authored = unzipSync(await download('export', 'authored-current.zip'));
  await writeFile(join(output, 'authored-current.fbx'), authored[Object.keys(authored).find(path => /\.fbx$/i.test(path))]);

  await context.setOffline(true);
  await push('D:/downloads/Tripo/man character 3d model.glb', /67 bones/);
  await field('object-selection').selectOption({ index: 1 });
  const glbSkin = readGlb(await download('export-selection', 'tripo-selection.glb')).json;
  assert.equal(glbSkin.meshes.length, 1);
  assert.equal(glbSkin.skins[0].joints.length, 67);
  report.offlineTripoSkin = glbSkin.skins[0].joints.length;
  await page.screenshot({ path: join(output, 'workspace.png') });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  await browser?.close();
  await app.close();
}
