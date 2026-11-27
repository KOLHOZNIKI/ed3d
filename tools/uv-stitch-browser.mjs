import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { decode, encode } from 'fast-png';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { AnimationClip, Bone, BufferGeometry, Float32BufferAttribute, Mesh, MeshPhongMaterial, Quaternion,
  QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, Vector3 } from 'three';
import { preview } from 'vite';
import { glbFixture } from './e00/corpus-glb.mjs';

const [executablePath] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const directory = resolve('test-results/uv-stitch');
await mkdir(directory, { recursive: true });
const glb = glbFixture();
glb.mesh('Connected pair', [glb.primitive({ positions: [[0,0,0],[1,0,0],[1,1,0],[2,0,0]],
  indices: [0,1,2,1,3,2], uv: [[.125,.125],[.375,.125],[.375,.5],[.875,.125]] })]);
await writeFile(join(directory, 'connected.glb'), glb.finish());
const points = [0,0,0, 1,0,0, 1,1,0, 2,0,.5, 2,1,.5, 1,0,0, 0,-1,0, 2,-1,0];
const uv = [.125,.125, .375,.125, .375,.5, .625,.125, .875,.125, .625,.5, .875,.125, .875,.5, .625,.5,
  .375,.125, .25,.03125, .5,.03125];
const pixelData = new Uint8Array(64 * 64 * 3);
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixelData.set([4 * x, 4 * y, 80], (y * 64 + x) * 3);
const color = encode({ width: 64, height: 64, data: pixelData, channels: 3 });
for (const skinned of [false, true]) {
  const name = skinned ? 'skinned' : 'static';
  const geometry = new BufferGeometry(), scene = new Scene();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  const sloped = new Vector3(-.5, 0, 1).normalize().toArray();
  geometry.setAttribute('normal', new Float32BufferAttribute(
    Array.from({ length: 12 }, (_, i) => i >= 3 && i < 9 ? sloped : [0, 0, 1]).flat(), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.userData.assetFixerFbxPolygons = Int32Array.of(0, 1, ~2, 1, 3, ~2, 3, 4, ~2, 5, 6, ~7);
  const map = new Texture();
  map.name = 'Gradient';
  const material = new MeshPhongMaterial({ name: 'Gradient', map });
  const mesh = skinned ? new SkinnedMesh(geometry, material) : new Mesh(geometry, material);
  mesh.name = 'Fold and independent triangle';
  scene.add(mesh);
  if (mesh instanceof SkinnedMesh) {
    const root = new Bone(), bend = new Bone(), loads = [.25, .4, .6, .8, .9, .1, 0, 0];
    root.name = 'Base';
    bend.name = 'Bend';
    bend.position.x = 1;
    root.add(bend);
    mesh.add(root);
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(loads.flatMap(() => [0, 1, 0, 0]), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(loads.flatMap(load => [1 - load, load, 0, 0]), 4));
    scene.updateMatrixWorld(true);
    mesh.bind(new Skeleton([root, bend]));
    const axis = new Vector3(0, 1, 0);
    scene.animations = [new AnimationClip('OpenFold', 1, [new QuaternionKeyframeTrack('Bend.quaternion', [0, .5, 1],
      [0, .55, -.1].flatMap(angle => new Quaternion().setFromAxisAngle(axis, angle).toArray()))])];
  }
  const path = `${name}.fbm/Gradient.png`;
  const fbx = new FBXExporter().register(plan => {
    for (const entry of plan.textures.textures.values()) entry.fileName = path;
  }).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
  await writeFile(join(directory, `${name}-source.zip`), zipSync({ [`${name}.fbx`]: new Uint8Array(fbx), [path]: color }));
  await writeFile(join(directory, `${name}-source.fbx`), new Uint8Array(fbx));
}

const server = await preview({ preview: { host: '127.0.0.1', port: 4299 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1250 } });
  const external = [], errors = [], report = {};
  await context.route(/^https?:/, route => {
    if (route.request().url().startsWith(url)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const read = id => field(id).textContent();
  const choose = (id, value) => field(id).selectOption(value);
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 90000 });
  const open = async (file, pattern) => {
    await field('sources').setInputFiles(join(directory, file));
    await ready();
    assert.match(await read('status'), pattern);
  };
  const run = async (id, pattern) => { await click(id); await ready(); assert.match(await read('status'), pattern); };
  const download = async (id, name) => {
    const [event] = await Promise.all([page.waitForEvent('download'), click(id)]);
    await event.saveAs(join(directory, name));
    await ready();
    return readFile(join(directory, name));
  };
  const exportZip = async (name, expectedMap = color) => {
    const entries = unzipSync(await download('export', `${name}.zip`));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    const map = entries[manifest.textures.find(map => map.semantic === 'BaseColor').file];
    if (expectedMap) assert.deepEqual(map, expectedMap);
    const fbx = entries[manifest.model];
    await writeFile(join(directory, `${name}.fbx`), fbx);
    assert.equal(manifest.meshes.triangles, 4);
    return { manifest, fbx, map, entries };
  };
  const enter = async () => { if (await field('uv-tools').isHidden()) await click('uv-mode'); };
  const pick = async (u, v, topDown = false) => {
    const canvas = field('uv-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const rect = await canvas.boundingBox(), zoom = .88 * 556;
    await page.mouse.click(rect.x + ((768 - zoom) / 2 + u * zoom) / 768 * rect.width,
      rect.y + ((556 - zoom) / 2 + (topDown ? v : 1 - v) * zoom) / 556 * rect.height);
  };
  const stitch = async () => {
    await choose('uv-kind', 'edge');
    await choose('uv-operation', 'stitch');
    await pick(.375, .3125);
    await click('uv-run');
    assert.match(await read('uv-info'), /UV draft\. Stitched the shared edge/);
    assert.match(await read('uv-diagnostics'), /2 islands · 0 outside · 0 overlapping/);
  };

  for (const name of ['static', 'skinned']) {
    await open(`${name}-source.zip`, /4 triangles/);
    await enter();
    assert.match(await read('uv-diagnostics'), /3 islands/);
    const openingRevision = await read('project-status');
    await stitch();
    assert.equal(await read('project-status'), openingRevision);
    await click('uv-cancel');
    assert.match(await read('uv-diagnostics'), /3 islands/);
    assert.equal(await read('project-status'), openingRevision);
    await choose('uv-operation', 'stitch');
    await pick(.25, .125);
    await click('uv-run');
    assert.match(await read('uv-info'), /exactly two faces/);
    assert.equal(await read('project-status'), openingRevision);
    await stitch();
    await choose('uv-mode-select', 'mapping');
    await run('uv-apply', /Texture images are unchanged/);
    const mapped = await exportZip(`${name}-stitched`);
    assert.equal(mapped.manifest.meshes.bones, name === 'skinned' ? 2 : 0);
    assert.equal(mapped.manifest.meshes.clips, name === 'skinned' ? 1 : 0);
    await run('undo-stroke', /Undid/);
    assert.match(await read('uv-diagnostics'), /3 islands/);
    await run('redo', /Redid/);
    assert.match(await read('uv-diagnostics'), /2 islands/);
    await download('save-project', `${name}.assetfixer`);
    await open(`${name}.assetfixer`, /Project restored/);
    await enter();
    assert.match(await read('uv-diagnostics'), /2 islands/);
    await open(`${name}-stitched.zip`, /4 triangles/);
    await enter();
    assert.match(await read('uv-diagnostics'), /2 islands/);
    report[name] = { cancelUnchanged: true, openEdgeRefused: true, undoRedo: true, reopenedProjectAndExport: true, mapBytesEqual: true };
  }
  await open('static-source.zip', /4 triangles/);
  await enter();
  await stitch();
  await choose('uv-mode-select', 'preserve');
  await choose('uv-size', '256');
  await run('uv-apply', /UVs and 1 maps applied from Working revision .* 0 occupied texels/);
  const baked = await exportZip('static-preserved', null);
  const image = decode(baked.map);
  assert.deepEqual([image.width, image.height], [256, 256]);
  // The moved triangle samples red from its former chart interior.
  const x = Math.floor((.375 + .875 + .375) / 3 * 256);
  const y = Math.floor((1 - (.125 + .125 + .5) / 3) * 256);
  const red = image.data[(y * 256 + x) * image.channels];
  assert.ok(Math.abs(red - 179) <= 3, `Expected the source gradient at the rebaked triangle, found red ${red}.`);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  report.bake = { width: image.width, height: image.height, transferredRed: red, misses: 0 };

  await open('connected.glb', /2 triangles/);
  await enter();
  await choose('uv-kind', 'edge');
  await choose('uv-operation', 'cut');
  await pick(.375, .3125, true);
  await click('uv-run');
  await choose('uv-operation', 'move');
  await pick(.375, .3125, true);
  await field('uv-u').fill('-.125');
  await click('uv-run');
  assert.match(await read('uv-diagnostics'), /2 islands/);
  await choose('uv-operation', 'stitch');
  await pick(.375, .3125, true);
  await click('uv-run');
  assert.match(await read('uv-diagnostics'), /1 islands · 0 outside · 0 overlapping/);
  await choose('uv-mode-select', 'mapping');
  await run('uv-apply', /Texture images are unchanged/);
  await download('export', 'connected-restored.glb');
  report.glb = { markMoveStitch: true };

  await writeFile(join(directory, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
