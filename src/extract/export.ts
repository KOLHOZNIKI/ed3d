import { Group, Mesh, Texture, Vector3, type Material, type Object3D } from 'three';
import { sourceMesh } from '../e00/fbx-topology';
import { exportAsset, sourceDeformation } from '../e00/round-trip';
import { exportGlb } from '../e00/glb-round-trip';
import { sceneStats } from '../e00/scene-stats';
import { pack, type Files } from '../e00/zip';
import type { Model, ModelAdapter } from '../project/adapter';
import type { WorkingState } from '../project/state';
import { applyViews, disposeAppearance, sourceAppearance } from '../texture/appearance';
import type { TextureCatalog } from '../texture/bindings';
import { extractedReport, reportText, type ExportReport } from '../diagnostics/report';

const encode = new TextEncoder();

export function trimmedMesh(source: Mesh, format: Model['format'], extracted = true) {
  const mesh = source.clone(false);
  if (extracted && mesh.userData.gltfExtensions?.FB_ngon_encoding) {
    const { FB_ngon_encoding: _, ...extensions } = mesh.userData.gltfExtensions;
    mesh.userData.gltfExtensions = extensions;
  }
  if (!Array.isArray(mesh.material)) return mesh;
  const used = source.geometry.groups.length ? [...new Set(source.geometry.groups.map(group => group.materialIndex ?? 0))] : [0];
  const remap = new Map(used.map((slot, i) => [slot, i]));
  const materials = source.material as Material[];
  mesh.material = used.map(slot => materials[slot]);
  const geometry = mesh.geometry = source.geometry.clone();
  for (const group of geometry.groups) group.materialIndex = remap.get(group.materialIndex ?? 0);
  if (format === 'fbx') {
    const profile = sourceMesh(geometry), layer = profile.material;
    geometry.userData = { ...geometry.userData, assetFixerFbxSource: { ...profile,
      readCorner(corner, face, point, attribute) {
        const value = profile.readCorner(corner, face, point, attribute);
        return attribute === layer ? [remap.get(value[0]) ?? 0] : value;
      },
    } satisfies ReturnType<typeof sourceMesh> };
  }
  return mesh;
}

export async function exportExtract(model: Model, adapter: ModelAdapter, catalog: TextureCatalog, state: WorkingState, object: string,
  report?: ExportReport, pngTextures = false) {
  const asset = state.extracts?.[object], source = adapter.objects.get(object);
  if (!asset || !(source instanceof Mesh)) throw new Error('Select an independent asset to export.');
  adapter.mesh.validateExtract(object);
  const label = state.objects[object]?.name ?? source.name;
  const cleaned = label.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 70) || 'asset';
  const name = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned;
  const bound = sourceAppearance(catalog, state, model.format, undefined, false, object);
  const restore = applyViews(bound.appearance.views);
  let extracted: Mesh | undefined;
  try {
    const scene = new Group();
    const mesh = extracted = trimmedMesh(source, model.format);
    const pivot = source.getWorldPosition(new Vector3());
    const auxiliary: { semantic: string; file: string; colorSpace: string; channel: string; png: Uint8Array<ArrayBuffer> }[] = [];
    for (const [slot, { bake }] of Object.entries(asset.bakes)) for (const map of catalog.workingBake(state, object, Number(slot), bake).maps) {
      if (map.slot === 'roughness' || map.slot === 'metallic') auxiliary.push({
        semantic: map.slot, file: `maps/material-${Number(slot) + 1}-${map.slot}.png`, colorSpace: 'linear', channel: 'uv0', png: map.png,
      });
    }
    mesh.name = name;
    mesh.visible = true;
    let branch: Object3D = mesh;
    for (let parent = source.parent; parent && parent !== model.scene; parent = parent.parent) {
      const wrapper = new Group();
      wrapper.name = parent.name;
      wrapper.position.copy(parent.position);
      wrapper.quaternion.copy(parent.quaternion);
      wrapper.scale.copy(parent.scale);
      wrapper.add(branch);
      branch = wrapper;
    }
    if (asset.zeroOrigin) branch.position.sub(pivot);
    scene.add(branch);
    if (model.format === 'glb') {
      const result = await exportGlb({ ...model, name, scene, skins: new Map(), images: new Map([...model.images, ...bound.glb]) });
      report?.files.push(`${name}.glb`);
      return { name: `${name}.glb`, bytes: new Uint8Array(result.bytes), pivot: pivot.toArray(), rebased: asset.zeroOrigin };
    }
    const images = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) {
        if (!(value instanceof Texture) || !(value.image instanceof HTMLImageElement)) continue;
        const path = model.imagePathsByUrl.get(value.image.src), bytes = path && model.images.get(path);
        if (path && bytes) images.set(path, bytes);
      }
    }
    const result = await exportAsset({ ...model, scene, name, images, stats: sceneStats(scene, 'FBX'), deformation: sourceDeformation(scene),
      uvAtlas: undefined, textureBake: undefined, texturePaint: undefined }, bound.fbx,
    { layout: asset.layout, originAtZero: asset.zeroOrigin, pivot: pivot.toArray(), auxiliary }, undefined, report, pngTextures);
    return { ...result, pivot: pivot.toArray(), rebased: asset.zeroOrigin };
  } finally {
    if (extracted && extracted.geometry !== source.geometry) extracted.geometry.dispose();
    restore();
    disposeAppearance(bound.appearance);
  }
}

export async function exportBatch(model: Model, adapter: ModelAdapter, catalog: TextureCatalog, state: WorkingState,
  objects: readonly string[], signal?: AbortSignal, report?: ExportReport, pngTextures = false) {
  if (!objects.length) throw new Error('Choose at least one independent asset for batch export.');
  const files: Files = new Map(), assets = [];
  for (const [i, object] of objects.entries()) {
    signal?.throwIfAborted();
    const result = await exportExtract(model, adapter, catalog, state, object, report && extractedReport(report, [object], 'asset'), pngTextures);
    const path = `${String(i + 1).padStart(2, '0')}/${result.name}`;
    files.set(path, result.bytes);
    assets.push({ object, name: state.objects[object]?.name, ...state.extracts?.[object] && {
      source: state.extracts[object].source, layout: state.extracts[object].layout,
    }, path, pivot: result.pivot, originAtZero: result.rebased });
  }
  signal?.throwIfAborted();
  files.set('manifest.json', encode.encode(JSON.stringify({ stage: 'E07', format: model.format, assets }, null, 2)));
  if (report) {
    report.files.push(...files.keys(), 'report.json', 'report.txt');
    files.set('report.json', encode.encode(JSON.stringify(report, null, 2) + '\n'));
    files.set('report.txt', encode.encode(reportText(report)));
  }
  return { name: 'AssetFixer-extracted.zip', bytes: await pack(files) };
}
