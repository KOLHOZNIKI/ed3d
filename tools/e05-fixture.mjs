import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import { AnimationClip, Bone, BufferGeometry, Float32BufferAttribute, Mesh, MeshPhongMaterial,
  Quaternion, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, Vector3 } from 'three';

const directory = 'test-results/e05';
await mkdir(directory, { recursive: true });
const sides = 12, rings = [[0, .52], [.25, .62], [.9, .62], [1.2, .30], [1.5, .24]];
const size = 64, pixels = new Uint8Array(size * size * 3);
for (let i = 0; i < pixels.length; i += 3) pixels.set([80, 115, (Math.floor(i / (size * 3)) % 16 < 8 ? 154 : 193)], i);
const baseColor = encode({ width: size, height: size, data: pixels, channels: 3 });

async function bottle(name, skinned) {
  const positions = [], indices = [], joints = [], weights = [], uv = [];
  const missing = new Set(['12,24,13', '20,32,21']);
  function triangle(...face) { if (!missing.has(face.join(','))) indices.push(...face); }
  for (const [row, [y, radius]] of rings.entries()) {
    for (let i = 0; i < sides; i++) {
      const angle = 2 * Math.PI * i / sides;
      positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      uv.push(i / sides, row / (rings.length - 1));
      const base = [1, 1, .5, .25, 0][row];
      joints.push(0, 1, 0, 0);
      weights.push(base, 1 - base, 0, 0);
      if (row === rings.length - 1) continue;
      const a = row * sides + i, b = row * sides + (i + 1) % sides;
      triangle(a, a + sides, b);
      triangle(b, a + sides, b + sides);
    }
  }
  for (let i = 1; i < sides - 1; i++) triangle(0, i, i + 1);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const map = new Texture();
  map.name = 'Bottle color';
  const material = new MeshPhongMaterial({ name: 'Bottle finish', map });
  const mesh = skinned ? new SkinnedMesh(geometry, material) : new Mesh(geometry, material);
  const scene = new Scene();
  mesh.name = 'Bottle';
  scene.add(mesh);
  if (skinned) {
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
    const base = new Bone(), neck = new Bone();
    base.name = 'Base'; neck.name = 'Neck'; neck.position.y = .6;
    base.add(neck);
    scene.add(base);
    scene.updateMatrixWorld(true);
    mesh.bind(new Skeleton([base, neck]));
    const axis = new Vector3(0, 0, 1);
    const motion = [0, .55, 0].flatMap(angle => new Quaternion().setFromAxisAngle(axis, angle).toArray());
    scene.animations = [new AnimationClip('Bend', 1, [new QuaternionKeyframeTrack('Neck.quaternion', [0, .5, 1], motion)])];
  }
  const packed = new BufferGeometry(), cornerUv = [], normals = [];
  const normal = geometry.getAttribute('normal');
  packed.setAttribute('position', geometry.getAttribute('position'));
  packed.userData.assetFixerFbxPolygons = Int32Array.from(indices, (id, i) => i % 3 === 2 ? ~id : id);
  for (let i = 0; i < indices.length; i += 3) {
    const tri = indices.slice(i, i + 3);
    const wrap = tri.some(id => id % sides === sides - 1);
    for (const id of tri) {
      // The UV seam duplicates corner attributes across a shared control point.
      cornerUv.push(wrap && id % sides === 0 ? 1 : uv[2 * id], uv[2 * id + 1]);
      normals.push(normal.getX(id), normal.getY(id), normal.getZ(id));
    }
  }
  packed.setAttribute('uv', new Float32BufferAttribute(cornerUv, 2));
  packed.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  const path = `${name}.fbm/BaseColor.png`;
  const bytes = new FBXExporter().register(plan => {
    plan.meshes[0].geometry = packed;
    for (const texture of plan.textures.textures.values()) texture.fileName = path;
  }).parseSync(scene, { preset: 'unity', unitScale: 100, axisForward: '-Z', bakeSpaceTransform: false, embedTextures: false });
  await writeFile(`${directory}/${name}.zip`, zipSync({ [`${name}.fbx`]: bytes, [path]: baseColor }, { mtime: new Date(2000, 0, 1) }));
}

await bottle('bottle', false);
await bottle('skinned-bottle', true);
