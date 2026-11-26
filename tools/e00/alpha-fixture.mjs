import { mkdir, writeFile } from 'node:fs/promises';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { encode } from 'fast-png';
import { strToU8, zipSync } from 'fflate';
import { BufferGeometry, ClampToEdgeWrapping, Float32BufferAttribute, Mesh, MeshPhongMaterial, RepeatWrapping, Scene, Texture } from 'three';

const size = 256;
const pixels = new Uint8Array(size * size * 4);
const palette = [[252, 101, 46], [40, 211, 178], [253, 220, 68], [69, 92, 232], [207, 67, 154]];
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = 1 - (y + 0.5) / size;
    const asArrow = u > 0.12 && u < 0.70 && Math.abs(v - 0.70) < (u > 0.52 ? 0.70 - u : 0.055);
    const rgb = palette[asArrow ? 2 : (Math.floor(u * 4) + 2 * Math.floor(v * 3)) % palette.length];
    const alpha = Math.hypot(u - 0.32, v - 0.34) < 0.18 ? 0 : asArrow || v > 0.82 ? 255 : u > 0.58 ? 140 : v < 0.25 ? 64 : 255;
    pixels.set([...rgb, alpha], 4 * (y * size + x));
  }
}
const png = encode({ width: size, height: size, channels: 4, data: pixels });

const angle = 27 * Math.PI / 180;
const a = 1.25 * Math.cos(angle), b = -0.82 * Math.sin(angle);
const d = 1.25 * Math.sin(angle), e = 0.82 * Math.cos(angle);
const uvTransform = [a, b, 0.17, d, e, -0.12];
const shift = [e / (a * e - b * d), -d / (a * e - b * d)];
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([
  -1, -0.65, 0, 0, -0.65, 0, 0, 0.65, 0, -1, 0.65, 0,
  0.42, -0.65, 0.91, 0.42, 0.65, 0.91,
], 3));
geometry.userData.assetFixerFbxPolygons = new Int32Array([0, 1, 2, -4, 1, 4, 5, -3]);
geometry.setAttribute('normal', new Float32BufferAttribute([
  0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  -0.91, 0, 0.42, -0.91, 0, 0.42, -0.91, 0, 0.42, -0.91, 0, 0.42,
], 3));
const left = [0, 0, 0.5, 0, 0.5, 1, 0, 1];
const right = [0.5, 0, 1, 0, 1, 1, 0.5, 1].map((value, i) => value + shift[i % 2]);
geometry.setAttribute('uv', new Float32BufferAttribute([...left, ...right], 2));
const paper = new Texture();
paper.name = 'Pattern';
paper.wrapS = RepeatWrapping;
paper.wrapT = ClampToEdgeWrapping;
const material = new MeshPhongMaterial({ name: 'Alpha pattern', color: 0xffffff, map: paper });
const mesh = new Mesh(geometry, material);
mesh.name = 'Folded display';
const scene = new Scene();
scene.add(mesh);

const directory = 'test-results/e00/alpha-fixture';
await mkdir(directory, { recursive: true });
for (const alphaMode of ['mask', 'blend']) {
  const name = `alpha_transform_${alphaMode}`;
  const model = `${name}.fbx`;
  const texture = `${name}.fbm/Pattern.png`;
  const fbx = new FBXExporter().register(plan => {
    for (const entry of plan.textures.textures.values()) entry.fileName = texture;
  }).parseSync(scene, { preset: 'unity', axisForward: '-Z', unitScale: 100, embedTextures: false, bakeSpaceTransform: false });
  const manifest = { stage: 'E00', model,
    assetFixerMaterial: { alphaMode, alphaCutoff: alphaMode === 'mask' ? 0.5 : undefined, uvTransform },
    textures: [{ semantic: 'BaseColor', file: texture }],
  };
  await writeFile(`${directory}/${name}.zip`, zipSync({
    [model]: new Uint8Array(fbx), [texture]: png, 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  }));
}
