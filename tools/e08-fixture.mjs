import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshPhongMaterial, Scene, Texture } from 'three';
import { glbFixture } from './e00/corpus-glb.mjs';

const dir = 'test-results/e08';
await mkdir(dir, { recursive: true });
const write = (name, bytes) => writeFile(`${dir}/${name}`, bytes);
const image = (size, pixel) => encode({ width: size, height: size, channels: 4, data: Uint8Array.from(
  Array.from({ length: size * size }, (_, i) => pixel(i % size, Math.floor(i / size))).flat(),
) });
const glb = glbFixture();
const sourceColor = glb.png('Red and green', image(32, x => x < 16 ? [230, 24, 35, 255] : [20, 220, 50, 255]));
const normal = glb.png('Directional normal', image(4, () => [181, 170, 235, 255]));
const targetColor = glb.png('Target placeholder', image(4, () => [20, 50, 230, 255]));
glb.doc.materials = [
  { name: 'Source maps', pbrMetallicRoughness: { baseColorTexture: { index: sourceColor }, metallicFactor: 0 },
    normalTexture: { index: normal } },
  { name: 'Initial target', pbrMetallicRoughness: { baseColorTexture: { index: targetColor }, metallicFactor: 0 },
    alphaMode: 'BLEND' },
];
const quad = (left, right, z) => [[left,-1,z],[right,-1,z],[right,1,z],[left,1,z]];
glb.mesh('Source surfaces', [glb.primitive({
  positions: [...quad(-.5, .5, 0), ...quad(-.5, .5, .02)],
  indices: [0,1,2,0,2,3,4,5,6,4,6,7],
  uv: [[.06,.06],[.44,.06],[.44,.94],[.06,.94],[.56,.06],[.94,.06],[.94,.94],[.56,.94]], material: 0,
})], { scale: [2, 1, 1] });
glb.mesh('Changed target', [glb.primitive({
  positions: quad(-.97,.97,.035), indices: [0,1,2,0,2,3],
  uv: [[.08,.08],[.08,.92],[.92,.92],[.92,.08]], material: 1,
})]);
await write('projection.glb', glb.finish());

const geometry = new BufferGeometry(), positions = [], uv = [], polygons = [];
for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) {
  positions.push(x - 2, y - 2, .07 * (x - 2) * (y - 2) + .03 * ((x - 2) ** 2 + (y - 2) ** 2));
  uv.push(x / 4, y / 4);
}
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
  const i = y * 5 + x;
  polygons.push(i, i + 1, i + 6, ~(i + 5));
}
geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
geometry.setAttribute('normal', new Float32BufferAttribute(polygons.flatMap(() => [0, 0, 1]), 3));
geometry.setAttribute('uv', new Float32BufferAttribute(polygons.flatMap(encoded => {
  const id = encoded < 0 ? ~encoded : encoded;
  return uv.slice(id * 2, id * 2 + 2);
}), 2));
geometry.userData.assetFixerFbxPolygons = Int32Array.from(polygons);
const texture = new Texture();
texture.name = 'Pattern';
const plane = new Mesh(geometry, new MeshPhongMaterial({ name: 'Patch source', map: texture }));
plane.name = 'Repair panel';
const scene = new Scene();
scene.add(plane);
const file = new FBXExporter().register(plan => {
  for (const entry of plan.textures.textures.values()) entry.fileName = 'patch.fbm/Pattern.png';
}).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
await write('patch.zip', zipSync({
  'patch.fbx': new Uint8Array(file),
  'patch.fbm/Pattern.png': image(32, (x, y) => [30 + x * 6, 40 + y * 5, 170, 255]),
}));
