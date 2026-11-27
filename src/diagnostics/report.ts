import { Mesh, PropertyBinding, SkinnedMesh, Texture } from 'three';
import versions from '../../package.json';
import { renderControlPoints, sourceMesh } from '../e00/fbx-topology';
import { checkMapping } from '../humanoid/profile';
import { decodeEdit } from '../mesh/commands';
import type { Model, ModelAdapter } from '../project/adapter';
import type { AssetDocument } from '../project/document';
import type { WorkingState } from '../project/state';
import { finishWorker } from '../project/worker';
import { drawVertices } from '../weights/sampling';
import type { Issue, ScanMesh } from './state';

const MiB = 1024 * 1024;
const semantics: Readonly<Record<string, string>> = {
  map: 'Base Color', normalMap: 'Normal', roughnessMap: 'Roughness', metalnessMap: 'Metallic', aoMap: 'AO',
  emissiveMap: 'Emissive', alphaMap: 'Alpha', bumpMap: 'Bump', specularMap: 'Specular', displacementMap: 'Displacement',
};

function dimensions(image: unknown) {
  if (typeof image !== 'object' || image === null) return undefined;
  const data = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  const width = data.naturalWidth ?? data.width, height = data.naturalHeight ?? data.height;
  return width && height ? { width, height } : undefined;
}

export function describeAsset(adapter: ModelAdapter, state: WorkingState, model: Model) {
  const resources = new Map<Texture, { id: string; name: string; width?: number; height?: number; colorSpace: string }>();
  const materialIds = new Set<string>();
  const objects = adapter.viewEntries.flatMap(entry => {
    const node = adapter.objects.get(entry.id);
    if (!(node instanceof Mesh)) return [];
    const attributes = node.geometry.attributes;
    const materials = (Array.isArray(node.material) ? node.material : [node.material]).map((material, slot) => {
      materialIds.add(material.uuid);
      const maps = Object.entries(semantics).flatMap(([key, semantic]) => {
        const texture: unknown = (material as unknown as Record<string, unknown>)[key];
        if (!(texture instanceof Texture)) return [];
        let resource = resources.get(texture);
        if (!resource) {
          const size = dimensions(texture.image);
          resource = { id: `texture-${resources.size + 1}`, name: texture.name || texture.image?.name || semantic,
            ...size, colorSpace: texture.colorSpace || 'linear or unspecified' };
          resources.set(texture, resource);
        }
        return [{ semantic, resource: resource.id, uv: texture.channel }];
      });
      return { slot, name: material.name || `Material ${slot + 1}`, model: material.type, maps };
    });
    return [{ id: entry.id, name: state.objects[entry.id]?.name ?? entry.name, sourceName: node.name,
      triangles: (node.geometry.index?.count ?? attributes.position.count) / 3,
      uvSets: Object.keys(attributes).filter(name => /^uv\d*$/.test(name)), materials, skinned: node instanceof SkinnedMesh }];
  });
  const maps = [...resources.values()];
  const decodedMapBytes = maps.reduce((bytes, { width = 0, height = 0 }) => bytes + width * height * 4, 0);
  return { objects, maps, materialCount: materialIds.size, decodedMapBytes, triangles: model.stats.triangles, bones: model.stats.bones };
}

export function inspectCapabilities(adapter: ModelAdapter, model: Model, state: WorkingState, description: ReturnType<typeof describeAsset>) {
  const issues: Issue[] = [], append = (code: string, severity: Issue['severity'], message: string, object?: string) => issues.push({ code, severity, message, object });
  if (model.format === 'fbx') {
    if (model.deformation.hasMorphTargets) append('fbx-morph-export', 'Error', 'FBX model export is blocked because the writer cannot preserve the source morph targets. Export Original is available.');
    if (model.deformation.pointsOverPreviewLimit) append('fbx-preview-limit', 'Warning', `${model.deformation.pointsOverPreviewLimit} control points use more than four influences. The FBX writer retains all source weights.`);
    append('fbx-material-profile', 'Info', 'FBX uses the Unity-compatible Phong material profile and an external-map manifest. Review PBR and alpha assignments in Unity.');
  } else {
    if (model.affineCorrections) append('glb-affine-correction', 'Info', `Corrected affine rounding in ${model.affineCorrections} inverse bind matrices.`);
    if (adapter.mesh.omittedPolygonMetadata) append('glb-private-polygons', 'Warning', 'The edited GLB exports indexed triangles. The source private polygon extension requires its original topology.');
  }
  for (const item of description.objects) for (const material of item.materials) for (const map of material.maps) {
    const resource = description.maps.find(item => item.id === map.resource)!;
    if (!resource.width || !resource.height) append('unreadable-material-map', 'Error', `${material.name}: ${map.semantic} has no decoded image.`, item.id);
    const uvName = map.uv ? `uv${map.uv}` : 'uv';
    if (!item.uvSets.includes(uvName) && !(map.uv === 0 && item.uvSets.includes('uv0'))) {
      append('map-uv-channel', 'Warning', `${material.name}: ${map.semantic} references a missing UV channel.`, item.id);
    }
    if (map.semantic === 'Normal' && resource.colorSpace === 'srgb') append('map-color-space', 'Warning', `${material.name}: the normal map is marked sRGB.`, item.id);
  }
  if (adapter.rig.blocked) append('bind-edit-block', 'Warning', adapter.rig.blocked);
  for (const item of adapter.rig.clips) {
    if (item.reason) append('clip-incompatible', 'Error', `${item.original.clip.name}: ${item.reason}`);
    if (item.setting.mode === 'exclude') append('clip-excluded', 'Info', `${item.original.clip.name} is explicitly excluded.`);
  }
  for (const clip of model.scene.animations) for (const track of clip.tracks) {
    try {
      const target = PropertyBinding.parseTrackName(track.name);
      if (!PropertyBinding.findNode(model.scene, target.nodeName)) append('unresolved-track', 'Error', `${clip.name}: unresolved animation target ${track.name}.`);
    } catch { append('unresolved-track', 'Error', `${clip.name}: invalid animation track ${track.name}.`); }
  }
  if (state.humanoid) {
    const { profile, published } = state.humanoid, basis = state.rig?.basis ?? '';
    const mapping = checkMapping(profile, state.rig?.joints ?? adapter.rig.original.joints);
    if (!mapping.complete) append('humanoid-partial', 'Info', 'The humanoid role map supports a partial diagnostic check.');
    for (const clip of published) if (clip.basis !== basis) append('stale-diagnostic-clip', 'Error', `Published clip ${clip.name} is stale. Remove it or publish it again on the current rig.`);
  }
  const bakes = [state.bake, ...Object.values(state.uvBakes ?? {}).map(item => item.bake),
    ...Object.values(state.extracts ?? {}).flatMap(asset => Object.values(asset.bakes).map(item => item.bake))];
  for (const bake of bakes) {
    const misses = bake?.projection?.misses ?? bake?.direct?.misses ?? 0;
    if (misses) append('bake-misses', 'Warning', `A recorded bake has ${misses} unresolved texels. Review its coverage view.`);
  }
  if (adapter.mesh.pendingUv) append('pending-face-uv', 'Warning', `${adapter.mesh.pendingUv} created faces need UV review.`);
  if (description.triangles > 250_000 || description.decodedMapBytes > 256 * MiB) {
    append('heavy-workload', 'Warning', 'This asset exceeds the heavy editing benchmark. Inspect memory before allocating another large bake.');
  }
  return issues;
}

export function exportReport(adapter: ModelAdapter, model: Model, document: AssetDocument<WorkingState>, issues: readonly Issue[] = []) {
  const { state } = document, description = describeAsset(adapter, state, model);
  const commands: Record<string, number> = {};
  for (const bytes of state.meshEdits ?? []) { const kind = decodeEdit(bytes).type; commands[kind] = (commands[kind] ?? 0) + 1; }
  const conversions = [state.atlas && 'FBX atlas creates a new UV channel', state.bake && 'Baked atlas uses UV0 in FBX',
    document.textureAssignments && 'Missing or ambiguous FBX texture references resolved through local assignments',
    Object.keys(state.uvBakes ?? {}).length && 'Working texture transfers use the recorded bake targets',
    Object.keys(state.extracts ?? {}).length && 'Extracted assets use their selected layouts and independent maps',
    state.rig && 'Working rig and clip policy applied', model.format === 'glb' && model.affineCorrections && 'GLB inverse bind affine row corrected'].filter(Boolean) as string[];
  const knownLosses = [model.format === 'fbx' && 'Vendor-specific FBX entities and PBR authoring metadata are outside the binary adapter profile.',
    model.format === 'glb' && adapter.mesh.omittedPolygonMetadata && 'Private GLB polygon metadata omitted after topology or incompatible corner changes.'].filter(Boolean) as string[];
  const findings = [...inspectCapabilities(adapter, model, state, description), ...issues];
  return {
    version: 1, project: { id: document.id, name: document.name, revision: document.revision },
    target: { format: model.format, scope: 'scene' as 'scene' | 'asset' | 'batch',
      profile: model.format === 'fbx' ? 'Unity FBX / external texture maps' : 'glTF 2.0 binary' },
    adapters: { three: versions.dependencies.three, fbxWriter: versions.dependencies['@comfyorg/fbx-exporter-three'],
      xatlas: versions.dependencies['xatlas-wasm'], zip: versions.dependencies.fflate },
    originals: document.originals.map(({ name, hash, data }) => ({ name, sha256: hash, bytes: data.size })),
    textureAssignments: document.textureAssignments,
    scene: description, files: [] as string[], changes: { commands, textureEdits: Object.keys(state.textures ?? {}).length },
    conversions, knownLosses, findings,
    animations: { source: adapter.rig.originalClips.map(item => item.clip.name), written: model.scene.animations.map(clip => clip.name),
      adapted: adapter.rig.clips.filter(item => item.setting.mode === 'adapted' && item.clip).map(item => item.clip!.name),
      published: state.humanoid?.published.map(clip => clip.name) ?? [] },
    reimportVerification: { status: 'Pending independent reimport', procedure: 'See Docs/E12_Report.md for the Unity and independent parser procedures.' },
  };
}

export type ExportReport = ReturnType<typeof exportReport>;

export function extractedReport(report: ExportReport, ids: readonly string[], scope: 'asset' | 'batch'): ExportReport {
  const objects = report.scene.objects.filter(object => ids.includes(object.id));
  const materialMaps = objects.flatMap(object => object.materials.flatMap(material => material.maps.map(map => map.resource)));
  const maps = report.scene.maps.filter(map => materialMaps.includes(map.id));
  return { ...report, target: { ...report.target, scope }, files: [], scene: { ...report.scene, objects, maps, bones: 0,
    triangles: objects.reduce((sum, object) => sum + object.triangles, 0),
    materialCount: objects.reduce((sum, object) => sum + object.materials.length, 0),
    decodedMapBytes: maps.reduce((sum, map) => sum + (map.width ?? 0) * (map.height ?? 0) * 4, 0) },
    animations: { source: [], written: [], adapted: [], published: [] },
    conversions: ['Independent static asset layout and pivot policy applied.'],
    findings: report.findings.filter(issue => issue.object ? ids.includes(issue.object) : issue.code === 'fbx-material-profile') };
}

export function reportText(report: ExportReport) {
  const list = (items: readonly string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : 'None recorded.';
  return [
    'AssetFixer compatibility report',
    `${report.project.name} (${report.project.id}), revision ${report.project.revision}`,
    `${report.target.format.toUpperCase()} · ${report.target.profile} · ${report.target.scope}`,
    `Adapters: ${Object.entries(report.adapters).map(([name, version]) => `${name} ${version}`).join(', ')}`,
    `Scene: ${report.scene.objects.length} meshes, ${report.scene.triangles} triangles, ${report.scene.materialCount} materials, ${report.scene.maps.length} maps`,
    `Approximate RGBA texture storage: ${(report.scene.decodedMapBytes / MiB).toFixed(1)} MiB before mipmaps and working copies.`,
    `Objects\n${list(report.scene.objects.map(object => `${object.name} (${object.id})`))}`,
    `Files\n${list(report.files)}`, `Clips\n${list(report.animations.written)}`,
    `Conversions\n${list(report.conversions)}`, `Known losses and profile limits\n${list(report.knownLosses)}`,
    `Findings\n${list(report.findings.map(issue => `${issue.severity} / ${issue.code}: ${issue.message}`))}`,
    `${report.reimportVerification.status}. ${report.reimportVerification.procedure}`,
  ].join('\n\n') + '\n';
}

export async function scanAsset(adapter: ModelAdapter, global: boolean, signal?: AbortSignal) {
  const meshes: ScanMesh[] = [];
  const transfer: Transferable[] = [];
  const add = <T extends Float64Array<ArrayBuffer> | Uint32Array<ArrayBuffer>>(array: T) => { transfer.push(array.buffer); return array; };
  // Paint or export can only use committed geometry. Transfer private copies to the worker.
  for (const [id, node] of adapter.objects) {
    if (!(node instanceof Mesh)) continue;
    const topology = adapter.workingTopology(id)!;
    const fbx = adapter.model.format === 'fbx' ? sourceMesh(node.geometry) : undefined;
    let skin: ScanMesh['skin'];
    if (node instanceof SkinnedMesh) {
      const count = topology.positions.length / 3, joints = node.skeleton.bones.length;
      if (fbx?.skin) {
        const entries = new Float64Array(3 * fbx.skin.reduce((sum, item) => sum + item.indices.length, 0));
        let cursor = 0;
        const original = renderControlPoints(fbx);
        const logical = new Map<number, number>();
        for (let i = 0; i < original.length; i++) logical.set(original[i], topology.corners[fbx.renderCorners[i]]);
        for (const [bone, item] of fbx.skin.entries()) for (let k = 0; k < item.indices.length; k++) {
          entries[cursor++] = logical.get(item.indices[k]) ?? item.indices[k];
          entries[cursor++] = bone;
          entries[cursor++] = item.weights[k];
        }
        skin = { vertexCount: count, joints, entries: add(entries) };
      } else {
        const rows = new Map<number, number>();
        for (const [index, logical] of drawVertices(adapter, id, node)) if (!rows.has(logical)) rows.set(logical, index);
        const indices = node.geometry.getAttribute('skinIndex'), weights = node.geometry.getAttribute('skinWeight');
        const data = new Float64Array(rows.size * weights.itemSize * 3);
        let cursor = 0;
        for (const [logical, index] of rows) for (let slot = 0; slot < weights.itemSize; slot++) {
          data[cursor++] = logical; data[cursor++] = indices.getComponent(index, slot); data[cursor++] = weights.getComponent(index, slot);
        }
        skin = { vertexCount: count, joints, entries: add(data) };
      }
    }
    meshes.push({ object: id, positions: add(Float64Array.from(topology.positions)), corners: add(Uint32Array.from(topology.corners)),
      faceEnds: add(Uint32Array.from(topology.faceEnds)), edges: add(Uint32Array.from(topology.edgeVertices)),
      edgeFaceEnds: add(Uint32Array.from(topology.edgeFaceEnds)), edgeFaces: add(Uint32Array.from(topology.edgeFaces)),
      triangleCorners: add(fbx ? fbx.renderCorners.slice() : Uint32Array.from(topology.corners, (_, i) => i)),
      triangleFaces: add(Uint32Array.from(topology.renderFaces)), skin,
      attributes: [...topology.cornerAttributes].filter(([name]) => name === 'normal' || /^uv\d*$/.test(name))
        .map(([name, { size, values }]) => ({ name, size, values: add(Float64Array.from(values)) })) });
  }
  return finishWorker<Issue[]>(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), { meshes, global }, transfer, signal);
}
