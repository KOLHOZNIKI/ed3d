import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshPhongMaterial, Scene, Texture } from 'three';

const name = 'topology_seams';
const points = [
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  0, 0, 0, 0, -1, 0, -1, 0, 0,
];
const faces = [
  { ids: [0, 3, 2, 1], normal: [0, 0, -1] },
  { ids: [4, 5, 6, 7], normal: [0, 0, 1] },
  { ids: [0, 4, 7, 3], normal: [-1, 0, 0] },
  { ids: [1, 2, 6, 5], normal: [1, 0, 0] },
  { ids: [0, 1, 5, 4], normal: [0, -1, 0] },
  { ids: [3, 7, 6, 2], normal: [0, 1, 0] },
];
const corners = [], normals = [], uv = [];
for (const [chart, { ids, normal }] of faces.entries()) {
  const u = (chart % 3) * 0.3125 + 0.03125;
  const v = Math.floor(chart / 3) * 0.4375 + 0.03125;
  const chartUvs = [[u, v], [u, v + 0.375], [u + 0.25, v + 0.375], [u + 0.25, v]];
  for (const triangle of [[0, 1, 2], [0, 2, 3]]) {
    for (const [index, corner] of triangle.entries()) {
      corners.push(index === 2 ? ~ids[corner] : ids[corner]);
      normals.push(...normal);
      uv.push(...chartUvs[corner]);
    }
  }
}
// Point 8 duplicates point 0, including its front-face UV and normal. Its face uses only points 8–10.
corners.push(8, 9, ~10);
normals.push(0, 0, -1, 0, 0, -1, 0, 0, -1);
uv.push(...uv.slice(0, 2), 0.15625, 0.84375, 0.28125, 0.90625);

const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
geometry.userData.assetFixerFbxPolygons = Int32Array.from(corners);
const map = new Texture();
map.name = 'Checker';
const material = new MeshPhongMaterial({ name: 'Checker', map });
const mesh = new Mesh(geometry, material);
mesh.name = 'Cube and independent triangle';
const scene = new Scene();
scene.add(mesh);
for (const [index, entity] of [scene, mesh, geometry, material, map].entries()) {
  entity.uuid = `6e3b3a1c-6277-45ce-a536-${String(index).padStart(12, '0')}`;
}

const mapPath = `${name}.fbm/Checker.png`;
const fbx = new FBXExporter().register(plan => {
  for (const entry of plan.textures.textures.values()) entry.fileName = mapPath;
}).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, bakeSpaceTransform: false, embedTextures: false });
const size = 64;
const pixels = new Uint8Array(size * size * 3);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const rgb = ((x >> 3) + (y >> 3)) % 2 ? [43, 86, 122] : [231, 212, 161];
    pixels.set(rgb, (y * size + x) * 3);
  }
}
const png = encode({ width: size, height: size, channels: 3, data: pixels });
const folder = 'test-results/e00/seam-fixture';
await mkdir(`${folder}/${name}.fbm`, { recursive: true });
await writeFile(`${folder}/${name}.fbx`, new Uint8Array(fbx));
await writeFile(`${folder}/${mapPath}`, png);
const zip = zipSync({ [`${name}.fbx`]: new Uint8Array(fbx), [mapPath]: png }, { mtime: new Date(2000, 0, 1) });
await writeFile(`${folder}/${name}.zip`, zip);
