import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshPhongMaterial, Scene, Texture } from 'three';

const directory = 'test-results/e04';
await mkdir(directory, { recursive: true });
const vertices = [], polygons = [], uv = [], normals = [], holes = [];
for (const [hole, count] of [3, 4, 6].entries()) {
  const start = vertices.length / 3, center = hole * 4;
  for (const radius of [1, 1.5]) for (let j = 0; j < count; j++) {
    const angle = 2 * Math.PI * j / count;
    vertices.push(center + radius * Math.cos(angle), radius * Math.sin(angle), 0);
  }
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    const face = [start + next, start + i, start + count + i, start + count + next];
    for (const [j, id] of face.entries()) {
      polygons.push(j === 3 ? ~id : id);
      const [x, y] = vertices.slice(3 * id, 3 * id + 2);
      uv.push((x + 2) / 12, (y + 1.6) / 3.2);
      normals.push(0, 0, 1);
    }
  }
  holes.push(Array.from({ length: count }, (_, i) => start + i));
}
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
geometry.userData.assetFixerFbxPolygons = Int32Array.from(polygons);
const scene = new Scene(), map = new Texture();
map.name = 'Contour map';
const material = new MeshPhongMaterial({ name: 'Contour material', map });
const mesh = new Mesh(geometry, material);
mesh.name = 'Three open contours';
scene.add(mesh);
for (const [i, node] of [scene, mesh, geometry, material, map].entries()) {
  node.uuid = `b834db9b-82a3-4b88-b50e-${String(i).padStart(12, '0')}`;
}
const path = 'holes.fbm/BaseColor.png';
const fbx = new FBXExporter().register(plan => {
  for (const texture of plan.textures.textures.values()) texture.fileName = path;
}).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, bakeSpaceTransform: false, embedTextures: false });
const bytes = new Uint8Array(32 * 32 * 3);
for (let i = 0; i < bytes.length; i += 3) bytes.set([42, 92, 149], i);
const png = encode({ width: 32, height: 32, channels: 3, data: bytes });
await writeFile(`${directory}/holes.zip`, zipSync({ 'holes.fbx': new Uint8Array(fbx), [path]: png }, { mtime: new Date(2000, 0, 1) }));
await writeFile(`${directory}/contours.json`, JSON.stringify(holes));

const chunks = [], views = [], accessors = [];
function add(array, type, count, bounds = {}) {
  const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  views.push({ buffer: 0, byteOffset: chunks.reduce((sum, chunk) => sum + chunk.length, 0), byteLength: data.length });
  chunks.push(data, Buffer.alloc((4 - data.length % 4) % 4));
  accessors.push({ bufferView: views.length - 1, componentType: array instanceof Uint16Array ? 5123 : 5126, type, count, ...bounds });
  return accessors.length - 1;
}
const floats = (array, type, bounds) => add(Float32Array.from(array), type, 4, bounds);
const position = floats([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 'VEC3', { min: [0, 0, 0], max: [1, 1, 0] });
const normal = floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3');
const color = floats([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1], 'VEC3');
const texcoord = floats([0, 0, 1, 0, 0, 1, 1, 1], 'VEC2');
const morph = floats([0, 0, 0, 0, 0, .125, 0, 0, .375, 0, 0, .5], 'VEC3', { min: [0, 0, 0], max: [0, 0, .5] });
const indices = add(Uint16Array.from([0, 1, 2, 2, 1, 3]), 'SCALAR', 6);
const payload = Buffer.concat(chunks);
const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0,
  scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Colored morph' }],
  meshes: [{ weights: [0], extras: { targetNames: ['Lift'] }, primitives: [{ indices,
    attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: texcoord, COLOR_0: color }, targets: [{ POSITION: morph }] }] }],
  buffers: [{ byteLength: payload.length }], bufferViews: views, accessors }));
const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const header = Buffer.alloc(20), binaryHeader = Buffer.alloc(8);
header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + payload.length, 8);
header.writeUInt32LE(padded.length, 12); header.write('JSON', 16);
binaryHeader.writeUInt32LE(payload.length); binaryHeader.write('BIN\0', 4);
await writeFile(`${directory}/colored-morph.glb`, Buffer.concat([header, padded, binaryHeader, payload]));
