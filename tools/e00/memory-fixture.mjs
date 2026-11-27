import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import {
  Bone, BufferGeometry, Float32BufferAttribute, Mesh, MeshPhongMaterial, RepeatWrapping, Scene, Skeleton, SkinnedMesh,
  Texture, Uint16BufferAttribute,
} from 'three';

const [profile] = process.argv.slice(2);
if (profile && profile !== '--heavy-paint' && profile !== '--heavy-bake') {
  throw new Error('Usage: node tools/e00/memory-fixture.mjs [--heavy-paint | --heavy-bake]');
}
const heavy = !!profile;
const paint = profile === '--heavy-paint';
const columns = heavy ? 500 : 200;
const rows = heavy ? 250 : 125;
const boneCount = 100;
const positions = [], uv = [], indices = [], joints = [], weights = [];
for (let row = 0; row <= rows; row++) {
  for (let col = 0; col <= columns; col++) {
    const u = col / columns, v = row / rows;
    positions.push(u - 0.5, 0.76 * (v - 0.5), 0.027 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI));
    uv.push(u, v);
    if (!heavy) {
      const center = Math.round(u * (boneCount - 3)) + 1;
      joints.push(center - 1, center, center + 1, 0);
      weights.push(0.16, 0.62, 0.22, 0);
    }
    if (row < rows && col < columns) {
      const a = row * (columns + 1) + col, b = a + 1, d = a + columns + 1, c = d + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
}
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
if (!heavy) {
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
}
geometry.setIndex(indices);
geometry.computeVertexNormals();

const bones = Array.from({ length: heavy ? 0 : boneCount }, (_, index) => {
  const bone = new Bone();
  bone.name = `Joint_${index}`;
  bone.position.x = index / (boneCount - 1);
  return bone;
});
function texture(name) {
  const map = new Texture();
  map.name = name;
  map.wrapS = map.wrapT = RepeatWrapping;
  return map;
}
const material = new MeshPhongMaterial({ map: texture('BaseColor'), normalMap: paint ? null : texture('Normal') });
const mesh = heavy ? new Mesh(geometry, material) : new SkinnedMesh(geometry, material);
mesh.name = heavy ? 'Heavy workload' : 'Typical workload';
const scene = new Scene();
scene.add(mesh);
if (mesh.isSkinnedMesh) {
  for (const bone of bones.slice(1)) bones[0].add(bone);
  mesh.add(bones[0]);
  scene.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
}
if (heavy) {
  [scene, mesh, geometry, material, material.map, material.normalMap].filter(Boolean).forEach((object, index) => {
    object.uuid = `4ba16fa3-1884-4ba0-942c-${String(index).padStart(12, '0')}`;
  });
}

const name = paint ? 'f18_paint' : heavy ? 'f18_four_maps' : 'typical_memory';
const fbx = new FBXExporter().register(plan => {
  for (const entry of plan.textures.textures.values()) entry.fileName = `${name}.fbm/${entry.texture.name}.png`;
}).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
const files = { [`${name}.fbx`]: new Uint8Array(fbx) };
const size = heavy ? 4096 : 2048;
function writeMap(textureName, channels, pixel) {
  const data = new Uint8Array(size * size * channels);
  let seed = 1337;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixel(data, (y * size + x) * channels, x, y, seed >>> 28);
  }
  files[`${name}.fbm/${textureName}.png`] = encode({ width: size, height: size, channels, data });
}
writeMap('BaseColor', 3, (data, i, x, y, noise) => {
  data[i] = 110 + (x >> 5) + noise;
  data[i + 1] = 95 + (y >> 5) + noise;
  data[i + 2] = 116 + ((x ^ y) >> 6) + noise;
});
if (!paint) {
  writeMap('Normal', 3, (data, i, x, y, noise) => {
    data[i] = 104 + ((x >> 4) & 31) + noise;
    data[i + 1] = 104 + ((y >> 4) & 31) + noise;
    data[i + 2] = 254;
  });
  const scalarName = heavy ? name : 'typical';
  writeMap(`${scalarName}_roughness`, 1, (data, i, x, y, noise) => { data[i] = 100 + (((x ^ y) >> 4) & 127) + noise; });
  writeMap(`${scalarName}_metallic`, 1, (data, i, x, y, noise) => { data[i] = (((x + y) >> 5) & 127) + noise; });
}
const directory = 'test-results/e00/memory';
await mkdir(directory, { recursive: true });
const bundle = zipSync(files, { level: 0, ...(heavy ? { mtime: new Date(2000, 0, 1) } : {}) });
await writeFile(`${directory}/${name}.zip`, bundle);
console.log(`${name}.zip: ${indices.length / 3} triangles, ${bones.length} bones, ${paint ? 'one map' : 'four maps'} at ${size} × ${size}, ${bundle.length} bytes`);
