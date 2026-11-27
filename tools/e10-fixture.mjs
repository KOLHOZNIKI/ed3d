import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { AnimationClip, Bone, BufferGeometry, Float32BufferAttribute, MeshPhongMaterial, Quaternion, QuaternionKeyframeTrack,
  Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';

const directory = 'test-results/e10';
await mkdir(directory, { recursive: true });
const points = [-.27, -.02, .02, .27];
const positions = points.slice(0, 2).flatMap(x => [[x, 0, 0], [x, .5, 0], [x, 1, 0]]).concat(
  points.slice(2).flatMap(x => [[x, 0, 0], [x, .5, 0], [x, 1, 0]]));
const triangles = [[0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2], [6, 9, 10], [6, 10, 7], [7, 10, 11], [7, 11, 8]];
const weights = [1, .5, 0, 1, .5, 0, .35, .25, 0, .35, .25, 0];
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute(positions.flat(), 3));
geometry.setAttribute('normal', new Float32BufferAttribute(triangles.flatMap(() => [0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
geometry.setAttribute('uv', new Float32BufferAttribute(triangles.flatMap((_, i) => {
  const u = (i % 4) / 4, v = Math.floor(i / 4) / 2;
  return [u + .01, v + .025, u + .2, v + .025, u + .2, v + .4];
}), 2));
geometry.setAttribute('skinIndex', new Uint16BufferAttribute(weights.flatMap((_, id) => [0, id < 6 ? 1 : 2, 0, 0]), 4));
geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights.flatMap(weight => [weight, 1 - weight, 0, 0]), 4));
geometry.userData.assetFixerFbxPolygons = Int32Array.from(triangles.flatMap(([a, b, c]) => [a, b, ~c]));

const bones = ['Palm', 'LeftFinger', 'RightFinger'].map(name => Object.assign(new Bone(), { name }));
bones[1].position.set(-.145, .3, 0);
bones[2].position.set(.145, .3, 0);
bones[0].add(bones[1], bones[2]);
const mesh = new SkinnedMesh(geometry, new MeshPhongMaterial({ name: 'Fingers' }));
mesh.name = 'Fingers';
const scene = new Scene();
scene.add(mesh, bones[0]);
scene.updateMatrixWorld(true);
mesh.bind(new Skeleton(bones));
const axis = new Vector3(0, 0, 1);
const track = new QuaternionKeyframeTrack('LeftFinger.quaternion', [0, .5, 1], [0, .6, 0].flatMap(angle =>
  new Quaternion().setFromAxisAngle(axis, angle).toArray()));
const clip = new AnimationClip('FingerBend', 1, [track]);
scene.animations = [clip];
for (const [index, object] of [scene, mesh, geometry, mesh.material, ...bones, clip].entries()) {
  object.uuid = `9206ecce-0646-41a4-b4a2-${String(index).padStart(12, '0')}`;
}
const options = {
  preset: 'unity', axisForward: '-Z', unitScale: 100, bakeSpaceTransform: false, embedTextures: false,
};
await writeFile(`${directory}/fingers.fbx`, new FBXExporter().parseSync(scene, options));
const invalid = new FBXExporter().register(plan => {
  for (const cluster of plan.meshes[0].skin.clusters) {
    const indices = [], weights = [];
    for (let i = 0; i < cluster.indices.length; i++) {
      const vertex = cluster.indices[i];
      if (vertex === 3) continue;
      indices.push(vertex);
      weights.push(vertex === 4 && cluster.boneIdx === 1 ? .2 : cluster.weights[i]);
    }
    cluster.indices = indices;
    cluster.weights = weights;
  }
}).parseSync(scene, options);
await writeFile(`${directory}/fingers-invalid.fbx`, invalid);
