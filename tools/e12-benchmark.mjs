import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preview } from 'vite';

const [executablePath, browserName = 'chrome'] = process.argv.slice(2);
const { chromium } = await import('../test-results/e00-browser/node_modules/playwright-core/index.mjs');
const inputs = resolve('test-results/e00/memory'), out = resolve('test-results/e12');
await mkdir(out, { recursive: true });
const server = await preview({ preview: { host: '127.0.0.1', port: 4298 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const summarize = samples => {
  const ordered = [...samples].sort((a, b) => a - b);
  return { count: ordered.length, p95: ordered[Math.ceil(ordered.length * .95) - 1], max: ordered.at(-1) };
};
let browser;
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--enable-gpu', '--use-angle=d3d11'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const html = (await readFile('dist/index.html', 'utf8')).replace(/width="640" height="480"/, 'width="1920" height="1080" data-fixed-buffer');
  await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(url);
  const field = id => page.locator(`#${id}`);
  const click = id => field(id).click();
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 180000 });
  const result = { browser: browser.version() };
  const open = async (name, count = '50 000') => {
    await field('sources').setInputFiles(resolve(inputs, name));
    await ready();
    const status = (await field('status').textContent()).replace(/\s+/g, ' ');
    assert.ok(status.includes(`${count} triangles`), status);
  };
  const command = async (id, expected) => {
    await page.evaluate(id => {
      const status = document.querySelector('#status'), trigger = document.getElementById(id);
      window.start = performance.now();
      const before = status.textContent;
      window.progress = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (status.textContent === before) return;
          observer.disconnect();
          requestAnimationFrame(() => resolve(performance.now() - window.start));
        });
        observer.observe(status, { childList: true });
      });
      trigger.click();
    }, id);
    await ready();
    assert.match(await field('status').textContent(), expected);
    return page.evaluate(async () => ({ elapsedMs: performance.now() - window.start, firstStatusFrameMs: await window.progress }));
  };
  await open('typical_memory.zip');
  const viewport = field('viewport');
  result.viewport = await viewport.evaluate(canvas => {
    const gl = canvas.getContext('webgl2'), debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, dpr: devicePixelRatio,
      renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
  });
  assert.deepEqual([result.viewport.width, result.viewport.height, result.viewport.dpr], [1920, 1080, 1]);
  result.frames = summarize(await viewport.evaluate(canvas => new Promise(resolve => {
    const frames = [];
    let prior;
    function frame(time) {
      if (prior !== undefined) frames.push(time - prior);
      prior = time;
      if (frames.length >= 120) { resolve(frames); return; }
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: frames.length % 2 ? 1 : -1, cancelable: true }));
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })));
  result.objectSelection = summarize(await field('object-selection').evaluate(select => {
    const options = [...select.options];
    return Array.from({ length: 30 }, (_, i) => {
      const start = performance.now();
      select.value = options[i % Math.min(options.length, 2)].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return performance.now() - start;
    });
  }));
  result.unwrap = await command('unwrap', /Generated .* charts/);
  await page.evaluate(() => {
    window.cancelStart = performance.now();
    document.querySelector('#rebake').click();
    document.querySelector('#cancel-job').click();
  });
  await ready();
  assert.match(await field('status').textContent(), /Operation cancelled/);
  result.cancelMs = await page.evaluate(() => performance.now() - window.cancelStart);
  const save = () => writeFile(resolve(out, `benchmark-${browserName}.json`), JSON.stringify(result, null, 2) + '\n');
  await save();

  for (const [suffix, size] of [['2k', '2048'], ['4k', '4096']]) {
    await open(`single_${suffix}.zip`);
    await click('toggle-texture');
    await field('texture-uv').uncheck();
    const pane = field('texture-viewport');
    await page.waitForFunction(size => document.querySelector('#texture-picture').width === Number(size), size);
    await pane.scrollIntoViewIfNeeded();
    const rect = await pane.boundingBox();
    await pane.evaluate(panel => {
      const picture = document.querySelector('#texture-picture');
      window.paintFrames = [];
      window.paintDown = 0;
      if (window.restorePaintTiming) window.restorePaintTiming();
      const onPointer = () => { window.paintDown = performance.now(); };
      panel.addEventListener('pointerdown', onPointer, true);
      const draw = CanvasRenderingContext2D.prototype.putImageData;
      CanvasRenderingContext2D.prototype.putImageData = function(...args) {
        draw.apply(this, args);
        if (this.canvas === picture && window.paintDown) {
          window.paintFrames.push(performance.now() - window.paintDown);
          window.paintDown = 0;
        }
      };
      window.restorePaintTiming = () => {
        CanvasRenderingContext2D.prototype.putImageData = draw;
        panel.removeEventListener('pointerdown', onPointer, true);
      };
    });
    for (let i = 0; i < 21; i++) {
      await field('texture-color').fill(i % 2 ? '#f91c54' : '#14e464');
      await page.mouse.click(rect.x + rect.width * (.39 + (i % 7) * .035), rect.y + rect.height * (.45 + Math.floor(i / 7) * .04));
      await ready();
    }
    const samples = await page.evaluate(() => { window.restorePaintTiming(); return window.paintFrames.slice(1); });
    assert.equal(samples.length, 20);
    await click('toggle-texture');
    await click('uv-mode');
    await field('uv-size').selectOption(size);
    const unwrap = await command('uv-unwrap', /Generated UVs in the draft/);
    const bake = await command('uv-apply', /UVs and 1 maps applied .* 0 occupied texels/);
    result[suffix] = { brushInputToTextureDrawMs: summarize(samples), unwrap, directBake: bake };
    await save();
  }
  await open('f18_paint.zip', '250 000');
  await click('uv-mode');
  await field('uv-size').selectOption('256');
  await field('uv-mode-select').selectOption('projection');
  result.heavyProjection = await command('uv-apply', /UVs and 1 maps applied/);
  result.heavyProjection.status = await field('status').textContent();
  assert.deepEqual(errors, []);
  await save();
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
