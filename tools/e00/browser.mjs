import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { preview } from 'vite';

const [tripoPath, chromePath, animatedSource] = process.argv.slice(2);
if (!tripoPath) throw new Error('Supply the path to the Tripo sample directory.');
const { chromium } = await import('../../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const output = resolve('test-results/e00/exports');
await mkdir(output, { recursive: true });
const server = await preview({ preview: { host: '127.0.0.1', port: 4270 } });

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
    const cases = [
      [join(tripoPath, 'ceramic plate 3d model.zip'), 'ceramic_plate_3d_model', 9138, 0, 0],
      [join(tripoPath, 'tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip'), 'tripo_convert_8b04a473', 17623, 67, 0],
      ...(animatedSource ? [[animatedSource, 'animated_fixture', 4, 2, 1]] : []),
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
      await input.setInputFiles(exported);
      await page.waitForFunction(() => !document.querySelector('#sources').disabled);
      const reimported = await status.textContent();
      assert.match(reimported, expected);
      assert.equal(Number(expected.exec(reimported)[1].replace(/\D/g, '')), triangles);
      console.log(reimported);
    }

    const entries = unzipSync(await readFile(cases[0][0]));
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
    assert.deepEqual(outsideRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
