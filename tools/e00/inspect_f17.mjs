import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { NodeIO } from '../../test-results/e00-gltf-transform/node_modules/@gltf-transform/core/dist/index.js';
import {
  EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization,
} from '../../test-results/e00-gltf-transform/node_modules/@gltf-transform/extensions/dist/index.js';
import { MeshoptDecoder } from '../../test-results/e00-gltf-transform/node_modules/meshoptimizer/meshopt_decoder.mjs';

const { positionals: [input, output], values } = parseArgs({
  allowPositionals: true,
  options: { 'position-edit': { type: 'string' } },
});
if (!input || !output) throw new Error('Usage: node tools/e00/inspect_f17.mjs original.glb exported.glb [--position-edit edit.json]');
const edit = values['position-edit'] ? JSON.parse(await readFile(values['position-edit'], 'utf8')) : undefined;
const meshopt = 'EXT_meshopt_compression';
const outputExtensions = ['EXT_texture_webp', 'KHR_mesh_quantization'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

async function inspect(path) {
  const bytes = await readFile(path);
  const { json } = await io.binaryToJSON(bytes);
  const root = (await io.readBinary(bytes)).getRoot();
  const nodes = root.listNodes().filter(node => node.getMesh());
  assert.equal(root.listScenes().length, 1);
  assert.equal(nodes.length, 1);
  assert.equal(root.listMeshes().length, 1);
  assert.equal(root.listMaterials().length, 1);
  assert.equal(root.listSkins().length, 0);
  assert.equal(root.listAnimations().length, 0);
  const [node] = nodes;
  const primitives = node.getMesh().listPrimitives();
  assert.equal(primitives.length, 1);
  const [primitive] = primitives;
  assert.equal(primitive.getMode(), 4);
  const attributes = Object.fromEntries(primitive.listSemantics().map(key => [key, primitive.getAttribute(key)]));
  const material = primitive.getMaterial();
  const slots = [
    ['baseColor', material.getBaseColorTexture(), material.getBaseColorTextureInfo()],
    ['normal', material.getNormalTexture(), material.getNormalTextureInfo()],
    ['metallicRoughness', material.getMetallicRoughnessTexture(), material.getMetallicRoughnessTextureInfo()],
  ];
  assert.equal(root.listTextures().length, slots.length);
  const textures = Object.fromEntries(slots.map(([role, texture, info]) => {
    const image = texture.getImage();
    return [role, { name: texture.getName(), mimeType: texture.getMimeType(), dimensions: texture.getSize(),
      bytes: image.byteLength, sha256: hash(image), texCoord: info.getTexCoord(),
      magFilter: info.getMagFilter(), minFilter: info.getMinFilter(), wrapS: info.getWrapS(), wrapT: info.getWrapT() }];
  }));
  return {
    sha256: hash(bytes), bytes: bytes.byteLength, generator: json.asset.generator,
    extensionsUsed: [...json.extensionsUsed].sort(), extensionsRequired: [...json.extensionsRequired].sort(),
    compressedViews: json.bufferViews.filter(view => view.extensions?.[meshopt]).length,
    node: { name: node.getName(), worldMatrix: node.getWorldMatrix() },
    attributes, indices: primitive.getIndices(), textures,
    material: { name: material.getName(), doubleSided: material.getDoubleSided(), alphaMode: material.getAlphaMode(),
      baseColor: material.getBaseColorFactor(), normalScale: material.getNormalScale(),
      metallic: material.getMetallicFactor(), roughness: material.getRoughnessFactor() },
  };
}

const before = await inspect(input);
const after = await inspect(output);
assert.deepEqual(before.extensionsRequired, [meshopt, ...outputExtensions]);
assert.deepEqual(after.extensionsRequired, outputExtensions);
assert.deepEqual(after.extensionsUsed, outputExtensions);
assert.equal(before.compressedViews, 4);
assert.equal(after.compressedViews, 0);
assert.deepEqual(after.node, before.node);
assert.deepEqual(after.material, before.material);
assert.deepEqual(after.textures, before.textures);
assert.deepEqual(Object.keys(before.attributes).sort(), ['NORMAL', 'POSITION', 'TEXCOORD_0']);
assert.deepEqual(Object.keys(after.attributes).sort(), Object.keys(before.attributes).sort());

const exactAccessors = {};
let positionEdit;
for (const [name, source, result] of [
  ...Object.entries(before.attributes).map(([key, value]) => [key, value, after.attributes[key]]),
  ['indices', before.indices, after.indices],
]) {
  assert.equal(result.getType(), source.getType(), `${name} type changed`);
  assert.equal(result.getComponentType(), source.getComponentType(), `${name} component type changed`);
  assert.equal(result.getNormalized(), source.getNormalized(), `${name} normalization changed`);
  if (edit && name === 'POSITION') {
    positionEdit = compareEditedPosition(source, result, before.indices, before.node.worldMatrix, edit);
    continue;
  }
  assert.deepEqual(result.getArray(), source.getArray(), `${name} values changed`);
  exactAccessors[name] = { count: source.getCount(), componentType: source.getComponentType(), normalized: source.getNormalized() };
}
const { attributes: sourceAttrs, indices: sourceIndices, ...original } = before;
const { attributes: exportedAttrs, indices: exportedIndices, ...exported } = after;
const vertices = sourceAttrs.POSITION.getCount(), triangles = sourceIndices.getCount() / 3;
assert.equal(vertices, 19274);
assert.equal(triangles, 28069);
console.log(JSON.stringify({ original, exported, vertices, triangles, exactAccessors, positionEdit }, null, 2));

function compareEditedPosition(source, result, indices, worldMatrix, { vertex, deltaYSteps }) {
  assert.equal(source.getComponentType(), 5122);
  assert.equal(source.getType(), 'VEC3');
  assert.ok(source.getNormalized());
  assert.ok(Number.isInteger(vertex) && vertex >= 0 && vertex < source.getCount(), 'Invalid vertex index');
  assert.ok(Number.isInteger(deltaYSteps) && deltaYSteps !== 0, 'Expected a nonzero offset in quantization steps');
  const original = source.getArray(), exported = result.getArray();
  const start = 3 * vertex;
  const expectedY = original[start + 1] + deltaYSteps;
  assert.ok(expectedY >= -32767 && expectedY <= 32767, 'Edited Y lies outside the signed normalized range');
  assert.equal(exported[start + 1], expectedY, 'The exported Y does not match the requested edit');
  const expected = original.slice();
  expected[start + 1] = expectedY;
  assert.deepEqual(exported, expected, 'A position component outside the requested edit changed');
  const originalPosition = [...original.subarray(start, start + 3)];
  const exportedPosition = [...exported.subarray(start, start + 3)];
  let nearestOtherPositionSteps = Infinity;
  for (let offset = 0; offset < original.length; offset += 3) {
    if (offset === start) continue;
    nearestOtherPositionSteps = Math.min(nearestOtherPositionSteps, Math.hypot(original[offset] - originalPosition[0],
      original[offset + 1] - originalPosition[1], original[offset + 2] - originalPosition[2]));
  }
  assert.ok(nearestOtherPositionSteps > Math.abs(deltaYSteps), 'Select a vertex away from coincident positions');
  const corners = indices.getArray();
  const affected = new Set();
  for (let index = 0; index < corners.length; index++) {
    if (corners[index] === vertex) affected.add(Math.floor(index / 3));
  }
  assert.ok(affected.size > 0, 'The edited vertex must be used by a triangle');
  const localOffsetY = (exportedPosition[1] - originalPosition[1]) / 32767;
  return { vertex, deltaYSteps, originalPosition, exportedPosition, changedPositions: 1,
    affectedTriangles: affected.size, nearestOtherPositionSteps, localOffsetY,
    worldOffsetMeters: worldMatrix.slice(4, 7).map(component => component * localOffsetY) };
}
