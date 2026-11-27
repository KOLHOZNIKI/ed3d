import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const palette = ['#f42c72', '#25d7fc', '#fbec37', '#1bf77e', '#913dff', '#ff8124'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const checkpointInterval = 8;

export async function readCheckpoint(path) {
  const bundle = unzipSync(await readFile(path));
  const manifest = JSON.parse(new TextDecoder().decode(bundle['manifest.json']));
  const png = bundle[manifest.textures.find(texture => texture.semantic === 'BaseColor').file];
  const header = new DataView(png.buffer, png.byteOffset);
  return {
    manifest, baseColor: hash(png), pngBytes: png.length, dimensions: [header.getUint32(16), header.getUint32(20)],
    fbx: hash(bundle[manifest.model]),
    atlasCorners: manifest.uvAtlas && hash(bundle[manifest.uvAtlas.sourceCornerMap]),
  };
}

export async function runHistory({ page, measure, snapshot, capture, strokeCount, directory, label, save }) {
  const forward = new Map(), checkpoints = [];
  const paint = page.locator('#paint'), undo = page.locator('#undo-stroke'), canvas = page.locator('#viewport');
  const color = page.locator('#paint-color'), status = page.getByRole('status');
  const paintedTexels = [];
  const ready = () => page.waitForFunction(() => !document.querySelector('#sources').disabled, null, { timeout: 120000 });

  const checkpoint = async (direction, depth) => {
    const state = `${direction}-${String(depth).padStart(2, '0')}`;
    const memory = await snapshot();
    assert.equal(memory.activeWorkers, 0);
    const download = await capture(`checkpoint-${state}`, /_e00_(baked|painted)\.zip$/);
    const path = save ? join(directory, `${label}-${state}.zip`) : await download.path();
    if (save) await download.saveAs(path);
    const result = await readCheckpoint(path);
    await download.delete();
    assert.equal(result.manifest.texturePaint?.strokes ?? 0, depth);
    assert.equal(result.manifest.textures.length, 1);
    assert.equal(result.manifest.meshes.triangles, 250000);
    assert.equal(result.manifest.uvAtlas.channel, 'uv0');
    assert.deepEqual(result.dimensions, [result.manifest.textureBake.width, result.manifest.textureBake.height]);
    const { baseColor, pngBytes, dimensions, fbx, atlasCorners } = result;
    const expected = direction === 'undo' ? forward.get(depth) : forward.get(0);
    if (expected) {
      assert.equal(atlasCorners, expected.atlasCorners);
      assert.deepEqual(dimensions, expected.dimensions);
      if (direction === 'undo') assert.equal(baseColor, expected.baseColor, `Undo checkpoint at ${depth} diverged`);
      else assert.ok([...forward.values()].every(previous => previous.baseColor !== baseColor));
    }
    const record = { direction, depth, baseColor, pngBytes, dimensions, fbx, atlasCorners, memory };
    if (direction === 'paint') forward.set(depth, record);
    checkpoints.push(record);
    console.log('F18', state, baseColor.slice(0, 12), `${Math.round(memory.processTree[1] / 1048576)} MiB private`);
    return result.manifest;
  };

  await checkpoint('paint', 0);
  const initialHistory = (await page.locator('#history-status').textContent())?.match(/Undo available: (\d+)/)?.[1];
  await paint.click();
  for (let index = 0; index < strokeCount; index++) {
    await color.fill(palette[index % palette.length]);
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    assert.ok(box);
    const x = box.x + (0.42 + 0.028 * (index % 6)) * box.width;
    const y = box.y + (0.39 + 0.026 * Math.floor(index / 6)) * box.height;
    await page.mouse.move(x, y);
    await measure(`paint-${index + 1}`, async () => {
      await page.mouse.down();
      await page.mouse.move(x + 0.014 * box.width, y + 0.012 * box.height, { steps: 5 });
      await page.mouse.up();
      await ready();
      const result = /^Painted ([\d\s,]+) Base Color texels\.$/.exec(await status.textContent());
      assert.ok(result, await status.textContent());
      paintedTexels.push(Number(result[1].replace(/\D/g, '')));
    });
    if ((index + 1) % checkpointInterval === 0) await checkpoint('paint', index + 1);
  }
  let manifest;
  for (let depth = strokeCount - 1; depth >= 0; depth--) {
    await measure(`undo-${depth}`, async () => {
      await undo.click();
      await ready();
      assert.equal(await status.textContent(), 'Undid the last stroke.');
    });
    if (depth % checkpointInterval === 0) manifest = await checkpoint('undo', depth);
  }
  if (initialHistory !== undefined) {
    assert.equal((await page.locator('#history-status').textContent()).match(/Undo available: (\d+)/)?.[1], initialHistory);
  } else assert.ok(await undo.isDisabled());
  return { checkpoints, paintedTexels, manifest, editedPath: join(directory, `${label}-paint-${String(strokeCount).padStart(2, '0')}.zip`) };
}
