import { AmbientLight, Box3, DirectionalLight, Mesh, PerspectiveCamera, Scene, SkinnedMesh, Texture, Vector3, WebGLRenderer } from 'three';
import { exportAsset, importAsset, type ImportedAsset } from './e00/round-trip';
import { exportGlb, importGlb, type ImportedGlb } from './e00/glb-round-trip';
import { unwrapAsset } from './e00/uv-atlas';
import { rebakeAsset } from './e00/rebake';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
const status = document.getElementById('status');
const sources = document.querySelector<HTMLInputElement>('#sources');
const exportButton = document.querySelector<HTMLButtonElement>('#export');
const unwrapButton = document.querySelector<HTMLButtonElement>('#unwrap');
const rebakeButton = document.querySelector<HTMLButtonElement>('#rebake');

if (!canvas || !status || !sources || !exportButton || !unwrapButton || !rebakeButton) {
  throw new Error('The E00 prototype is missing its workspace elements.');
}

const context = canvas.getContext('webgl2', { antialias: true });
const renderer = context ? new WebGLRenderer({ canvas, context }) : null;
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1.5));
const light = new DirectionalLight(0xffffff, 2);
light.position.set(3, 5, 4);
scene.add(light);
renderer?.setClearColor(0x151b25);

let asset: ImportedAsset | ImportedGlb | undefined;
sources.addEventListener('change', async () => {
  const input = Array.from(sources.files ?? []);
  if (!input.length) return;
  sources.disabled = true;
  exportButton.disabled = true;
  unwrapButton.disabled = true;
  rebakeButton.disabled = true;
  status.textContent = 'Opening local asset…';
  try {
    const glb = input.find(file => /\.glb$/i.test(file.name));
    if (glb && input.length !== 1) throw new Error('Select one GLB file at a time.');
    const imported = glb ? await importGlb(glb) : await importAsset(input);
    if (asset) {
      releasePreview(asset.scene);
      if (asset.format === 'fbx') asset.uvAtlas?.geometry.dispose();
    }
    asset = imported;
    exportButton.textContent = asset.format === 'glb' ? 'Export GLB' : 'Export FBX ZIP';
    unwrapButton.textContent = 'Generate UV atlas';
    rebakeButton.textContent = 'Rebake textures';
    const { stats } = asset;
    status.textContent = `${asset.name} · ${stats.triangles.toLocaleString()} triangles · ${stats.bones} bones · ${stats.clips} clips`;
    if (asset.format === 'glb' && asset.affineCorrections) {
      status.textContent += ` · Corrected rounding in ${asset.affineCorrections} inverse bind matrices for GLB export`;
    }
    if (renderer) {
      scene.add(asset.scene);
      const bounds = new Box3().setFromObject(asset.scene);
      const center = bounds.getCenter(new Vector3());
      const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.001);
      const camera = new PerspectiveCamera(40, canvas.width / canvas.height, radius / 100, radius * 100);
      camera.position.copy(center).addScaledVector(new Vector3(0.6, 0.45, 1).normalize(), 3.5 * radius);
      camera.lookAt(center);
      renderer.render(scene, camera);
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
  }
});

exportButton.addEventListener('click', async () => {
  if (!asset) return;
  sources.disabled = true;
  exportButton.disabled = true;
  unwrapButton.disabled = true;
  rebakeButton.disabled = true;
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
  }
});

unwrapButton.addEventListener('click', async () => {
  if (asset?.format !== 'fbx') return;
  if (asset.uvAtlas) {
    asset.uvAtlas.geometry.dispose();
    asset = { ...asset, uvAtlas: undefined, textureBake: undefined };
    unwrapButton.textContent = 'Generate UV atlas';
    rebakeButton.textContent = 'Rebake textures';
    rebakeButton.disabled = true;
    status.textContent = 'Restored the source UV channels.';
    return;
  }
  sources.disabled = exportButton.disabled = unwrapButton.disabled = rebakeButton.disabled = true;
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
  }
});

rebakeButton.addEventListener('click', async () => {
  if (asset?.format !== 'fbx' || !asset.uvAtlas) return;
  if (asset.textureBake) {
    asset = { ...asset, textureBake: undefined };
    rebakeButton.textContent = 'Rebake textures';
    status.textContent = 'Restored the UV atlas with the original maps on UV0.';
    return;
  }
  sources.disabled = exportButton.disabled = unwrapButton.disabled = rebakeButton.disabled = true;
  status.textContent = 'Rebaking the original textures from UV0 to UV1…';
  try {
    asset = await rebakeAsset(asset);
    const bake = asset.textureBake!;
    status.textContent = `Rebaked ${bake.maps.length} maps from UV0 to UV1 at ${bake.width}×${bake.height}. FBX export makes the atlas primary for Unity.`;
    rebakeButton.textContent = 'Discard texture bake';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sources.disabled = exportButton.disabled = unwrapButton.disabled = rebakeButton.disabled = false;
  }
});

function releasePreview(model: ImportedAsset['scene']): void {
  model.removeFromParent();
  model.traverse(object => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    if (object instanceof SkinnedMesh) object.skeleton.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const property of Object.values(material)) {
        if (property instanceof Texture) property.dispose();
      }
      material.dispose();
    }
  });
}
