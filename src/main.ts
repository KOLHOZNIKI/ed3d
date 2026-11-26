import { AmbientLight, Box3, DirectionalLight, Mesh, MeshLambertMaterial, MeshPhongMaterial, PerspectiveCamera, Scene, SkinnedMesh, SRGBColorSpace, Texture, Vector3, WebGLRenderer, type BufferGeometry } from 'three';
import { exportAsset, importAsset, type ImportedAsset } from './e00/round-trip';
import { exportGlb, importGlb, type ImportedGlb } from './e00/glb-round-trip';
import { unwrapAsset } from './e00/uv-atlas';
import { rebakeAsset } from './e00/rebake';
import { brushRadius, paintableMesh, paintStroke, type TexturePaint } from './e00/paint';

function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`The E00 prototype is missing ${selector}.`);
  return node;
}
const canvas = element<HTMLCanvasElement>('#viewport');
const status = element('#status');
const sources = element<HTMLInputElement>('#sources');
const closeButton = element<HTMLButtonElement>('#close-model');
const exportButton = element<HTMLButtonElement>('#export');
const unwrapButton = element<HTMLButtonElement>('#unwrap');
const rebakeButton = element<HTMLButtonElement>('#rebake');
const paintButton = element<HTMLButtonElement>('#paint');
const paintColor = element<HTMLInputElement>('#paint-color');
const undoStroke = element<HTMLButtonElement>('#undo-stroke');

const context = canvas.getContext('webgl2', { antialias: true });
const renderer = context ? new WebGLRenderer({ canvas, context }) : null;
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1.5));
const light = new DirectionalLight(0xffffff, 2);
light.position.set(3, 5, 4);
scene.add(light);
renderer?.setClearColor(0x151b25);

let asset: ImportedAsset | ImportedGlb | undefined;
let camera: PerspectiveCamera | undefined;
let paintedPreview: { geometry: BufferGeometry; material: MeshLambertMaterial | MeshPhongMaterial; texture: Texture } | undefined;
let paintEnabled = false;
const history: (TexturePaint | undefined)[] = [];
let stroke: { pointer: number; points: [number, number][] } | undefined;

function paintControls(working = false) {
  const available = !!(renderer && asset?.format === 'fbx' && paintableMesh(asset));
  closeButton.disabled = working || !asset;
  paintButton.disabled = working || !available;
  paintColor.disabled = working || !available || !paintEnabled;
  undoStroke.disabled = working || !history.length;
  paintButton.setAttribute('aria-pressed', String(paintEnabled));
  canvas.style.cursor = paintEnabled && !working ? 'crosshair' : '';
  canvas.style.touchAction = paintEnabled && !working ? 'none' : '';
}

function clearPaintPreview() {
  paintedPreview?.geometry.dispose();
  paintedPreview?.material.dispose();
  paintedPreview?.texture.dispose();
  paintedPreview = undefined;
  paintEnabled = false;
  stroke = undefined;
  history.length = 0;
}

function renderPreview() {
  if (!renderer || !camera) return;
  const mesh = asset?.format === 'fbx' ? paintableMesh(asset) : undefined;
  if (!mesh || !paintedPreview) {
    renderer.render(scene, camera);
    return;
  }
  const { geometry, material } = mesh;
  try {
    mesh.geometry = paintedPreview.geometry;
    mesh.material = paintedPreview.material;
    renderer.render(scene, camera);
  } finally {
    mesh.geometry = geometry;
    mesh.material = material;
  }
}

async function previewTexture(snapshot: ImportedAsset, paint?: TexturePaint) {
  const mesh = paintableMesh(snapshot);
  const original = mesh?.material;
  const png = paint?.png ?? snapshot.textureBake?.maps.find(map => map.slot === 'map')?.png;
  if (!mesh || !png || !(original instanceof MeshLambertMaterial || original instanceof MeshPhongMaterial)) return;
  const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!paintedPreview) {
      const geometry = snapshot.uvAtlas!.geometry.clone();
      geometry.setAttribute('uv', geometry.getAttribute('uv1'));
      const material = original.clone();
      const texture = new Texture();
      texture.colorSpace = SRGBColorSpace;
      material.map = texture;
      paintedPreview = { geometry, material, texture };
    }
    paintedPreview.texture.image = image;
    paintedPreview.texture.needsUpdate = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function releaseCurrentAsset() {
  clearPaintPreview();
  if (asset) {
    releasePreview(asset.scene);
    if (asset.format === 'fbx') asset.uvAtlas?.geometry.dispose();
  }
  asset = undefined;
  camera = undefined;
  renderer?.renderLists.dispose();
}

closeButton.addEventListener('click', () => {
  releaseCurrentAsset();
  renderer?.clear();
  canvas.hidden = true;
  exportButton.textContent = 'Export FBX ZIP';
  unwrapButton.textContent = 'Generate UV atlas';
  rebakeButton.textContent = 'Rebake textures';
  exportButton.disabled = unwrapButton.disabled = rebakeButton.disabled = true;
  paintControls();
  status.textContent = 'Model closed.';
});

sources.addEventListener('change', async () => {
  const input = Array.from(sources.files ?? []);
  if (!input.length) return;
  sources.disabled = true;
  exportButton.disabled = true;
  unwrapButton.disabled = true;
  rebakeButton.disabled = true;
  paintControls(true);
  status.textContent = 'Opening local asset…';
  try {
    const glb = input.find(file => /\.glb$/i.test(file.name));
    if (glb && input.length !== 1) throw new Error('Select one GLB file at a time.');
    const imported = glb ? await importGlb(glb) : await importAsset(input);
    releaseCurrentAsset();
    asset = imported;
    exportButton.textContent = asset.format === 'glb' ? 'Export GLB' : 'Export FBX ZIP';
    unwrapButton.textContent = 'Generate UV atlas';
    rebakeButton.textContent = 'Rebake textures';
    const { stats } = asset;
    status.textContent = `${asset.name} · ${stats.triangles.toLocaleString()} triangles · ${stats.bones} bones · ${stats.clips} clips`;
    if (asset.format === 'glb' && asset.affineCorrections) {
      status.textContent += ` · Corrected rounding in ${asset.affineCorrections} inverse bind matrices for GLB export`;
    }
    if (asset.format === 'fbx') {
      const { maxSkinInfluences, pointsOverPreviewLimit, morphChannels, hasMorphTargets } = asset.deformation;
      if (pointsOverPreviewLimit > 0) {
        status.textContent += ` · Approximate skin preview: ${pointsOverPreviewLimit} control points exceed the four-influence limit` +
          ` (maximum ${maxSkinInfluences}). All source weights are retained.`;
      }
      if (hasMorphTargets) status.textContent += ` · ${morphChannels} morph channels detected. FBX export is blocked for morph targets.`;
    }
    if (renderer) {
      scene.add(asset.scene);
      const bounds = new Box3().setFromObject(asset.scene);
      const center = bounds.getCenter(new Vector3());
      const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.001);
      camera = new PerspectiveCamera(40, canvas.width / canvas.height, radius / 100, radius * 100);
      camera.position.copy(center).addScaledVector(new Vector3(0.6, 0.45, 1).normalize(), 3.5 * radius);
      camera.lookAt(center);
      renderPreview();
      canvas.hidden = false;
    } else {
      status.textContent += ' · WebGL2 preview unavailable';
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sources.value = '';
    sources.disabled = false;
    exportButton.disabled = !asset;
    unwrapButton.disabled = asset?.format !== 'fbx';
    rebakeButton.disabled = asset?.format !== 'fbx' || !asset.uvAtlas;
    paintControls();
  }
});

exportButton.addEventListener('click', async () => {
  if (!asset) return;
  sources.disabled = true;
  exportButton.disabled = true;
  unwrapButton.disabled = true;
  rebakeButton.disabled = true;
  paintControls(true);
  const glb = asset.format === 'glb';
  status.textContent = glb ? 'Preparing GLB…' : 'Preparing FBX package…';
  try {
    const output = asset.format === 'glb' ? await exportGlb(asset) : await exportAsset(asset);
    const url = URL.createObjectURL(new Blob([output.bytes], { type: glb ? 'model/gltf-binary' : 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = output.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `Exported ${output.name}.` + (glb ? '' : ' See manifest.json for material assignments and scope.');
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sources.disabled = false;
    exportButton.disabled = false;
    unwrapButton.disabled = asset.format !== 'fbx';
    rebakeButton.disabled = asset.format !== 'fbx' || !asset.uvAtlas;
    paintControls();
  }
});

unwrapButton.addEventListener('click', async () => {
  if (asset?.format !== 'fbx') return;
  if (asset.uvAtlas) {
    clearPaintPreview();
    asset.uvAtlas.geometry.dispose();
    asset = { ...asset, uvAtlas: undefined, textureBake: undefined, texturePaint: undefined };
    unwrapButton.textContent = 'Generate UV atlas';
    rebakeButton.textContent = 'Rebake textures';
    rebakeButton.disabled = true;
    status.textContent = 'Restored the source UV channels.';
    paintControls();
    renderPreview();
    return;
  }
  sources.disabled = exportButton.disabled = unwrapButton.disabled = rebakeButton.disabled = true;
  paintControls(true);
  status.textContent = 'Generating UV atlas…';
  try {
    asset = await unwrapAsset(asset);
    const atlas = asset.uvAtlas!.metrics;
    status.textContent = `Generated ${atlas.charts} charts at ${atlas.width}×${atlas.height} in UV1. Export writes triangles. Existing textures still use UV0.`;
    unwrapButton.textContent = 'Discard UV atlas';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sources.disabled = exportButton.disabled = unwrapButton.disabled = false;
    rebakeButton.disabled = !asset.uvAtlas;
    paintControls();
  }
});

rebakeButton.addEventListener('click', async () => {
  if (asset?.format !== 'fbx' || !asset.uvAtlas) return;
  if (asset.textureBake) {
    clearPaintPreview();
    asset = { ...asset, textureBake: undefined, texturePaint: undefined };
    rebakeButton.textContent = 'Rebake textures';
    status.textContent = 'Restored the UV atlas with the original maps on UV0.';
    paintControls();
    renderPreview();
    return;
  }
  sources.disabled = exportButton.disabled = unwrapButton.disabled = rebakeButton.disabled = true;
  paintControls(true);
  status.textContent = 'Rebaking the original textures from UV0 to UV1…';
  try {
    const baked = await rebakeAsset(asset);
    await previewTexture(baked);
    asset = baked;
    renderPreview();
    const bake = baked.textureBake!;
    status.textContent = `Rebaked ${bake.maps.length} maps from UV0 to UV1 at ${bake.width}×${bake.height}. FBX export makes the atlas primary for Unity.`;
    rebakeButton.textContent = 'Discard texture bake';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sources.disabled = exportButton.disabled = unwrapButton.disabled = rebakeButton.disabled = false;
    paintControls();
  }
});

paintButton.addEventListener('click', () => {
  paintEnabled = !paintEnabled;
  stroke = undefined;
  paintControls();
  status.textContent = paintEnabled ? `Drag on the model to paint Base Color. Brush diameter ${brushRadius * 2} viewport pixels.` : '3D brush is off.';
});

function pointerPoint(event: PointerEvent): [number, number] {
  const bounds = canvas.getBoundingClientRect();
  return [(event.clientX - bounds.left) * canvas.width / bounds.width, (event.clientY - bounds.top) * canvas.height / bounds.height];
}

canvas.addEventListener('pointerdown', (event) => {
  if (!paintEnabled || paintButton.disabled || stroke || event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  stroke = { pointer: event.pointerId, points: [pointerPoint(event)] };
  event.preventDefault();
});
canvas.addEventListener('pointermove', (event) => {
  if (stroke?.pointer !== event.pointerId) return;
  stroke.points.push(pointerPoint(event));
});
canvas.addEventListener('pointercancel', (event) => {
  if (stroke?.pointer === event.pointerId) stroke = undefined;
});
canvas.addEventListener('pointerup', async (event) => {
  if (stroke?.pointer !== event.pointerId) return;
  const { points } = stroke;
  stroke = undefined;
  if (asset?.format !== 'fbx' || !camera || paintButton.disabled) return;
  points.push(pointerPoint(event));
  const snapshot = asset;
  setStrokeBusy(true);
  status.textContent = 'Projecting the stroke onto visible faces…';
  try {
    const paint = await paintStroke(snapshot, camera, canvas.width, canvas.height, points, paintColor.value);
    if (paint) {
      await previewTexture(snapshot, paint);
      history.push(snapshot.texturePaint);
      asset = { ...snapshot, texturePaint: paint };
      renderPreview();
      status.textContent = `Painted ${paint.lastStrokeTexels.toLocaleString()} Base Color texels.`;
    } else status.textContent = 'The stroke missed the visible model.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setStrokeBusy(false);
  }
});

undoStroke.addEventListener('click', async () => {
  if (asset?.format !== 'fbx' || !history.length) return;
  stroke = undefined;
  const previous = history.at(-1);
  setStrokeBusy(true);
  try {
    await previewTexture(asset, previous);
    asset = { ...asset, texturePaint: previous };
    history.pop();
    renderPreview();
    status.textContent = 'Undid the last stroke.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setStrokeBusy(false);
  }
});

function setStrokeBusy(working: boolean) {
  sources.disabled = exportButton.disabled = unwrapButton.disabled = rebakeButton.disabled = working;
  paintControls(working);
}

function releasePreview(model: ImportedAsset['scene']): void {
  model.removeFromParent();
  const textures = new Set<Texture>();
  const bitmaps = new Set<ImageBitmap>();
  model.traverse(object => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    if (object instanceof SkinnedMesh) object.skeleton.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const property of Object.values(material)) {
        if (property instanceof Texture) textures.add(property);
      }
      material.dispose();
    }
  });
  for (const texture of textures) {
    if (texture.image instanceof ImageBitmap) bitmaps.add(texture.image);
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
}
