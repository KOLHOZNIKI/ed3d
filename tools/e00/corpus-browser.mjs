import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decode } from 'fast-png';
import { unzipSync } from 'fflate';
import { createServer } from 'vite';

const [executablePath, directory = 'tools/e00/fixtures/corpus'] = process.argv.slice(2);
const { chromium } = await import('../../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const out = resolve('test-results/e00/corpus');
await mkdir(out, { recursive: true });
const fixture = name => resolve(directory, name);
const app = await createServer({ server: { host: '127.0.0.1', port: 4283, hmr: false, ws: false } });
let chrome;
try {
  await app.listen();
  chrome = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await chrome.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') external.push(url.href);
  });
  await page.goto(`http://127.0.0.1:${app.httpServer.address().port}`);
  const input = page.locator('#sources'), status = page.getByRole('status');
  const exportGlb = page.getByRole('button', { name: 'Export GLB' });
  const open = async (name, expected) => {
    await input.setInputFiles(fixture(name));
    await page.waitForFunction(() => !document.querySelector('#sources').disabled);
    const message = await status.textContent();
    assert.match(message, expected);
    return message;
  };
  const download = async (action, filename) => {
    const [job] = await Promise.all([page.waitForEvent('download'), action()]);
    assert.equal(job.suggestedFilename(), filename);
    const path = join(out, filename);
    await job.saveAs(path);
    return path;
  };
  const observed = {};
  for (const [name, match] of [
    ['f03_boundaries', /80 triangles/], ['f04_bottle', /104 triangles/], ['f05_grid_bridge', /64 triangles/],
    ['f07_shared_atlas', /8 triangles/], ['f08_material_bindings', /4 triangles/],
    ['f11_wide_torso', /456 triangles · 8 bones · 1 clips/], ['f12_coordinate_root', /2 triangles · 0 bones · 1 clips/],
    ['f16_non_manifold', /3 triangles.*Non-manifold topology: 1 indexed mesh edge/],
  ]) {
    observed[name] = await open(`${name}.glb`, match);
    await download(() => exportGlb.click(), `${name}_e00.glb`);
  }
  observed.f16_invalid_index = await open('f16_invalid_index.glb', /GLB triangle 1 references a vertex outside its position array/);
  assert.ok(await exportGlb.isEnabled());
  observed.f16_missing_texture = await open('f16_missing_texture.zip', /Missing or ambiguous textures:.*Source.png/);
  assert.ok(await exportGlb.isEnabled());
  const stillLoaded = await download(() => exportGlb.click(), 'f16_non_manifold_e00.glb');
  assert.ok((await readFile(stillLoaded)).length > 0);
  observed.f12_zup_axes = await open('f12_zup_axes.fbx', /2 triangles · 0 bones · 1 clips/);
  const converted = await download(() => page.getByRole('button', { name: 'Export FBX ZIP' }).click(), 'f12_zup_axes_e00.zip');
  const axisManifest = JSON.parse(new TextDecoder().decode(unzipSync(await readFile(converted))['manifest.json']));
  assert.deepEqual(axisManifest.sourceAxes, ['-X', '+Z', '+Y']);
  assert.equal(axisManifest.unitsInCentimeters, 2.54);
  const mirrored = await readFile(fixture('f12_zup_axes.fbx'));
  const axisProperty = 'FrontAxisSign';
  let end = mirrored.indexOf(axisProperty) + axisProperty.length;
  for (let i = 0; i < 3; i++) {
    assert.equal(mirrored[end], 'S'.charCodeAt(0));
    end += 5 + mirrored.readUInt32LE(end + 1);
  }
  assert.equal(mirrored[end], 'I'.charCodeAt(0));
  assert.equal(mirrored.readInt32LE(end + 1), 1);
  mirrored.writeInt32LE(-1, end + 1);
  await input.setInputFiles({ name: 'left-handed.fbx', mimeType: 'application/octet-stream', buffer: mirrored });
  await page.waitForFunction(() => !document.querySelector('#sources').disabled);
  observed.f12_mirrored_axes = await status.textContent();
  assert.match(observed.f12_mirrored_axes, /Unsupported FBX axes in “left-handed\.fbx”.*requires a handedness conversion.*export a GLB/);
  assert.ok(await page.getByRole('button', { name: 'Export FBX ZIP' }).isEnabled());

  await page.evaluate(() => {
    const node = document.createElement('input');
    node.id = 'identity-input';
    node.type = 'file';
    node.hidden = true;
    document.body.append(node);
  });
  await page.locator('#identity-input').setInputFiles(fixture('identity.zip'));
  const result = await download(() => page.evaluate(async () => {
    const { importAsset, exportAsset } = await import('/src/e00/round-trip.ts');
    const { rebakeAsset } = await import('/src/e00/rebake.ts');
    const { sourceMesh } = await import('/src/e00/fbx-topology.ts');
    const { bakeScale } = await import('/src/e00/atlas-raster.ts');
    const asset = await importAsset([...document.querySelector('#identity-input').files]);
    const { geometry } = asset.scene.getObjectByProperty('isMesh', true);
    const source = sourceMesh(geometry);
    // Keep original corner UVs and image dimensions for the identity control.
    const target = geometry.clone();
    target.setAttribute('uv1', geometry.attributes.uv.clone());
    target.setIndex(Array.from({ length: geometry.attributes.position.count }, (_, i) => i));
    const uvAtlas = { inputGeometry: geometry, geometry: target, sourceCorners: source.renderCorners.slice(),
      faceComponents: new Uint32Array(target.index.count / 3), channel: 'uv1',
      metrics: { width: 64 / bakeScale, height: 64 / bakeScale, charts: 1, separatedFaces: 0, milliseconds: 0,
        controlPoints: 4, chartVertices: 4, renderVertices: target.attributes.position.count, splitControlPoints: 0 } };
    const working = await rebakeAsset({ ...asset, uvAtlas });
    const { name, bytes } = await exportAsset(working);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }), 'identity_e00_baked.zip');
  const inputZip = unzipSync(await readFile(fixture('identity.zip')));
  const outputZip = unzipSync(await readFile(result));
  const manifest = JSON.parse(new TextDecoder().decode(outputZip['manifest.json']));
  const before = decode(inputZip['identity.fbm/Source.png']);
  const after = decode(outputZip[manifest.textures[0].file]);
  assert.equal(manifest.assetFixerMaterial.alphaMode, 'blend');
  assert.deepEqual([after.width, after.height, after.channels, after.depth], [before.width, before.height, 4, 8]);
  assert.equal(manifest.textureBake.covered, before.width * before.height);
  let pixels = 0, hiddenRgbTexels = 0;
  const maxErrorByChannel = [0, 0, 0, 0];
  for (let y = 1; y < before.height - 1; y++) for (let x = 1; x < before.width - 1; x++) {
    if (x + y === before.width - 1) continue;
    const at = (y * before.width + x) * 4;
    pixels++;
    if (before.data[at + 3] === 0 && before.data.subarray(at, at + 3).some(value => value !== 0)) hiddenRgbTexels++;
    for (let channel = 0; channel < 4; channel++) {
      maxErrorByChannel[channel] = Math.max(maxErrorByChannel[channel], Math.abs(before.data[at + channel] - after.data[at + channel]));
    }
  }
  assert.equal(pixels, 3782);
  assert.ok(hiddenRgbTexels > 0);
  assert.ok(maxErrorByChannel.every(error => error <= 1), JSON.stringify(maxErrorByChannel));
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const report = { chrome: chrome.version(), observed, identity: { pixels, hiddenRgbTexels, maxErrorByChannel } };
  await writeFile(join(out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  await chrome?.close();
  await app.close();
}
