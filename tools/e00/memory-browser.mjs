import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
import { preview } from 'vite';

const { values, positionals: [fixture, executablePath] } = parseArgs({
  allowPositionals: true,
  options: {
    cycles: { type: 'string', default: '5' },
    label: { type: 'string', default: 'typical' },
    'idle-seconds': { type: 'string', default: '0' },
    swiftshader: { type: 'boolean' },
  },
});
const cycleCount = Number(values.cycles);
const idleSeconds = Number(values['idle-seconds']);
if (process.platform !== 'win32' || !fixture || !Number.isInteger(cycleCount) || cycleCount < 1 ||
    !Number.isInteger(idleSeconds) || idleSeconds < 0 ||
    !/^[a-z0-9-]+$/.test(values.label)) {
  throw new Error('Usage on Windows: node tools/e00/memory-browser.mjs input.zip [Chrome.exe] [--cycles 5] [--label typical] [--idle-seconds 0] [--swiftshader]');
}

const { chromium } = await import('../../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const fixturePath = resolve(fixture);
const fixtureSha256 = createHash('sha256').update(await readFile(fixturePath)).digest('hex');
const out = resolve('test-results/e00/memory');
await mkdir(out, { recursive: true });
const targetFile = join(out, `${values.label}-export.zip`);
const sampleIntervalMs = 20;
const settleMs = 2500;
const width = 1920, height = 1080;
const app = await preview({ preview: { host: '127.0.0.1', port: 4282 } });
const url = `http://127.0.0.1:${app.httpServer.address().port}/`;
let chrome, sampler;

try {
  chrome = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: values.swiftshader ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--use-angle=d3d11'],
  });
  const browserCdp = await chrome.newBrowserCDPSession();
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  const browserProcess = processInfo.find(process => process.type === 'browser');
  assert.ok(browserProcess, 'The dedicated Chrome browser process is missing.');
  const samples = [];
  sampler = spawn('python', ['tools/e00/windows-process-memory.py', String(browserProcess.id), String(sampleIntervalMs)],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let samplerError;
  sampler.once('error', error => { samplerError = error; });
  const lines = createInterface({ input: sampler.stdout });
  lines.on('line', line => samples.push(JSON.parse(line)));
  for (let attempt = 0; !samples.length && attempt < 30 && !samplerError; attempt++) await delay(100);
  if (samplerError || !samples.length) throw samplerError ?? new Error('The Windows sampler did not report any data.');

  const context = await chrome.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const html = await readFile('dist/index.html', 'utf8');
  const body = html.replace(/width="640" height="480"/, `width="${width}" height="${height}"`);
  await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  await page.goto(url);
  const viewport = await page.locator('#viewport').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { width: gl?.drawingBufferWidth, height: gl?.drawingBufferHeight, dpr: devicePixelRatio,
      renderer: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
  });
  assert.deepEqual([viewport.width, viewport.height, viewport.dpr], [width, height, 1]);
  const { gpu } = await browserCdp.send('SystemInfo.getInfo');
  const snapshot = async () => ({
    processTree: samples.at(-1),
    heap: await cdp.send('Runtime.getHeapUsage'),
    dom: await cdp.send('Memory.getDOMCounters'),
    activeWorkers: page.workers().length,
  });
  await cdp.send('HeapProfiler.collectGarbage');
  await delay(settleMs);
  const baseline = await snapshot();
  const cycles = [];
  const status = page.getByRole('status');
  const input = page.locator('#sources');
  const unwrap = page.locator('#unwrap');
  const bake = page.locator('#rebake');
  const exportButton = page.getByRole('button', { name: 'Export FBX ZIP' });
  const close = page.getByRole('button', { name: 'Close model' });
  for (let cycle = 1; cycle <= cycleCount; cycle++) {
    const phases = {};
    const measure = async (name, action) => {
      const start = Date.now();
      await action();
      const end = Date.now();
      await delay(60);
      const range = samples.filter(sample => sample[0] >= start && sample[0] <= end);
      assert.ok(range.length, `No OS samples in cycle ${cycle}, ${name}`);
      phases[name] = { start, end, milliseconds: end - start, samples: range.length,
        peakPrivate: Math.max(...range.map(sample => sample[1])), peakWorkingSet: Math.max(...range.map(sample => sample[2])) };
    };

    await measure('import', async () => {
      await input.setInputFiles(fixturePath);
      await page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 180000 });
      assert.match(await status.textContent(), /triangles · .* bones/);
      assert.ok(await close.isEnabled());
    });
    const imported = await status.textContent();
    await measure('unwrap', async () => {
      await unwrap.click();
      await page.waitForFunction(() => !document.querySelector('#unwrap').disabled, null, { timeout: 240000 });
      assert.match(await status.textContent(), /Generated .* charts at .* in UV1/);
    });
    const atlas = await status.textContent();
    await measure('bake', async () => {
      await bake.click();
      await page.waitForFunction(() => !document.querySelector('#rebake').disabled, null, { timeout: 240000 });
      assert.match(await status.textContent(), /Rebaked 4 maps/);
    });
    const baked = await status.textContent();
    let download;
    await measure('export', async () => {
      [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), exportButton.click()]);
      assert.match(download.suggestedFilename(), /_e00_baked\.zip$/);
      assert.equal(await download.failure(), null);
    });
    if (cycle === cycleCount) await download.saveAs(targetFile);
    await download.delete();
    await close.click();
    assert.equal(await status.textContent(), 'Model closed.');
    assert.ok(await page.locator('#viewport').isHidden());
    assert.ok(await close.isDisabled());
    assert.ok(await exportButton.isDisabled());
    await delay(settleMs);
    const afterClose = await snapshot();
    assert.equal(afterClose.activeWorkers, 0);
    cycles.push({ cycle, imported, atlas, baked, phases, afterClose });
    console.log(imported, 'cycle', cycle,
      Object.fromEntries(Object.entries(phases).map(([name, data]) => [name, `${Math.round(data.peakPrivate / 1048576)} MiB`])),
      'closed', `${Math.round(afterClose.processTree[1] / 1048576)} MiB`);
  }
  const afterLastClose = await snapshot();
  await cdp.send('HeapProfiler.collectGarbage');
  await delay(settleMs);
  const afterForcedGc = await snapshot();
  let afterIdle;
  if (idleSeconds) {
    await delay(idleSeconds * 1000);
    afterIdle = await snapshot();
  }
  const finalProcesses = await browserCdp.send('SystemInfo.getProcessInfo');
  assert.deepEqual(errors, []);
  const bundle = unzipSync(await readFile(targetFile));
  const manifest = JSON.parse(new TextDecoder().decode(bundle['manifest.json']));
  const report = {
    fixture: basename(fixture), fixtureSha256,
    host: { os: os.version(), release: os.release(), cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length,
      ramBytes: os.totalmem(), chrome: chrome.version(), viewport, gpuDevices: gpu.devices, glRenderer: gpu.auxAttributes?.glRenderer },
    sampleIntervalMs, settleMs, idleSeconds, baseline, cycles, afterLastClose, afterForcedGc, afterIdle, manifest, samples,
    processTypes: Object.fromEntries(finalProcesses.processInfo.map(process => [process.id, process.type])),
  };
  const reportPath = join(out, `${values.label}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(reportPath);
} finally {
  sampler?.kill();
  await chrome?.close();
  await app.close();
}
