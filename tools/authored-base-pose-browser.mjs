import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from '../test-results/e00-browser/node_modules/playwright-core/index.mjs';

const output = resolve('test-results/authored-base-pose');
const [source = join(output, 'Samba Dancing.fbx'), executablePath] = process.argv.slice(2);
const build = resolve('dist');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
  const origin = 'http://localhost/', outside = [], errors = [];
  await context.route(/^https?:/, route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.fulfill({ path: join(build, new URL(url).pathname.slice(1) || 'index.html') });
    outside.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin);
  const ui = id => page.locator(`#${id}`);
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 120000 });
  const check = async (id, expected) => assert.match(await ui(id).textContent(), expected, id);
  const act = async (id, expected) => { await ui(id).click(); await ready(); await check('status', expected); };
  const open = async (file, expected) => { await ui('sources').setInputFiles(file); await ready(); await check('status', expected); };
  async function download(id, filename) {
    const [result] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), ui(id).click()]);
    const path = join(output, filename);
    await result.saveAs(path);
    await ready();
    return readFile(path);
  }
  async function exportFbx(label) {
    const files = unzipSync(await download('export', `${label}.zip`));
    const name = Object.keys(files).find(file => file.endsWith('.fbx'));
    await writeFile(join(output, `${label}.fbx`), files[name]);
    return JSON.parse(strFromU8(files['manifest.json']));
  }

  await open(source, /55\s?320 triangles.*52 bones.*2 clips/);
  await ui('rig-mode').click();
  await ui('rig-edit-mode').selectOption('pose');
  await ui('rig-joint').selectOption({ label: 'mixamorigLeftForeArm' });
  await ui('rig-space').selectOption('local');
  await ui('rig-z').fill('15');
  await act('rig-apply', /Rotate manual pose joint applied/);
  await act('rig-bake-base', /2 bound meshes.*1 affected clips/);
  await act('export', /Clip export blocked.*mixamo\.com/);
  await ui('rig-clips').locator('summary').click();
  await ui('rig-clip').selectOption({ label: 'mixamo.com' });
  await act('rig-adapt', /Save adapted clip applied/);
  await check('rig-clip-info', /mixamo\.com_Adapted_1/);
  const result = await exportFbx('samba-adapted');
  assert.deepEqual(result.meshes, { meshes: 2, triangles: 55320, bones: 52, clips: 2 });
  const project = 'samba.assetfixer';
  const archive = await download('save-project', project);
  assert.equal(JSON.parse(strFromU8(unzipSync(archive)['manifest.json'])).schemaVersion, 20);
  await open(join(output, project), /Project restored/);
  assert.deepEqual((await exportFbx('samba-reopened')).meshes, result.meshes);
  assert.deepEqual(await download('export-original', 'samba-original.fbx'), await readFile(source));
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(`Baked the left forearm of both meshes and adapted mixamo.com in Chrome ${browser.version()}.`);
} finally {
  await browser.close();
}
