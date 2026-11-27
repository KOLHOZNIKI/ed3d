import { Mesh, SkinnedMesh, Vector3, type Object3D } from 'three';
import { exportAsset } from './e00/round-trip';
import { exportGlb } from './e00/glb-round-trip';
import { unwrapAsset } from './e00/uv-atlas';
import { blankPaintMesh, createPaintAtlas, rebakeAsset } from './e00/rebake';
import { sourceMesh } from './e00/fbx-topology';
import { captureAtlas, importOriginals, ModelAdapter, type Model } from './project/adapter';
import { captureOriginals, readProject, writeProject, type ProjectData } from './project/archive';
import { TextureAssignmentError } from './e00/round-trip';
import type { OriginalFile, TextureAssignments } from './project/document';
import { autosaveDelay, latestCheckpoint, saveCheckpoint } from './project/autosave';
import { AssetDocument, defaultHistoryBudget } from './project/document';
import { atlasColor, type WorkingState, workingBuffers } from './project/state';
import { elementId } from './project/topology';
import { prepareAppearance, Viewer, type CompareMode, type DisplayMode } from './project/viewer';
import { disposeModel } from './project/resources';
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
import { diagnosticExports, HumanoidTool } from './humanoid/tool';
import type { Layout } from './uv/layout';
import { ExtractTool } from './extract/tool';
import { buildExtraction } from './extract/build';
import { exportBatch, exportExtract } from './extract/export';
import { AssetPanel } from './diagnostics/panel';
import { exportReport, extractedReport, reportText, scanAsset } from './diagnostics/report';
import { offlineSetup } from './project/offline';
import { WorkspaceLayout, type LayoutChoice } from './project/workspace';
import { SceneHierarchy } from './project/hierarchy';
import { transformObjects, validateObject, type TransformSpec } from './project/object-transform';
import { exportSelection, selectedMeshes } from './project/export-selection';
import { drawSelection, projectedSelection, selectionPath, SelectionArea, type PickShape } from './project/selection';
import { paintView } from './paint3d/scene';
import { configureShortcuts, shortcut } from './project/shortcuts';
import { pack } from './e00/zip';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}.`);
  return node as T;
}

const canvas = element<HTMLCanvasElement>('viewport');
const status = element('status'), projectStatus = element('project-status'), historyStatus = element('history-status');
const sources = element<HTMLInputElement>('sources');
const folder = element<HTMLInputElement>('sources-folder'), originalButton = element<HTMLButtonElement>('export-original');
const assignmentPanel = element('texture-assignment'), assignmentRows = element('texture-assignment-rows');
const assignmentRetry = element<HTMLButtonElement>('texture-assignment-retry');
const assignmentCancel = element<HTMLButtonElement>('texture-assignment-cancel');
const close = element<HTMLButtonElement>('close-model'), save = element<HTMLButtonElement>('save-project');
const saveAs = element<HTMLButtonElement>('save-copy'), exportButton = element<HTMLButtonElement>('export');
const exportSelected = element<HTMLButtonElement>('export-selection');
const unwrap = element<HTMLButtonElement>('unwrap'), rebake = element<HTMLButtonElement>('rebake');
const paintButton = element<HTMLButtonElement>('paint');
const objectButton = element<HTMLButtonElement>('object-mode');
const meshButton = element<HTMLButtonElement>('mesh-mode');
const repairButton = element<HTMLButtonElement>('repair-mode');
const uvButton = element<HTMLButtonElement>('uv-mode');
const extractButton = element<HTMLButtonElement>('extract-mode');
const rigButton = element<HTMLButtonElement>('rig-mode');
const weightsButton = element<HTMLButtonElement>('weights-mode');
const diagnosticButton = element<HTMLButtonElement>('diag-mode');
const paintUnwrap = element<HTMLButtonElement>('paint-unwrap');
const undo = element<HTMLButtonElement>('undo-stroke'), redo = element<HTMLButtonElement>('redo');
const cancel = element<HTMLButtonElement>('cancel-job');
const autosaveStatus = element('autosave-status'), restore = element<HTMLButtonElement>('restore-autosave');
const recovery = element('recovery');
const objects = element<HTMLSelectElement>('object-selection'), objectLabel = element<HTMLInputElement>('object-label');
const rename = element<HTMLButtonElement>('rename-object'), visibility = element<HTMLButtonElement>('object-visibility');
const isolate = element<HTMLButtonElement>('object-isolate');
const projection = element<HTMLSelectElement>('projection'), viewDirection = element<HTMLSelectElement>('view-direction');
const viewDisplay = element<HTMLSelectElement>('view-display');
const viewGrid = element<HTMLInputElement>('view-grid'), viewAxes = element<HTMLInputElement>('view-axes');
const viewBounds = element<HTMLInputElement>('view-bounds'), viewExposure = element<HTMLInputElement>('view-exposure');
const viewBackground = element<HTMLInputElement>('view-background');
const viewReference = element<HTMLSelectElement>('view-reference'), viewCompare = element<HTMLSelectElement>('view-compare');
const viewCapture = element<HTMLButtonElement>('view-capture');
const frameSelection = element<HTMLButtonElement>('frame-selection');
const frameAll = element<HTMLButtonElement>('frame-all');
const pickShape = element<HTMLSelectElement>('view-selection-mode');
const throughSurface = element<HTMLInputElement>('view-selection-through');
const selectionOverlay = element<HTMLCanvasElement>('selection-overlay');
const objectOperation = element<HTMLSelectElement>('object-operation');
const objectAxes = element<HTMLSelectElement>('object-axes'), objectPivot = element<HTMLSelectElement>('object-pivot');
const objectApply = element<HTMLButtonElement>('object-apply-transform'), cursorPick = element<HTMLButtonElement>('object-cursor-pick');
const objectField = (kind: 'delta' | 'cursor', axis: string) => element<HTMLInputElement>(`object-${kind}-${axis}`);
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
const assetPanel = new AssetPanel(viewer, selectObject);
const workspaceLayout = new WorkspaceLayout(chooseLayout);
const rigJoint = element<HTMLSelectElement>('rig-joint');
const sceneHierarchy = new SceneHierarchy(selectObject, id => {
  chooseLayout('texture');
  selectBinding(id);
}, id => {
  if (!rigging) rigButton.click();
  if (!rigging) return;
  rigJoint.value = id;
  rigJoint.dispatchEvent(new Event('change'));
});
rigJoint.addEventListener('change', () => queueMicrotask(refreshHierarchy));
element('workspace-open').addEventListener('click', () => sources.click());
offlineSetup(element('offline-cache'), element('offline-status'));
configureShortcuts();

interface Workspace {
  adapter: ModelAdapter;
  document: AssetDocument<WorkingState>;
  model: Model;
  textures: TextureCatalog;
}

let current: Workspace | undefined;
let comparisonSnapshot: ProjectData | undefined;
let comparison: { model: Model; adapter?: ModelAdapter; appearance?: Appearance; snapshot?: ProjectData } | undefined;
let displayMode: DisplayMode = 'textured';
let selected = '';
let selectedIds = new Set<string>();
let placingCursor = false;
let painting = false;
let meshEditing = false;
let repairing = false;
let uvEditing = false;
let extracting = false;
let rigging = false;
let weighting = false;
let diagnostic = false;
let weightsStroke: number | undefined;
let stroke: { pointer: number; gesture: Exclude<ReturnType<PaintTool['begin']>, string | undefined> } | undefined;
let paintBinding = '';
let textureBinding = '';
let picking: { pointer: number; x: number; y: number } | undefined;
let selecting: { pointer: number; shape: Exclude<PickShape, 'click'>; points: Point[] } | undefined;
let busy = false;
let abort: AbortController | undefined;
let pendingRecovery: ProjectData | undefined;
let autosaveTimer: number | undefined;
let autosaveDue: number | undefined;
let writingCheckpoint = false;
let historyCheckpoint: { id: string; revision: number } | undefined;
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
      const paint = target.atlas && !target.binding.semantic && existing && existing.lastStrokeTexels <= image.width * image.height
        ? { strokes: existing.strokes, lastStrokeTexels: existing.lastStrokeTexels } : undefined;
      await edit(work, revision, { ...state, paint: target.atlas && !target.binding.semantic ? undefined : state.paint,
        textures: { ...state.textures, [key]: { image, paint } } }, label, key);
    });
    if (!ok) throw new Error(status.textContent || 'The image edit was not committed.');
  },
  export(target, image) {
    void locked(async () => {
      const names = { metalRough: 'metallic-roughness', aoMap: 'ao', roughness: 'roughness', metallic: 'metallic' };
      const map = target.binding.semantic ? names[target.binding.semantic] : 'base-color';
      const file = `${current!.document.name}-${target.binding.object}-${map}.png`.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      download(new Blob([encodeImage(image)], { type: 'image/png' }), file);
      status.textContent = `Exported ${file}.`;
    });
  },
  selectBinding(target) {
    textureBinding = target.binding.id;
    if (target.binding.semantic) selectObject(target.binding.object);
    else selectBinding(textureBinding);
  },
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
      const report = extractedReport(exportReport(adapter, model, document, assetPanel.findings), ids, batch ? 'batch' : 'asset');
      const problem = report.findings.find(finding => finding.severity === 'Error');
      if (problem) throw new Error(problem.message);
      const output = batch ? await exportBatch(model, adapter, textures, document.state, ids, signal, report)
        : await exportExtract(model, adapter, textures, document.state, ids[0], report);
      signal?.throwIfAborted();
      assetPanel.exported(report);
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

const diagnosticTool = new HumanoidTool(viewer, {
  apply(revision, patch, label) {
    return locked(async () => {
      const work = current!;
      await edit(work, revision, { ...work.document.state, ...patch }, label, 'humanoid');
      status.textContent = `${label} applied.`;
    });
  },
  freeze(frame) {
    if (current?.adapter !== frame.adapter) return;
    openWeights(frame);
    status.textContent = `Weight Paint froze ${frame.name} at ${frame.time.toFixed(3)} s.`;
  },
});

function commitUv(request: UvRequest) {
  return locked(async signal => {
    // Let the status and cancel control paint before preparing a large snapshot.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    signal?.throwIfAborted();
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
      clearSlot(textures, object, 0);
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
      clearSlot(textures, object, slot);
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
        clearSlot(textures, object, 0);
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

function clearSlot(textures: Record<string, unknown>, object: string, slot: number) {
  const root = `slot/${object}/${slot}`;
  for (const key of Object.keys(textures)) if (key === root || key.startsWith(`${root}/`)) delete textures[key];
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
  if (!availablePaint || !current?.adapter.rig.available) diagnostic = false;
  if (!availableWeights) weighting = false;
  sources.disabled = locked;
  folder.disabled = locked;
  assignmentRetry.disabled = assignmentCancel.disabled = locked;
  close.disabled = save.disabled = saveAs.disabled = exportButton.disabled = locked || !document;
  originalButton.disabled = locked || !document;
  assetPanel.configure(current, locked);
  unwrap.disabled = locked || !fbx || !!current?.adapter.mesh.geometryActive;
  const canCreatePaintAtlas = !!(fbx && !model.textureBake && painting && !editedMesh && blankPaintMesh(model));
  rebake.disabled = locked || !fbx || !model.uvAtlas || canCreatePaintAtlas;
  paintButton.disabled = locked || !availablePaint;
  objectButton.disabled = locked || !document;
  meshButton.disabled = locked || !availablePaint;
  repairButton.disabled = locked || !availablePaint;
  uvButton.disabled = locked || !availablePaint;
  extractButton.disabled = locked || !availablePaint;
  rigButton.disabled = locked || !availablePaint || !current?.adapter.rig.available;
  weightsButton.disabled = locked || !availableWeights;
  diagnosticButton.disabled = locked || !availablePaint || !current?.adapter.rig.available;
  for (const item of [viewDisplay, viewGrid, viewAxes, viewBounds, viewExposure, viewBackground, viewCompare, viewReference, viewCapture]) {
    item.disabled = locked || !availablePaint;
  }
  viewDisplay.value = weighting ? 'weights' : displayMode;
  viewDisplay.querySelector<HTMLOptionElement>('option[value=weights]')!.disabled = !availableWeights;
  viewReference.querySelector<HTMLOptionElement>('option[value=snapshot]')!.disabled = !comparisonSnapshot;
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
  diagnosticButton.setAttribute('aria-pressed', String(diagnostic));
  objectButton.setAttribute('aria-pressed', String(objectMode()));
  const canSelectShape = objectMode() || meshEditing || uvEditing;
  pickShape.disabled = throughSurface.disabled = locked || !availablePaint || !canSelectShape;
  viewer.areaSelection(canSelectShape && (pickShape.value !== 'click' || placingCursor));
  canvas.style.cursor = !busy && (painting || canSelectShape && (pickShape.value !== 'click' || placingCursor)) ? 'crosshair' : '';
  canvas.style.touchAction = 'none';
  viewer.setPainting(painting || meshEditing || repairing || uvEditing || extracting || rigging || weighting,
    busy || !!stroke || weightsStroke !== undefined || meshTool.dragging || rigTool.dragging);
  exportButton.textContent = model?.format === 'glb' ? 'Export GLB' : 'Export FBX ZIP';
  exportSelected.disabled = locked || !selectedIds.size;
  const transformFields = element<HTMLFieldSetElement>('object-transform-tools');
  transformFields.hidden = !document || !objectMode();
  transformFields.disabled = locked;
  let transformUnavailable = '';
  if (current && !transformFields.hidden) try {
    for (const node of selectionNodes()) validateObject(current.adapter, node);
  } catch (error) { transformUnavailable = errorMessage(error); }
  objectApply.disabled = !selectedIds.size || !!transformUnavailable;
  const transformHint = element('object-transform-hint');
  transformHint.textContent = transformUnavailable;
  transformHint.hidden = !transformUnavailable;
  element('object-cursor-controls').hidden = objectPivot.value !== 'cursor';
  cursorPick.setAttribute('aria-pressed', String(placingCursor));
  viewer.showCursor(document && objectMode() && objectPivot.value === 'cursor' ? objectVector('cursor') : undefined);
  element<HTMLButtonElement>('object-show-all').disabled = locked || !document || !current?.adapter.viewEntries.some(entry =>
    !(document.state.objects[entry.id]?.visible ?? entry.visible));
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
  isolate.disabled = locked || !availablePaint || !selected && !viewer.isolated;
  isolate.textContent = viewer.isolated ? 'Exit isolation' : selectedIds.size > 1 ? 'Isolate selection' : 'Isolate object';
  isolate.setAttribute('aria-pressed', String(!!viewer.isolated));
  frameSelection.disabled = !selected || locked;
  const targets = current?.textures.targets(document!.state) ?? [];
  const canEditTexture = !!current?.textures.editTargets(document!.state).length;
  toggleTexture.disabled = locked || !canEditTexture;
  toggleTexture.setAttribute('aria-expanded', String(!editor.panel.hidden));
  workspaceLayout.sync(!!document, viewer.available && !!viewer.camera, locked,
    uvEditing && selected ? 'uv' : editor.panel.hidden ? undefined : 'texture', canEditTexture);
  refreshHierarchy();
  editor.lock(busy || !!stroke);
  if (!diagnostic) diagnosticTool.configure(undefined, locked);
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
  if (diagnostic && current) diagnosticTool.configure({ adapter: current.adapter, object: selected, state: document!.state, revision: document!.revision }, locked);
  const pendingUv = fbx && document?.state.bake?.direct ? 0 : current?.adapter.mesh.pendingUv ?? 0;
  const notes = [current?.adapter.mesh.omittedPolygonMetadata ? 'GLB exports the edited topology as indexed triangles and omits incompatible private polygon metadata.' : '',
    pendingUv ? `${pendingUv} created faces require UV review or unwrapping.` : '',
    current?.adapter.mesh.hasRepairFaces ? 'Repair geometry has no source texture. Use the patch selection to paint or assign its appearance.' : '',
    editedMesh && fbx && model.deformation.pointsOverPreviewLimit ? 'Some vertices have more than four influences. FBX retains the full weights.' : ''].filter(Boolean);
  element('mesh-export-note').hidden = !notes.length;
  element('mesh-export-note').textContent = notes.join(' ');
}

function objectMode() { return !(painting || meshEditing || repairing || uvEditing || extracting || rigging || weighting || diagnostic); }

function refreshHierarchy() {
  sceneHierarchy.configure(current && { adapter: current.adapter, state: current.document.state, textures: current.textures }, selected, selectedIds,
    rigging ? rigJoint.value : '', busy || !!stroke || weightsStroke !== undefined || textureGesture);
}

function renderObjects() {
  if (!current) {
    objects.replaceChildren();
    return;
  }
  const entries = current.adapter.viewEntries.filter(entry => entry.mesh || selectedIds.has(entry.id));
  objects.replaceChildren(new Option('None', ''), ...entries.map(entry => {
    const state = current!.document.state.objects[entry.id] ?? entry;
    return new Option(state.visible ? state.name : `${state.name} (hidden)`, entry.id);
  }));
  updateSelection([...selectedIds].filter(id => current!.adapter.objects.has(id)), selected);
}

function selectObject(id: string, toggle = false) {
  if (!objectMode() && id && current && !current.adapter.workingTopology(id)) {
    const mesh = selectedMeshes(current.adapter, new Set([id])).values().next().value;
    id = [...current.adapter.objects].find(([, node]) => node === mesh)?.[0] ?? '';
  }
  const ids = toggle ? selectedIds.has(id) ? [...selectedIds].filter(item => item !== id) : [...selectedIds, id] : id ? [id] : [];
  updateSelection(ids, id);
}

function updateSelection(ids: readonly string[], active?: string) {
  const previous = selected;
  selectedIds = new Set(ids.filter(id => current?.adapter.objects.has(id)));
  selected = active && selectedIds.has(active) ? active : [...selectedIds].at(-1) ?? '';
  const entry = current?.adapter.viewEntries.find(node => node.id === selected);
  const targets = current?.textures.targets(current.document.state) ?? [];
  if (!targets.some(target => target.binding.id === paintBinding && (!selected || target.binding.object === selected))) {
    paintBinding = (targets.find(target => target.binding.object === selected) ?? targets[0])?.binding.id ?? '';
  }
  if (entry && ![...objects.options].some(option => option.value === selected)) objects.add(new Option(entry.name, selected));
  objects.value = selected;
  const state = entry && (current!.document.state.objects[selected] ?? entry);
  objectLabel.value = state?.name ?? '';
  visibility.textContent = state?.visible === false ? 'Show object' : 'Hide object';
  const topology = current?.adapter.workingTopology(selected);
  const render = current?.adapter.mesh.render.get(selected);
  element('selection-details').textContent = topology
    ? `${selected} · ${render ? new Set(topology.corners).size : topology.positions.length / 3} vertices · ${topology.faceEnds.length} faces · First face ID ${elementId(selected, 'face', render?.render.faceIds[0] ?? 0)}`
    : entry?.name ?? '';
  if (selectedIds.size > 1) element('selection-details').textContent = `${selectedIds.size} selected · Active ${entry?.name ?? selected}`;
  const nodes = selectionNodes();
  if (viewer.isolated && previous !== selected && nodes.some(node => !viewer.inIsolation(node))) viewer.isolate();
  viewer.measureGuides();
  viewer.select(nodes);
  syncTextureEditor();
  controls();
}

function selectionNodes(): Object3D[] {
  return [...selectedIds].flatMap(id => { const node = current?.adapter.objects.get(id); return node ? [node] : []; });
}

function selectBinding(id: string) {
  const target = current?.textures.targets(current.document.state).find(item => item.binding.id === id);
  if (!target) return;
  paintBinding = id;
  textureBinding = id;
  selectObject(target.binding.object);
}

function syncTextureEditor() {
  const work = current;
  if (!work || editor.panel.hidden) return;
  const state = work.document.state;
  const targets = work.textures.editTargets(state);
  if (!targets.some(target => target.binding.id === textureBinding && (!selected || target.binding.object === selected))) {
    textureBinding = targets.find(target => target.binding.object === selected)?.binding.id ?? paintBinding;
  }
  editor.setSession({ targets, atlas: work.model.format === 'fbx' ? work.model.uvAtlas?.geometry : undefined,
    load: target => work.textures.load(target, state) }, textureBinding);
}

function chooseLayout(layout: LayoutChoice) {
  const work = current;
  if (!work) return;
  workspaceLayout.setEditorOnly(layout.endsWith('-only'));
  if (layout.startsWith('uv') && viewer.available) {
    painting = meshEditing = repairing = extracting = rigging = weighting = diagnostic = false;
    editor.close();
    uvEditing = true;
    if (!selected) selectObject(work.adapter.viewEntries.find(entry => entry.mesh)?.id ?? '');
  } else if (layout.startsWith('texture') && work.textures.editTargets(work.document.state).length) {
    uvEditing = extracting = rigging = weighting = diagnostic = false;
    editor.open();
    syncTextureEditor();
  } else {
    editor.close();
    uvEditing = false;
  }
  controls();
}

objectButton.addEventListener('click', () => {
  painting = meshEditing = repairing = uvEditing = extracting = rigging = weighting = diagnostic = false;
  editor.close();
  controls();
});

toggleTexture.addEventListener('click', () => {
  diagnostic = false;
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
  diagnosticTool.reset();
  releaseComparison();
  comparisonSnapshot = undefined;
  viewCompare.value = 'working';
  viewReference.value = 'original';
  viewer.close();
  if (current) {
    current.adapter.dispose();
    disposeModel(current.model);
  }
  current = undefined;
  editor.close();
  previewTextureStroke();
  selected = '';
  selectedIds.clear();
  placingCursor = false;
  for (const axis of objectAxesNames) objectField('cursor', axis).value = '0';
  textureBinding = '';
  paintBinding = '';
  painting = false;
  meshEditing = false;
  repairing = false;
  uvEditing = false;
  extracting = false;
  rigging = false;
  weighting = false;
  diagnostic = false;
  weightsStroke = undefined;
  autosaveDue = undefined;
  window.clearTimeout(autosaveTimer);
  autosaveStatus.textContent = '';
  renderObjects();
}

function install(workspace: Workspace, appearance?: Appearance) {
  const layout = workspaceLayout.initialLayout();
  closeWorkspace();
  current = workspace;
  workspace.adapter.applyVisibility(workspace.document.state);
  viewer.setPainting(false);
  viewer.install(workspace.model.scene, appearance);
  projection.selectedIndex = viewDirection.selectedIndex = 0;
  renderObjects();
  if (layout !== 'model') chooseLayout(layout);
  status.textContent = modelStatus(workspace.model);
  pendingRecovery = undefined;
  recovery.hidden = true;
}

async function makeWorkspace(model: Model, data?: ProjectData, originals = data?.originals, textureAssignments = data?.textureAssignments) {
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
      scene: adapter.entries, topology: adapter.topology, textureAssignments, state: data?.state ?? { objects: {} } }, workingBuffers,
    async (document, snapshot) => {
      const { revision } = snapshot;
      try {
        const archive = await writeProject(document, undefined, snapshot);
        await saveCheckpoint({ key: `${document.id}/${revision}`, name: document.name, projectId: document.id, revision,
          savedAt: Date.now(), archive });
        historyCheckpoint = { id: document.id, revision };
        autosaveStatus.textContent = `Saved history checkpoint for revision ${revision}.`;
      } catch (error) {
        throw new Error(`History was kept. ${errorMessage(error)} Save Project to download a file or raise the history limit.`);
      }
    });
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

function openFiles(input: File[]) {
  if (!input.length) return;
  void locked(async () => {
    clearAssignments();
    const project = input.find(file => /\.assetfixer$/i.test(file.name));
    if (project && input.length !== 1) throw new Error('Open one .assetfixer project at a time.');
    const data = project && await readProject(project);
    const originals = data?.originals ?? await captureOriginals(input);
    await openCaptured(originals, data?.textureAssignments, data || undefined);
  }, `Opening local asset · ${(input.reduce((bytes, file) => bytes + file.size, 0) / 1048576).toFixed(1)} MiB input…`);
}

async function openCaptured(originals: readonly OriginalFile[], assignments?: TextureAssignments, data?: ProjectData) {
  try {
    const model = await importOriginals(originals, assignments);
    const { workspace, appearance } = await makeWorkspace(model, data, originals, assignments);
    if (!canReplace()) {
      if (appearance) disposeAppearance(appearance);
      workspace.adapter.dispose();
      disposeModel(workspace.model);
      clearAssignments();
      status.textContent = 'Open cancelled.';
      return;
    }
    clearAssignments();
    install(workspace, appearance);
    if (data) status.textContent += ' · Project restored. Undo history starts here.';
    else scheduleAutosave();
  } catch (error) {
    if (error instanceof TextureAssignmentError && !data) showAssignments(error, originals, assignments);
    throw error;
  }
}

let retryAssignments: (() => Promise<void>) | undefined;

function clearAssignments() {
  assignmentPanel.hidden = true;
  assignmentRows.replaceChildren();
  retryAssignments = undefined;
}

function showAssignments(error: TextureAssignmentError, originals: readonly OriginalFile[], assignments?: TextureAssignments) {
  assignmentRows.replaceChildren();
  const rows = error.requests.map(request => {
    const row = document.createElement('div');
    row.className = 'actions';
    const label = document.createElement('label'), select = document.createElement('select');
    label.append(request + ' ', select);
    select.add(new Option('Choose a map from the input', ''));
    for (const path of error.candidates) select.add(new Option(path, path));
    const local = document.createElement('input'), localLabel = document.createElement('label');
    local.type = 'file';
    local.accept = '.png,.jpg,.jpeg';
    localLabel.append('Or choose a local map ', local);
    row.append(label, localLabel);
    assignmentRows.append(row);
    return { request, select, local };
  });
  assignmentPanel.hidden = false;
  retryAssignments = async () => {
    const next = new Map(Object.entries(assignments ?? {})), extra: File[] = [];
    for (const { request, select, local } of rows) {
      const file = local.files?.[0];
      if (!file && !select.value) throw new Error(`Choose a local map for ${request}.`);
      const path = file ? `assigned/${crypto.randomUUID()}/${file.name}` : select.value;
      if (file) extra.push(new File([file], path));
      next.set(request, path);
    }
    const added = extra.length ? await captureOriginals(extra) : [];
    const source = [...originals, ...added];
    if (source.length > 256 || next.size > 256) throw new Error('The source file or texture assignment count exceeds 256.');
    await openCaptured(source, Object.fromEntries(next));
  };
}

assignmentRetry.addEventListener('click', () => {
  if (retryAssignments) void locked(retryAssignments, 'Opening local asset with assigned textures…');
});
assignmentCancel.addEventListener('click', () => {
  clearAssignments();
  status.textContent = 'Open cancelled.';
});

for (const picker of [sources, folder]) picker.addEventListener('change', () => {
  const input = Array.from(picker.files ?? []).filter(file => /\.(assetfixer|glb|zip|fbx|png|jpe?g)$/i.test(file.name));
  picker.value = '';
  openFiles(input);
});
window.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
window.addEventListener('drop', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  openFiles(Array.from(event.dataTransfer.files));
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

originalButton.addEventListener('click', () => void locked(async () => {
  const { originals, name } = current!.document;
  if (originals.length === 1) download(originals[0].data, originals[0].name.split('/').at(-1)!);
  else {
    const entries = await Promise.all(originals.map(async file => [file.name, new Uint8Array(await file.data.arrayBuffer())] as const));
    const bytes = await pack(new Map(entries));
    download(new Blob([bytes], { type: 'application/zip' }), `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_originals.zip`);
  }
  status.textContent = 'Exported immutable original files.';
}, 'Preparing original files…'));

for (const [id, global] of [['asset-scan', false], ['asset-intersections', true]] as const) {
  element(id).addEventListener('click', () => void locked(async signal => {
    const work = current!, revision = work.document.revision;
    await new Promise(requestAnimationFrame);
    signal?.throwIfAborted();
    const findings = await scanAsset(work.adapter, global, signal);
    work.document.assertRevision(revision);
    signal?.throwIfAborted();
    if (current !== work) throw new Error('The active project changed during the scan.');
    assetPanel.scanned(findings, global);
    status.textContent = `Asset scan complete · ${findings.length} findings.`;
  }, global ? 'Checking mesh self-intersections…' : 'Checking mesh topology, UVs and weights…', true));
}
for (const [id, extension] of [['asset-report-text', 'txt'], ['asset-report-json', 'json']] as const) {
  element(id).addEventListener('click', () => void locked(async () => {
    const report = assetPanel.report;
    const contents = extension === 'json' ? JSON.stringify(report, null, 2) + '\n' : reportText(report);
    download(new Blob([contents], { type: extension === 'json' ? 'application/json' : 'text/plain' }), `AssetFixer-r${report.project.revision}-report.${extension}`);
    status.textContent = 'Saved the compatibility report.';
  }));
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
historyBudget.addEventListener('change', () => void (async () => {
  if (!current || busy || stroke) return;
  const { document } = current;
  const mib = historyBudget.valueAsNumber;
  await locked(async () => {
    if (!Number.isInteger(mib)) throw new Error('Enter a whole number of MiB.');
    if (await document.configureHistory(mib * 1048576)) scheduleAutosave();
  });
  historyBudget.value = String(document.historyBudget / 1048576);
  controls();
})());

exportButton.addEventListener('click', () => saveModel());
exportSelected.addEventListener('click', () => saveModel(new Set(selectedIds)));

function saveModel(selection?: ReadonlySet<string>) { void locked(async () => {
  const { model, adapter, document, textures } = current!;
  const selected = selection && selectedMeshes(adapter, selection);
  if (!selected || [...selected].some(mesh => mesh instanceof SkinnedMesh)) adapter.rig.assertExportable();
  const published = diagnosticExports(adapter, document.state), animation = model.scene.animations;
  const state = document.state;
  const fbxModel = projectedModel(model, state, textures);
  const bound = sourceAppearance(textures, state, model.format);
  const auxiliary = new Set(textures.editTargets(state).flatMap(({ binding }) => selected?.has(binding.mesh) &&
    (binding.semantic === 'roughness' || binding.semantic === 'metallic') && binding.sourceName ? [binding.sourceName] : []));
  let scoped: ReturnType<typeof exportSelection> | undefined;
  let restore = () => {};
  try {
    const clips = published.length ? [...animation, ...published] : animation;
    if (selection) scoped = exportSelection(fbxModel, adapter, selection, bound.appearance.views, clips, auxiliary);
    else {
      // Export the source visibility and committed model independently of the viewport.
      adapter.applyVisibility({ objects: {} });
      model.scene.animations = clips;
      restore = applyViews(bound.appearance.views);
    }
    const outputModel = scoped?.model ?? fbxModel;
    const report = exportReport(adapter, outputModel, document, assetPanel.findings, scoped?.objects);
    const problem = report.findings.find(finding => finding.severity === 'Error');
    if (problem) throw new Error(problem.message);
    let output;
    const glb = outputModel.format === 'glb';
    const name = scoped ? `${outputModel.name}_selection` : outputModel.name;
    if (outputModel.format === 'glb') output = await exportGlb({ ...outputModel, name, images: new Map([...outputModel.images, ...bound.glb]) });
    else {
      const transfers = Object.entries(state.uvBakes ?? {}).filter(([object]) => !scoped || scoped.objects.has(object))
        .map(([object, transfer]) => ({ object, bake: textures.workingBake(state, object, 0, transfer.bake) }));
      output = await exportAsset({ ...outputModel, name, auxiliaryEdits: bound.auxiliary,
        stats: { ...outputModel.stats, clips: outputModel.scene.animations.length } }, bound.fbx, undefined, transfers.length ? transfers : undefined, report);
    }
    if (glb) report.files.push(output.name);
    download(new Blob([output.bytes], { type: glb ? 'model/gltf-binary' : 'application/zip' }), output.name);
    assetPanel.exported(report);
    status.textContent = `Exported ${output.name}.` + (glb ? '' : ' See manifest.json for material assignments and scope.');
  } finally {
    restore();
    scoped?.dispose();
    disposeAppearance(bound.appearance);
    model.scene.animations = animation;
    adapter.applyVisibility(document.state);
  }
}, 'Preparing export…'); }

function scheduleAutosave() {
  const document = current?.document;
  if (document && historyCheckpoint?.id === document.id && historyCheckpoint.revision === document.revision) {
    autosaveDue = undefined;
    return;
  }
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
  const { workspace, appearance } = await makeWorkspace(await importOriginals(data.originals, data.textureAssignments), data);
  workspace.document.markRecovered();
  install(workspace, appearance);
  status.textContent += ' · Autosave restored. Undo history starts here.';
}, 'Restoring autosave…'));
element('dismiss-autosave').addEventListener('click', () => {
  pendingRecovery = undefined;
  recovery.hidden = true;
  autosaveStatus.textContent = '';
});

async function applyWorking(work: Workspace, revision: number, state: WorkingState, commit: () => void | Promise<void>, signal?: AbortSignal) {
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
    await commit();
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
  await applyWorking(work, revision, state, () => work.document.execute({ id: crypto.randomUUID(), label, baseRevision: revision,
    affectedResources: [resource], state }), signal);
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
visibility.addEventListener('click', () => setVisibility(current?.document.state.objects[selected]?.visible === false ||
  current?.document.state.objects[selected] === undefined && current?.adapter.viewEntries.find(entry => entry.id === selected)?.visible === false));
element('object-show-all').addEventListener('click', () => setVisibility(true, true));

function setVisibility(visible: boolean, all = false) {
  const work = current;
  if (!work) return;
  void locked(async () => {
    const { state, revision } = work.document, objects = { ...state.objects };
    for (const entry of work.adapter.viewEntries) if (all || selectedIds.has(entry.id)) {
      const override = objects[entry.id] ?? entry;
      if (override.visible !== visible) objects[entry.id] = { name: override.name, visible };
    }
    await edit(work, revision, { ...state, objects }, 'Object visibility', 'visibility');
    status.textContent = 'Object visibility applied.';
  });
}

isolate.addEventListener('click', () => {
  viewer.isolate(viewer.isolated ? undefined : selectionNodes());
  controls();
});

const objectAxesNames = ['x', 'y', 'z'] as const;
const objectVector = (kind: 'delta' | 'cursor') => new Vector3(...objectAxesNames.map(axis => objectField(kind, axis).valueAsNumber));

function setObjectOperation(operation: TransformSpec['operation']) {
  objectOperation.value = operation;
  objectApply.textContent = `Apply ${operation}`;
  for (const axis of objectAxesNames) objectField('delta', axis).value = operation === 'scale' ? '1' : '0';
}

objectOperation.addEventListener('change', () => setObjectOperation(objectOperation.value as TransformSpec['operation']));
objectPivot.addEventListener('change', () => { placingCursor = false; controls(); });
for (const axis of objectAxesNames) objectField('cursor', axis).addEventListener('input', controls);
cursorPick.addEventListener('click', () => { placingCursor = !placingCursor; controls(); });
pickShape.addEventListener('change', controls);
objectApply.addEventListener('click', () => void locked(async () => {
  const work = current;
  if (!work) return;
  const { state, revision } = work.document;
  const operation = objectOperation.value as TransformSpec['operation'];
  const value = objectVector('delta'), cursor = objectVector('cursor');
  if (!value.toArray().every(Number.isFinite) || objectPivot.value === 'cursor' && !cursor.toArray().every(Number.isFinite)) {
    throw new Error('Enter finite coordinates on all three axes.');
  }
  if (value.equals(operation === 'scale' ? new Vector3(1, 1, 1) : new Vector3())) return;
  const objectTransforms = transformObjects(work.adapter, selectedIds, selected, { operation, value, cursor,
    axes: objectAxes.value as TransformSpec['axes'], pivot: objectPivot.value as TransformSpec['pivot'] }, state.objectTransforms);
  await edit(work, revision, { ...state, objectTransforms }, `${operation[0].toUpperCase()}${operation.slice(1)} objects`, 'transforms');
  setObjectOperation(operation);
}));

function visibleMeshIds() {
  return current?.adapter.viewEntries.filter(entry => {
    const object = current!.adapter.objects.get(entry.id)!;
    if (!(object instanceof Mesh) || !viewer.inIsolation(object)) return false;
    for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
    return true;
  }).map(entry => entry.id) ?? [];
}

element('objects-select-all').addEventListener('click', () => updateSelection(visibleMeshIds(), selected));
element('objects-select-none').addEventListener('click', () => updateSelection([]));
element('objects-select-invert').addEventListener('click', () => updateSelection(visibleMeshIds().filter(id => !selectedIds.has(id))));

function frame(selection = false) {
  const direction = [new Vector3(.6, .45, 1), new Vector3(0, 0, 1), new Vector3(0, 0, -1), new Vector3(-1, 0, 0),
    new Vector3(1, 0, 0), new Vector3(0, 1, .00001), new Vector3(0, -1, .00001)][viewDirection.selectedIndex];
  const nodes = selection ? selectionNodes() : [];
  if (nodes.length > 1) viewer.frameSelection(nodes, projection.selectedIndex === 1, direction);
  else viewer.frame(nodes[0], projection.selectedIndex === 1, direction);
  controls();
}
projection.addEventListener('change', () => frame());
viewDirection.addEventListener('change', () => frame());
frameAll.addEventListener('click', () => frame());
frameSelection.addEventListener('click', () => frame(true));
viewDisplay.addEventListener('change', () => {
  if (viewDisplay.value === 'weights') openWeights();
  else {
    weighting = false;
    displayMode = viewDisplay.value as DisplayMode;
    viewer.setDisplay(displayMode);
    controls();
  }
});
for (const setting of [viewGrid, viewAxes, viewBounds]) setting.addEventListener('change', () =>
  viewer.setGuides(viewGrid.checked, viewAxes.checked, viewBounds.checked));
for (const setting of [viewExposure, viewBackground]) setting.addEventListener('input', () => {
  if (Number.isFinite(viewExposure.valueAsNumber)) viewer.setLighting(viewExposure.valueAsNumber, viewBackground.value);
});

function releaseComparison() {
  viewer.compare('working');
  element('view-compare-labels').hidden = true;
  if (!comparison) return;
  if (comparison.appearance) disposeAppearance(comparison.appearance);
  comparison.adapter?.dispose();
  disposeModel(comparison.model);
  comparison = undefined;
}

function showComparison() {
  const work = current, mode = viewCompare.value as CompareMode;
  if (!work || mode === 'working') {
    releaseComparison();
    return;
  }
  const snapshot = viewReference.value === 'snapshot' ? comparisonSnapshot : undefined;
  void locked(async () => {
    if (!comparison || comparison.snapshot !== snapshot) {
      const model = await importOriginals(work.document.originals, work.document.textureAssignments);
      const copy = snapshot && await makeWorkspace(model, snapshot);
      if (copy) copy.workspace.adapter.applyVisibility(snapshot.state);
      releaseComparison();
      comparison = { model: copy ? copy.workspace.model : model, adapter: copy ? copy.workspace.adapter : undefined,
        appearance: copy ? copy.appearance : undefined, snapshot };
    }
    viewer.compare(mode, { root: comparison.model.scene, appearance: comparison.appearance });
    element('view-reference-label').textContent = snapshot ? `Snapshot · revision ${snapshot.revision}` : 'Original';
    element('view-compare-labels').hidden = false;
    status.textContent = mode === 'split' ? 'Comparing the reference and working model with the same camera.' : 'Showing the reference model.';
  }, 'Loading the local comparison reference…').then(ok => {
    if (ok) return;
    viewCompare.value = 'working';
    releaseComparison();
  });
}

viewCompare.addEventListener('change', showComparison);
viewReference.addEventListener('change', showComparison);
viewCapture.addEventListener('click', () => {
  if (!current) return;
  const { id, name, revision, originals, textureAssignments, scene, historyBudget, state } = current.document;
  comparisonSnapshot = { id, name, revision, originals, textureAssignments, scene, historyBudget, state };
  controls();
  viewReference.value = 'snapshot';
  if (viewer.comparing) showComparison();
  else status.textContent = `Captured comparison snapshot at revision ${revision}.`;
});

window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement ||
      event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLElement && event.target.isContentEditable ||
      event.defaultPrevented || busy || stroke || weightsStroke !== undefined || textureGesture || meshTool.dragging || rigTool.dragging) return;
  const action = shortcut(event);
  if (action === 'cancel' && (placingCursor || selecting)) {
    clearAreaSelection();
    placingCursor = false;
    controls();
    event.preventDefault();
    return;
  }
  if (action === 'save' && !save.disabled) {
    event.preventDefault();
    save.click();
    return;
  }
  if (action === 'space' && diagnostic && event.target === canvas) {
    event.preventDefault();
    element<HTMLButtonElement>('diag-play').click();
    return;
  }
  if (action === 'select' && event.target === canvas) {
    event.preventDefault();
    pickShape.value = 'click';
    objectButton.click();
    return;
  }
  if (action && objectMode() && event.target === canvas && ['move', 'rotate', 'scale'].includes(action)) {
    event.preventDefault();
    setObjectOperation(action as TransformSpec['operation']);
    return;
  }
  const toolKey = action && ({ move: 'w', rotate: 'e', scale: 'r', vertex: '1', edge: '2', face: '3', island: '4',
    apply: 'Enter', cancel: 'Escape', delete: 'Delete' } as Partial<Record<NonNullable<ReturnType<typeof shortcut>>, string>>)[action];
  if (toolKey && (uvTool.keyboard(toolKey) || repairTool.keyboard(toolKey) || meshTool.keyboard(toolKey))) {
    event.preventDefault();
    return;
  }
  if (action === 'frame' && event.target === canvas) { event.preventDefault(); frame(!!selected); }
  if (action === 'undo' || action === 'redo') {
    event.preventDefault();
    navigate(action);
  }
});

paintButton.addEventListener('click', () => {
  diagnostic = false;
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
  diagnostic = false;
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
  diagnostic = false;
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
  diagnostic = false;
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
  diagnostic = false;
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
  diagnostic = false;
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
  if (weighting) weighting = false;
  else openWeights();
  controls();
  status.textContent = weighting ? 'Weight Paint is active. Right-drag to orbit.' : 'Weight Paint is off.';
});

function openWeights(frame?: Parameters<WeightTool['useDiagnostic']>[0]) {
  if (!current) return;
  const first = current.adapter.viewEntries.find(entry => current!.adapter.objects.get(entry.id) instanceof SkinnedMesh);
  if (!first) throw new Error('Weight Paint requires a skinned mesh.');
  weighting = true;
  painting = meshEditing = repairing = uvEditing = extracting = rigging = diagnostic = false;
  if (!editor.panel.hidden) editor.close();
  if (frame) weightsTool.useDiagnostic(frame);
  if (!(current.adapter.objects.get(selected) instanceof SkinnedMesh)) selectObject(first.id);
  controls();
}

diagnosticButton.addEventListener('click', () => {
  diagnostic = !diagnostic;
  if (diagnostic) {
    painting = meshEditing = repairing = uvEditing = extracting = rigging = weighting = false;
    if (!editor.panel.hidden) editor.close();
  }
  controls();
  status.textContent = diagnostic ? 'Humanoid Tests is active.' : 'Humanoid Tests is off.';
});

function pointerPoint(event: PointerEvent): Point {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
}

function selectionPoint(event: PointerEvent): Point {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function clearAreaSelection() {
  selecting = undefined;
  selectionOverlay.hidden = true;
}

function selectArea(points: readonly Point[], toggle: boolean, click?: Point) {
  const work = current, camera = viewer.camera;
  if (!work || !camera || points.length < 3) return;
  const { width, height } = canvas.getBoundingClientRect();
  const through = throughSurface.checked;
  const view = viewer.withPose(() => paintView(work.adapter, undefined, new Map(), camera, Math.ceil(width), Math.ceil(height), undefined,
    { through, includes: mesh => viewer.inIsolation(mesh) }));
  const hits = projectedSelection(view, new SelectionArea(points), through, click);
  if (meshEditing || uvEditing) {
    const active = selected || hits.keys().next().value;
    if (active && active !== selected) selectObject(active);
    if (meshEditing) meshTool.selectRegion(active ? hits.get(active) : undefined, toggle);
    if (uvEditing) uvTool.selectRegion3d(active ? hits.get(active) : undefined, toggle);
  } else {
    const ids = [...hits].filter(([, hit]) => hit.faces.size).map(([id]) => id);
    const next = toggle ? [...selectedIds].filter(id => !ids.includes(id)).concat(ids.filter(id => !selectedIds.has(id))) : ids;
    updateSelection(next, selected);
  }
}

canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || busy || stroke || weightsStroke !== undefined || textureGesture || !current || viewer.comparing) return;
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
    canvas.focus({ preventScroll: true });
    const shape = pickShape.value as PickShape;
    if (!placingCursor && shape !== 'click' && (meshEditing || uvEditing || objectMode())) {
      selecting = { pointer: event.pointerId, shape, points: [selectionPoint(event)] };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
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
  if (viewer.comparing) return;
  const region = selecting;
  if (region?.pointer === event.pointerId) {
    const p = selectionPoint(event), prior = region.points.at(-1)!;
    if (Math.hypot(p.x - prior.x, p.y - prior.y) < 2) return;
    if (region.shape === 'rectangle') region.points[1] = p;
    else if (region.points.length < 1000) region.points.push(p);
    selectionOverlay.hidden = false;
    const bounds = canvas.getBoundingClientRect(), ctx = selectionOverlay.getContext('2d')!;
    selectionOverlay.width = Math.ceil(bounds.width);
    selectionOverlay.height = Math.ceil(bounds.height);
    drawSelection(ctx, selectionPath(region.shape, region.points));
    return;
  }
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
  clearAreaSelection();
  stroke = picking = undefined;
  weightsStroke = undefined;
  weightsTool.cancel();
  painter.leave();
  controls();
  resumeAutosave();
});
canvas.addEventListener('lostpointercapture', clearAreaSelection);

canvas.addEventListener('pointerup', event => {
  const work = current;
  if (!work || viewer.comparing) return;
  if (selecting?.pointer === event.pointerId) {
    const region = selecting;
    clearAreaSelection();
    const p = selectionPoint(event);
    if (region.shape === 'rectangle') region.points[1] = p;
    else region.points.push(p);
    const path = selectionPath(region.shape, region.points);
    if (path.length >= 3 && (region.shape === 'lasso' || Math.hypot(p.x - path[0].x, p.y - path[0].y) > 4)) selectArea(path, event.shiftKey);
    return;
  }
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
    if (placingCursor && objectMode()) {
      const hit = viewer.hit(event, list.map(([, mesh]) => mesh));
      if (hit) {
        for (const [i, axis] of objectAxesNames.entries()) objectField('cursor', axis).value = String(hit.point.getComponent(i));
        placingCursor = false;
        controls();
      }
      return;
    }
    if (throughSurface.checked && (meshEditing || uvEditing || objectMode())) {
      const { x, y } = selectionPoint(event);
      selectArea(selectionPath('rectangle', [{ x: x - 8, y: y - 8 }, { x: x + 8, y: y + 8 }]), event.shiftKey, { x, y });
      return;
    }
    const model = viewer.pick(event, list.map(([, mesh]) => mesh));
    const id = list.find(([, mesh]) => mesh === model)?.[0];
    if ((!meshEditing && !repairing && !uvEditing) || id) selectObject(id ?? '', objectMode() && event.shiftKey);
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
