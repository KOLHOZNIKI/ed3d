import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import { mkdir, writeFile } from 'node:fs/promises';
import { AnimationClip, Bone, BufferGeometry, ClampToEdgeWrapping, Float32BufferAttribute, Mesh, MeshPhongMaterial,
  Quaternion, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, Vector3 } from 'three';

const directory = 'test-results/e03';
await mkdir(directory, { recursive: true });
const size = 128;
const pixels = new Uint8Array(size * size * 4);
for (let i = 0; i < pixels.length; i += 4) pixels.set([64, 96, 140, 255], i);
const png = encode({ width: size, height: size, channels: 4, data: pixels });

function geometry(position, indices, uv) {
  const mesh = new BufferGeometry();
  mesh.setAttribute('position', new Float32BufferAttribute(position, 3));
  if (uv) mesh.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  mesh.setIndex(indices);
  mesh.computeVertexNormals();
  return mesh;
}

function material(withMap) {
  const map = withMap ? new Texture() : null;
  if (map) { map.name = 'Paint sample'; map.wrapS = map.wrapT = ClampToEdgeWrapping; }
  return new MeshPhongMaterial({ name: 'Paintable', map });
}

function exportFixture(name, scene, withMap = true, image = png) {
  let count = 0;
  scene.traverse(object => {
    for (const value of [object, object.geometry, object.material, object.material?.map].filter(Boolean)) {
      value.uuid = `1d77bc95-9376-461c-acd5-${String(count++).padStart(12, '0')}`;
    }
  });
  for (const clip of scene.animations) clip.uuid = `1d77bc95-9376-461c-acd5-${String(count++).padStart(12, '0')}`;
  const path = `${name}.fbm/BaseColor.png`;
  const fbx = new FBXExporter().register(plan => {
    for (const entry of plan.textures?.textures.values() ?? []) entry.fileName = path;
  }).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
  const files = { [`${name}.fbx`]: new Uint8Array(fbx) };
  if (withMap) files[path] = image;
  return writeFile(`${directory}/${name}.zip`, zipSync(files, { mtime: new Date(2000, 0, 1) }));
}

// The two lobes are separated by .04 world units at the stroke, but joined
// only at the top. A second, disconnected plane is hidden behind the left lobe.
const positions = [
  -.58, -.52, 0, -.02, -.52, 0, -.58, .38, 0, -.02, .38, 0,
  .02, -.52, -.022, .58, -.52, -.022, .02, .38, -.022, .58, .38, -.022,
  -.02, .55, 0, .02, .55, -.022,
  -.23, -.32, -.025, -.026, -.32, -.025, -.23, .15, -.025, -.026, .15, -.025,
];
const faces = [0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6,
  2, 3, 8, 3, 6, 8, 6, 9, 8, 6, 7, 9, 10, 11, 12, 11, 13, 12];
const uv = [];
for (let i = 0; i < 30; i += 3) uv.push(.38 + positions[i] * .5, .43 + positions[i + 1] * .67);
uv.push(.83, .1, .96, .1, .83, .9, .96, .9);
const testMesh = new Mesh(geometry(positions, faces, uv), material(true));
testMesh.name = 'Connected lobes and occluded plane';
const lab = new Scene();
lab.add(testMesh);
await exportFixture('paint_fold', lab);

// Reuse the map on both adjacent lobes. Editing a shared texel must be disclosed.
const overlap = uv.slice();
overlap.splice(8, 8, ...overlap.slice(0, 8));
testMesh.geometry = geometry(positions, faces, overlap);
await exportFixture('paint_overlap', lab);

const ribbon = geometry([-.25, 0, 0, .25, 0, 0, -.25, 1, 0, .25, 1, 0, -.25, 2, 0, .25, 2, 0],
  [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5], [.125, .0625, .875, .0625, .125, .5, .875, .5, .125, .9375, .875, .9375]);
ribbon.setAttribute('skinIndex', new Uint16BufferAttribute([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
], 4));
ribbon.setAttribute('skinWeight', new Float32BufferAttribute([
  1, 0, 0, 0, 1, 0, 0, 0, .5, .5, 0, 0, .5, .5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
], 4));
const root = new Bone(), elbow = new Bone();
root.name = 'Base';
elbow.name = 'Elbow';
elbow.position.y = 1;
root.add(elbow);
const skinned = new SkinnedMesh(ribbon, material(true));
skinned.name = 'Sleeve';
skinned.add(root);
const rig = new Scene();
rig.add(skinned);
rig.updateMatrixWorld(true);
skinned.bind(new Skeleton([root, elbow]));
const axis = new Vector3(0, 0, 1);
rig.animations = [new AnimationClip('Bend', 1, [new QuaternionKeyframeTrack('Elbow.quaternion', [0, .25, .75, 1],
  [0, .6, -.4, 0].flatMap(angle => new Quaternion().setFromAxisAngle(axis, angle).toArray()))])];
await exportFixture('paint_elbow', rig);
skinned.material = material(false);
ribbon.deleteAttribute('uv');
await exportFixture('paint_no_uv', rig, false);

const gridPoints = [], gridIndices = [], gridUvs = [], gridJoints = [], gridWeights = [];
for (let row = 0; row < 5; row++) for (let column = 0; column < 5; column++) {
  const id = row * 5 + column;
  gridPoints.push(column - 2, id === 12 ? .5 : 0, row);
  gridUvs.push(column / 4, row / 4);
  if (column < 4 && row < 4) gridIndices.push(id, id + 5, id + 1, id + 1, id + 5, id + 6);
  gridJoints.push(0, 1, 0, 0);
  gridWeights.push(1 - row / 4, row / 4, 0, 0);
}
const grid = geometry(gridPoints, gridIndices, gridUvs);
const smoothStatic = new Mesh(grid, material(true));
smoothStatic.name = 'Smooth grid';
await exportFixture('smooth_selection_static', new Scene().add(smoothStatic));

const smoothGeometry = grid.clone();
smoothGeometry.setAttribute('skinIndex', new Uint16BufferAttribute(gridJoints, 4));
smoothGeometry.setAttribute('skinWeight', new Float32BufferAttribute(gridWeights, 4));
const smoothSkin = new SkinnedMesh(smoothGeometry, material(true));
smoothSkin.name = 'Smooth ribbon';
const gridBase = new Bone(), gridHinge = new Bone();
gridBase.name = 'GridBase';
gridHinge.name = 'GridHinge';
gridHinge.position.z = 2;
gridBase.add(gridHinge);
smoothSkin.add(gridBase);
const smoothRig = new Scene().add(smoothSkin);
smoothRig.updateMatrixWorld(true);
smoothSkin.bind(new Skeleton([gridBase, gridHinge]));
const gridAxis = new Vector3(1, 0, 0);
smoothRig.animations = [new AnimationClip('GridBend', 1, [new QuaternionKeyframeTrack('GridHinge.quaternion', [0, .5, 1],
  [0, .5, 0].flatMap(angle => new Quaternion().setFromAxisAngle(gridAxis, angle).toArray()))])];
await exportFixture('smooth_selection_skinned', smoothRig);

const flattenRegion = [6, 7, 8, 11, 12, 13, 16, 17, 18];
function projectedGrid(source, normal, offset) {
  const result = source.clone(), positions = result.getAttribute('position');
  const [nx, ny, nz] = normal;
  for (const id of flattenRegion) {
    const x = positions.getX(id), y = positions.getY(id), z = positions.getZ(id);
    const distance = x * nx + y * ny + z * nz - offset;
    positions.setXYZ(id, x - distance * nx, y - distance * ny, z - distance * nz);
  }
  result.computeVertexNormals();
  return result;
}
const angled = [1, 3, 1].map(value => value / Math.sqrt(11));
smoothStatic.geometry = projectedGrid(grid, angled, .75);
await exportFixture('flatten_reference_custom', smoothStatic.parent);

const tilted = smoothGeometry.clone(), tiltedPositions = tilted.getAttribute('position');
for (let i = 0; i < tiltedPositions.count; i++) {
  const x = tiltedPositions.getX(i), y = tiltedPositions.getY(i);
  tiltedPositions.setXYZ(i, .6 * x - .8 * y, .8 * x + .6 * y, tiltedPositions.getZ(i));
}
tilted.computeVertexNormals();
smoothSkin.geometry = tilted;
await exportFixture('flatten_selection_skinned', smoothRig);
// A rigid rotation preserves the fitted plane of the symmetric raised-center grid.
smoothSkin.geometry = projectedGrid(tilted, [-.8, .6, 0], .5 / flattenRegion.length);
await exportFixture('flatten_reference_best', smoothRig);

const gradient = pixels.slice();
for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) gradient[(row * size + column) * 4] = column * 2;
const gradientPng = encode({ width: size, height: size, channels: 4, data: gradient });
const relaxLayout = gridUvs.slice();
relaxLayout.splice(14, 2, .49, .24);
relaxLayout.splice(24, 2, .60, .52);

function subdivideReference(source) {
  const p = Array.from(source.getAttribute('position').array), uvs = Array.from(source.getAttribute('uv').array), indices = [];
  const sourceTriangles = Array.from(source.index.array);
  const edges = [[6, 11], [11, 7], [7, 6]];
  for (const [a, b] of edges) {
    for (let axis = 0; axis < 3; axis++) p.push((gridPoints[a * 3 + axis] + gridPoints[b * 3 + axis]) / 2);
    for (let axis = 0; axis < 2; axis++) uvs.push((gridUvs[a * 2 + axis] + gridUvs[b * 2 + axis]) / 2);
  }
  for (let i = 0; i < sourceTriangles.length; i += 3) {
    const triangle = sourceTriangles.slice(i, i + 3);
    if (i / 3 === 10) { indices.push(6, 25, 27, 25, 11, 26, 27, 26, 7, 25, 26, 27); continue; }
    const edge = edges.findIndex(pair => pair.every(id => triangle.includes(id)));
    if (edge < 0) { indices.push(...triangle); continue; }
    const j = triangle.findIndex((a, k) => edges[edge].includes(a) && edges[edge].includes(triangle[(k + 1) % 3]));
    const first = triangle[j], second = triangle[(j + 1) % 3], opposite = triangle[(j + 2) % 3], middle = 25 + edge;
    indices.push(first, middle, opposite, middle, second, opposite);
  }
  const result = geometry(p, indices, uvs);
  if (source.hasAttribute('skinWeight')) {
    const joints = gridJoints.slice(), weights = gridWeights.slice();
    for (const [a, b] of edges) {
      joints.push(0, 1, 0, 0);
      weights.push(...[0, 1, 2, 3].map(k => (gridWeights[a * 4 + k] + gridWeights[b * 4 + k]) / 2));
    }
    result.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4));
    result.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  }
  return result;
}

for (const [name, object, source] of [['static', smoothStatic, grid], ['skinned', smoothSkin, smoothGeometry]]) {
  const scene = object.parent;
  object.geometry = source.clone().setAttribute('uv', new Float32BufferAttribute(relaxLayout, 2));
  await exportFixture(`relax_source_${name}`, scene, true, gradientPng);
  object.geometry = source.clone();
  const xyz = object.geometry.getAttribute('position');
  for (const [id, offset] of [[11, .125], [12, 0], [13, -.125]]) xyz.setXYZ(id, xyz.getX(id) + offset, xyz.getY(id) + .0625, xyz.getZ(id));
  object.geometry.computeVertexNormals();
  await exportFixture(`mirror_reference_${name}`, scene);
  object.geometry = subdivideReference(source);
  await exportFixture(`subdivide_reference_${name}`, scene);
}
