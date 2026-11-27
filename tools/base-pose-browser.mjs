import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const [executablePath, tripo = 'D:/downloads/Tripo', character = 'test-results/e00/ufbx/data/maya_kenney_character_7700_binary.fbx'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/base-pose'), build = resolve('dist');
const scenario = process.env.BASE_POSE_CASE;
const run = name => !scenario || name === scenario;
const report = {};
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ viewport: { width: 1550, height: 1550 } });
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
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 180000 });
  const check = async (id, message) => assert.match(await read(id), message, id);
  const act = async (id, message) => { await click(id); await ready(); await check('status', message); };
  const open = async (path, message) => { await field('sources').setInputFiles(path); await ready(); await check('status', message); };
  const enter = async kind => { if (await field(`${kind}-tools`).isHidden()) await click(`${kind}-mode`); };
  const details = async id => { if (await field(id).getAttribute('open') === null) await field(id).locator('summary').click(); };
  const manifest = files => JSON.parse(strFromU8(files['manifest.json']));
  const downloadBytes = async (id, name) => {
    const path = join(output, name);
    const [event] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), click(id)]);
    await event.saveAs(path);
    await ready();
    return readFile(path);
  };
  const download = async (id, name) => unzipSync(await downloadBytes(id, name));
  const extractFbx = async (files, name) => {
    const folder = join(output, name);
    await mkdir(folder, { recursive: true });
    for (const [file, bytes] of Object.entries(files)) {
      if (!/\.(fbx|png|jpe?g)$/i.test(file)) continue;
      const path = join(folder, file);
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, bytes);
    }
    return files['manifest.json'] ? manifest(files) : undefined;
  };
  const exportFbx = async name => extractFbx(await download('export', `${name}.zip`), name);
  const rotate = async (jointName, angle) => {
    await enter('rig');
    await choose('rig-edit-mode', 'pose');
    const joints = await field('rig-joint').locator('option').evaluateAll(options => options.map(item => ({ name: item.text.trim(), value: item.value })));
    const selected = joints.find(item => jointName.test(item.name));
    assert.ok(selected, `Joint ${jointName} missing: ${joints.map(item => item.name).join(', ')}`);
    assert.equal(await field('rig-bake-base').isDisabled(), true);
    await choose('rig-joint', selected.value);
    await choose('rig-space', 'local');
    await fill('rig-z', angle);
    await act('rig-apply', /Rotate manual pose joint applied/);
    return selected;
  };
  const adapt = async pattern => {
    await details('rig-clips');
    await act('rig-adapt', /Save adapted clip applied/);
    await check('rig-clip-info', pattern);
  };
  const reopen = async (name, checkArchive, writeExport = exportFbx) => {
    const project = `${name}.assetfixer`;
    const files = await download('save-project', project), archive = manifest(files);
    const edits = strFromU8(files[`blobs/${archive.working.meshEdits}`]).trim().split('\n').map(row => JSON.parse(row));
    checkArchive(archive, edits);
    await open(join(output, project), /Project restored/);
    return writeExport(`${name}-reopened`);
  };

  if (run('shared')) {
    const original = resolve('tools/e00/fixtures/shared_skin.fbx');
    await open(original, /124 triangles/);
    await enter('rig');
    await choose('rig-edit-mode', 'pose');
    await fill('rig-pose-name', 'Original rest');
    await act('rig-save', /Save saved pose applied/);
    const spine = await rotate(/^Spine$/, 20);
    await act('rig-bake-base', /2 bound meshes.*1 affected clips/);
    await act('export', /Clip export blocked/);
    await act('undo-stroke', /Undid.*Bake current base pose/);
    assert.equal(await field('rig-bake-base').isEnabled(), true);
    await act('redo', /Redid.*Bake current base pose/);
    assert.equal(await field('rig-bake-base').isDisabled(), true);
    await choose('rig-edit-mode', 'rest');
    assert.equal(await field('rig-reset').isDisabled(), true);
    await adapt(/SharedTorsoBend_Adapted_1/);
    await exportFbx('shared');
    await reopen('shared', (archive, edits) => {
      assert.equal(archive.schemaVersion, 20);
      assert.equal(edits.filter(edit => edit.type === 'bakeBase').length, 2);
      assert.equal(archive.working.rig.bakedGroups.length, 1);
      assert.equal(Object.keys(archive.working.poses.current).length, 0);
      assert.ok(spine.value in archive.working.poses.saved[0].rotations);
    });
    assert.deepEqual(await downloadBytes('export-original', 'shared-immutable.fbx'), await readFile(original));
    report.shared = { undoRedo: true, schema: 20, preservedSavedPose: true, clipAdaptation: true };
    console.log('Shared rig passed browser checks.');
  }

  if (run('plate')) {
    const source = join(tripo, 'ceramic plate 3d model.zip');
    await extractFbx(unzipSync(await readFile(source)), 'plate-source');
    await open(source, /9\s?138 triangles/);
    await choose('object-selection', { index: 1 });
    await enter('mesh');
    await choose('mesh-kind', 'face');
    await choose('mesh-operation', 'extrude');
    await fill('mesh-extrude-depth', .0002);
    let face;
    for (const id of [1, 8, 29, 105, 279, 619, 1214, 2000]) {
      await fill('mesh-ids', id);
      await click('mesh-preview');
      if (await field('mesh-apply').isEnabled()) { face = id; break; }
    }
    assert.ok(face, await read('mesh-info'));
    await act('mesh-apply', /Extrude applied/);
    await enter('uv');
    await choose('uv-size', '1024');
    await act('uv-unwrap', /Generated UVs in the draft/);
    await choose('uv-operation', 'relax');
    await click('uv-select-all');
    await fill('uv-relax-iterations', 1);
    let relaxed;
    for (const strength of [.2, .05, .01, .001]) {
      await fill('uv-relax-strength', strength);
      await click('uv-run');
      relaxed = await read('uv-info');
      if (/Relaxed [1-9]/.test(relaxed)) break;
    }
    assert.match(relaxed, /Relaxed [1-9]/);
    await choose('uv-mode-select', 'preserve');
    await field('uv-missing').check();
    await act('uv-apply', /UVs and \d maps applied/);
    const result = await exportFbx('plate');
    assert.equal(result.meshes.triangles, 9144);
    const restored = await reopen('plate', (_, edits) => assert.ok(edits.some(edit => edit.type === 'extrude')));
    assert.deepEqual(restored.meshes, result.meshes);
    report.plate = { face, relaxed, textureBake: result.textureBake, triangles: result.meshes.triangles };
    console.log('Tripo plate passed browser checks.');
  }

  if (run('character')) {
    await open(resolve(character), /1\s?604 triangles.*45 bones/);
    await rotate(/^Spine$/, 10);
    assert.equal(await field('rig-bake-base').isDisabled(), true);
    await check('rig-info', /imported rest transforms require shear or contain a singular joint/);
    await act('rig-reset-pose', /Reset manual pose applied/);
    await choose('object-selection', { index: 1 });
    await enter('mesh');
    await choose('mesh-kind', 'vertex');
    await choose('mesh-operation', 'move');
    await fill('mesh-ids', 100);
    await fill('mesh-y', .03125);
    await click('mesh-preview');
    await check('mesh-info', /Preview/);
    await act('mesh-apply', /Move applied/);
    const result = await exportFbx('character');
    assert.deepEqual(result.meshes, { meshes: 1, triangles: 1604, bones: 45, clips: 1 });
    const restored = await reopen('character', (_, edits) => assert.deepEqual(edits, [
      { object: edits[0].object, type: 'move', vertices: [100], value: [0, .03125, 0] },
    ]));
    assert.deepEqual(restored.meshes, result.meshes);
    report.character = { controlPoint: 100, offsetY: .03125, triangles: 1604, bones: 45, originalClips: 1, unsupportedRestTransformGuard: true };
    console.log('Kenney animated character passed browser checks.');
  }

  if (run('tripo')) {
    const input = join(tripo, 'man character 3d model.glb');
    await open(input, /17\s?623 triangles.*67 bones/);
    const joint = await rotate(/^left.*upper.*arm/i, 15);
    assert.equal(await field('rig-bake-base').isEnabled(), true, await read('rig-info'));
    await act('rig-bake-base', /1 bound meshes/);
    const exportGlb = name => downloadBytes('export', `${name}.glb`);
    const exported = await exportGlb('tripo');
    const restored = await reopen('tripo', archive => assert.equal(archive.working.rig.bakedGroups.length, 1), exportGlb);
    assert.deepEqual(restored, exported);
    report.tripo = { joint: joint.name, degrees: 15, triangles: 17623, bones: 67 };
    console.log('Tripo rigged character passed browser checks.');
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(join(output, `browser-${scenario ?? 'all'}.json`), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
