import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { zipSync } from 'fflate';
import { BufferGeometry, ClampToEdgeWrapping, Float32BufferAttribute, Mesh, MeshPhongMaterial, Scene, Texture } from 'three';

const width = 256, height = 256;
const pattern = new Uint8Array(width * height * 3);
const vectors = [[0.57, 0.25], [0.28, 0.59], [-0.49, 0.37], [0.41, -0.54]];
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const [u, v] = vectors[2 * Number(y >= 125) + Number(x >= 136)];
    const normal = [u, v, Math.sqrt(1 - u * u - v * v)];
    pattern.set(normal.map(component => Math.round((component * 0.5 + 0.5) * 255)), 3 * (y * width + x));
  }
}

const geometry = new BufferGeometry();
const fold = 66 * Math.PI / 180, cos = Math.cos(fold), sin = Math.sin(fold);
geometry.setAttribute('position', new Float32BufferAttribute([
  -1.4, -0.5, 0, 0, -0.5, 0, 0, 0.5, 0, -1.4, 0.5, 0,
  1.4 * cos, -0.5, 1.4 * sin, 1.4 * cos, 0.5, 1.4 * sin,
], 3));
geometry.userData.assetFixerFbxPolygons = new Int32Array([0, 1, 2, -4, 1, 4, 5, -3]);
geometry.setAttribute('normal', new Float32BufferAttribute([
  0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  -sin, 0, cos, -sin, 0, cos, -sin, 0, cos, -sin, 0, cos,
], 3));

function panelUv(degrees, mirrorV) {
  const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [[-0.7, -0.5], [0.7, -0.5], [0.7, 0.5], [-0.7, 0.5]].flatMap(([x, y]) => {
    const v = mirrorV ? -y : y;
    return [0.5 + 0.53 * (c * x - s * v), 0.5 + 0.53 * (s * x + c * v)];
  });
}

// Relative to this fixture's packed atlas, the first panel changes only
// tangent direction and the second changes both direction and handedness.
geometry.setAttribute('uv', new Float32BufferAttribute([...panelUv(-37, true), ...panelUv(157, false)], 2));
function map(name) {
  const texture = new Texture();
  texture.name = name;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  return texture;
}
const material = new MeshPhongMaterial({ name: 'Directional normal test', map: map('BaseColor'), normalMap: map('Normal') });
const mesh = new Mesh(geometry, material);
mesh.name = 'Rotated and mirrored UV panels';
const scene = new Scene();
scene.add(mesh);

const name = 'directional_normals';
const maps = {
  [`${name}.fbm/BaseColor.png`]: encode({ width: 1, height: 1, channels: 3, data: Uint8Array.of(190, 190, 190) }),
  [`${name}.fbm/Normal.png`]: encode({ width, height, channels: 3, data: pattern }),
};
const fbx = new FBXExporter().register(plan => {
  for (const entry of plan.textures.textures.values()) entry.fileName = `${name}.fbm/${entry.texture.name}.png`;
}).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
const directory = 'test-results/e00/normal-fixture';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/${name}.zip`, zipSync({ [`${name}.fbx`]: new Uint8Array(fbx), ...maps }));
