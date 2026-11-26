import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import { BufferGeometry, ClampToEdgeWrapping, Float32BufferAttribute, Mesh, MeshPhongMaterial, Scene, Texture } from 'three';

const size = 64;
const warm = new Uint8Array(size * size / 2 * 3), cool = warm.slice(), atlas = new Uint8Array(size * size * 3);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size / 2; x++) {
    const i = 3 * (y * size / 2 + x);
    warm.set((Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? [240, 150, 24] : [198, 48, 24], i);
    cool.set(Math.floor(x / 8) % 2 ? [24, 210, 242] : [24, 85, 192], i);
    atlas.set(warm.subarray(i, i + 3), 3 * (y * size + x));
    atlas.set(cool.subarray(i, i + 3), 3 * (y * size + x + size / 2));
  }
}
const png = (data, width) => encode({ width, height: size, data, channels: 3 });
const assets = {
  'patterns/WarmChecker.png': png(warm, size / 2),
  'patterns/CoolStripes.png': png(cool, size / 2),
};
const atlasPng = png(atlas, size);

function fixture(name, target) {
  const positions = [], uv = [], indices = [];
  for (const [sheet, [left, right, z]] of [
    [-0.484375, target ? 0.09375 : 0.0390625, target ? -0.00390625 : 0.0078125],
    [-0.015625, 0.515625, target ? -0.001953125 : 0],
  ].entries()) {
    const i = sheet * 4, a = sheet / 2 + 0.03125, b = a + 0.4375;
    positions.push(left, -0.25, z, right, -0.25, z, right, 0.25, z, left, 0.25, z);
    uv.push(a, 0.03125, b, 0.03125, b, 0.96875, a, 0.96875);
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const map = new Texture();
  map.name = 'Patterns';
  map.wrapS = map.wrapT = ClampToEdgeWrapping;
  const material = new MeshPhongMaterial({ name: 'Patterns', map });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'Nearby panels';
  const scene = new Scene();
  scene.add(mesh);
  for (const [i, value] of [scene, mesh, geometry, material, map].entries()) {
    value.uuid = `bfa60169-0836-43d5-85ac-${String(i).padStart(12, '0')}`;
  }
  const mapPath = `${name}.fbm/BaseColor.png`;
  const fbx = new FBXExporter().register(plan => {
    for (const entry of plan.textures.textures.values()) entry.fileName = mapPath;
  }).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
  return zipSync({ [`${name}.fbx`]: new Uint8Array(fbx), [mapPath]: atlasPng, ...assets }, { mtime: new Date(2000, 0, 1) });
}

const folder = 'test-results/e00/f15';
await mkdir(folder, { recursive: true });
for (const [name, target] of [['f15_source', false], ['f15_target', true]]) {
  await writeFile(`${folder}/${name}.zip`, fixture(name, target));
}
