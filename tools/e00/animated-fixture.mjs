import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import {
  AnimationClip, Bone, BufferGeometry, Float32BufferAttribute, MeshPhongMaterial,
  Quaternion, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3,
} from 'three';

const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([
  -0.25, 0, 0, 0.25, 0, 0, -0.25, 1, 0, 0.25, 1, 0, -0.25, 2, 0, 0.25, 2, 0,
], 3));
geometry.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5]);
geometry.computeVertexNormals();
geometry.setAttribute('skinIndex', new Uint16BufferAttribute([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
], 4));
geometry.setAttribute('skinWeight', new Float32BufferAttribute([
  1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
], 4));

const root = new Bone();
root.name = 'Base';
const hinge = new Bone();
hinge.name = 'Hinge';
hinge.position.y = 1;
root.add(hinge);

const mesh = new SkinnedMesh(geometry, new MeshPhongMaterial({ name: 'Untextured' }));
mesh.name = 'Ribbon';
mesh.add(root);
mesh.updateMatrixWorld(true);
mesh.bind(new Skeleton([root, hinge]));
const scene = new Scene();
scene.add(mesh);

const axis = new Vector3(0, 0, 1);
const angles = [0, 0.6, -0.4, 0];
const track = new QuaternionKeyframeTrack('Hinge.quaternion', [0, 0.25, 0.75, 1],
  angles.flatMap(angle => new Quaternion().setFromAxisAngle(axis, angle).toArray()));
scene.animations = [new AnimationClip('Bend', 1, [track])];

const directory = 'test-results/e00';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/animated_fixture.fbx`, new FBXExporter().parseSync(scene, {
  preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false,
}));
