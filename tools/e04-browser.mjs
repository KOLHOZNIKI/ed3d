import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { decode } from 'fast-png';
import { preview } from 'vite';

const [executablePath, tripo = 'D:/downloads/Tripo'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const dir = resolve('test-results/e04');
const contours = JSON.parse(await readFile(join(dir, 'contours.json'), 'utf8'));
const app = await preview({ preview: { host: '127.0.0.1', port: 4287 } });
const url = `http://127.0.0.1:${app.httpServer.address().port}/`;
const errors = [], outside = [];
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1450 } });
  await context.route(/^https?:/, route => {
    if (route.request().url().startsWith(url)) return route.continue();
    outside.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const choose = (id, value) => field(id).selectOption(value);
  const text = id => field(id).textContent();
  const fill = async (id, value) => {
    await field(id).fill(String(value));
    await field(id).press('Tab');
  };
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled);
  const open = async (file, message) => {
    await field('sources').setInputFiles(file);
    await ready();
    const status = await text('status');
    assert.ok(status.includes(message), `${file}: expected ${message}, got ${status}`);
  };
  const start = async () => { await choose('object-selection', { index: 1 }); await click('mesh-mode'); };
  const ids = async (kind, values) => { await choose('mesh-kind', kind); await fill('mesh-ids', values.join(', ')); };
  const preview = async type => { await choose('mesh-operation', type); await click('mesh-preview'); return text('mesh-info'); };
  const apply = async () => { await click('mesh-apply'); await ready(); assert.match(await text('status'), /applied\./); };
  const undo = async () => { await click('undo-stroke'); await ready(); };
  const redo = async () => { await click('redo'); await ready(); };
  const download = async (id, name) => {
    const [file] = await Promise.all([page.waitForEvent('download'), click(id)]);
    await file.saveAs(join(dir, name));
    await ready();
    return readFile(join(dir, name));
  };
  const bundle = async name => {
    const zip = unzipSync(await download('export', name));
    return { zip, manifest: JSON.parse(strFromU8(zip['manifest.json'])) };
  };

  const seamPath = resolve('tools/e00/fixtures/topology_seams.zip');
  const source = unzipSync(await readFile(seamPath));
  await open(seamPath, '13 triangles');
  await start();
  await ids('vertex', [0]);
  await fill('mesh-y', .03125);
  await click('mesh-preview');
  assert.match(await text('mesh-info'), /6 existing faces affected/);
  await apply();
  const moved = await bundle('seam-moved.zip');
  assert.equal(moved.manifest.meshes.triangles, 13);
  assert.deepEqual(moved.zip[moved.manifest.textures[0].file], source['topology_seams.fbm/Checker.png']);

  await ids('edge', ['0/1']);
  assert.match(await preview('splitEdge'), /2 existing faces affected/);
  await apply();
  const split = await bundle('seam-split.zip');
  assert.equal(split.manifest.meshes.triangles, 15);
  await undo();
  assert.equal((await bundle('split-undone.zip')).manifest.meshes.triangles, 13);
  await redo();
  await ids('edge', ['0/11']);
  assert.match(await preview('dissolve'), /discontinuity/);

  await ids('vertex', [0, 8]);
  await choose('mesh-operation', 'weld');
  await choose('mesh-weld-mode', 'tolerance');
  await click('mesh-preview');
  assert.match(await text('mesh-info'), /no selected vertices within the weld tolerance/);
  await fill('mesh-tolerance', .05);
  await click('mesh-preview');
  assert.match(await text('mesh-info'), /Preview/);
  await apply();
  await bundle('seam-welded.zip');

  await ids('face', [12]);
  await click('mesh-connected');
  assert.equal(await field('mesh-ids').inputValue(), '12');
  assert.match(await preview('separate'), /1 in the new object/);
  await apply();
  assert.equal(await field('object-selection').inputValue(), 'object-1');
  assert.equal((await bundle('seam-separated.zip')).manifest.meshes.meshes, 2);
  await click('object-visibility');
  await ready();
  assert.match(await field('object-selection').locator('option:checked').textContent(), /hidden/);
  await download('save-project', 'seam.assetfixer');
  await open(join(dir, 'seam.assetfixer'), 'Project restored');
  assert.equal((await bundle('seam-reopened.zip')).manifest.meshes.meshes, 2);
  assert.match(await field('object-selection').locator('option[value="object-1"]').textContent(), /hidden/);

  await open(join(dir, 'holes.zip'), '26 triangles');
  await start();
  await choose('projection', { label: 'Orthographic' });
  await choose('view-direction', { label: 'Front' });
  await choose('mesh-kind', 'face');
  const viewport = field('viewport');
  await viewport.scrollIntoViewIfNeeded();
  const rect = await viewport.boundingBox();
  await page.mouse.click(rect.x + .50 * rect.width, rect.y + .42 * rect.height);
  assert.match(await field('mesh-ids').inputValue(), /^\d+$/);
  await ids('vertex', [0]);
  await choose('mesh-operation', 'move');
  await choose('mesh-axis', 'X');
  const gizmo = decode(await viewport.screenshot());
  const red = [];
  for (let i = 0; i < gizmo.width * gizmo.height; i++) {
    const [r, g, b] = gizmo.data.subarray(i * gizmo.channels, i * gizmo.channels + 3);
    if (r > 180 && g < 125 && b < 125) red.push([i % gizmo.width, Math.floor(i / gizmo.width)]);
  }
  assert.ok(red.length > 5, 'The X gizmo axis was not rendered.');
  red.sort((a, b) => a[0] - b[0]);
  const [gx, gy] = red[Math.floor(red.length / 2)];
  const toolRect = await viewport.boundingBox();
  const sx = toolRect.x + gx * toolRect.width / gizmo.width, sy = toolRect.y + gy * toolRect.height / gizmo.height;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy, { steps: 8 });
  await page.mouse.up();
  assert.ok(Number(await field('mesh-x').inputValue()) > 0, await text('mesh-info'));
  assert.equal(Number(await field('mesh-y').inputValue()), 0);
  await click('mesh-cancel');
  await choose('mesh-axis', '');
  assert.equal((await bundle('gizmo-cancelled.zip')).manifest.meshes.triangles, 26);
  await ids('vertex', contours[0].slice().reverse());
  assert.match(await preview('create'), /same direction/);
  await click('mesh-winding');
  assert.match(await text('mesh-info'), /requires UV unwrapping/);
  await apply();
  await ids('vertex', [contours[1][0], contours[1][2], contours[1][1], contours[1][3]]);
  assert.match(await preview('create'), /zero area|crosses itself/);
  await ids('vertex', contours[1]);
  await field('mesh-project').check();
  assert.match(await preview('create'), /Preview/);
  await apply();
  await ids('vertex', contours[2]);
  assert.match(await preview('create'), /Preview/);
  await apply();
  const filled = await bundle('holes-filled.zip');
  assert.equal(filled.manifest.meshes.triangles, 33);
  assert.match(await text('mesh-export-note'), /1 created faces/);
  await page.locator('#viewport').screenshot({ path: join(dir, 'filled.png') });

  await ids('vertex', contours[2]);
  await choose('mesh-operation', 'rotate');
  await choose('mesh-axis', 'Z');
  await fill('mesh-z', 5);
  await click('mesh-preview');
  assert.match(await text('mesh-info'), /Preview/);
  await page.keyboard.press('Escape');
  assert.ok(await field('mesh-apply').isDisabled());
  await click('mesh-preview');
  await page.keyboard.press('Enter');
  await ready();
  assert.match(await text('status'), /Rotate applied/);
  await undo();
  await choose('mesh-operation', 'scale');
  await choose('mesh-axis', 'Y');
  await fill('mesh-y', 1.02);
  await click('mesh-preview');
  assert.match(await text('mesh-info'), /Preview/);
  await apply();
  await undo();
  await choose('mesh-axis', '');

  await ids('face', [14]);
  await ids('vertex', [contours[1][0], contours[1][2]]);
  assert.match(await preview('splitFace'), /16 → 17 faces/);
  await apply();
  let edge = `${contours[1][0]}/${contours[1][2]}`;
  await ids('edge', [edge]);
  assert.match(await preview('flipEdge'), /2 existing faces affected/);
  await apply();
  edge = `${contours[1][1]}/${contours[1][3]}`;
  await ids('edge', [edge]);
  assert.match(await preview('dissolve'), /17 → 16 faces/);
  await apply();
  await ids('face', [13]);
  assert.match(await preview('flipNormals'), /1 existing faces affected/);
  await apply();
  assert.match(await preview('recalculate'), /Preview/);
  await apply();
  assert.match(await preview('delete'), /16 → 15 faces/);
  await apply();
  await undo();
  await click('paint');
  await choose('paint-mask', 'created');
  assert.match(await text('paint-info'), /2 new faces with paintable UVs/);

  const animated = resolve('test-results/e03/paint_elbow.zip');
  await open(animated, '2 bones');
  await start();
  await ids('edge', ['1/2']);
  assert.match(await preview('splitEdge'), /4 → 4 faces/);
  await apply();
  const skin = await bundle('elbow-split.zip');
  assert.equal(skin.manifest.meshes.triangles, 6);
  assert.equal(skin.manifest.meshes.clips, 1);
  await undo();
  assert.equal((await bundle('elbow-undone.zip')).manifest.meshes.triangles, 4);
  await redo();
  await ids('face', [3]);
  assert.match(await preview('separate'), /1 in the new object/);
  await apply();
  const separated = await bundle('elbow-separated.zip');
  assert.deepEqual(separated.manifest.meshes, { meshes: 2, triangles: 6, bones: 2, clips: 1 });

  await open(join(tripo, 'man character 3d model.glb'), '67 bones');
  await start();
  await ids('vertex', [100]);
  await choose('mesh-operation', 'move');
  await fill('mesh-y', .0005);
  await click('mesh-preview');
  assert.match(await text('mesh-info'), /Preview/);
  await apply();
  await download('export', 'tripo-mesh-edited.glb');

  await open(join(dir, 'colored-morph.glb'), '2 triangles');
  await start();
  await ids('edge', ['1/2']);
  assert.match(await preview('splitEdge'), /2 existing faces affected/);
  await apply();
  await download('export', 'colored-morph-split.glb');

  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  const result = { chrome: browser.version(), seamTriangles: split.manifest.meshes.triangles,
    filledTriangles: filled.manifest.meshes.triangles, skinnedTriangles: skin.manifest.meshes.triangles,
    skinnedPieces: separated.manifest.meshes.meshes, offlineRequests: outside };
  await writeFile(join(dir, 'browser-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => app.httpServer.close(resolve));
}
