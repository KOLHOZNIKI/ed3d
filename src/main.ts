import { Mesh, SkinnedMesh, Vector3 } from 'three';
import { exportAsset } from './e00/round-trip';
import { exportGlb } from './e00/glb-round-trip';
import { unwrapAsset } from './e00/uv-atlas';
import { blankPaintMesh, createPaintAtlas, rebakeAsset } from './e00/rebake';
import { sourceMesh } from './e00/fbx-topology';
import { captureAtlas, importOriginals, ModelAdapter, type Model } from './project/adapter';
import { captureOriginals, readProject, writeProject, type ProjectData } from './project/archive';
import { autosaveDelay, latestCheckpoint, saveCheckpoint } from './project/autosave';
import { AssetDocument, defaultHistoryBudget } from './project/document';
import { atlasColor, type WorkingState, workingBuffers } from './project/state';
import { elementId } from './project/topology';
import { disposeModel, prepareAppearance, Viewer } from './project/viewer';
import { applyViews, disposeAppearance, sourceAppearance, type Appearance } from './texture/appearance';
import { projectedModel, TextureCatalog, withoutAtlasEdits, type TextureTarget } from './texture/bindings';
import { TextureEditor } from './texture/editor';
import { encodeImage } from './texture/image';
import { PaintTool } from './paint3d/tool';
import type { Point } from './texture/stroke';
import { MeshTool } from './mesh/tool';
import { encodeEdit, type MeshEdit } from './mesh/commands';
import { RepairTool } from './repair/tool';
import { UvTool, type UvRequest } from './uv/tool';
import { fbxAtlas, uvCommand } from './uv/surface';
import { transfer } from './uv/transfer';
import { prepareProjection } from './uv/spatial';
import { RigTool } from './rig/tool';
import { WeightTool } from './weights/tool';
import type { Layout } from './uv/layout';
import { ExtractTool } from './extract/tool';
import { buildExtraction } from './extract/build';
import { exportBatch, exportExtract } from './extract/export';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}.`);
  return node as T;
}

const canvas = element<HTMLCanvasElement>('viewport');
const status = element('status'), projectStatus = element('project-status'), historyStatus = element('history-status');
const sources = element<HTMLInputElement>('sources');
const close = element<HTMLButtonElement>('close-model'), save = element<HTMLButtonElement>('save-project');
const saveAs = element<HTMLButtonElement>('save-copy'), exportButton = element<HTMLButtonElement>('export');
const unwrap = element<HTMLButtonElement>('unwrap'), rebake = element<HTMLButtonElement>('rebake');
const paintButton = element<HTMLButtonElement>('paint');
const meshButton = element<HTMLButtonElement>('mesh-mode');
const repairButton = element<HTMLButtonElement>('repair-mode');
const uvButton = element<HTMLButtonElement>('uv-mode');
const extractButton = element<HTMLButtonElement>('extract-mode');
const rigButton = element<HTMLButtonElement>('rig-mode');
const weightsButton = element<HTMLButtonElement>('weights-mode');
const paintUnwrap = element<HTMLButtonElement>('paint-unwrap');
const undo = element<HTMLButtonElement>('undo-stroke'), redo = element<HTMLButtonElement>('redo');
const cancel = element<HTMLButtonElement>('cancel-job');
const autosaveStatus = element('autosave-status'), restore = element<HTMLButtonElement>('restore-autosave');
const recovery = element('recovery');
const objects = element<HTMLSelectElement>('object-selection'), objectLabel = element<HTMLInputElement>('object-label');
const rename = element<HTMLButtonElement>('rename-object'), visibility = element<HTMLButtonElement>('object-visibility');
const projection = element<HTMLSelectElement>('projection'), viewDirection = element<HTMLSelectElement>('view-direction');
const frameSelection = element<HTMLButtonElement>('frame-selection');
const frameAll = element<HTMLButtonElement>('frame-all');
const historyBudget = element<HTMLInputElement>('history-budget');
const toggleTexture = element<HTMLButtonElement>('toggle-texture');
const viewer = new Viewer(canvas, lost => {
  stroke = undefined;
  weightsStroke = undefined;
  weightsTool.cancel();
  status.textContent = lost ? 'WebGL context lost. The project is still open and can be saved.' : 'WebGL preview restored.';
  controls();
  resumeAutosave();
});

interface Workspace {
  adapter: ModelAdapter;
  document: AssetDocument<WorkingState>;
  model: Model;
  textures: TextureCatalog;
}

let current: Workspace | undefined;
let selected = '';
let painting = false;
let meshEditing = false;
let repairing = false;
let uvEditing = false;
let extracting = false;
let rigging = false;
let weighting = false;
let weightsStroke: number | undefined;
let stroke: { pointer: number; gesture: Exclude<ReturnType<PaintTool['begin']>, string | undefined> } | undefined;
let paintBinding = '';
let picking: { pointer: number; x: number; y: number } | undefined;
let busy = false;
let abort: AbortController | undefined;
let pendingRecovery: ProjectData | undefined;
let autosaveTimer: number | undefined;
let autosaveDue: number | undefined;
let writingCheckpoint = false;
let textureGesture = false;
let unlit = false;
let liveId = 0;
let liveTarget: TextureTarget | undefined;
let liveFrame: number | undefined;
let lookId = 0;
const editor = new TextureEditor({
  busy(active) {
    textureGesture = active;
    controls();
    if (!active) resumeAutosave();
  },
  live: previewTextureStroke,
  async commit(target, image, label, copy) {
    const work = current;
    if (!work) throw new Error('Open a project first.');
    const ok = await locked(async () => {
      const { state, revision } = work.document;
      const key = copy ? target.binding.id : target.key;
      const existing = state.textures?.[target.key]?.paint ?? state.paint;
      const paint = target.atlas && existing ? { strokes: existing.strokes, lastStrokeTexels: existing.lastStrokeTexels } : undefined;
      await edit(work, revision, { ...state, paint: target.atlas ? undefined : state.paint,
        textures: { ...state.textures, [key]: { image, paint } } }, label, key);
    });
    if (!ok) throw new Error(status.textContent || 'The image edit was not committed.');
  },
  export(target, image) {
    void locked(async () => {
      const file = `${current!.document.name}-${target.binding.object}-base-color.png`.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      download(new Blob([encodeImage(image)], { type: 'image/png' }), file);
      status.textContent = `Exported ${file}.`;
    });
  },
  selectBinding(target) { selectBinding(target.binding.id); },
  unlit(value) {
    unlit = value;
    void refreshAppearance();
  },
});
const painter = new PaintTool(viewer, canvas, target => current!.textures.load(target, current!.document.state), selectBinding);
const meshTool = new MeshTool(viewer, canvas, (command, revision) =>
  commitMesh(command, revision, element<HTMLSelectElement>('mesh-operation').selectedOptions[0].textContent!),
  dragging => viewer.setPainting(painting || meshEditing || repairing || uvEditing, dragging || busy || !!stroke));
const repairTool = new RepairTool(viewer, canvas, {
  keep(object, id, value, revision) {
    void locked(async () => {
      const work = current!, state = work.document.state;
      const keepOpen = { ...state.keepOpen, [object]: { ...state.keepOpen?.[object], [id]: value } };
      await edit(work, revision, { ...state, keepOpen }, value ? 'Keep boundary open' : 'Allow boundary repair', object);
      status.textContent = value ? `${id} is protected from repair.` : `${id} can be considered for repair.`;
    });
  },
  apply(object, patches, revision) {
    return commitMesh({ type: 'repair', object, patches }, revision, patches.length > 1 ? 'Fill boundaries' : 'Fill boundary');
  },
  manual(vertices, project, material) {
    repairing = false;
    meshEditing = true;
    controls();
    meshTool.buildFace(vertices, project, material);
  },
  selectFaces(ids) {
    repairing = false;
    meshEditing = true;
    controls();
    meshTool.selectFaces(ids);
  },
  uvFaces(ids) {
    repairing = false;
    uvEditing = true;
    controls();
    uvTool.selectFaces(ids);
  },
  paintFaces(object, ids) {
    const work = current!;
    const faces = work.adapter.mesh.data(object).faces.filter(face => ids.includes(face.id));
    const target = work.textures.targets(work.document.state).find(target => target.binding.object === object &&
      faces.some(face => face.material === target.binding.slot));
    if (!target) { status.textContent = 'There is no editable Base Color binding for the new faces.'; return; }
    repairing = false;
    painting = true;
    selectBinding(target.binding.id);
    painter.selectFaces(object, faces.filter(face => face.material === target.binding.slot).map(face => face.id));
    status.textContent = '3D Paint is active on the new faces.';
  },
});

const uvTool = new UvTool(viewer, canvas, {
  async run(work) {
    let result: Layout | undefined;
    const ok = await locked(async signal => {
      result = await work(signal);
      status.textContent = 'Generated UVs in the draft.';
    }, 'Unwrapping the draft with xatlas…', true);
    return ok ? result : undefined;
  },
  commit(request) { return commitUv(request); },
});

const extractTool = new ExtractTool(viewer, canvas, {
  create(object, revision, candidates, options) {
    return locked(async signal => {
      const work = current!;
      work.document.assertRevision(revision);
      const { state, output } = await buildExtraction(work.adapter, work.model, work.textures, work.document.state,
        revision, object, candidates, options, signal);
      await edit(work, revision, state, options.independent ? 'Create independent assets' : 'Separate geometry', object, signal);
      selectObject(output[0]);
      status.textContent = `Created ${output.length} ${options.independent ? 'independent' : 'geometry'} ${output.length === 1 ? 'object' : 'objects'}.`;
    }, 'Preparing extracted assets…', true);
  },
  export(ids, batch) {
    return locked(async signal => {
      const { model, adapter, textures, document } = current!;
      const output = batch ? await exportBatch(model, adapter, textures, document.state, ids, signal)
        : await exportExtract(model, adapter, textures, document.state, ids[0]);
      signal?.throwIfAborted();
      download(new Blob([output.bytes], { type: output.name.endsWith('.glb') ? 'model/gltf-binary' : 'application/zip' }), output.name);
      status.textContent = `Exported ${output.name}.`;
    }, 'Exporting independent assets…', true);
  },
});

const rigTool = new RigTool(viewer, canvas, {
  apply(revision, state, label) {
    return locked(async () => {
      const work = current!;
      await edit(work, revision, state, label, 'rig');
      status.textContent = `${label} applied.`;
    });
  },
  orbit(dragging) { viewer.setPainting(rigging, dragging || busy); },
});

const weightsTool = new WeightTool(viewer, canvas, {
  commit: commitMesh,
  lock(revision, ids) {
    return locked(async () => {
      const work = current!;
      await edit(work, revision, { ...work.document.state, weightLocks: ids }, 'Change influence locks', 'weights');
      status.textContent = 'Influence locks updated.';
    });
  },
});

function commitUv(request: UvRequest) {
  return locked(async signal => {
    const work = current!, { object, revision, layout, channel, options } = request;
    work.document.assertRevision(revision);
    const state = work.document.state, mesh = work.adapter.objects.get(object), model = work.model;
    if (!(mesh instanceof Mesh)) throw new Error('Select a UV mesh.');
    const oldAtlas = model.format === 'fbx' && channel === 1 && model.uvAtlas?.inputGeometry === mesh.geometry ? state.atlas : undefined;
    const extracted = state.extracts?.[object];
    let next: WorkingState;
    if (request.projection) {
      if (model.format === 'fbx' && (state.atlas || channel !== 0)) {
        throw new Error('Spatial FBX output uses UV0. Discard any global atlas before projecting.');
      }
      if (options.size > 2048) throw new Error('Choose a spatial bake resolution of 2048 pixels or less.');
      const source = request.projection.object;
      const label = state.objects[source]?.name ?? work.adapter.viewEntries.find(entry => entry.id === source)?.name ?? source;
      const sourceName = `${options.original ? 'Original import' : `Working revision ${revision}`} · ${label.slice(0, 100)}`;
      const input = prepareProjection(work.adapter, state, object, request.surface, request.projection, options.original, sourceName);
      const bake = await transfer(work.adapter, model, work.textures, state, revision, object, layout, request.surface,
        { ...options, projection: { object: source, input } }, signal);
      const textures = { ...state.textures };
      delete textures[`slot/${object}/0`];
      const meshEdits = [...state.meshEdits ?? [], encodeEdit(uvCommand(object, channel, layout, true))];
      next = { ...state, textures, meshEdits,
        ...(extracted ? { extracts: { ...state.extracts, [object]: { ...extracted, bakes: { 0: { channel, bake } } } } }
          : { uvBakes: { ...state.uvBakes, [object]: { channel, bake } } }) };
    } else if (request.preserve && (extracted || model.format === 'fbx' && state.uvBakes?.[object])) {
      const slots = new Set(request.surface.slots);
      const [slot] = slots;
      if (slots.size !== 1 || model.format === 'fbx' && channel !== 0) {
        throw new Error('Rebaking an extracted mesh requires a single used material. FBX exports the bake in UV0.');
      }
      const bake = await transfer(work.adapter, model, work.textures, state, revision, object, layout, request.surface,
        { ...options, scope: { slot, triangles: Array.from(request.surface.faces.keys()), clearUnused: false } }, signal);
      const textures = { ...state.textures };
      delete textures[`slot/${object}/${slot}`];
      const meshEdits = [...state.meshEdits ?? [], encodeEdit(uvCommand(object, channel, layout, true))];
      next = { ...state, textures, meshEdits,
        ...(extracted ? { extracts: { ...state.extracts, [object]: { ...extracted, bakes: { [slot]: { channel, bake } } } } }
          : { uvBakes: { ...state.uvBakes, [object]: { channel, bake } } }) };
    } else if (model.format === 'fbx' && (request.preserve || oldAtlas)) {
      if (model.stats.meshes !== 1) throw new Error('FBX atlas transfer requires a single mesh. Change Mapping is available per mesh.');
      if (layout.uv.some(value => value < 0 || value > 1)) throw new Error('This FBX atlas requires UVs inside 0–1.');
      const atlas = fbxAtlas(mesh, request.surface, layout, request.preserve ? options.size : oldAtlas!.metrics.width,
        request.preserve ? options.size : oldAtlas!.metrics.height);
      try {
        const captured = captureAtlas(atlas);
        if (request.preserve) {
          const bake = await transfer(work.adapter, model, work.textures, state, revision, object, layout, request.surface, options, signal);
          next = { ...state, atlas: captured, bake, paint: undefined, textures: withoutAtlasEdits(state) };
        } else next = { ...state, atlas: captured };
      } finally {
        atlas.geometry.dispose();
      }
    } else {
      const meshEdits = [...state.meshEdits ?? [], encodeEdit(uvCommand(object, channel, layout, request.preserve))];
      next = { ...state, meshEdits };
      if (request.preserve) {
        const bake = await transfer(work.adapter, model, work.textures, state, revision, object, layout, request.surface, options, signal);
        const textures = { ...state.textures };
        delete textures[`slot/${object}/0`];
        next = { ...next, textures, uvBakes: { ...state.uvBakes, [object]: { channel, bake } } };
      }
    }
    await edit(work, revision, next, request.projection ? 'Project maps and apply UVs' : request.preserve ? 'Rebake and apply UVs' : 'Change UV mapping', object, signal);
    const baked = request.preserve && (next.bake ?? next.uvBakes?.[object]?.bake ??
      Object.values(next.extracts?.[object]?.bakes ?? {})[0]?.bake);
    status.textContent = baked ? `UVs and ${baked.maps.length} maps applied from ${baked.direct!.sourceName}. ${baked.direct!.misses} occupied texels had no source.` :
      'UV mapping applied. Texture images are unchanged.';
  }, request.preserve ? 'Transferring maps from the frozen source…' : 'Applying UV mapping…', true);
}

function commitMesh(command: MeshEdit, revision: number, label: string) {
  return locked(async () => {
    const work = current!;
    work.document.assertRevision(revision);
    const state = work.document.state, meshEdits = state.meshEdits ?? [];
    let textures = state.textures;
    let keepOpen = state.keepOpen;
    let uvBakes = state.uvBakes;
    if (command.type === 'separate') {
      if (state.extracts?.[command.object]) throw new Error('Use Extract to separate an independent asset and retain its map ownership.');
      if (keepOpen?.[command.object]) keepOpen = { ...keepOpen, [command.piece]: keepOpen[command.object] };
      if (uvBakes?.[command.object]) uvBakes = { ...uvBakes, [command.piece]: uvBakes[command.object] };
      for (const target of work.textures.targets(state)) {
        if (target.binding.object !== command.object || !state.textures?.[target.binding.id]) continue;
        textures = { ...textures, [`slot/${command.piece}/${target.binding.slot}`]: state.textures[target.binding.id] };
      }
    }
    const bytes = encodeEdit(command);
    await edit(work, revision, { ...state, textures, keepOpen, uvBakes, meshEdits: [...meshEdits, bytes] }, label, command.object);
    if (command.type === 'separate') selectObject(command.piece);
    status.textContent = `${label} applied.`;
  });
}

function controls() {
  const document = current?.document;
  const model = current?.model;
  const locked = busy || !!stroke || weightsStroke !== undefined || textureGesture;
  const fbx = model?.format === 'fbx';
  const editedMesh = current?.adapter.mesh.active ?? false;
  const availablePaint = !!(viewer.available && model);
  const availableWeights = availablePaint && current?.adapter.viewEntries.some(entry => current!.adapter.objects.get(entry.id) instanceof SkinnedMesh);
  if (!availablePaint) painting = false;
  if (!availablePaint) meshEditing = false;
  if (!availablePaint) repairing = false;
  if (!availablePaint) uvEditing = false;
  if (!availablePaint) extracting = false;
  if (!availablePaint || !current?.adapter.rig.available) rigging = false;
  if (!availableWeights) weighting = false;
  sources.disabled = locked;
  close.disabled = save.disabled = saveAs.disabled = exportButton.disabled = locked || !document;
  unwrap.disabled = locked || !fbx || !!current?.adapter.mesh.geometryActive;
  const canCreatePaintAtlas = !!(fbx && !model.textureBake && painting && !editedMesh && blankPaintMesh(model));
  rebake.disabled = locked || !fbx || !model.uvAtlas || canCreatePaintAtlas;
  paintButton.disabled = locked || !availablePaint;
  meshButton.disabled = locked || !availablePaint;
  repairButton.disabled = locked || !availablePaint;
  uvButton.disabled = locked || !availablePaint;
  extractButton.disabled = locked || !availablePaint;
  rigButton.disabled = locked || !availablePaint || !current?.adapter.rig.available;
  weightsButton.disabled = locked || !availableWeights;
  undo.disabled = locked || !document?.undoDepth;
  redo.disabled = locked || !document?.redoDepth;
  restore.disabled = locked;
  cancel.hidden = !abort;
  cancel.disabled = abort?.signal.aborted ?? true;
  paintButton.setAttribute('aria-pressed', String(painting));
  meshButton.setAttribute('aria-pressed', String(meshEditing));
  repairButton.setAttribute('aria-pressed', String(repairing));
  uvButton.setAttribute('aria-pressed', String(uvEditing));
  extractButton.setAttribute('aria-pressed', String(extracting));
  rigButton.setAttribute('aria-pressed', String(rigging));
  weightsButton.setAttribute('aria-pressed', String(weighting));
  canvas.style.cursor = painting && !busy ? 'crosshair' : '';
  canvas.style.touchAction = 'none';
  viewer.setPainting(painting || meshEditing || repairing || uvEditing || extracting || rigging || weighting,
    busy || !!stroke || weightsStroke !== undefined || meshTool.dragging || rigTool.dragging);
  exportButton.textContent = model?.format === 'glb' ? 'Export GLB' : 'Export FBX ZIP';
  unwrap.textContent = fbx && model.uvAtlas ? 'Discard UV atlas' : 'Generate UV atlas';
  rebake.textContent = fbx && model.textureBake ? 'Discard texture bake' : 'Rebake textures';
  projectStatus.textContent = document
    ? `${document.name} · Revision ${document.revision} · ${document.dirty ? 'Unsaved changes' : 'No unsaved changes'}`
    : 'No open project';
  historyStatus.hidden = !document;
  historyStatus.textContent = document ? `Undo available: ${document.undoDepth} · Redo available: ${document.redoDepth}` : '';
  element('project-settings').hidden = !document;
  historyBudget.disabled = locked;
  if (document && historyBudget !== window.document.activeElement) historyBudget.value = String(document.historyBudget / 1048576);
  element('viewer-tools').hidden = !viewer.camera;
  projection.disabled = viewDirection.disabled = frameAll.disabled = locked;
  element('object-tools').hidden = !document;
  objects.disabled = locked;
  objectLabel.disabled = rename.disabled = visibility.disabled = locked || !selected;
  frameSelection.disabled = !selected || locked;
  const targets = current?.textures.targets(document!.state) ?? [];
  toggleTexture.disabled = locked || !targets.length;
  toggleTexture.setAttribute('aria-expanded', String(!editor.panel.hidden));
  editor.lock(busy || !!stroke);
  if (!weighting) weightsTool.configure(undefined, locked);
  painter.configure(painting, locked, current && { model: current.model, adapter: current.adapter, revision: current.document.revision,
    targets, region: target => editor.region(target) }, paintBinding);
  paintUnwrap.hidden = !canCreatePaintAtlas;
  paintUnwrap.disabled = locked;
  meshTool.configure(meshEditing && current ? { adapter: current.adapter, id: selected, revision: document!.revision,
    blocked: !!document!.state.atlas } : undefined, locked);
  repairTool.configure(repairing && current ? { adapter: current.adapter, object: selected, revision: document!.revision,
    flags: document!.state.keepOpen?.[selected], blocked: !!document!.state.atlas } : undefined, locked);
  uvTool.configure(uvEditing && current ? { adapter: current.adapter, model: current.model, catalog: current.textures,
    state: document!.state, revision: document!.revision, object: selected } : undefined, locked);
  extractTool.configure(extracting && current ? { adapter: current.adapter, state: document!.state, revision: document!.revision, object: selected } : undefined, locked);
  rigTool.configure(rigging && current ? { session: current.adapter.rig, state: document!.state, revision: document!.revision } : undefined, locked);
  if (weighting && current) weightsTool.configure({ adapter: current.adapter, object: selected, state: document!.state, revision: document!.revision }, locked);
  const pendingUv = fbx && document?.state.bake?.direct ? 0 : current?.adapter.mesh.pendingUv ?? 0;
  const notes = [current?.adapter.mesh.omittedPolygonMetadata ? 'GLB exports the edited topology as indexed triangles and omits incompatible private polygon metadata.' : '',
    pendingUv ? `${pendingUv} created faces require UV review or unwrapping.` : '',
    current?.adapter.mesh.hasRepairFaces ? 'Repair geometry has no source texture. Use the patch selection to paint or assign its appearance.' : '',
    editedMesh && fbx && model.deformation.pointsOverPreviewLimit ? 'Some vertices have more than four influences. FBX retains the full weights.' : ''].filter(Boolean);
  element('mesh-export-note').hidden = !notes.length;
  element('mesh-export-note').textContent = notes.join(' ');
}

function renderObjects() {
  if (!current) {
    objects.replaceChildren();
    return;
  }
  const entries = current.adapter.viewEntries.filter(entry => entry.mesh);
  objects.replaceChildren(new Option('None', ''), ...entries.map(entry => {
    const state = current!.document.state.objects[entry.id] ?? entry;
    return new Option(state.visible ? state.name : `${state.name} (hidden)`, entry.id);
  }));
  selectObject(selected);
}

function selectObject(id: string) {
  const entry = current?.adapter.viewEntries.find(node => node.id === id && node.mesh);
  selected = entry?.id ?? '';
  const targets = current?.textures.targets(current.document.state) ?? [];
  if (!targets.some(target => target.binding.id === paintBinding && (!selected || target.binding.object === selected))) {
    paintBinding = (targets.find(target => target.binding.object === selected) ?? targets[0])?.binding.id ?? '';
  }
  objects.value = selected;
  const state = entry && (current!.document.state.objects[selected] ?? entry);
  objectLabel.value = state?.name ?? '';
  visibility.textContent = state?.visible === false ? 'Show object' : 'Hide object';
  const topology = current?.adapter.workingTopology(selected);
  const render = current?.adapter.mesh.render.get(selected);
  element('selection-details').textContent = topology
    ? `${selected} · ${render ? new Set(topology.corners).size : topology.positions.length / 3} vertices · ${topology.faceEnds.length} faces · First face ID ${elementId(selected, 'face', render?.render.faceIds[0] ?? 0)}`
    : '';
  viewer.select(current?.adapter.objects.get(selected));
  syncTextureEditor();
  controls();
}

function selectBinding(id: string) {
  const target = current?.textures.targets(current.document.state).find(item => item.binding.id === id);
  if (!target) return;
  paintBinding = id;
  selectObject(target.binding.object);
}

function syncTextureEditor() {
  const work = current;
  if (!work || editor.panel.hidden) return;
  const state = work.document.state;
  editor.setSession({ targets: work.textures.targets(state), atlas: work.model.format === 'fbx' ? work.model.uvAtlas?.geometry : undefined,
    load: target => work.textures.load(target, state) }, paintBinding);
}

toggleTexture.addEventListener('click', () => {
  weighting = false;
  uvEditing = false;
  extracting = false;
  rigging = false;
  if (editor.panel.hidden) {
    editor.open();
    syncTextureEditor();
  } else editor.close();
  controls();
});

async function refreshAppearance() {
  const work = current;
  if (!work) return;
  const ticket = ++lookId;
  const revision = work.document.revision;
  try {
    const appearance = await prepareAppearance(work.model, work.textures, work.document.state, undefined, unlit);
    if (current !== work || work.document.revision !== revision || ticket !== lookId) disposeAppearance(appearance);
    else {
      viewer.replaceAppearance(appearance);
      viewer.render();
    }
  } catch (error) { if (current === work && ticket === lookId) status.textContent = errorMessage(error); }
}

function previewTextureStroke(target?: TextureTarget, canvas?: HTMLCanvasElement) {
  const work = current;
  if (!work || !target || !canvas) {
    liveId++;
    liveTarget = undefined;
    if (liveFrame !== undefined) cancelAnimationFrame(liveFrame);
    liveFrame = undefined;
    viewer.setLive();
    viewer.render();
    return;
  }
  if (liveTarget?.key === target.key) {
    if (liveFrame === undefined) liveFrame = requestAnimationFrame(() => { liveFrame = undefined; viewer.updateLive(); });
    return;
  }
  liveTarget = target;
  const ticket = ++liveId;
  void prepareAppearance(work.model, work.textures, work.document.state, { target, canvas }, unlit).then(appearance => {
    if (current !== work || ticket !== liveId) disposeAppearance(appearance);
    else { viewer.setLive(appearance); viewer.updateLive(); }
  }).catch(error => { if (ticket === liveId) status.textContent = errorMessage(error); });
}

function modelStatus(model: Model) {
  const { name, stats } = model;
  let message = `${name} · ${stats.triangles.toLocaleString()} triangles · ${stats.bones} bones · ${stats.clips} clips`;
  if (model.format === 'glb') {
    if (model.affineCorrections) message += ` · Corrected rounding in ${model.affineCorrections} inverse bind matrices for GLB export`;
    if (model.nonManifoldEdges) message += ` · Non-manifold topology: ${model.nonManifoldEdges} indexed mesh edge(s) with more than two incident triangles`;
  } else {
    const { maxSkinInfluences, pointsOverPreviewLimit, morphChannels, hasMorphTargets } = model.deformation;
    if (pointsOverPreviewLimit) message += ` · Approximate skin preview: ${pointsOverPreviewLimit} control points exceed the four-influence limit` +
      ` (maximum ${maxSkinInfluences}). All source weights are retained.`;
    if (hasMorphTargets) message += ` · ${morphChannels} morph channels detected. FBX export is blocked for morph targets.`;
  }
  return message + (viewer.available ? '' : ' · WebGL2 preview unavailable');
}

async function locked(action: (signal?: AbortSignal) => Promise<void>, message?: string, cancellable = false) {
  if (busy || stroke || weightsStroke !== undefined || textureGesture) return false;
  busy = true;
  if (cancellable) abort = new AbortController();
  const signal = abort?.signal;
  if (message) status.textContent = message;
  controls();
  try {
    await action(signal);
    return true;
  } catch (error) {
    status.textContent = signal?.aborted ? 'Operation cancelled. The document is unchanged.' : errorMessage(error);
    return false;
  } finally {
    abort = undefined;
    busy = false;
    controls();
    resumeAutosave();
  }
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function canReplace() {
  return !current?.document.dirty || window.confirm('Close this project with unsaved changes? Save a project file to keep them.');
}

function closeWorkspace() {
  viewer.close();
  if (current) {
    current.adapter.dispose();
    disposeModel(current.model);
  }
  current = undefined;
  editor.close();
  previewTextureStroke();
  selected = '';
  paintBinding = '';
  painting = false;
  meshEditing = false;
  repairing = false;
  uvEditing = false;
  extracting = false;
  rigging = false;
  weighting = false;
  weightsStroke = undefined;
  autosaveDue = undefined;
  window.clearTimeout(autosaveTimer);
  autosaveStatus.textContent = '';
  renderObjects();
}

function install(workspace: Workspace, appearance?: Appearance) {
  closeWorkspace();
  current = workspace;
  workspace.adapter.applyVisibility(workspace.document.state);
  viewer.setPainting(false);
  viewer.install(workspace.model.scene, appearance);
  projection.selectedIndex = viewDirection.selectedIndex = 0;
  renderObjects();
  status.textContent = modelStatus(workspace.model);
  pendingRecovery = undefined;
  recovery.hidden = true;
}

async function makeWorkspace(model: Model, data?: ProjectData, originals = data?.originals) {
  if (!originals) throw new Error('The project has no captured originals.');
  let adapter: ModelAdapter | undefined;
  try {
    adapter = new ModelAdapter(model);
    if (data && (data.scene.length !== adapter.entries.length || data.scene.some((entry, index) => {
      const source = adapter!.entries[index];
      return entry.id !== source.id || entry.parent !== source.parent || entry.mesh !== source.mesh ||
        entry.name !== source.name || entry.visible !== source.visible || entry.transform.some((value, i) => value !== source.transform[i]);
    }))) throw new Error('The saved object hierarchy does not match the original assets.');
    const document = new AssetDocument<WorkingState>({ id: data?.id ?? crypto.randomUUID(), name: data?.name ?? model.name.slice(0, 160),
      revision: data?.revision ?? 0, originals, historyBudget: data?.historyBudget ?? defaultHistoryBudget,
      scene: adapter.entries, topology: adapter.topology, state: data?.state ?? { objects: {} } }, workingBuffers);
    const working = adapter.materialize(document.state);
    const textures = new TextureCatalog(adapter);
    textures.validate(document.state);
    if (working.format === 'fbx' && !working.textureBake?.generated && working.textureBake?.maps.some(map => !working.images.has(map.source))) {
      throw new Error('A saved baked map refers to an unknown source image.');
    }
    return { workspace: { adapter, document, model: working, textures }, appearance: await prepareAppearance(working, textures, document.state) };
  } catch (error) {
    adapter?.dispose();
    disposeModel(model);
    throw error;
  }
}

sources.addEventListener('change', () => {
  const input = Array.from(sources.files ?? []);
  sources.value = '';
  if (!input.length) return;
  void locked(async () => {
    const project = input.find(file => /\.assetfixer$/i.test(file.name));
    if (project && input.length !== 1) throw new Error('Open one .assetfixer project at a time.');
    const data = project && await readProject(project);
    const originals = data?.originals ?? await captureOriginals(input);
    const model = await importOriginals(originals);
    const { workspace, appearance } = await makeWorkspace(model, data, originals);
    if (!canReplace()) {
      if (appearance) disposeAppearance(appearance);
      workspace.adapter.dispose();
      disposeModel(workspace.model);
      status.textContent = 'Open cancelled.';
      return;
    }
    install(workspace, appearance);
    if (data) status.textContent += ' · Project restored. Undo history starts here.';
    else scheduleAutosave();
  }, 'Opening local asset…');
});

close.addEventListener('click', () => {
  if (!canReplace()) return;
  closeWorkspace();
  status.textContent = 'Model closed.';
  controls();
});

window.addEventListener('beforeunload', event => {
  if (!current?.document.dirty && !stroke && !textureGesture) return;
  event.preventDefault();
  event.returnValue = '';
});

function download(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveFile(copy: boolean) {
  void locked(async () => {
    const document = current!.document;
    const name = copy ? `${document.name.slice(0, 155)} copy` : document.name;
    const archive = await writeProject(document, copy ? { id: crypto.randomUUID(), name } : undefined);
    download(archive, `${name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}.assetfixer`);
    if (!copy) document.markSaved();
    status.textContent = copy ? 'Saved an independent project copy.' : 'Project saved as .assetfixer.';
  }, 'Packing project…');
}
save.addEventListener('click', () => saveFile(false));
saveAs.addEventListener('click', () => saveFile(true));
historyBudget.addEventListener('change', () => {
  if (!current || busy || stroke) return;
  const { document } = current;
  try {
    if (!Number.isInteger(historyBudget.valueAsNumber)) throw new Error('Enter a whole number of MiB.');
    if (document.configureHistory(historyBudget.valueAsNumber * 1048576)) scheduleAutosave();
  } catch (error) {
    status.textContent = errorMessage(error);
  }
  historyBudget.value = String(document.historyBudget / 1048576);
  controls();
});

exportButton.addEventListener('click', () => void locked(async () => {
  const { model, adapter, document, textures } = current!;
  adapter.rig.assertExportable();
  // Viewport visibility is a project setting. Export preserves the original visibility and complete asset.
  adapter.applyVisibility({ objects: {} });
  try {
    const bound = sourceAppearance(textures, document.state, model.format === 'glb' ? 'glb' : 'fbx');
    const restore = applyViews(bound.appearance.views);
    let output;
    const glb = model.format === 'glb';
    try {
      if (model.format === 'glb') output = await exportGlb({ ...model, images: new Map([...model.images, ...bound.glb]) });
      else {
        const projected = projectedModel(model, document.state);
        if (projected.format !== 'fbx') throw new Error('Invalid FBX export state.');
        const transfers = Object.entries(document.state.uvBakes ?? {}).map(([object, transfer]) => ({ object, bake: transfer.bake }));
        output = await exportAsset(projected, bound.fbx, undefined, transfers.length ? transfers : undefined);
      }
    } finally {
      restore();
      disposeAppearance(bound.appearance);
    }
    download(new Blob([output.bytes], { type: glb ? 'model/gltf-binary' : 'application/zip' }), output.name);
    status.textContent = `Exported ${output.name}.` + (glb ? '' : ' See manifest.json for material assignments and scope.');
  } finally {
    adapter.applyVisibility(document.state);
  }
}, 'Preparing export…'));

function scheduleAutosave() {
  autosaveDue = performance.now() + autosaveDelay;
  autosaveStatus.textContent = 'Autosave pending.';
  resumeAutosave();
}

function resumeAutosave() {
  window.clearTimeout(autosaveTimer);
  if (!current || autosaveDue === undefined || busy || stroke || weightsStroke !== undefined || textureGesture || writingCheckpoint) return;
  autosaveTimer = window.setTimeout(() => void writeAutosave(), Math.max(0, autosaveDue - performance.now()));
}

async function writeAutosave() {
  if (!current || busy || stroke || textureGesture || writingCheckpoint) return;
  const { document } = current;
  const revision = document.revision;
  autosaveDue = undefined;
  writingCheckpoint = true;
  const isCurrent = () => current?.document === document && document.revision === revision;
  try {
    const archive = await writeProject(document);
    if (!isCurrent()) return;
    await saveCheckpoint({ key: `${document.id}/${revision}`, name: document.name, projectId: document.id, revision,
      savedAt: Date.now(), archive });
    if (isCurrent()) autosaveStatus.textContent = `Autosaved revision ${revision} in this browser.`;
  } catch (error) {
    if (isCurrent()) autosaveStatus.textContent = `Autosave unavailable. ${errorMessage(error)} Use Save Project to download a file.`;
  } finally {
    writingCheckpoint = false;
    resumeAutosave();
  }
}

async function offerRecovery() {
  try {
    const { data, checkpoint, skipped } = await latestCheckpoint();
    if (current) return;
    pendingRecovery = data;
    recovery.hidden = !checkpoint;
    if (checkpoint) autosaveStatus.textContent = `Recover ${checkpoint.name}, revision ${checkpoint.revision} (${new Date(checkpoint.savedAt).toLocaleString()}).` +
      (skipped ? ` Skipped ${skipped} damaged checkpoint(s).` : '');
    else if (skipped) autosaveStatus.textContent = 'No intact autosave. Open a saved project file.';
  } catch {
    if (!current) autosaveStatus.textContent = 'Browser autosave is unavailable. Use Save Project to keep a file.';
  }
}

restore.addEventListener('click', () => void locked(async () => {
  const data = pendingRecovery;
  if (!data) return;
  if (!canReplace()) return;
  const { workspace, appearance } = await makeWorkspace(await importOriginals(data.originals), data);
  workspace.document.markRecovered();
  install(workspace, appearance);
  status.textContent += ' · Autosave restored. Undo history starts here.';
}, 'Restoring autosave…'));
element('dismiss-autosave').addEventListener('click', () => {
  pendingRecovery = undefined;
  recovery.hidden = true;
  autosaveStatus.textContent = '';
});

async function applyWorking(work: Workspace, revision: number, state: WorkingState, commit: () => void, signal?: AbortSignal) {
  work.document.assertRevision(revision);
  signal?.throwIfAborted();
  const previous = work.document.state;
  const geometryChange = state.meshEdits !== previous.meshEdits;
  const rigChange = state.rig !== previous.rig;
  const piecesBefore = work.adapter.mesh.pieces.map(piece => piece.id).join(',');
  const visualChange = geometryChange || rigChange || state.atlas !== previous.atlas || state.bake !== previous.bake ||
    state.paint !== previous.paint || state.textures !== previous.textures || state.uvBakes !== previous.uvBakes || state.extracts !== previous.extracts;
  let appearance: Appearance | undefined;
  try {
    const model = work.adapter.materialize(state);
    const textures = piecesBefore === work.adapter.mesh.pieces.map(piece => piece.id).join(',') ? work.textures : new TextureCatalog(work.adapter);
    textures.validate(state);
    if (visualChange) appearance = await prepareAppearance(model, textures, state, undefined, unlit);
    signal?.throwIfAborted();
    if (current !== work) throw new Error('The active project changed during the operation.');
    work.document.assertRevision(revision);
    commit();
    work.model = model;
    work.textures = textures;
  } catch (error) {
    if (appearance) disposeAppearance(appearance);
    work.model = work.adapter.materialize(previous);
    if (geometryChange || rigChange) {
      work.textures = new TextureCatalog(work.adapter);
      await refreshAppearance();
    }
    throw error;
  }
  if (visualChange) { lookId++; viewer.replaceAppearance(appearance); }
  work.adapter.applyVisibility(state);
  renderObjects();
  scheduleAutosave();
}

async function edit(work: Workspace, revision: number, state: WorkingState, label: string, resource: string, signal?: AbortSignal) {
  await applyWorking(work, revision, state, () => {
    work.document.execute({ id: crypto.randomUUID(), label, baseRevision: revision, affectedResources: [resource], state });
  }, signal);
}

cancel.addEventListener('click', () => { abort?.abort(); controls(); });

unwrap.addEventListener('click', () => void locked(async signal => {
  const work = current!;
  const { model, document } = work;
  if (model.format !== 'fbx') return;
  const { state, revision } = document;
  if (state.atlas) {
    if ((state.paint || state.textures?.[atlasColor]) && !window.confirm('Discard this atlas, its baked maps and paint? Undo can restore them.')) {
      status.textContent = 'Kept the current atlas and paint.';
      return;
    }
    await edit(work, revision, { ...state, atlas: undefined, bake: undefined, paint: undefined,
      textures: withoutAtlasEdits(state) }, 'Discard UV atlas', 'geometry', signal);
    status.textContent = 'Restored the source UV channels.';
    return;
  }
  const result = await unwrapAsset(model, signal);
  const atlas = result.uvAtlas!;
  const target = captureAtlas(atlas);
  atlas.geometry.dispose();
  await edit(work, revision, { ...state, atlas: target }, 'Generate UV atlas', 'geometry', signal);
  const hadUv = sourceMesh(atlas.inputGeometry).uvs.length > 0;
  status.textContent = `Generated ${target.metrics.charts} charts at ${target.metrics.width}×${target.metrics.height} in ${hadUv ? 'UV1' : 'UV0'}. Export writes triangles.` +
    (hadUv ? ' Existing textures still use UV0.' : '');
}, 'Generating UV atlas…', true));

paintUnwrap.addEventListener('click', () => void locked(async signal => {
  const work = current!;
  if (work.model.format !== 'fbx') return;
  const { revision, state } = work.document;
  const model = work.model.uvAtlas ? work.model : await unwrapAsset(work.model, signal);
  try {
    const bake = await createPaintAtlas(model, signal);
    await edit(work, revision, { ...state, atlas: state.atlas ?? captureAtlas(model.uvAtlas!), bake },
      'Create paint atlas', atlasColor, signal);
    status.textContent = 'Created a blank Base Color map on the new UV atlas.';
  } finally {
    if (model !== work.model && !state.atlas) model.uvAtlas!.geometry.dispose();
  }
}, 'Creating a paint atlas…', true));

rebake.addEventListener('click', () => void locked(async signal => {
  const work = current!;
  const { model, document } = work;
  if (model.format !== 'fbx') return;
  const { state, revision } = document;
  if (state.bake) {
    if ((state.paint || state.textures?.[atlasColor]) && !window.confirm('Discard the baked maps and paint? Undo can restore them.')) {
      status.textContent = 'Kept the current baked maps and paint.';
      return;
    }
    await edit(work, revision, { ...state, bake: undefined, paint: undefined, textures: withoutAtlasEdits(state) }, 'Discard texture bake', 'textures', signal);
    status.textContent = 'Restored the UV atlas with the original maps on UV0.';
    return;
  }
  const target = work.textures.targets(state)[0];
  const image = target && state.textures?.[target.key]?.image;
  const result = await rebakeAsset(model, signal, image && encodeImage(image)), bake = result.textureBake!;
  await edit(work, revision, { ...state, bake }, 'Rebake textures', 'textures', signal);
  status.textContent = `Rebaked ${bake.maps.length} maps from UV0 to UV1 at ${bake.width}×${bake.height}. FBX export makes the atlas primary for Unity.`;
}, 'Rebaking the original textures from UV0 to UV1…', true));

function navigate(direction: 'undo' | 'redo') {
  const work = current;
  const target = direction === 'undo' ? work?.document.undoTarget : work?.document.redoTarget;
  if (!work || !target) return;
  void locked(async () => {
    await applyWorking(work, work.document.revision, target.state, () => work.document.navigate(direction));
    if (direction === 'undo' && target.label === 'Brush stroke') status.textContent = 'Undid the last stroke.';
    else status.textContent = `${direction === 'undo' ? 'Undid' : 'Redid'} ${target.label}.`;
  });
}
undo.addEventListener('click', () => navigate('undo'));
redo.addEventListener('click', () => navigate('redo'));

function changeObject(label: string, update: (state: { name: string; visible: boolean }) => { name: string; visible: boolean }) {
  const work = current, id = selected;
  const entry = work?.adapter.viewEntries.find(object => object.id === id);
  if (!work || !entry) return;
  void locked(async () => {
    const { state, revision } = work.document;
    const before = state.objects[id] ?? entry, after = update(before);
    if (after.name === before.name && after.visible === before.visible) return;
    await edit(work, revision, { ...state, objects: { ...state.objects, [id]: after } }, label, id);
    status.textContent = `${label} applied.`;
  });
}
objects.addEventListener('change', () => selectObject(objects.value));
rename.addEventListener('click', () => changeObject('Object label', state => ({ ...state, name: objectLabel.value.trim() || state.name })));
visibility.addEventListener('click', () => changeObject('Object visibility', state => ({ name: state.name, visible: !state.visible })));

function frame(selection = false) {
  const direction = [new Vector3(.6, .45, 1), new Vector3(0, 0, 1), new Vector3(0, 0, -1), new Vector3(-1, 0, 0),
    new Vector3(1, 0, 0), new Vector3(0, 1, .00001), new Vector3(0, -1, .00001)][viewDirection.selectedIndex];
  viewer.frame(selection ? current?.adapter.objects.get(selected) : undefined, projection.selectedIndex === 1, direction);
  controls();
}
projection.addEventListener('change', () => frame());
viewDirection.addEventListener('change', () => frame());
frameAll.addEventListener('click', () => frame());
frameSelection.addEventListener('click', () => frame(true));

window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement ||
      busy || stroke || weightsStroke !== undefined || textureGesture || meshTool.dragging || rigTool.dragging) return;
  if (!event.ctrlKey && !event.metaKey && (uvTool.keyboard(event.key) || repairTool.keyboard(event.key) ||
      meshTool.keyboard(event.key.length === 1 ? event.key.toLowerCase() : event.key))) {
    event.preventDefault();
    return;
  }
  if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) frame(!!selected);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    navigate(event.shiftKey ? 'redo' : 'undo');
  }
});

paintButton.addEventListener('click', () => {
  weighting = false;
  rigging = false;
  uvEditing = false;
  extracting = false;
  repairing = false;
  meshEditing = false;
  painting = !painting;
  controls();
  status.textContent = painting ? '3D Paint is active.' : '3D Paint is off.';
});

meshButton.addEventListener('click', () => {
  weighting = false;
  rigging = false;
  uvEditing = false;
  extracting = false;
  repairing = false;
  meshEditing = !meshEditing;
  if (meshEditing) painting = false;
  controls();
  status.textContent = meshEditing ? 'Mesh Edit is active. Right-drag to orbit.' : 'Mesh Edit is off.';
});

repairButton.addEventListener('click', () => {
  weighting = false;
  rigging = false;
  uvEditing = false;
  extracting = false;
  repairing = !repairing;
  if (repairing) painting = meshEditing = false;
  controls();
  status.textContent = repairing ? 'Repair is active. Select boundaries in the list or viewport.' : 'Repair is off.';
});

uvButton.addEventListener('click', () => {
  weighting = false;
  rigging = false;
  extracting = false;
  uvEditing = !uvEditing;
  if (uvEditing) {
    painting = meshEditing = repairing = false;
    if (!editor.panel.hidden) editor.close();
    if (!selected) selectObject(current?.adapter.viewEntries.find(entry => entry.mesh)?.id ?? '');
  }
  controls();
  status.textContent = uvEditing ? 'UV Editor is active.' : 'UV Editor is off.';
});

extractButton.addEventListener('click', () => {
  weighting = false;
  rigging = false;
  extracting = !extracting;
  if (extracting) {
    painting = meshEditing = repairing = uvEditing = false;
    if (!editor.panel.hidden) editor.close();
    if (!selected) selectObject(current?.adapter.viewEntries.find(entry => entry.mesh)?.id ?? '');
  }
  controls();
  status.textContent = extracting ? 'Extract is active.' : 'Extract is off.';
});

rigButton.addEventListener('click', () => {
  weighting = false;
  rigging = !rigging;
  if (rigging) {
    painting = meshEditing = repairing = uvEditing = extracting = false;
    if (!editor.panel.hidden) editor.close();
  }
  controls();
  status.textContent = rigging ? 'Rig & Pose is active.' : 'Rig & Pose is off.';
});

weightsButton.addEventListener('click', () => {
  weighting = !weighting;
  if (weighting && current) {
    painting = meshEditing = repairing = uvEditing = extracting = rigging = false;
    if (!editor.panel.hidden) editor.close();
    if (!(current.adapter.objects.get(selected) instanceof SkinnedMesh)) {
      const first = current.adapter.viewEntries.find(entry => current!.adapter.objects.get(entry.id) instanceof SkinnedMesh);
      if (first) selectObject(first.id);
    }
  }
  controls();
  status.textContent = weighting ? 'Weight Paint is active. Right-drag to orbit.' : 'Weight Paint is off.';
});

function pointerPoint(event: PointerEvent): Point {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
}

canvas.addEventListener('contextmenu', event => { if (painting || meshEditing || repairing || uvEditing || extracting || rigging || weighting) event.preventDefault(); });
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || busy || stroke || weightsStroke !== undefined || textureGesture || !current) return;
  if (weighting) {
    canvas.focus({ preventScroll: true });
    if (weightsTool.begin(event)) {
      canvas.setPointerCapture(event.pointerId);
      weightsStroke = event.pointerId;
      controls();
    }
    event.preventDefault();
    return;
  }
  if (!painting) {
    if (meshEditing && meshTool.gizmoHit || rigging && rigTool.gizmoHit) return;
    if (meshEditing || repairing || uvEditing || extracting || rigging) canvas.focus({ preventScroll: true });
    picking = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    return;
  }
  if (paintButton.disabled) return;
  const gesture = painter.begin(pointerPoint(event));
  if (typeof gesture === 'string') { status.textContent = gesture; return; }
  if (!gesture) return;
  canvas.setPointerCapture(event.pointerId);
  stroke = { pointer: event.pointerId, gesture };
  controls();
  event.preventDefault();
});

canvas.addEventListener('pointermove', event => {
  if (weighting) {
    if (!busy && (weightsStroke === event.pointerId || !event.buttons)) weightsTool.move(event);
    return;
  }
  if (stroke?.pointer === event.pointerId) {
    const events = event.getCoalescedEvents?.() ?? [];
    for (const sample of events.length ? events : [event]) stroke.gesture.points.push(pointerPoint(sample));
  } else if (painting && !busy && !event.buttons) painter.move(pointerPoint(event));
  if (picking?.pointer === event.pointerId && Math.hypot(event.clientX - picking.x, event.clientY - picking.y) > 4) picking = undefined;
});

canvas.addEventListener('pointerleave', () => { painter.leave(); weightsTool.leave(); });
canvas.addEventListener('pointercancel', () => {
  stroke = picking = undefined;
  weightsStroke = undefined;
  weightsTool.cancel();
  painter.leave();
  controls();
  resumeAutosave();
});

canvas.addEventListener('pointerup', event => {
  const work = current;
  if (!work) return;
  if (weightsStroke === event.pointerId) {
    weightsStroke = undefined;
    void weightsTool.finish(event).finally(() => { controls(); resumeAutosave(); });
    return;
  }
  if (picking?.pointer === event.pointerId) {
    picking = undefined;
    if (rigging) { if (!rigTool.dragging && !rigTool.gizmoHit) rigTool.pick(event); return; }
    if (repairing && repairTool.pick(event)) return;
    if (extracting) { extractTool.pick(event); return; }
    const list = [...work.adapter.objects].filter((pair): pair is [string, Mesh] => pair[1] instanceof Mesh);
    const model = viewer.pick(event, list.map(([, mesh]) => mesh));
    const id = list.find(([, mesh]) => mesh === model)?.[0];
    if ((!meshEditing && !repairing && !uvEditing) || id) selectObject(id ?? '');
    if (meshEditing && id) meshTool.pick(event);
    if (uvEditing && id) uvTool.pick3d(event);
  }
  if (stroke?.pointer !== event.pointerId) return;
  const { gesture } = stroke;
  stroke = undefined;
  gesture.points.push(pointerPoint(event));
  void locked(async signal => {
    const { state, revision } = work.document;
    const { target } = gesture;
    const { image, texels } = await painter.finish(gesture, await work.textures.load(target, state), signal);
    if (!texels) { status.textContent = 'The stroke did not change any visible, eligible texels.'; return; }
    const prior = state.textures?.[target.key]?.paint ?? state.paint;
    const paint = target.atlas ? { strokes: (prior?.strokes ?? 0) + 1, lastStrokeTexels: texels } : undefined;
    await edit(work, revision, { ...state, paint: target.atlas ? undefined : state.paint,
      textures: { ...state.textures, [target.key]: { image, paint } } }, 'Brush stroke', target.key, signal);
    status.textContent = `Painted ${texels.toLocaleString()} Base Color texels.`;
  }, 'Projecting the stroke onto visible faces…', true);
});

controls();
void offerRecovery();
