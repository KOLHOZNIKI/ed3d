import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshPhongMaterial, Scene, Texture } from 'three';

const directory = 'test-results/e07';
await mkdir(directory, { recursive: true });
const width = 160, height = 128, color = new Uint8Array(width * height * 3);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = Math.floor(x / 32) + 5 * Math.floor((height - 1 - y) / 32);
  color.set([30 + i * 10, 55 + i * 3, 200 - i * 5], (y * width + x) * 3);
}
const positions = [], normals = [], polygons = [], uv = [];
for (let i = 0; i < 18; i++) {
  const x = i < 3 ? i * 0.6 : 2 + (i - 3) % 5, y = i < 3 ? i * 0.15 : 1 + Math.floor((i - 3) / 5);
  const z = (i % 3) * 0.2, u = i % 5 * 32 / width, v = Math.floor(i / 5) * 32 / height;
  const size = 0.35 + (i % 3) * 0.07;
  const first = positions.length / 3;
  for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    positions.push(x + size * a, y + size * b, z);
    normals.push(0, 0, 1);
    uv.push(u + (4 + 24 * a) / width, v + (4 + 24 * b) / height);
  }
  polygons.push(first, first + 1, first + 2, ~(first + 3));
}
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
geometry.userData.assetFixerFbxPolygons = Int32Array.from(polygons);
const texture = new Texture();
texture.name = 'Shared';
const mesh = new Mesh(geometry, new MeshPhongMaterial({ name: 'Atlas', map: texture }));
mesh.name = 'Sixteen assets';
mesh.position.set(1.25, 0.4, 0.65);
mesh.rotation.z = 0.23;
mesh.scale.setScalar(1.35);
const scene = new Scene();
scene.add(mesh);
const fbx = new FBXExporter().register(plan => {
  for (const entry of plan.textures.textures.values()) entry.fileName = 'batch.fbm/Shared.png';
}).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
const png = encode({ width, height, channels: 3, data: color });
await writeFile(`${directory}/batch.fbx`, new Uint8Array(fbx));
await writeFile(`${directory}/batch.zip`, zipSync({ 'batch.fbx': new Uint8Array(fbx), 'batch.fbm/Shared.png': png,
  'unused.png': encode({ width: 1, height: 1, channels: 3, data: Uint8Array.of(1, 2, 3) }) }));
