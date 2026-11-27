import { Mesh, Vector3 } from 'three';
import { exportAsset } from './e00/round-trip';
import { exportGlb } from './e00/glb-round-trip';
import { unwrapAsset } from './e00/uv-atlas';
import { rebakeAsset } from './e00/rebake';
import { brushRadius, paintableMesh, paintStroke } from './e00/paint';
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
import { decodePng, encodeImage } from './texture/image';

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
const paintButton = element<HTMLButtonElement>('paint'), paintColor = element<HTMLInputElement>('paint-color');
const undo = element<HTMLButtonElement>('undo-stroke'), redo = element<HTMLButtonElement>('redo');
const cancel = element<HTMLButtonElement>('cancel-job');
const autosaveStatus = element('autosave-status'), restore = element<HTMLButtonElement>('restore-autosave');
const recovery = element('recovery');
const objects = element<HTMLSelectElement>('object-selection'), objectLabel = element<HTMLInputElement>('object-label');
const rename = element<HTMLButtonElement>('rename-object'), visibility = element<HTMLButtonElement>('object-visibility');
const projection = element<HTMLSelectElement>('projection'), viewDirection = element<HTMLSelectElement>('view-direction');
const frameSelection = element<HTMLButtonElement>('frame-selection');
const historyBudget = element<HTMLInputElement>('history-budget');
const toggleTexture = element<HTMLButtonElement>('toggle-texture');
const viewer = new Viewer(canvas, lost => {
  stroke = undefined;
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
let stroke: { pointer: number; points: [number, number][] } | undefined;
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
  selectObject,
  unlit(value) {
    unlit = value;
    void refreshAppearance();
  },
});

function controls() {
  const document = current?.document;
  const model = current?.model;
  const locked = busy || !!stroke || textureGesture;
  const fbx = model?.format === 'fbx';
  const availablePaint = !!(viewer.available && fbx && paintableMesh(model));
  if (!availablePaint) painting = false;
  sources.disabled = locked;
  close.disabled = save.disabled = saveAs.disabled = exportButton.disabled = locked || !document;
  unwrap.disabled = locked || !fbx;
  rebake.disabled = locked || !fbx || !model.uvAtlas;
  paintButton.disabled = locked || !availablePaint;
  paintColor.disabled = locked || !painting;
  undo.disabled = locked || !document?.undoDepth;
  redo.disabled = locked || !document?.redoDepth;
  restore.disabled = locked;
  cancel.hidden = !abort;
  cancel.disabled = abort?.signal.aborted ?? true;
  paintButton.setAttribute('aria-pressed', String(painting));
  canvas.style.cursor = painting && !busy ? 'crosshair' : '';
  canvas.style.touchAction = 'none';
  viewer.setPainting(painting);
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
  element('object-tools').hidden = !document;
  objects.disabled = locked;
  objectLabel.disabled = rename.disabled = visibility.disabled = locked || !selected;
  frameSelection.disabled = !selected || locked;
  toggleTexture.disabled = locked || !current?.textures.bindings.length;
  toggleTexture.setAttribute('aria-expanded', String(!editor.panel.hidden));
  editor.lock(busy || !!stroke);
}

function renderObjects() {
  if (!current) {
    objects.replaceChildren();
    return;
  }
  const entries = current.document.scene.filter(entry => entry.mesh);
  objects.replaceChildren(new Option('None', ''), ...entries.map(entry => {
    const state = current!.document.state.objects[entry.id] ?? entry;
    return new Option(state.visible ? state.name : `${state.name} (hidden)`, entry.id);
  }));
  selectObject(selected);
}

function selectObject(id: string) {
  const entry = current?.document.scene.find(node => node.id === id && node.mesh);
  selected = entry?.id ?? '';
  objects.value = selected;
  const state = entry && (current!.document.state.objects[selected] ?? entry);
  objectLabel.value = state?.name ?? '';
  visibility.textContent = state?.visible === false ? 'Show object' : 'Hide object';
  const topology = current?.document.topology.get(selected);
  element('selection-details').textContent = topology
    ? `${selected} · ${topology.positions.length / 3} vertices · ${topology.faceEnds.length} faces · First face ID ${elementId(selected, 'face', 0)}`
    : '';
  viewer.select(current?.adapter.objects.get(selected));
  syncTextureEditor();
  controls();
}

function syncTextureEditor() {
  const work = current;
  if (!work || editor.panel.hidden) return;
  const state = work.document.state;
  editor.setSession({ targets: work.textures.targets(state), atlas: work.model.format === 'fbx' ? work.model.uvAtlas?.geometry : undefined,
    load: target => work.textures.load(target, state) }, selected);
}

toggleTexture.addEventListener('click', () => {
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
  if (busy || stroke || textureGesture) return false;
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
  painting = false;
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
    if (working.format === 'fbx' && working.textureBake?.maps.some(map => !working.images.has(map.source))) {
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
        output = await exportAsset(projected, bound.fbx);
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
  if (!current || autosaveDue === undefined || busy || stroke || textureGesture || writingCheckpoint) return;
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
  const visualChange = state.atlas !== previous.atlas || state.bake !== previous.bake || state.paint !== previous.paint || state.textures !== previous.textures;
  let appearance: Appearance | undefined;
  try {
    work.textures.validate(state);
    const model = work.adapter.materialize(state);
    if (visualChange) appearance = await prepareAppearance(model, work.textures, state, undefined, unlit);
    signal?.throwIfAborted();
    if (current !== work) throw new Error('The active project changed during the operation.');
    work.document.assertRevision(revision);
    commit();
    work.model = model;
  } catch (error) {
    if (appearance) disposeAppearance(appearance);
    work.model = work.adapter.materialize(previous);
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
    await edit(work, revision, { objects: state.objects, textures: withoutAtlasEdits(state) }, 'Discard UV atlas', 'geometry', signal);
    status.textContent = 'Restored the source UV channels.';
    return;
  }
  const result = await unwrapAsset(model, signal);
  const atlas = result.uvAtlas!;
  const target = captureAtlas(atlas);
  atlas.geometry.dispose();
  await edit(work, revision, { ...state, atlas: target }, 'Generate UV atlas', 'geometry', signal);
  status.textContent = `Generated ${target.metrics.charts} charts at ${target.metrics.width}×${target.metrics.height} in UV1. Export writes triangles. Existing textures still use UV0.`;
}, 'Generating UV atlas…', true));

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
  const entry = work?.document.scene.find(object => object.id === id);
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
}
projection.addEventListener('change', () => frame());
viewDirection.addEventListener('change', () => frame());
element('frame-all').addEventListener('click', () => frame());
frameSelection.addEventListener('click', () => frame(true));

window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || busy || stroke || textureGesture) return;
  if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) frame(!!selected);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    navigate(event.shiftKey ? 'redo' : 'undo');
  }
});

paintButton.addEventListener('click', () => {
  painting = !painting;
  controls();
  status.textContent = painting ? `Drag on the model to paint Base Color. Brush diameter ${brushRadius * 2} viewport pixels.` : '3D brush is off.';
});

function pointerPoint(event: PointerEvent): [number, number] {
  const bounds = canvas.getBoundingClientRect();
  return [(event.clientX - bounds.left) * canvas.width / bounds.width, (event.clientY - bounds.top) * canvas.height / bounds.height];
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || busy || stroke || textureGesture || !current) return;
  if (!painting) {
    picking = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    return;
  }
  if (paintButton.disabled) return;
  canvas.setPointerCapture(event.pointerId);
  stroke = { pointer: event.pointerId, points: [pointerPoint(event)] };
  controls();
  event.preventDefault();
});

canvas.addEventListener('pointermove', event => {
  if (stroke?.pointer === event.pointerId) stroke.points.push(pointerPoint(event));
  if (picking?.pointer === event.pointerId && Math.hypot(event.clientX - picking.x, event.clientY - picking.y) > 4) picking = undefined;
});

canvas.addEventListener('pointercancel', () => {
  stroke = picking = undefined;
  controls();
  resumeAutosave();
});

canvas.addEventListener('pointerup', event => {
  const work = current, camera = viewer.camera;
  if (!work) return;
  if (picking?.pointer === event.pointerId) {
    picking = undefined;
    const list = [...work.adapter.objects].filter((pair): pair is [string, Mesh] => pair[1] instanceof Mesh);
    const model = viewer.pick(event, list.map(([, mesh]) => mesh));
    selectObject(list.find(([, mesh]) => mesh === model)?.[0] ?? '');
  }
  if (stroke?.pointer !== event.pointerId) return;
  const points = stroke.points;
  stroke = undefined;
  if (work.model.format !== 'fbx' || !camera) { controls(); resumeAutosave(); return; }
  const model = work.model;
  points.push(pointerPoint(event));
  void locked(async signal => {
    const { state, revision } = work.document;
    const projected = projectedModel(model, state);
    if (projected.format !== 'fbx') return;
    const paint = await paintStroke(projected, camera, canvas.width, canvas.height, points, paintColor.value, signal);
    if (!paint) { status.textContent = 'The stroke missed the visible model.'; return; }
    const target = work.textures.targets(state)[0];
    if (!target) throw new Error('The baked Base Color binding is missing.');
    const previous = await work.textures.load(target, state);
    const image = decodePng(paint.png, previous);
    await edit(work, revision, { ...state, paint: undefined, textures: { ...state.textures,
      [atlasColor]: { image, paint: { strokes: paint.strokes, lastStrokeTexels: paint.lastStrokeTexels } } } }, 'Brush stroke', atlasColor, signal);
    status.textContent = `Painted ${paint.lastStrokeTexels.toLocaleString()} Base Color texels.`;
  }, 'Projecting the stroke onto visible faces…', true);
});

controls();
void offerRecovery();
