import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import {
  AnimationClip, Bone, BufferGeometry, Float32BufferAttribute, MeshPhongMaterial, Quaternion,
  QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3,
} from 'three';

const bodyPoints = [-0.25, 0, 0, 0.25, 0, 0, -0.25, 0.75, 0, 0.25, 0.75, 0, -0.25, 1.5, 0, 0.25, 1.5, 0];
const middle = [0.3125, 0.25, 0.1875, 0.15625, 0.09375];
const rows = [[1, 0, 0, 0, 0], [1, 0, 0, 0, 0], middle, middle, [0, 0, 0, 0, 1], [0, 0, 0, 0, 1]];
const targets = [
  ['Raise', new Map([[2, [0, 0, 0.125]], [4, [0, 0, 0.25]]])],
  ['Widen', new Map([[3, [0.0625, 0, 0]], [5, [0.1875, 0, 0]]])],
];

function fixture(withMorphs) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(bodyPoints, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(rows.flatMap(() => [0, 1, 2, 3]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(rows.flatMap(row => row.slice(0, 4)), 4));
  geometry.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5]);
  geometry.computeVertexNormals();
  if (withMorphs) {
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = targets.map(([name, deltas]) => {
      const attribute = new Float32BufferAttribute(rows.flatMap((_, vertex) => deltas.get(vertex) ?? [0, 0, 0]), 3);
      attribute.name = name;
      return attribute;
    });
  }

  const bones = Array.from({ length: 5 }, (_, index) => {
    const bone = new Bone();
    bone.name = `Joint${index + 1}`;
    bone.position.y = index ? 0.25 : 0;
    return bone;
  });
  bones.slice(1).forEach((bone, index) => bones[index].add(bone));
  const mesh = new SkinnedMesh(geometry, new MeshPhongMaterial({ name: 'Untextured' }));
  mesh.name = 'WideSkin';
  const scene = new Scene();
  scene.add(mesh, bones[0]);
  scene.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  const axis = new Vector3(0, 0, 1);
  const track = new QuaternionKeyframeTrack('Joint5.quaternion', [0, 0.25, 0.75, 1],
    [0, 0.6, -0.4, 0].flatMap(angle => new Quaternion().setFromAxisAngle(axis, angle).toArray()));
  const clip = new AnimationClip('FifthInfluenceBend', 1, [track]);
  scene.animations = [clip];
  for (const [index, entity] of [scene, mesh, geometry, mesh.material, ...bones, clip].entries()) {
    entity.uuid = `62c56170-789b-4fcc-9c0a-${String(index).padStart(12, '0')}`;
  }
  return new FBXExporter().register(plan => {
    // The authoring preview has four slots. Write all five source cluster contributions directly.
    for (const cluster of plan.meshes[0].skin.clusters) {
      const entries = rows.flatMap((row, vertex) => row[cluster.boneIdx] ? [[vertex, row[cluster.boneIdx]]] : []);
      cluster.indices = entries.map(([vertex]) => vertex);
      cluster.weights = entries.map(([, weight]) => weight);
    }
  }).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
}

const directory = 'test-results/e00/f13';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/f13_wide_skin.fbx`, new Uint8Array(fixture(false)));
await writeFile(`${directory}/f13_wide_skin_morphs.fbx`, new Uint8Array(fixture(true)));
