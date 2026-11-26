import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { createServer, preview } from 'vite';
import { decode } from 'fast-png';

const { values: { edited, glb, 'glb-edited': glbEdited, unwrap, rebake, paint, repair, alpha, normal, seams,
  'shared-skin': sharedSkin }, positionals } = parseArgs({
  options: { edited: { type: 'boolean' }, glb: { type: 'string' }, unwrap: { type: 'boolean' }, rebake: { type: 'boolean' },
    paint: { type: 'boolean' }, repair: { type: 'boolean' }, alpha: { type: 'boolean' }, normal: { type: 'boolean' },
    seams: { type: 'boolean' }, 'glb-edited': { type: 'boolean' }, 'shared-skin': { type: 'boolean' } }, allowPositionals: true,
});
const standalone = seams || sharedSkin;
const [tripoPath, chromePath, animatedSource, realAnimatedSource] = standalone ? [undefined, ...positionals] : positionals;
if (!tripoPath && !standalone) throw new Error('Supply the path to the Tripo sample directory.');
if (glbEdited && !glb) throw new Error('--glb-edited requires --glb with the Tripo GLB path.');
if (standalone && ((seams && sharedSkin) || edited || glb || unwrap || rebake || paint || repair || alpha || normal || animatedSource)) {
  throw new Error('Use either --seams or --shared-skin with an optional Chrome path as a standalone fixture check.');
}
const { chromium } = await import('../../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/e00/exports');
await mkdir(output, { recursive: true });
const localServer = { host: '127.0.0.1', port: 4270 };
const dev = edited || paint || repair || seams || glbEdited;
const server = dev
  ? await createServer({ server: localServer, optimizeDeps: { include: ['xatlas-wasm'] } })
  : await preview({ preview: localServer });
if (dev) await server.listen();

try {
  const browser = await chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const outsideRequests = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') outsideRequests.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    const input = page.locator('#sources');
    const status = page.getByRole('status');
    const exportButton = page.getByRole('button', { name: 'Export FBX ZIP' });
    const cases = sharedSkin ? [[resolve('tools/e00/fixtures/shared_skin.fbx'), 'shared_skin', 124, 3, 1]]
      : seams ? [[resolve('tools/e00/fixtures/topology_seams.zip'), 'topology_seams', 13, 0, 0]] : [
      [join(tripoPath, 'ceramic plate 3d model.zip'), 'ceramic_plate_3d_model', 9138, 0, 0],
      [join(tripoPath, 'tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip'), 'tripo_convert_8b04a473', 17623, 67, 0],
      ...(animatedSource ? [[animatedSource, 'animated_fixture', 4, 2, 1]] : []),
      ...(realAnimatedSource ? [[realAnimatedSource, basename(realAnimatedSource, '.fbx'), 1604, 45, 1]] : []),
    ];
    for (const [path, name, triangles, bones, clips] of cases) {
      const expected = new RegExp(`^${name}.* · (.*) triangles · ${bones} bones · ${clips} clips`);
      await input.setInputFiles(path);
      await page.waitForFunction(() => !document.querySelector('#sources').disabled);
      const imported = await status.textContent();
      assert.match(imported, expected);
      assert.equal(Number(expected.exec(imported)[1].replace(/\D/g, '')), triangles);
      assert.ok(await page.locator('#viewport').isVisible());

      const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
      const exported = join(output, download.suggestedFilename());
      await download.saveAs(exported);
      if (sharedSkin) {
        const files = unzipSync(await readFile(exported));
        const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
        assert.deepEqual(manifest.meshes, { meshes: 2, triangles: 124, bones: 3, clips: 1 });
      }
      await input.setInputFiles(exported);
      await page.waitForFunction(() => !document.querySelector('#sources').disabled);
      const reimported = await status.textContent();
      assert.match(reimported, expected);
      assert.equal(Number(expected.exec(reimported)[1].replace(/\D/g, '')), triangles);
      console.log(reimported);
    }

    if (!standalone) {
      await checkTripoInputs({ page, input, status, exportButton, tripoPath, plate: cases[0][0] });
    }

    if (edited || seams) {
      const expectations = seams ? './topology-seams.json' : './position-edits.json';
      const edits = JSON.parse(await readFile(new URL(expectations, import.meta.url), 'utf8'));
      const editCases = seams ? [[edits, cases[0]]] : [[edits.static, cases[0]], [edits.skinned, cases[1]]];
      await page.evaluate(() => {
        const file = document.createElement('input');
        file.id = 'edit-source';
        file.type = 'file';
        file.hidden = true;
        document.body.append(file);
      });
      for (const [edit, [path, name, triangles, bones, clips]] of editCases) {
        await page.locator('#edit-source').setInputFiles(path);
        const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(async edit => {
          const { importAsset, moveControlPointY, exportAsset } = await import('/src/e00/round-trip.ts');
          const source = await importAsset([...document.querySelector('#edit-source').files]);
          const working = moveControlPointY(source, edit.controlPoint, edit.offsetY);
          const { bytes, name } = await exportAsset(working);
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
          link.download = name;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }, edit)]);
        assert.ok(download.suggestedFilename().endsWith('_e00_edited.zip'));
        const exported = join(output, download.suggestedFilename());
        await download.saveAs(exported);
        await input.setInputFiles(exported);
        await page.waitForFunction(() => !document.querySelector('#sources').disabled);
        const reimported = await status.textContent();
        const expected = new RegExp(`^${name}.*_e00_edited · (.*) triangles · ${bones} bones · ${clips} clips`);
        assert.match(reimported, expected);
        assert.equal(Number(expected.exec(reimported)[1].replace(/\D/g, '')), triangles);
        console.log(reimported);
      }
    }

    if (repair) {
      const fixture = JSON.parse(await readFile(new URL('./plate-repair.json', import.meta.url), 'utf8'));
      const [sourcePath, name, triangles] = cases[0];
      await page.evaluate(() => {
        const file = document.createElement('input');
        file.id = 'repair-source';
        file.type = 'file';
        file.hidden = true;
        document.body.append(file);
      });
      await page.locator('#repair-source').setInputFiles(sourcePath);
      const original = unzipSync(await readFile(sourcePath));
      for (const method of ['smooth', 'grid']) {
        const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(async ({ center, method }) => {
          const { importAsset, exportAsset } = await import('/src/e00/round-trip.ts');
          const { repairQuadPatch } = await import('/src/e00/repair.ts');
          const source = await importAsset([...document.querySelector('#repair-source').files]);
          try {
            repairQuadPatch(source, -1, method);
            throw new Error('Expected the repair to reject an invalid patch.');
          } catch (error) {
            if (!error.message.includes('exactly four quads')) throw error;
          }
          const working = repairQuadPatch(source, center, method);
          if (source.repairPatch || working.repairPatch.inputGeometry !== source.scene.getObjectByProperty('isMesh', true).geometry) {
            throw new Error('The fill must create a separate working snapshot.');
          }
          const { bytes, name } = await exportAsset(working);
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
          link.download = name;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }, { center: fixture.center, method })]);
        assert.equal(download.suggestedFilename(), `${name}_e00_${method}.zip`);
        const exported = join(output, download.suggestedFilename());
        await download.saveAs(exported);
        const files = unzipSync(await readFile(exported));
        const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
        const patch = manifest.repair;
        assert.equal(patch.method, method);
        assert.equal(patch.center, fixture.center);
        assert.deepEqual(patch.removed.map(face => face.face), fixture.faces);
        assert.equal(new Set(patch.boundary).size, 8);
        assert.equal(patch.replacementPolygons, method === 'smooth' ? 8 : 4);
        assert.equal(files[patch.sourceCornerMap].length, 4 * (fixture.originalCorners + (method === 'smooth' ? 8 : 0)));
        const distance = Math.hypot(...patch.after.map((value, i) => value - patch.before[i]));
        assert.ok(distance > 0.0005 && distance < 0.01);
        for (const texture of manifest.textures) assert.deepEqual(files[texture.file], original[texture.source]);
        await input.setInputFiles(exported);
        await page.waitForFunction(() => !document.querySelector('#sources').disabled);
        const message = await status.textContent();
        const expected = new RegExp(`^${name}_e00_${method} · (.*) triangles · 0 bones · 0 clips`);
        assert.match(message, expected);
        assert.equal(Number(expected.exec(message)[1].replace(/\D/g, '')), triangles);
        console.log(method, { center: patch.center, boundary: patch.boundary, distance, triangles });
      }
    }

    if (unwrap || rebake || paint) {
      const unwrapButton = page.locator('#unwrap');
      for (const [path, name, triangles, bones, clips] of cases.slice(0, 2)) {
        await input.setInputFiles(path);
        await page.waitForFunction(() => !document.querySelector('#sources').disabled);
        await unwrapButton.click();
        await page.waitForFunction(() => !document.querySelector('#unwrap').disabled, null, { timeout: 120000 });
        assert.match(await status.textContent(), /Generated .* in UV1/);
        const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
        assert.ok(download.suggestedFilename().endsWith('_e00_atlas.zip'));
        const exported = join(output, download.suggestedFilename());
        await download.saveAs(exported);
        const bundle = unzipSync(await readFile(exported));
        const atlas = JSON.parse(new TextDecoder().decode(bundle['manifest.json'])).uvAtlas;
        assert.equal(atlas.channel, 'uv1');
        assert.ok(atlas.splitControlPoints > 0);
        assert.equal(bundle[atlas.sourceCornerMap].length, triangles * 12);
        console.log(name, atlas);

        let bakedExport, paintedExport;
        if (rebake || (paint && !bones)) {
          const button = page.getByRole('button', { name: 'Rebake textures' });
          await button.click();
          await page.waitForFunction(() => !document.querySelector('#rebake').disabled, null, { timeout: 120000 });
          assert.match(await status.textContent(), new RegExp(`Rebaked ${bones ? 4 : 1} maps from UV0 to UV1`));
          const [baked] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
          assert.ok(baked.suggestedFilename().endsWith('_e00_baked.zip'));
          bakedExport = join(output, baked.suggestedFilename());
          await baked.saveAs(bakedExport);
          const files = unzipSync(await readFile(bakedExport));
          const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
          assert.equal(manifest.textureBake.exportedLayout, 'uv0');
          assert.equal(manifest.textureBake.width, atlas.width * 2);
          assert.ok(manifest.textureBake.covered > 0 && manifest.textureBake.padded > 0);
          assert.equal(manifest.textureBake.covered + manifest.textureBake.padded, manifest.textureBake.width * manifest.textureBake.height);
          assert.deepEqual(manifest.textures.map(map => map.semantic).sort(), bones ? ['BaseColor', 'Normal'] : ['BaseColor']);
          assert.deepEqual(manifest.textureBake.auxiliaryMaps.map(map => map.semantic).sort(), bones ? ['metallic', 'roughness'] : []);
          for (const map of [...manifest.textures, ...manifest.textureBake.auxiliaryMaps]) {
            assert.equal(map.file.slice(-4), '.png');
            assert.equal(files[map.file][0], 137);
          }
          console.log(name, manifest.textureBake);
          if (paint && !bones) {
            paintedExport = await checkSeamStroke(page, bakedExport, exportButton, status);
          }
          await page.getByRole('button', { name: 'Discard texture bake' }).click();
          assert.match(await status.textContent(), /original maps on UV0/);
        }
        await unwrapButton.click();
        assert.equal(await unwrapButton.textContent(), 'Generate UV atlas');
        await input.setInputFiles(paintedExport ?? bakedExport ?? exported);
        await page.waitForFunction(() => !document.querySelector('#sources').disabled);
        const reimported = await status.textContent();
        const kind = paintedExport ? 'painted' : bakedExport ? 'baked' : 'atlas';
        const expected = new RegExp(`^${name}.*_e00_${kind} · (.*) triangles · ${bones} bones · ${clips} clips`);
        assert.match(reimported, expected);
        assert.equal(Number(expected.exec(reimported)[1].replace(/\D/g, '')), triangles);
      }
    }

    if (alpha) {
      for (const alphaMode of ['mask', 'blend']) {
        const name = `alpha_transform_${alphaMode}`;
        await input.setInputFiles(resolve('test-results/e00/alpha-fixture', `${name}.zip`));
        await page.waitForFunction(() => !document.querySelector('#sources').disabled);
        assert.match(await status.textContent(), new RegExp(`^${name} · 4 triangles · 0 bones`));
        await page.locator('#unwrap').click();
        await page.waitForFunction(() => !document.querySelector('#unwrap').disabled, null, { timeout: 120000 });
        assert.match(await status.textContent(), /Generated [2-9]\d* charts/);
        await page.getByRole('button', { name: 'Rebake textures' }).click();
        await page.waitForFunction(() => !document.querySelector('#rebake').disabled, null, { timeout: 120000 });
        assert.match(await status.textContent(), /Rebaked 1 maps from UV0 to UV1/);
        assert.ok(await page.locator('#paint').isDisabled());
        const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
        assert.equal(download.suggestedFilename(), `${name}_e00_baked.zip`);
        const exported = join(output, download.suggestedFilename());
        await download.saveAs(exported);
        const files = unzipSync(await readFile(exported));
        const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
        assert.deepEqual(manifest.assetFixerMaterial, alphaMode === 'mask' ? { alphaMode, alphaCutoff: 0.5 } : { alphaMode });
        const image = decode(files[manifest.textures[0].file]);
        assert.equal(image.channels, 4);
        const observed = new Set();
        let hiddenRgb = 0;
        for (let i = 0; i < image.data.length; i += 4) {
          observed.add(image.data[i + 3]);
          if (image.data[i + 3] === 0 && (image.data[i] || image.data[i + 1] || image.data[i + 2])) hiddenRgb++;
        }
        for (const value of [0, 64, 140, 255]) assert.ok(observed.has(value));
        assert.ok(hiddenRgb > 0);
        await input.setInputFiles(exported);
        await page.waitForFunction(() => !document.querySelector('#sources').disabled);
        assert.match(await status.textContent(), new RegExp(`^${name}_e00_baked · 4 triangles · 0 bones`));
        console.log(name, { charts: manifest.uvAtlas.charts, width: image.width, height: image.height, hiddenRgb, alphaLevels: observed.size });
      }
    }

    if (normal) {
      await input.setInputFiles(resolve('test-results/e00/normal-fixture/directional_normals.zip'));
      await page.waitForFunction(() => !document.querySelector('#sources').disabled);
      assert.match(await status.textContent(), /^directional_normals · 4 triangles · 0 bones/);
      await page.locator('#unwrap').click();
      await page.waitForFunction(() => !document.querySelector('#unwrap').disabled, null, { timeout: 120000 });
      assert.match(await status.textContent(), /Generated 2 charts/);
      await page.getByRole('button', { name: 'Rebake textures' }).click();
      await page.waitForFunction(() => !document.querySelector('#rebake').disabled, null, { timeout: 120000 });
      assert.match(await status.textContent(), /Rebaked 2 maps from UV0 to UV1/);
      const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
      assert.equal(download.suggestedFilename(), 'directional_normals_e00_baked.zip');
      const exported = join(output, download.suggestedFilename());
      await download.saveAs(exported);
      const files = unzipSync(await readFile(exported));
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
      assert.deepEqual(manifest.textures.map(map => map.semantic).sort(), ['BaseColor', 'Normal']);
      const image = decode(files[manifest.textures.find(map => map.semantic === 'Normal').file]);
      assert.equal(image.width, manifest.textureBake.width);
      assert.equal(image.height, manifest.textureBake.height);
      await input.setInputFiles(exported);
      await page.waitForFunction(() => !document.querySelector('#sources').disabled);
      assert.match(await status.textContent(), /^directional_normals_e00_baked · 4 triangles · 0 bones/);
      console.log('Directional normals', { charts: manifest.uvAtlas.charts, width: image.width, height: image.height });
    }

    if (glb) {
      const sourceName = basename(glb, '.glb');
      const checkGlb = async (path, name) => {
        await input.setInputFiles(path);
        await page.waitForFunction(() => !document.querySelector('#sources').disabled);
        const message = await status.textContent();
        const [asset, triangles, bones, clips] = message.split(' · ');
        assert.equal(asset, name);
        assert.equal(Number(triangles.replace(/\D/g, '')), 17623);
        assert.equal(bones, '67 bones');
        assert.equal(clips, '0 clips');
        assert.ok(await page.locator('#viewport').isVisible());
        console.log(message);
      };
      await checkGlb(glb, sourceName);
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export GLB' }).click()]);
      assert.equal(download.suggestedFilename(), `${sourceName}_e00.glb`);
      const exported = join(output, download.suggestedFilename());
      await download.saveAs(exported);
      await checkGlb(exported, `${sourceName}_e00`);
      if (glbEdited) {
        const edit = JSON.parse(await readFile(new URL('./glb-position-edit.json', import.meta.url), 'utf8'));
        await page.evaluate(() => {
          const file = document.createElement('input');
          file.id = 'glb-edit-source';
          file.type = 'file';
          file.hidden = true;
          document.body.append(file);
        });
        await page.locator('#glb-edit-source').setInputFiles(glb);
        const [editedDownload] = await Promise.all([page.waitForEvent('download'), page.evaluate(async ({ vertex, offsetY }) => {
          const { importGlb, exportGlb } = await import('/src/e00/glb-round-trip.ts');
          // Use a fresh import instead of changing the scene owned by the viewport.
          const asset = await importGlb(document.querySelector('#glb-edit-source').files[0]);
          if (asset.stats.meshes !== 1 || asset.skins.size !== 1) throw new Error('Expected one skinned mesh.');
          const mesh = asset.skins.keys().next().value;
          const positions = mesh.geometry.getAttribute('position');
          if (positions.itemSize !== 3 || !(positions.array instanceof Float32Array) ||
              !Number.isInteger(vertex) || vertex < 0 || vertex >= positions.count) {
            throw new Error('Expected a valid float32 position accessor index.');
          }
          const y = positions.getY(vertex);
          const moved = Math.fround(y + offsetY);
          if (!Number.isFinite(moved) || moved === y) throw new Error('Expected a finite position change.');
          positions.setY(vertex, moved);
          const { bytes, name } = await exportGlb(asset);
          const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = name.replace(/\.glb$/, '_edited.glb');
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, edit)]);
        assert.equal(editedDownload.suggestedFilename(), `${sourceName}_e00_edited.glb`);
        const editedExport = join(output, editedDownload.suggestedFilename());
        await editedDownload.saveAs(editedExport);
        await checkGlb(editedExport, `${sourceName}_e00_edited`);
      }
    }
    assert.deepEqual(outsideRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

async function checkTripoInputs({ page, input, status, exportButton, tripoPath, plate }) {
  const entries = unzipSync(await readFile(plate));
  const looseFiles = Object.entries(entries).map(([path, bytes]) => ({
    name: path.split('/').at(-1), mimeType: 'application/octet-stream', buffer: Buffer.from(bytes),
  }));
  await input.setInputFiles(looseFiles.find(file => file.name.endsWith('.fbx')));
  await page.waitForFunction(() => !document.querySelector('#sources').disabled);
  assert.match(await status.textContent(), /Missing, ambiguous or unreadable textures/);
  await input.setInputFiles(looseFiles);
  await page.waitForFunction(() => !document.querySelector('#sources').disabled);
  assert.match(await status.textContent(), /^ceramic_plate_3d_model.* · 0 bones · 0 clips/);

  const malformed = zipSync({ '../escape.fbx': strToU8('invalid') });
  await input.setInputFiles({ name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from(malformed) });
  await page.waitForFunction(() => !document.querySelector('#sources').disabled);
  assert.match(await status.textContent(), /Invalid ZIP path/);
  assert.ok(await exportButton.isEnabled());

  const wrongAxes = await readFile(join(tripoPath, 'tripo_convert_720eb24f-5864-47f1-8cfb-aed1d6df6c86.zip'));
  await input.setInputFiles({ name: 'unsupported.zip', mimeType: 'application/zip', buffer: wrongAxes });
  await page.waitForFunction(() => !document.querySelector('#sources').disabled);
  assert.match(await status.textContent(), /supports binary FBX with \+X right/);
}

async function checkSeamStroke(page, bakedExport, exportButton, status) {
  await page.evaluate(() => {
    const reference = document.createElement('input');
    reference.type = 'file';
    reference.id = 'paint-reference';
    reference.hidden = true;
    document.body.append(reference);
  });
  await page.locator('#paint-reference').setInputFiles(bakedExport);
  const path = await page.evaluate(async () => {
    const { importAsset } = await import('/src/e00/round-trip.ts');
    const { Box3, PerspectiveCamera, Raycaster, Vector2, Vector3 } = await import('/node_modules/three/build/three.module.js');
    const asset = await importAsset([...document.querySelector('#paint-reference').files]);
    const mesh = asset.scene.getObjectByProperty('isMesh', true);
    const bounds = new Box3().setFromObject(asset.scene);
    const center = bounds.getCenter(new Vector3());
    const radius = bounds.getSize(new Vector3()).length() / 2;
    const canvas = document.querySelector('#viewport');
    const camera = new PerspectiveCamera(40, canvas.width / canvas.height, radius / 100, radius * 100);
    camera.position.copy(center).addScaledVector(new Vector3(0.6, 0.45, 1).normalize(), 3.5 * radius);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    asset.scene.updateMatrixWorld(true);
    const ray = new Raycaster();
    const pointer = new Vector2();
    const { polygons, renderCorners } = mesh.geometry.userData.assetFixerFbxSource;
    const { uv, uv1, normal } = mesh.geometry.attributes;
    const controlPoint = i => {
      const index = polygons[renderCorners[i]];
      return index < 0 ? -1 - index : index;
    };
    const different = (attr, i, j) => Math.hypot(attr.getX(i) - attr.getX(j), attr.getY(i) - attr.getY(j)) > 1e-6;
    const sharedSeam = (a, b) => {
      const shared = [];
      for (let i = 3 * a; i < 3 * a + 3; i++) for (let j = 3 * b; j < 3 * b + 3; j++) {
        if (controlPoint(i) === controlPoint(j)) shared.push([i, j]);
      }
      return shared.length === 2 && shared.every(([i, j]) => !different(uv1, i, j)) &&
        shared.some(([i, j]) => different(uv, i, j));
    };
    const trace = (y, rise) => {
      const samples = [];
      const crossings = [];
      for (let i = 0; i <= 224; i++) {
        const x = 235 + i * 0.75;
        const h = y + i * rise / 224;
        pointer.set(2 * x / canvas.width - 1, 1 - 2 * h / canvas.height);
        ray.setFromCamera(pointer, camera);
        const hit = ray.intersectObject(mesh, false)[0];
        if (!hit?.uv || hit.faceIndex == null || normal.getY(hit.faceIndex * 3) < 0.3) return;
        const previous = samples.at(-1);
        if (previous && previous.face !== hit.faceIndex && sharedSeam(previous.face, hit.faceIndex)) crossings.push(i);
        samples.push({ x, y: h, u: hit.uv.x, v: hit.uv.y, face: hit.faceIndex });
      }
      return { samples, crossings };
    };
    for (const rise of [20, 0, -20]) {
      for (const y of [222, 215, 230, 240, 205, 198, 247, 256]) {
        const route = trace(y, rise);
        if (!route?.crossings.length) continue;
        const lanes = [-8, -4, 4, 8].map(offset => trace(y + offset, rise));
        if (lanes.every(Boolean)) return { ...route, lanes, width: canvas.width, height: canvas.height, color: '#15e4f2' };
      }
    }
    throw new Error('No continuous stroke crossing a new UV seam was found on the top of the plate.');
  });
  assert.ok(path.crossings.length > 0);
  const canvas = page.locator('#viewport');
  await canvas.scrollIntoViewIfNeeded();
  const start = path.samples[0], end = path.samples.at(-1);
  const draw = async () => {
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + start.x * box.width / path.width, box.y + start.y * box.height / path.height);
    await page.mouse.down();
    await page.mouse.move(box.x + end.x * box.width / path.width, box.y + end.y * box.height / path.height, { steps: 68 });
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('#paint').disabled);
    assert.match(await status.textContent(), /^Painted .* Base Color texels\./);
  };
  await page.locator('#paint').click();
  await draw();
  await page.getByRole('button', { name: 'Undo stroke' }).click();
  await page.waitForFunction(() => !document.querySelector('#paint').disabled);
  assert.equal(await status.textContent(), 'Undid the last stroke.');
  const [undone] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  assert.ok(undone.suggestedFilename().endsWith('_e00_baked.zip'));
  const original = unzipSync(await readFile(bakedExport));
  const reverted = unzipSync(await readFile(await undone.path()));
  const originalManifest = JSON.parse(new TextDecoder().decode(original['manifest.json']));
  const originalMap = originalManifest.textures.find(map => map.semantic === 'BaseColor').file;
  assert.deepEqual(reverted[originalMap], original[originalMap]);
  await draw();
  const [painted] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  assert.ok(painted.suggestedFilename().endsWith('_e00_painted.zip'));
  const exported = join(output, painted.suggestedFilename());
  await painted.saveAs(exported);
  const files = unzipSync(await readFile(exported));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  assert.equal(manifest.texturePaint.strokes, 1);
  assert.equal(manifest.texturePaint.channel, 'uv0');
  assert.ok(manifest.texturePaint.lastStrokeTexels > 0);
  await writeFile(join(output, 'ceramic-plate-stroke.json'), JSON.stringify(path, null, 2));
  await canvas.screenshot({ path: join(output, 'ceramic-plate-browser-stroke.png') });
  console.log('Plate 3D brush', { samples: path.samples.length, crossings: path.crossings, ...manifest.texturePaint });
  return exported;
}
