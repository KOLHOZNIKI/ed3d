import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { AnimationClip, Bone, BufferGeometry, Float32BufferAttribute, MeshPhongMaterial, Quaternion, QuaternionKeyframeTrack,
  Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3, VectorKeyframeTrack } from 'three';

const bones = [], scene = new Scene();
function joint(name, parent, offset) {
  const bone = new Bone();
  bone.name = name;
  bone.position.fromArray(offset);
  (parent ?? scene).add(bone);
  bones.push(bone);
  return bone;
}
const hips = joint('Hips', null, [0, .99, 0]);
const spine = joint('Spine', hips, [0, .18, 0]);
const chest = joint('Chest', spine, [0, .23, 0]);
const neck = joint('Neck', chest, [0, .21, 0]);
const head = joint('Head', neck, [0, .18, 0]);
for (const [side, sign] of [['Left', -1], ['Right', 1]]) {
  const shoulder = joint(`${side}Shoulder`, chest, [.12 * sign, .11, 0]);
  const arm = joint(`${side}UpperArm`, shoulder, [.09 * sign, 0, 0]);
  const guide = joint(`${side}ArmTwist`, arm, [.12 * sign, 0, 0]);
  const elbow = joint(`${side}Forearm`, guide, [.17 * sign, 0, .02]);
  const hand = joint(`${side}Hand`, elbow, [.28 * sign, 0, .01]);
  joint(`${side}IndexProximal`, hand, [.08 * sign, 0, .02]);
  const thigh = joint(`${side}Thigh`, hips, [.115 * sign, -.045, 0]);
  const shin = joint(`${side}Shin`, thigh, [0, -.45, .02]);
  const foot = joint(`${side}Foot`, shin, [0, -.43, -.015]);
  joint(`${side}Toes`, foot, [0, -.025, .14]);
}
scene.updateMatrixWorld(true);
const positions = [], uv = [], joints = [], weights = [], indices = [];
function segment(bone, tip, radius, endRadius = radius) {
  const start = bone.getWorldPosition(new Vector3()), end = tip instanceof Bone ? tip.getWorldPosition(new Vector3()) : start.clone().add(new Vector3(...tip));
  const direction = end.clone().sub(start).normalize(), normal = new Vector3(0, 0, 1);
  if (Math.abs(direction.dot(normal)) > .99) normal.set(0, 1, 0);
  normal.cross(direction).normalize();
  const tangent = new Vector3().crossVectors(direction, normal).normalize();
  const base = positions.length / 3, first = bones.indexOf(bone), last = tip instanceof Bone ? bones.indexOf(tip) : first;
  for (const [ring, origin] of [start, start.clone().lerp(end, .5), end].entries()) {
    const r = radius + (endRadius - radius) * ring / 2;
    for (let i = 0; i < 8; i++) {
      const theta = i * Math.PI / 4;
      const point = origin.clone().addScaledVector(normal, r * Math.cos(theta)).addScaledVector(tangent, r * Math.sin(theta) * .85);
      positions.push(...point.toArray()); uv.push(i / 8, ring / 2);
      const blend = ring * .375;
      joints.push(first, last === first ? 0 : last, 0, 0); weights.push(last === first ? 1 : 1 - blend, last === first ? 0 : blend, 0, 0);
      if (ring < 2) {
        const a = base + ring * 8 + i, b = base + ring * 8 + (i + 1) % 8;
        indices.push(a, b, a + 8, b, b + 8, a + 8);
      }
    }
  }
}
segment(hips, spine, .32, .34);
segment(spine, chest, .34, .31);
segment(chest, neck, .31, .14);
segment(neck, head, .095, .115);
segment(head, [0, .20, 0], .12, .10);
for (const side of ['Left', 'Right']) {
  const find = part => bones.find(bone => bone.name === `${side}${part}`);
  for (const [part, next, a, b] of [['UpperArm', 'Forearm', .105, .08], ['Forearm', 'Hand', .08, .065], ['Hand', 'IndexProximal', .065, .05],
    ['Thigh', 'Shin', .145, .105], ['Shin', 'Foot', .105, .075], ['Foot', 'Toes', .075, .045]]) segment(find(part), find(next), a, b);
}
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4));
geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
geometry.setIndex(indices);
geometry.computeVertexNormals();
const mesh = new SkinnedMesh(geometry, new MeshPhongMaterial({ name: 'Diagnostic body', color: 0xba9e86 }));
mesh.name = 'DiagnosticBody';
scene.add(mesh);
scene.updateMatrixWorld(true);
mesh.bind(new Skeleton(bones));
const sample = [0, .5, 1], axis = new Vector3(0, 1, 0);
const clip = new AnimationClip('SourceStep', 1, [
  new VectorKeyframeTrack('Hips.position', sample, [0, .99, 0, 0, 1.015, .22, 0, .99, .44]),
  new QuaternionKeyframeTrack('Spine.quaternion', sample, [0, .33, 0].flatMap(angle => new Quaternion().setFromAxisAngle(axis, angle).toArray())),
]);
scene.animations = [clip];
for (const [i, node] of [scene, mesh, geometry, mesh.material, ...bones, clip].entries()) node.uuid = `81e9a7b3-6300-413e-b19b-${String(i).padStart(12, '0')}`;
const directory = 'test-results/e11';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/humanoid.fbx`, new FBXExporter().parseSync(scene, {
  preset: 'unity', axisForward: '-Z', unitScale: 100, bakeSpaceTransform: false, embedTextures: false,
}));
