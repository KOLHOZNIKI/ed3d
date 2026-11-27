import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import {
  AnimationClip, Bone, BufferGeometry, Float32BufferAttribute, MeshPhongMaterial, Quaternion,
  QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3,
} from 'three';

const sides = 8;
function makeMesh(name, color, rings, capped) {
  const positions = [], uv = [], joints = [], weights = [], indices = [];
  for (const [row, [y, width, depth, influences]] of rings.entries()) {
    for (let side = 0; side < sides; side++) {
      const angle = side * 2 * Math.PI / sides;
      positions.push(width * Math.cos(angle), y, depth * Math.sin(angle));
      uv.push(side / sides, row / (rings.length - 1));
      const used = influences.map((weight, bone) => ({ weight, bone })).filter(({ weight }) => weight > 0)
        .sort((a, b) => b.weight - a.weight);
      for (let slot = 0; slot < 4; slot++) {
        joints.push(used[slot]?.bone ?? 0);
        weights.push(used[slot]?.weight ?? 0);
      }
      if (row === rings.length - 1) continue;
      const a = row * sides + side, b = row * sides + (side + 1) % sides;
      indices.push(a, a + sides, b, b, a + sides, b + sides);
    }
  }
  if (capped) {
    const top = (rings.length - 1) * sides;
    for (let side = 1; side < sides - 1; side++) indices.push(0, side, side + 1, top, top + side + 1, top + side);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new SkinnedMesh(geometry, new MeshPhongMaterial({ name, color }));
  mesh.name = name;
  return mesh;
}

const body = makeMesh('Body', 0xc08a63, [
  [0, 0.25, 0.125, [1, 0, 0]],
  [0.375, 0.35, 0.16, [0.75, 0.25, 0]],
  [0.75, 0.325, 0.17, [0.25, 0.75, 0]],
  [1.25, 0.375, 0.2, [0, 0.5, 0.5]],
  [1.625, 0.22, 0.13, [0, 0, 1]],
], true);
const clothing = makeMesh('Clothing', 0x326c9b, [
  [0.25, 0.39, 0.20, [0.75, 0.25, 0]],
  [0.5625, 0.38, 0.22, [0.25, 0.75, 0]],
  [0.9375, 0.41, 0.235, [0, 0.75, 0.25]],
  [1.4375, 0.4, 0.232, [0, 0.25, 0.75]],
], false);
clothing.position.set(0, 0.0625, 0.015625);

const pelvis = new Bone(), spine = new Bone(), chest = new Bone();
pelvis.name = 'Pelvis';
spine.name = 'Spine';
chest.name = 'Chest';
pelvis.add(spine);
spine.add(chest);
spine.position.y = 0.625;
chest.position.y = 0.5;
const scene = new Scene();
scene.add(body, clothing, pelvis);
scene.updateMatrixWorld(true);
const skeleton = new Skeleton([pelvis, spine, chest]);
body.bind(skeleton);
clothing.bind(skeleton);

function bend(bone, axis, angles) {
  return new QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0, 0.25, 0.75, 1],
    angles.flatMap(angle => new Quaternion().setFromAxisAngle(axis, angle).toArray()));
}
const clip = new AnimationClip('SharedTorsoBend', 1, [
  bend(spine, new Vector3(0, 0, 1), [0, 0.55, -0.40, 0]),
  bend(chest, new Vector3(1, 0, 0), [0, -0.30, 0.35, 0]),
]);
scene.animations = [clip];

const reference = process.argv[2];
if (reference) {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 9);
  spine.quaternion.copy(rotation);
  scene.updateMatrixWorld(true);
  const point = new Vector3();
  for (const mesh of [body, clothing]) {
    const position = mesh.geometry.getAttribute('position');
    for (let vertex = 0; vertex < position.count; vertex++) {
      mesh.getVertexPosition(vertex, point);
      position.setXYZ(vertex, point.x, point.y, point.z);
    }
  }
  skeleton.calculateInverses();
  const spineTrack = clip.tracks[0];
  for (let offset = 0; offset < spineTrack.values.length; offset += 4) {
    new Quaternion().fromArray(spineTrack.values, offset).premultiply(rotation).toArray(spineTrack.values, offset);
  }
  clip.name = 'SharedTorsoBend_Adapted_1';
}

for (const [index, entity] of [scene, body, clothing, body.geometry, clothing.geometry, body.material, clothing.material,
  pelvis, spine, chest, clip].entries()) {
  entity.uuid = `4f62c99c-2f06-42b3-8481-${String(index).padStart(12, '0')}`;
}
const directory = 'test-results/e00/f10';
await mkdir(directory, { recursive: true });
await writeFile(reference ?? `${directory}/shared_skin.fbx`, new FBXExporter().parseSync(scene, {
  preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false,
}));
