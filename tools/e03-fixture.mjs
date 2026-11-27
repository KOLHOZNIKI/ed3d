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

function exportFixture(name, scene, withMap = true) {
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
  if (withMap) files[path] = png;
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
