import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { strToU8, zipSync } from 'fflate';
import { AnimationClip, BufferGeometry, ClampToEdgeWrapping, Float32BufferAttribute, Group, Mesh, MeshPhongMaterial,
  Scene, Texture, VectorKeyframeTrack } from 'three';
import { glbFixture } from './corpus-glb.mjs';

const out = resolve(process.argv[2] ?? 'test-results/e00/corpus/generated');
await mkdir(out, { recursive: true });
const write = (name, bytes) => writeFile(resolve(out, name), bytes);

function patch(inner) {
  const outer = inner.map(([x, y]) => {
    const radius = Math.hypot(x, y);
    return [2 * x / radius, 2 * y / radius, 0];
  });
  const count = inner.length, back = 2 * count;
  const positions = [...outer, ...inner, ...outer.map(([x, y]) => [x, y, -0.5]), [0, 0, -0.5]];
  const indices = [];
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    indices.push(i, j, count + i, j, count + j, count + i, j, i, back + i, j, back + i, back + j, back + j, back + i, back + count);
  }
  return { positions, indices };
}

function loft(sides, rings, { bottom = true, top = false, omit = [] } = {}) {
  const positions = [], indices = [], uv = [];
  const triangle = (...face) => { if (!omit.includes(face.join(','))) indices.push(...face); };
  for (const [row, [y, width, depth, center = 0]] of rings.entries()) {
    for (let side = 0; side < sides; side++) {
      const angle = side * 2 * Math.PI / sides;
      positions.push([center + Math.cos(angle) * width, y, Math.sin(angle) * depth]);
      uv.push([side / sides, row / (rings.length - 1)]);
      if (row === rings.length - 1) continue;
      const a = row * sides + side, b = row * sides + (side + 1) % sides;
      triangle(a, a + sides, b);
      triangle(b, a + sides, b + sides);
    }
  }
  for (let side = 1; side < sides - 1; side++) {
    if (bottom) triangle(0, side, side + 1);
    if (top) {
      const last = (rings.length - 1) * sides;
      triangle(last, last + side + 1, last + side);
    }
  }
  return { positions, indices, uv };
}

function combine(pieces) {
  const result = { positions: [], indices: [], uv: [], joints: [], weights: [] };
  for (const piece of pieces) {
    const offset = result.positions.length;
    for (const key of ['positions', 'uv', 'joints', 'weights']) result[key].push(...(piece[key] ?? []));
    result.indices.push(...piece.indices.map(index => index + offset));
  }
  if (!result.uv.length) delete result.uv;
  if (!result.joints.length) delete result.joints;
  if (!result.weights.length) delete result.weights;
  return result;
}

const quad = (x, y, uv) => ({ positions: [[x,y,0], [x+1,y,0], [x+1,y+1,0], [x,y+1,0]], indices: [0,1,2,0,2,3], uv });
function rgba(size, pixel) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set(pixel(x, y), 4 * (y * size + x));
  return encode({ width: size, height: size, channels: 4, data });
}

const f03 = glbFixture();
const outline = [[1,0], [.4,.4], [0,1], [-.65,.7], [-1,0], [-.65,-.7], [0,-1], [.65,-.7]];
for (const [i, name] of ['ConcavePlanar', 'NonPlanar'].entries()) {
  const heights = i ? [0,.28,0,-.22,0,.34,0,-.18] : Array(8).fill(0);
  f03.mesh(name, [f03.primitive(patch(outline.map(([x,y], j) => [x,y,heights[j]])))], { translation: [i * 5,0,0] });
}
await write('f03_boundaries.glb', f03.finish());

const f04 = glbFixture();
const bottle = loft(12, [[0,.52,.52], [.25,.62,.62], [.9,.62,.62], [1.2,.30,.30], [1.5,.24,.24]],
  { omit: ['12,24,13', '20,32,21'] });
f04.mesh('Bottle', [f04.primitive(bottle)], { extras: { protectedLoop: Array.from({length: 12}, (_, i) => i + 48) } });
await write('f04_bottle.glb', f04.finish());

const f05 = glbFixture();
f05.mesh('GridRing', [f05.primitive(patch([[1,1,0], [-1,1,0], [-1,-1,0], [1,-1,0]]))]);
const ends = [loft(8, [[-.8,.6,.6], [-.3,.6,.6]]), loft(8, [[.3,.6,.6], [.8,.6,.6]], { bottom: false, top: true })];
f05.mesh('BridgeEnds', [f05.primitive(combine(ends))], { translation: [4,0,0] });
await write('f05_grid_bridge.glb', f05.finish());

const f07 = glbFixture();
const atlas = f07.png('Shared atlas', rgba(64, (x,y) => [32 + 48 * Math.floor(x / 16), 65 + 90 * ((x + y) % 2), 210,255]));
f07.doc.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: atlas }, metallicFactor: 0 } }];
for (const [i, name] of ['Tray', 'Handle', 'Lid'].entries()) {
  const start = (i + 0.125) / 4, end = start + .1875;
  const uv = [[start,.05],[end,.05],[end,.95],[start,.95]];
  const parts = [quad(2 * i, 0, uv)];
  if (i === 1) parts.push(quad(2 * i, 1.4, uv.map(([u,v]) => [u + .5, v])));
  f07.mesh(name, [f07.primitive({ ...combine(parts), material: 0 })]);
}
await write('f07_shared_atlas.glb', f07.finish());

const f08 = glbFixture();
const fullUv = [[0,0], [1,0], [1,1], [0,1]], secondaryUv = [[.1,.2], [.8,.1], [.9,.7], [.2,.9]];
f08.doc.extensionsUsed = ['KHR_texture_transform'];
f08.doc.materials = [0, 1].map(i => {
  const texture = f08.png(i ? 'Veil' : 'Cutout', rgba(32, (x,y) => [220 - 100 * i, x * 8, y * 8, i ? 24 + x * 7 : (x ^ y) & 4 ? 255 : 0]));
  return { name: i ? 'Veil' : 'Cutout', alphaMode: i ? 'BLEND' : 'MASK', ...(i ? {} : { alphaCutoff: .375 }),
    pbrMetallicRoughness: { metallicFactor: 0, baseColorTexture: { index: texture, texCoord: i,
      extensions: { KHR_texture_transform: i ? { offset: [.125,.25], rotation: .4, scale: [.75,1.25] }
        : { offset: [.25,0], rotation: -.2, scale: [1,.5] } } } } };
});
for (const [i, name] of ['CutoutPanel', 'VeilPanel'].entries()) {
  f08.mesh(name, [f08.primitive({ ...quad(i, 0, fullUv), uv1: secondaryUv, material: i })]);
}
await write('f08_material_bindings.glb', f08.finish());

const f11 = glbFixture();
const jointSpecs = [
  ['Pelvis', null, [0,.72,0]], ['Spine', 0, [0,.36,0]], ['Chest', 1, [0,.38,0]], ['Head', 2, [0,.45,0]],
  ['LeftArm', 2, [-.68,.09,0]], ['RightArm', 2, [.68,.09,0]], ['LeftLeg', 0, [-.25,-.15,0]], ['RightLeg', 0, [.25,-.15,0]],
];
const bones = [], centers = [];
for (const [name, parent, translation] of jointSpecs) {
  const bone = f11.node({ name, translation }, parent === null);
  if (parent !== null) (f11.doc.nodes[bones[parent]].children ??= []).push(bone);
  centers.push(translation.map((value, axis) => value + (centers[parent]?.[axis] ?? 0)));
  bones.push(bone);
}
function skinPart(rings, bindings) {
  const part = loft(12, rings, { top: true });
  part.joints = part.positions.map((_, i) => bindings[Math.floor(i / 12)][0]);
  part.weights = part.positions.map((_, i) => bindings[Math.floor(i / 12)][1]);
  return part;
}
const rigid = (rings, joint) => skinPart(rings, rings.map(() => [[joint,0,0,0], [1,0,0,0]]));
const body = skinPart([[.56,.35,.24], [.76,.61,.31], [1.05,.70,.36], [1.40,.58,.31], [1.64,.38,.22]], [
  [[0,0,0,0],[1,0,0,0]], [[0,1,0,0],[.75,.25,0,0]], [[1,0,2,0],[.5,.25,.25,0]],
  [[2,1,0,0],[.75,.25,0,0]], [[2,0,0,0],[1,0,0,0]],
]);
const head = rigid([[1.65,.20,.17], [1.87,.235,.20], [2.08,.15,.138]], 3);
const limbs = [-1,1].flatMap((side,i) => [
  rigid([[.80,.12,.11,side*.74], [1.15,.16,.13,side*.72], [1.52,.16,.14,side*.66]], 4+i),
  rigid([[.06,.14,.15,side*.25], [.33,.17,.17,side*.25], [.73,.20,.19,side*.25]], 6+i),
]);
f11.mesh('WideTorso', [f11.primitive(combine([body,head,...limbs]))], { skin: 0 });
const bind = centers.flatMap(([x,y,z]) => [1,0,0,0, 0,1,0,0, 0,0,1,0, -x,-y,-z,1]);
f11.doc.skins = [{ name: 'WideTorsoRig', skeleton: bones[0], joints: bones,
  inverseBindMatrices: f11.accessor(Float32Array.from(bind), 'MAT4') }];
const time = f11.accessor(Float32Array.of(0,.5,1), 'SCALAR', undefined, true);
const rotation = f11.accessor(Float32Array.of(0,0,0,1, 0,0,Math.sin(Math.PI/12),Math.cos(Math.PI/12), 0,0,0,1), 'VEC4');
f11.doc.animations = [{ name: 'TorsoSweep', samplers: [{ input: time, output: rotation }],
  channels: [{ sampler: 0, target: { node: bones[1], path: 'rotation' } }] }];
await write('f11_wide_torso.glb', f11.finish());

const square = quad(-.5, -.5, fullUv);
const f12 = glbFixture();
const moving = f12.mesh('MovingPanel', [f12.primitive(square)], {}, false);
const intermediate = f12.node({ name: 'Intermediate', translation: [0,25,0], children: [moving] }, false);
f12.node({ name: 'SurveyRoot', translation: [2,3,4], rotation: [-Math.SQRT1_2,0,0,Math.SQRT1_2], scale: [.01,.01,.01], children: [intermediate] });
const f12Time = f12.accessor(Float32Array.of(0,.5,1), 'SCALAR', undefined, true);
const motion = f12.accessor(Float32Array.of(0,0,0, 0,0,50, 0,0,0), 'VEC3');
f12.doc.animations = [{ name: 'ReferenceLift', samplers: [{ input: f12Time, output: motion }],
  channels: [{ sampler: 0, target: { node: moving, path: 'translation' } }] }];
await write('f12_coordinate_root.glb', f12.finish());

function fbxSquare(name, texture) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(square.positions.flat(), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(square.uv.flat(), 2));
  geometry.setIndex(square.indices);
  geometry.computeVertexNormals();
  const material = new MeshPhongMaterial({ ...(texture ? { map: texture } : {}) });
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}
function writeFbx(scene, settings, mapPath) {
  const entities = [scene, ...scene.animations];
  scene.traverse(object => {
    if (object !== scene) entities.push(object);
    if (object.isMesh) {
      entities.push(object.geometry, object.material);
      if (object.material.map) entities.push(object.material.map);
    }
  });
  entities.forEach((object, i) => { object.uuid = `42641b3d-c953-4bac-8da4-${String(i).padStart(12,'0')}`; });
  return new Uint8Array(new FBXExporter().register(plan => {
    for (const entry of plan.textures.textures.values()) entry.fileName = mapPath;
  }).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false, ...settings }));
}

const f12Scene = new Scene(), root = new Group(), helper = new Group(), panel = fbxSquare('Panel');
root.name = 'SurveyRoot';
root.position.set(2,3,4);
root.rotation.x = -Math.PI / 2;
root.scale.setScalar(.5);
helper.name = 'Intermediate';
helper.position.y = .25;
root.add(helper);
helper.add(panel);
f12Scene.add(root);
f12Scene.animations = [new AnimationClip('ReferenceLift', 1, [new VectorKeyframeTrack('Panel.position', [0,.5,1], [0,0,0, 0,0,.5, 0,0,0])])];
await write('f12_zup_axes.fbx', writeFbx(f12Scene, { axisUp: 'Z', axisForward: '-Y', unitScale: 2.54 }));

const f16Invalid = glbFixture();
f16Invalid.mesh('OutOfRange', [f16Invalid.primitive({ ...square, uv: undefined, corrupt: [0,1,2,0,2,19] })]);
await write('f16_invalid_index.glb', f16Invalid.finish());
const f16NonManifold = glbFixture();
f16NonManifold.mesh('ThreeAlongOneEdge', [f16NonManifold.primitive({ positions: [[0,0,0], [1,0,0], [.5,1,0], [.5,-1,0], [.5,0,1]],
  indices: [0,1,2,1,0,3,0,1,4] })]);
await write('f16_non_manifold.glb', f16NonManifold.finish());

const identitySize = 64, identitySource = 'identity.fbm/Source.png';
const identityPng = rgba(identitySize, (x,y) => [(x*73+y*19)%256, (x*41+y*33)%256, (x*13+y*97)%256, (x*23+y*55)%256]);
const texture = new Texture();
texture.name = 'IdentitySource';
texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
const identityScene = new Scene();
identityScene.add(fbxSquare('Identity', texture));
const model = 'identity.fbx';
const identityFbx = writeFbx(identityScene, {}, identitySource);
await write('f16_missing_texture.zip', zipSync({ [model]: identityFbx }, { mtime: new Date(2000,0,1) }));
await write('identity.zip', zipSync({ [model]: identityFbx, [identitySource]: identityPng,
  'manifest.json': strToU8(JSON.stringify({ stage: 'E00', model, assetFixerMaterial: { alphaMode: 'blend' },
    textures: [{ semantic: 'BaseColor', file: identitySource }] })) }, { mtime: new Date(2000,0,1) }));
