import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath, heavyFixture] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const out = resolve('test-results/e01');
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(out, 'profile-'));
const skinProfile = await mkdtemp(join(out, 'skin-profile-'));
const staticOriginal = resolve('tools/e00/fixtures/f15_source.zip');
const skinOriginal = resolve('tools/e00/fixtures/shared_skin.fbx');
const glbOriginal = resolve('tools/e00/fixtures/meshy-gambit-pawn-lo.glb');
const staticInput = join(out, 'f15_source.zip'), skinInput = join(out, 'shared_skin.fbx');
const glbInput = join(out, 'meshy-gambit-pawn-lo.glb');
await copyFile(staticOriginal, staticInput);
await copyFile(skinOriginal, skinInput);
await copyFile(glbOriginal, glbInput);
const app = await preview({ preview: { host: '127.0.0.1', port: 4284 } });
const address = `http://127.0.0.1:${app.httpServer.address().port}/`;
let context;
const errors = [], remote = [], offlineRequests = [];
const report = {};

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function unpack(path) {
  const files = unzipSync(await readFile(path));
  return { files, manifest: JSON.parse(strFromU8(files['manifest.json'])) };
}

async function browser(data, offline = false) {
  context = await chromium.launchPersistentContext(data, {
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    viewport: { width: 1200, height: 1000 }, acceptDownloads: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = context.pages()[0];
  let localOnly = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (url.hostname !== '127.0.0.1') remote.push(url.href);
    if (localOnly) offlineRequests.push(url.href);
  });
  await page.goto(address);
  await page.waitForFunction(() => !document.querySelector('#sources').disabled);
  if (offline) {
    await context.setOffline(true);
    localOnly = true;
    assert.equal(await page.evaluate(() => navigator.onLine), false);
  }
  const status = page.getByRole('status');
  const sources = page.locator('#sources');
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const open = async (path, message) => {
    await sources.setInputFiles(path);
    await ready();
    assert.match(await status.textContent(), message);
  };
  const click = async (selector, message) => {
    await page.locator(selector).click();
    await ready();
    assert.match(await status.textContent(), message);
  };
  const save = async (selector, filename) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
    const destination = join(out, filename);
    assert.equal(await download.failure(), null);
    await download.saveAs(destination);
    await ready();
    return destination;
  };
  const autosave = pattern => page.waitForFunction(text => document.querySelector('#autosave-status').textContent.includes(text), pattern);
  return { page, ready, open, click, save, autosave };
}

async function corruptCheckpoint(page, revision) {
  return page.evaluate(value => new Promise((resolve, reject) => {
    const request = indexedDB.open('assetfixer-workspace', 1);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('checkpoints', 'readwrite');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore('checkpoints').put({ key: 'damaged-control', name: 'Invalid control', projectId: 'invalid',
        revision: value, savedAt: Date.now() + 60000, archive: new Blob(['damaged project']) });
    };
    request.onerror = () => reject(request.error);
  }), revision);
}

const select = async (work, label) => work.page.locator('#object-selection').selectOption({ label });
const showProject = work => work.page.locator('#project-status').textContent();
async function stroke(work, start, end) {
  const canvas = work.page.locator('#viewport');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await work.page.mouse.move(box.x + start[0] * box.width, box.y + start[1] * box.height);
  await work.page.mouse.down();
  await work.page.mouse.move(box.x + end[0] * box.width, box.y + end[1] * box.height, { steps: 12 });
  await work.page.mouse.up();
  await work.ready();
  assert.match(await work.page.getByRole('status').textContent(), /Painted .* Base Color texels/);
}
const exportColor = async path => {
  const { files, manifest } = await unpack(path);
  return { hash: sha256(files[manifest.textures.find(texture => texture.semantic === 'BaseColor').file]),
    corners: sha256(files['uv-atlas-source-corners.bin']), paint: manifest.texturePaint, stats: manifest.meshes };
};

try {
  let work = await browser(profile);
  await work.open(staticInput, /f15_source .*4 triangles/);
  await unlink(staticInput);
  const cell = work.page.locator('#object-selection option').nth(1);
  const originalLabel = await cell.textContent();
  await select(work, originalLabel);
  const stableId = await work.page.locator('#object-selection').inputValue();
  const faces = await work.page.locator('#selection-details').textContent();
  assert.match(faces, /8 vertices · 4 faces/);
  await work.page.locator('#projection').selectOption('Orthographic');
  await work.page.locator('#view-direction').selectOption('Front');
  await work.page.locator('#frame-all').click();
  assert.match(await showProject(work), /Revision 0/);
  await work.page.locator('#projection').selectOption('Perspective');
  await work.page.locator('#view-direction').selectOption('Oblique');
  await work.page.locator('#object-label').fill('Panel study');
  await work.click('#rename-object', /Object label applied/);
  await work.click('#undo-stroke', /Undid Object label/);
  assert.equal(await work.page.locator('#object-label').inputValue(), originalLabel);
  await work.click('#redo', /Redid Object label/);
  assert.equal(await work.page.locator('#object-label').inputValue(), 'Panel study');
  await work.click('#object-visibility', /Object visibility applied/);
  assert.equal(await work.page.locator('#object-visibility').textContent(), 'Show object');
  await work.click('#object-visibility', /Object visibility applied/);
  await work.page.locator('#project-settings summary').click();
  await work.page.locator('#history-budget').fill('128');
  await work.page.locator('#history-budget').press('Tab');
  await work.page.locator('#project-settings summary').click();
  work.page.once('dialog', dialog => dialog.dismiss());
  await work.page.locator('#close-model').click();
  assert.match(await showProject(work), /Unsaved changes/);
  const beforeCancel = await showProject(work);
  await work.page.evaluate(() => {
    document.querySelector('#unwrap').click();
    document.querySelector('#cancel-job').click();
  });
  await work.ready();
  assert.match(await work.page.getByRole('status').textContent(), /Operation cancelled/);
  assert.equal(await showProject(work), beforeCancel);
  await work.click('#unwrap', /Generated 2 charts/);
  await work.click('#rebake', /Rebaked 1 map/);
  await work.click('#paint', /Drag on the model/);
  await work.page.locator('#paint-color').fill('#28f758');
  await stroke(work, [.49, .48], [.49, .55]);
  const supportsContextLoss = await work.page.evaluate(() => {
    const extension = document.querySelector('#viewport').getContext('webgl2').getExtension('WEBGL_lose_context');
    if (!extension) return false;
    window.restoreProbeContext = () => extension.restoreContext();
    extension.loseContext();
    return true;
  });
  if (supportsContextLoss) {
    await work.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('WebGL context lost.'));
    await work.page.evaluate(() => window.restoreProbeContext());
    await work.page.waitForFunction(() => document.querySelector('#status').textContent === 'WebGL preview restored.');
  }
  const painted = await work.save('#export', 'static-before-restart.zip');
  await work.click('#undo-stroke', /Undid the last stroke/);
  await work.click('#redo', /Redid Brush stroke/);
  const paintedRedo = await work.save('#export', 'static-after-redo.zip');
  const paintReference = await exportColor(painted);
  assert.deepEqual(await exportColor(paintedRedo), paintReference);

  const path = await work.save('#save-project', 'static.assetfixer');
  const independent = await work.save('#save-copy', 'independent.assetfixer');
  const source = await unpack(path), copy = await unpack(independent);
  assert.equal(source.manifest.schemaVersion, 2);
  assert.equal(source.manifest.settings.historyBudget, 128 * 1024 * 1024);
  assert.notEqual(copy.manifest.id, source.manifest.id);
  assert.deepEqual(copy.manifest.working, source.manifest.working);
  const originalHash = source.manifest.originals[0].hash;
  assert.equal(originalHash, sha256(await readFile(staticOriginal)));
  assert.equal(sha256(source.files[`blobs/${originalHash}`]), originalHash);
  assert.equal(source.manifest.working.paint.hash, paintReference.hash);
  await work.autosave(`Autosaved revision ${source.manifest.revision}`);
  await corruptCheckpoint(work.page, source.manifest.revision + 1);
  await context.close();

  work = await browser(profile, true);
  await work.autosave('Skipped 1 damaged checkpoint');
  await work.click('#restore-autosave', /Autosave restored\. Undo history starts here/);
  assert.ok(await work.page.locator('#undo-stroke').isDisabled());
  await select(work, 'Panel study');
  assert.equal(await work.page.locator('#object-selection').inputValue(), stableId);
  assert.equal(await work.page.locator('#selection-details').textContent(), faces);
  const recovered = await work.save('#export', 'static-recovered.zip');
  assert.deepEqual(await exportColor(recovered), paintReference);
  await work.page.evaluate(() => {
    navigator.storage.estimate = async () => ({ quota: 1, usage: 1 });
  });
  await work.click('#object-visibility', /Object visibility applied/);
  await work.autosave('insufficient browser storage');
  const afterQuota = await work.save('#save-project', 'quota-download.assetfixer');
  const quotaProject = await unpack(afterQuota);
  assert.equal(quotaProject.manifest.working.objects[stableId].visible, false);

  const versioned = async (name, adjust) => {
    const contents = { ...source.files };
    const manifest = structuredClone(source.manifest);
    adjust(manifest, contents);
    contents['manifest.json'] = strToU8(JSON.stringify(manifest));
    const file = join(out, `${name}.assetfixer`);
    await writeFile(file, zipSync(contents));
    return file;
  };
  await work.open(await versioned('newer-schema', data => { data.schemaVersion = 999; }), /newer than this application supports/);
  await work.open(await versioned('damaged-resource', (_data, files) => {
    const name = `blobs/${originalHash}`;
    files[name] = files[name].slice();
    files[name][0] ^= 1;
  }), /Invalid project resource hash or size/);
  assert.match(await showProject(work), new RegExp(`Revision ${quotaProject.manifest.revision}`));
  await work.open(await versioned('schema-v1', data => { data.schemaVersion = 1; delete data.settings; }), /Project restored/);
  const migrated = await unpack(await work.save('#save-project', 'migrated.assetfixer'));
  assert.equal(migrated.manifest.schemaVersion, 2);
  assert.equal(migrated.manifest.settings.historyBudget, 256 * 1024 * 1024);
  await work.open(path, /Project restored/);
  const restored = await work.save('#export', 'static-restored.zip');
  assert.deepEqual(await exportColor(restored), paintReference);
  assert.ok(await work.page.locator('#undo-stroke').isDisabled());
  report.static = { stableId, revision: source.manifest.revision, sourceHash: originalHash, paint: paintReference, supportsContextLoss,
    quotaFileRevision: quotaProject.manifest.revision, migratedSchema: migrated.manifest.schemaVersion };
  await context.close();

  work = await browser(skinProfile);
  await work.open(skinInput, /shared_skin .*3 bones · 1 clips/);
  const skinPath = await work.save('#save-project', 'animated.assetfixer');
  await context.close();
  await unlink(skinInput);
  work = await browser(skinProfile, true);
  await work.open(skinPath, /shared_skin .*3 bones · 1 clips.*Project restored/);
  const skinExport = await unpack(await work.save('#export', 'animated-restored.zip'));
  assert.equal(skinExport.manifest.meshes.meshes, 2);
  assert.equal(skinExport.manifest.meshes.clips, 1);
  report.animated = skinExport.manifest.meshes;
  await work.open(glbInput, /meshy-gambit-pawn-lo .*28[\d\s,]*069 triangles/);
  const glbPath = await work.save('#save-project', 'meshy.assetfixer');
  const glbProject = await unpack(glbPath);
  assert.equal(glbProject.manifest.originals[0].hash, sha256(await readFile(glbOriginal)));
  await context.close();
  await unlink(glbInput);
  work = await browser(skinProfile, true);
  await work.open(glbPath, /28[\d\s,]*069 triangles.*Project restored/);
  const glbExport = await work.save('#export', 'meshy-restored.glb');
  report.glb = { sourceHash: glbProject.manifest.originals[0].hash, exportHash: sha256(await readFile(glbExport)) };
  if (heavyFixture) {
    await context.close();
    const heavyProfile = await mkdtemp(join(out, 'heavy-profile-'));
    const heavyInput = join(out, 'f18_paint.zip');
    await copyFile(resolve(heavyFixture), heavyInput);
    work = await browser(heavyProfile);
    await work.open(heavyInput, /250[\d\s,]*000 triangles/);
    await unlink(heavyInput);
    await work.click('#unwrap', /Generated 1 charts/);
    await work.click('#rebake', /Rebaked 1 map/);
    await work.click('#paint', /Drag on the model/);
    for (let i = 0; i < 8; i++) {
      await work.page.locator('#paint-color').fill(i % 2 ? '#faba21' : '#1ce4ea');
      const x = .43 + i * .018, y = i % 2 ? .48 : .43;
      await stroke(work, [x, y], [x + .016, y + .025]);
    }
    await work.click('#undo-stroke', /Undid the last stroke/);
    await work.click('#undo-stroke', /Undid the last stroke/);
    await work.click('#redo', /Redid Brush stroke/);
    const reference = await exportColor(await work.save('#export', 'f18-before-restart.zip'));
    assert.equal(reference.paint.strokes, 7);
    const heavyPath = await work.save('#save-project', 'f18.assetfixer');
    const heavy = await unpack(heavyPath);
    await work.autosave(`Autosaved revision ${heavy.manifest.revision}`);
    await context.close();
    work = await browser(heavyProfile, true);
    await work.page.locator('#restore-autosave').waitFor({ state: 'visible' });
    await work.click('#restore-autosave', /Autosave restored/);
    assert.deepEqual(await exportColor(await work.save('#export', 'f18-recovered.zip')), reference);
    assert.ok(await work.page.locator('#undo-stroke').isDisabled());
    report.heavy = { revision: heavy.manifest.revision, sourceHash: heavy.manifest.originals[0].hash, ...reference };
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  assert.deepEqual(offlineRequests, []);
  await writeFile(join(out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  await app.close();
}
