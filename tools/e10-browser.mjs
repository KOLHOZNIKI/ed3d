import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { preview } from 'vite';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const dir = resolve('test-results/e10'), fixtures = resolve('tools/e00/fixtures');
const server = await preview({ preview: { host: '127.0.0.1', port: 4295 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const external = [], errors = [];
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1550, height: 1600 } });
  await context.route(/^https?:/, route => {
    const requested = route.request().url();
    if (requested.startsWith(url)) return route.continue();
    external.push(requested);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const text = id => field(id).textContent();
  const choose = (id, value) => field(id).selectOption(value);
  const fill = (id, value) => field(id).fill(String(value));
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 120000 });
  const check = async (actual, expected, id) => assert.match(actual ?? '', expected, `${id}: ${actual} / ${await text('weights-info')}`);
  const run = async (id, pattern, message = 'status') => { await click(id); await ready(); await check(await text(message), pattern, id); };
  const open = async (path, pattern) => { await field('sources').setInputFiles(path); await ready(); await check(await text('status'), pattern, path); };
  const enter = async () => { if (await field('weights-tools').isHidden()) await click('weights-mode'); };
  async function option(id, label) {
    const rows = await field(id).locator('option').evaluateAll(options => options.map(item => ({ name: item.text.trim().split(' · ')[0], value: item.value })));
    const row = rows.find(item => item.name === label);
    assert.ok(row, `Missing ${label} from ${id} (${rows.map(item => item.name).join(', ')})`);
    return row.value;
  }
  const joint = async label => choose('weights-joint', await option('weights-joint', label));
  async function details(id) {
    if (await field(id).getAttribute('open') === null) await field(id).locator('summary').click();
  }
  async function download(id, name) {
    const [result] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), click(id)]);
    const path = join(dir, name);
    await result.saveAs(path);
    await ready();
    return readFile(path);
  }
  async function project(name) {
    const zip = unzipSync(await download('save-project', name));
    const manifest = JSON.parse(strFromU8(zip['manifest.json']));
    assert.equal(manifest.schemaVersion, 12);
    const path = manifest.working.meshEdits;
    const log = path ? strFromU8(zip[`blobs/${path}`]).trim().split('\n').map(line => JSON.parse(line)) : [];
    return { manifest, log };
  }
  const resultRow = (change, vertex) => new Map(change.rows.find(([id]) => id === vertex)[1]);
  const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

  await open(join(fixtures, 'corpus/f11_wide_torso.glb'), /8 bones/);
  await enter();
  const viewport = field('viewport');
  const pelvisHeatmap = await viewport.screenshot();
  await joint('LeftArm');
  assert.notDeepEqual(await viewport.screenshot(), pelvisHeatmap);
  const pelvis = await option('weights-joint', 'Pelvis'), head = await option('weights-joint', 'Head'), arm = await option('weights-joint', 'LeftArm');
  await fill('weights-vertices', '24');
  await joint('Head');
  await fill('weights-value', '.125');
  await run('weights-numeric', /Set exact skin weight applied/);
  await joint('Pelvis');
  await field('weights-lock').check();
  await ready();
  await joint('LeftArm');
  await fill('weights-value', '.2');
  const revision = await text('project-status');
  await run('weights-numeric', /exceed 4 influences/, 'weights-info');
  assert.equal(await text('project-status'), revision);
  assert.match(await text('weights-issues'), /Vertex IDs 24/);
  await details('weights-limit-tools');
  await choose('weights-policy', 'replace');
  await choose('weights-replace', pelvis);
  await run('weights-numeric', /replacement influence is locked/i, 'weights-info');
  await choose('weights-replace', head);
  await run('weights-numeric', /Set exact skin weight applied/);
  const { manifest, log } = await project('overflow.assetfixer');
  assert.deepEqual(manifest.working.weightLocks, [pelvis]);
  assert.equal(log.length, 2);
  const before = resultRow(log[0], 24), after = resultRow(log[1], 24);
  assert.equal(after.get(pelvis), before.get(pelvis));
  assert.equal(after.get(arm), .2);
  assert.equal(after.has(head), false);
  await download('export', 'torso-replaced.glb');
  await open(join(dir, 'overflow.assetfixer'), /Project restored/);
  await enter();
  await joint('Pelvis');
  assert.ok(await field('weights-lock').isChecked());
  await run('weights-find', /All active vertices satisfy/, 'weights-info');

  const fingerSource = join(dir, 'fingers.fbx');
  await open(fingerSource, /8 triangles.*3 bones.*1 clips/);
  await enter();
  const palm = await option('weights-joint', 'Palm'), left = await option('weights-joint', 'LeftFinger'), right = await option('weights-joint', 'RightFinger');
  await choose('view-direction', 'Front');
  await choose('weights-brush', 'smooth');
  await fill('weights-radius', '9');
  await fill('weights-strength', '100');
  await fill('weights-hardness', '100');
  await fill('weights-faces', 'F0, F1, F2, F3');
  await choose('weights-pose', await option('weights-pose', 'FingerBend'));
  await fill('weights-time', '.5');
  await field('weights-time').press('Tab');
  async function brush(x, y, move = false, width = .54, height = 1) {
    await viewport.scrollIntoViewIfNeeded();
    const bounds = await viewport.boundingBox(), z = 3.5 * Math.hypot(width, height) / 2;
    const frameHeight = Math.min(bounds.height, bounds.width * 3 / 4);
    const scale = frameHeight / (2 * z * Math.tan(20 * Math.PI / 180));
    const clientX = bounds.x + bounds.width / 2 + x * scale, clientY = bounds.y + bounds.height / 2 - (y - height / 2) * scale;
    await page.mouse.move(clientX, clientY);
    await page.mouse.down();
    if (move) await page.mouse.move(clientX + 3, clientY, { steps: 3 });
    await page.mouse.up();
    await ready();
  }
  const cx = -.145 + (.125 * Math.cos(.6) - .2 * Math.sin(.6));
  const cy = .3 + (.125 * Math.sin(.6) + .2 * Math.cos(.6));
  await brush((cx - .02) / 2, (cy + .5) / 2, true);
  await check(await text('status'), /Smooth weight stroke applied/, 'frozen brush');
  const { log: smooth } = await project('fingers.assetfixer');
  assert.equal(smooth.length, 1);
  assert.deepEqual(smooth[0].rows.map(([id]) => id), [4]);
  close(resultRow(smooth[0], 4).get(palm), .625);
  await download('export', 'fingers-smooth.zip');
  await run('undo-stroke', /Undid.*Smooth weight stroke/);
  await download('export', 'fingers-undone.zip');
  await run('redo', /Redid.*Smooth weight stroke/);
  await run('undo-stroke', /Undid.*Smooth weight stroke/);
  await choose('weights-pose', 'rest');
  await fill('weights-faces', '');
  await fill('weights-radius', '27');
  await field('weights-xray').check();
  await brush(0, .5);
  await check(await text('status'), /Smooth weight stroke applied/, 'both fingers');
  const { log: both } = await project('fingers-both.assetfixer');
  assert.deepEqual(both.at(-1).rows.map(([id]) => id).sort((a, b) => a - b), [4, 7]);
  await run('undo-stroke', /Undid/);
  await fill('weights-radius', '9');
  await brush(-.02, .5);
  await check(await text('status'), /Smooth weight stroke applied/, 'restore left edit');

  await details('weights-mirror-tools');
  await fill('weights-vertices', '7');
  await fill('weights-mirror-pairs', `${left}=${right}, ${palm}=${palm}`);
  await run('weights-mirror', /Mirror skin weights applied/);
  const { log: mirrored } = await project('fingers-mirror.assetfixer');
  close(resultRow(mirrored.at(-1), 7).get(right), .375);
  await details('weights-transfer-tools');
  await run('weights-capture', /Captured 12 logical weight rows/, 'weights-info');
  await joint('RightFinger');
  await fill('weights-value', '.9');
  await run('weights-numeric', /Set exact skin weight applied/);
  await fill('weights-source-faces', '4,5,6,7');
  await run('weights-transfer', /Transfer skin weights applied/);
  const { log: transferred } = await project('fingers-transfer.assetfixer');
  close(resultRow(transferred.at(-1), 7).get(right), .375, 1e-5);

  await click('mesh-mode');
  await choose('mesh-kind', 'edge');
  await fill('mesh-ids', '1/4');
  await field('mesh-ids').press('Tab');
  await choose('mesh-operation', 'splitEdge');
  await fill('mesh-fraction', '.5');
  await click('mesh-preview');
  await run('mesh-apply', /Split Edge applied/i);
  await enter();
  await joint('Palm');
  await fill('weights-vertices', '12');
  await fill('weights-value', '.5625');
  await run('weights-numeric', /already has these weights/i, 'weights-info');

  await open(join(dir, 'fingers-invalid.fbx'), /8 triangles/);
  await enter();
  await run('weights-find', /2 vertices need attention/, 'weights-info');
  assert.match(await text('weights-issues'), /3 \(zero sum\), 4 \(non-unit sum\)/);
  await fill('weights-vertices', '3');
  await details('weights-limit-tools');
  await choose('weights-fallback', '');
  const invalidRevision = await text('project-status');
  await run('weights-normalize', /Choose a fallback joint/, 'weights-info');
  assert.equal(await text('project-status'), invalidRevision);
  await choose('weights-fallback', left);
  await run('weights-normalize', /Normalize skin weights applied/);
  await joint('Palm');
  await field('weights-lock').check();
  await ready();
  await fill('weights-vertices', '4');
  await run('weights-normalize', /Normalize skin weights applied/);
  const { log: normalized } = await project('fingers-normalized.assetfixer');
  assert.deepEqual([...resultRow(normalized[0], 3)], [[left, 1]]);
  assert.equal(resultRow(normalized[1], 4).get(palm), .5);
  assert.equal(resultRow(normalized[1], 4).get(left), .5);
  await run('weights-find', /All active vertices satisfy/, 'weights-info');

  await open(join(fixtures, 'f13_wide_skin.fbx'), /Approximate skin preview: 2 control points/);
  await enter();
  await run('weights-find', /2 vertices need attention/, 'weights-info');
  await joint('Joint1');
  await field('weights-lock').check();
  await ready();
  await fill('weights-vertices', '2,3');
  await run('weights-normalize', /Convert the wide row explicitly/, 'weights-info');
  await choose('weights-pose', await option('weights-pose', 'FifthInfluenceBend'));
  await fill('weights-time', '.25');
  await field('weights-time').press('Tab');
  await details('weights-limit-tools');
  const prior = await text('project-status');
  await run('weights-convert', /2 vertices.*dropped mass 0\.1875.*peak deformation change (?!0 scene)/, 'weights-info');
  assert.equal(await text('project-status'), prior);
  await run('weights-confirm', /Convert skin influence limit applied/);
  await download('export', 'wide-converted.zip');
  await run('undo-stroke', /Undid.*Convert skin influence limit/);
  await download('export', 'wide-undone.zip');

  await choose('weights-pose', 'rest');
  await choose('view-direction', 'Front');
  await joint('Joint1');
  await field('weights-lock').uncheck();
  await ready();
  await fill('weights-vertices', '0');
  await fill('weights-value', '.125');
  for (const name of ['Joint2', 'Joint3', 'Joint4']) {
    await joint(name);
    await run('weights-numeric', /Set exact skin weight applied/);
  }
  await joint('Joint1');
  await field('weights-lock').check();
  await ready();
  await joint('Joint5');
  await choose('weights-policy', 'reject');
  await choose('weights-brush', 'add');
  await fill('weights-strength', '20');
  await fill('weights-radius', '9');
  await field('weights-xray').check();
  const paintRevision = await text('project-status');
  await brush(-.25, 0, false, .5, 1.5);
  await check(await text('weights-info'), /exceed 4 influences/, 'fifth influence brush');
  assert.match(await text('weights-issues'), /Vertex IDs 0/);
  assert.equal(await text('project-status'), paintRevision);

  await open(join(fixtures, 'shared_skin.fbx'), /124 triangles/);
  await click('rig-mode');
  await choose('rig-edit-mode', 'rest');
  await choose('rig-joint', await option('rig-joint', 'Pelvis'));
  await details('rig-structure');
  await fill('rig-name', 'WeightHelper');
  await run('rig-add', /Add child joint applied/);
  await details('rig-clips');
  await run('rig-exclude', /Set clip export mode applied/);
  await enter();
  const helper = await option('weights-joint', 'WeightHelper');
  await joint('WeightHelper');
  await fill('weights-vertices', '16');
  await fill('weights-value', '.2');
  await run('weights-numeric', /Set exact skin weight applied/);
  const { log: weightedHelper } = await project('weighted-helper.assetfixer');
  close(resultRow(weightedHelper[0], 16).get(helper), .2);
  await download('export', 'weighted-helper.zip');
  await open(join(dir, 'weighted-helper.assetfixer'), /Project restored/);
  await click('rig-mode');
  await details('rig-structure');
  await choose('rig-joint', await option('rig-joint', 'WeightHelper'));
  await choose('rig-other', await option('rig-other', 'Pelvis'));
  await run('rig-delete', /Delete joint and transfer weights applied/);
  await enter();
  assert.equal(await field('weights-joint').locator('option').count(), 3);
  await run('weights-find', /All active vertices satisfy/, 'weights-info');
  await download('export', 'weighted-helper-deleted.zip');
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  const report = { fifthInfluenceRejected: true, lockedReplacementRejected: true, locksPersisted: true, frozenSmooth: [4],
    broadSmooth: [4, 7], heatmap: true, mirror: true, snapshotTransfer: true, splitsInterpolateEditedWeights: true,
    zeroWeightsRequireFallback: true, normalizationKeepsLocks: true,
    wideConversionUndo: true, addedJointWeights: true,
    externalRequests: external.length, browserErrors: errors.length };
  await writeFile(join(dir, 'browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.httpServer.close(resolveClose));
}
