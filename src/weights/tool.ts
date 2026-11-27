import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Matrix4, MeshBasicMaterial, Points, PointsMaterial, SkinnedMesh,
  Vector3 } from 'three';
import { usedVertices, type MeshData } from '../mesh/data';
import type { MeshEdit } from '../mesh/commands';
import { Projection } from '../paint3d/projection';
import { paintView } from '../paint3d/scene';
import type { ModelAdapter } from '../project/adapter';
import type { WorkingState } from '../project/state';
import type { Viewer } from '../project/viewer';
import type { Point } from '../texture/stroke';
import type { UvTriangle } from '../texture/overlay';
import type { FrozenDiagnostic } from '../humanoid/tool';
import { total, type Row, type WeightEditRow } from './data';
import { adjacency, blend, readProfile, reconcile, weightOf, type Weights } from './operations';
import { deformation, drawVertices, sample } from './sampling';
import { bonePairs, mapRow, mirrorMatches, surfaceTransfer, type Snapshot } from './spatial';

const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`weights-${id}`)! as T;
const select = (id: string) => ui<HTMLSelectElement>(id);
const field = (id: string) => ui<HTMLInputElement>(id);
const emptyUv = new Map<number, UvTriangle>();
const blue = new Color(0x243d8b), mid = new Color(0x42d5ae), red = new Color(0xe24933);
const format = (value: number) => Number(value.toPrecision(5)).toString();

interface Context { adapter: ModelAdapter; object: string; state: WorkingState; revision: number }
interface Actions {
  commit(command: MeshEdit, revision: number, label: string): Promise<boolean>;
  lock(revision: number, ids: string[]): Promise<boolean>;
}
interface Profile { mesh: SkinnedMesh; data: MeshData; ids: (string | undefined)[]; palette: Set<string>; weights: Weights }
interface Conversion { rows: WeightEditRow[]; revision: number; report: string }
interface Gesture {
  stroke: Point[]; projection: Projection; mask?: Set<string>; radius: number; strength: number; hardness: number; xray: boolean;
}

export class WeightTool {
  #context?: Context;
  #profile?: Profile;
  #gesture?: Gesture;
  #external?: FrozenDiagnostic;
  #geometry?: BufferGeometry;
  #conversion?: Conversion;
  #snapshot?: { object: string; snapshot: Snapshot };
  #highlight = new Set<number>();
  #locked = false;
  #maskPick = false;
  #material = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false });
  #markers = new Points(new BufferGeometry(), new PointsMaterial({ color: 0xff55d7, size: 9, sizeAttenuation: false, depthTest: false }));

  constructor(readonly viewer: Viewer, readonly canvas: HTMLCanvasElement, readonly actions: Actions) {
    this.#markers.visible = false;
    this.#markers.frustumCulled = false;
    this.#markers.renderOrder = 10;
    viewer.scene.add(this.#markers);
    for (const id of ['joint', 'pose', 'time', 'vertices', 'faces', 'limit', 'policy', 'replace', 'fallback']) ui(id).onchange = () => {
      this.#conversion = undefined;
      this.#highlight.clear();
      ui('issues').textContent = '';
      this.#refresh();
    };
    field('lock').onchange = () => void this.#setLock();
    ui('pick-mask').onclick = () => {
      this.#maskPick = !this.#maskPick;
      ui('pick-mask').setAttribute('aria-pressed', String(this.#maskPick));
    };
    ui('numeric').onclick = () => void this.#numeric(false);
    ui('normalize').onclick = () => void this.#numeric(true);
    ui('find').onclick = () => this.#find();
    ui('convert').onclick = () => this.#convert();
    ui('confirm').onclick = () => void this.#confirm();
    ui('mirror').onclick = () => void this.#mirror();
    ui('capture').onclick = () => this.#capture();
    ui('transfer').onclick = () => void this.#transfer();
  }

  configure(context: Context | undefined, locked: boolean) {
    const previous = this.#context;
    this.#context = context;
    this.#locked = locked;
    ui<HTMLFieldSetElement>('tools').disabled = locked;
    ui('tools').hidden = !context;
    if (!context) {
      if (previous) {
        this.#external = undefined;
        this.#snapshot = this.#profile = this.#conversion = undefined;
        this.#highlight.clear();
        this.#maskPick = false;
        ui('pick-mask').setAttribute('aria-pressed', 'false');
        this.cancel();
        this.#clearView();
        this.viewer.manualPose();
        this.viewer.freeze();
      }
      return;
    }
    if (previous?.adapter !== context.adapter || previous.object !== context.object || previous.revision !== context.revision) {
      this.#conversion = undefined;
      this.#highlight.clear();
      ui('issues').textContent = '';
      if (previous?.object !== context.object) {
        field('vertices').value = field('faces').value = '';
      }
      try { this.#profile = this.#read(context.object); }
      catch (error) { this.#profile = undefined; this.#report(error); }
      this.#options();
      if (previous?.adapter !== context.adapter) {
        const handoff = this.#external?.adapter === context.adapter ? this.#external : undefined;
        select('pose').value = handoff ? 'diagnostic' : 'rest';
        field('time').value = String(handoff?.time ?? 0);
      }
      this.#refresh();
    }
    for (const id of ['numeric', 'normalize', 'find', 'convert', 'mirror', 'transfer', 'pick-mask', 'lock']) {
      ui<HTMLButtonElement>(id).disabled = !this.#profile;
    }
    ui<HTMLButtonElement>('confirm').disabled = !this.#conversion;
  }

  useDiagnostic(frame: FrozenDiagnostic) { this.#external = frame; }

  #read(object: string, original = false): Profile {
    const { adapter, state } = this.#context!;
    const mesh = adapter.objects.get(object);
    if (!(mesh instanceof SkinnedMesh)) throw new Error('Select a skinned mesh in Objects.');
    const data = original ? adapter.mesh.originalData(object) : adapter.mesh.data(object);
    const ids = original ? [...data.weightJoints ?? []] : adapter.rig.palette(mesh);
    if (ids.some(id => !id) || !ids.length) throw new Error('The mesh has an unresolved skin palette.');
    const palette = new Set(ids as string[]);
    return { mesh, data, ids, palette, weights: readProfile(data, palette, original ? undefined : state.rig?.transfers) };
  }

  #options() {
    const { adapter, state, object } = this.#context!;
    const joints = [...this.#profile?.palette ?? []].map(id => [id, adapter.rig.bone(id)?.name || id] as const);
    for (const picker of ['joint', 'replace', 'fallback']) this.#selectOptions(picker, joints, picker === 'joint' ? undefined : 'None');
    const clips = adapter.model.scene.animations.map((clip, index) => [`clip-${index}`, clip.name] as const);
    const manual = state.poses && (Object.keys(state.poses.current).length || Object.keys(state.poses.translations ?? {}).length);
    const handoff = this.#external?.adapter === adapter ? this.#external : undefined;
    this.#selectOptions('pose', [['rest', 'Working rest'], ...(manual ? [['manual', 'Current manual pose'] as const] : []), ...clips,
      ...(handoff ? [['diagnostic', `${handoff.name} · diagnostic frame`] as const] : [])]);
    const original = select('source-mode').value === 'original';
    this.#selectOptions('source', adapter.viewEntries.filter(entry => adapter.objects.get(entry.id) instanceof SkinnedMesh &&
      (!original || adapter.mesh.originalGeometry(entry.id))).map(entry => [entry.id, state.objects[entry.id]?.name ?? entry.name]), undefined, object);
    select('source-mode').onchange = () => this.#options();
  }

  #selectOptions(id: string, choices: readonly (readonly [string, string])[], empty?: string, preferred?: string) {
    const picker = select(id), last = picker.value;
    picker.replaceChildren(...(empty ? [new Option(empty, '')] : []), ...choices.map(([id, label]) =>
      new Option(id.startsWith('object-') || id.startsWith('joint-') ? `${label} · ${id}` : label, id)));
    if ([...picker.options].some(option => option.value === last)) picker.value = last;
    else if (preferred && choices.some(([id]) => id === preferred)) picker.value = preferred;
  }

  #refresh() {
    const ctx = this.#context, profile = this.#profile;
    if (!ctx || !profile) { this.#clearView(); return; }
    field('lock').checked = ctx.state.weightLocks?.includes(select('joint').value) ?? false;
    ui<HTMLButtonElement>('confirm').disabled = !this.#conversion;
    const pose = select('pose').value;
    const handoff = pose === 'diagnostic' && this.#external?.adapter === ctx.adapter ? this.#external : undefined;
    const clip = pose.startsWith('clip-') ? ctx.adapter.model.scene.animations[Number(pose.slice(5))] : handoff?.clip;
    field('time').disabled = !!handoff;
    if (handoff) field('time').value = String(handoff.time);
    this.viewer.manualPose(clip ? undefined : () => ctx.adapter.rig.applyPose(pose === 'manual' ? ctx.state.poses?.current ?? {} : {},
      pose === 'manual' ? ctx.state.poses?.translations : undefined));
    this.viewer.freeze(clip, clip ? Math.min(clip.duration, Math.max(0, handoff?.time ?? (field('time').valueAsNumber || 0))) : 0);
    this.#draw();
    const count = [...profile.weights.issues.values()].filter(issues => issues.includes('over four influences')).length;
    this.#info(`${profile.weights.rows.size.toLocaleString()} logical vertices · ${profile.palette.size} influences` +
      (count ? ` · ${count} wide rows use an approximate four-weight GPU preview. Use Preview conversion to compare the full weights.` : '.'));
  }

  #clearView() {
    this.viewer.skinView();
    this.#geometry?.dispose();
    this.#geometry = undefined;
    this.#markers.visible = false;
    this.#markers.geometry.dispose();
    this.#markers.geometry = new BufferGeometry();
  }

  #draw() {
    const { adapter, object } = this.#context!, profile = this.#profile!;
    const { mesh, weights } = profile;
    this.#clearView();
    const geometry = this.#geometry = mesh.geometry.clone(), joint = select('joint').value;
    const draft = new Map(this.#conversion?.rows), render = drawVertices(adapter, object, mesh);
    const rgb = new Float32Array(geometry.getAttribute('position').count * 3), color = new Color();
    const indices = geometry.getAttribute('skinIndex'), values = geometry.getAttribute('skinWeight');
    const slots = new Map(profile.ids.map((id, i) => [id, i]));
    for (const [i, vertex] of render) {
      const changed = draft.get(vertex), row = changed ?? weights.rows.get(vertex) ?? [];
      const weight = Math.min(1, weightOf(row, joint));
      if (weight < .5) color.copy(blue).lerp(mid, weight * 2);
      else color.copy(mid).lerp(red, 2 * weight - 1);
      color.toArray(rgb, i * 3);
      if (changed) for (let k = 0; k < 4; k++) {
        indices.setComponent(i, k, slots.get(changed[k]?.[0]) ?? 0);
        values.setComponent(i, k, changed[k]?.[1] ?? 0);
      }
    }
    geometry.setAttribute('color', new Float32BufferAttribute(rgb, 3));
    this.viewer.skinView({ mesh, geometry, material: this.#material });
    if (this.#highlight.size) {
      const positions: number[] = [], done = new Set<number>(), point = new Vector3();
      this.viewer.withPose(() => {
        for (const [i, vertex] of render) if (this.#highlight.has(vertex) && !done.has(vertex)) {
          positions.push(...mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld).toArray());
          done.add(vertex);
        }
      });
      this.#markers.visible = positions.length > 0;
      this.#markers.geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    }
    this.viewer.render();
  }

  #clearDraft() {
    const hadPreview = !!this.#conversion;
    this.#conversion = undefined;
    ui<HTMLButtonElement>('confirm').disabled = true;
    if (hadPreview) this.#draw();
  }

  #scope() {
    const profile = this.#profile!, faces = this.#faces();
    const vertices = ids(field('vertices').value);
    if (vertices?.some(id => !profile.weights.rows.has(id))) throw new Error('The vertex list contains a missing logical ID.');
    const eligible = faces ? new Set(usedVertices(profile.data.faces.filter(face => faces.has(face.id)))) : undefined;
    const target = (vertices ?? [...profile.weights.rows.keys()]).filter(id => !eligible || eligible.has(id));
    if (!target.length) throw new Error('The current selection has no eligible logical vertices.');
    return target;
  }

  #faces() {
    const selected = ids(field('faces').value, 'F');
    if (!selected) return;
    const active = new Set(this.#profile!.data.faces.map(face => face.id));
    if (selected.some(id => !active.has(id))) throw new Error('The face mask contains a missing face ID.');
    return new Set(selected);
  }

  async #setLock() {
    const { revision, state } = this.#context!, selected = select('joint').value;
    const locks = new Set(state.weightLocks);
    if (field('lock').checked) locks.add(selected);
    else locks.delete(selected);
    if (!await this.actions.lock(revision, [...locks].sort())) field('lock').checked = state.weightLocks?.includes(selected) ?? false;
  }

  #config() {
    return { locks: new Set(this.#context!.state.weightLocks), policy: select('policy').value as 'reject' | 'replace' | 'limit',
      replace: select('replace').value, fallback: select('fallback').value };
  }

  #invalid(id: number) {
    const issues = this.#profile!.weights.issues.get(id) ?? [];
    return issues.filter(issue => issue === 'negative or nonfinite' || issue === 'unsupported bone');
  }

  #propose(target: Iterable<number>, make: (id: number, before: Row) => ReturnType<typeof reconcile>, partial = false) {
    const { weights, mesh, ids: palette } = this.#profile!;
    const rows: WeightEditRow[] = [], measures: [number, Row, Row][] = [], issues = new Map<number, string>();
    let dropped = 0;
    for (const id of target) try {
      const invalid = this.#invalid(id);
      if (invalid.length) throw new Error(invalid.join(', '));
      const before = weights.rows.get(id)!;
      const { row, dropped: lost } = make(id, before);
      if (before.length === row.length && before.every(([joint, value]) => Math.abs(value - weightOf(row, joint)) <= 1e-12) && !weights.issues.has(id)) continue;
      rows.push([id, row]); measures.push([id, before, row]);
      dropped += lost;
    } catch (error) { issues.set(id, message(error)); }
    this.#issues(issues);
    if (issues.size && !partial) throw new Error(`Edit rejected on ${issues.size} vertices. ${issues.values().next().value}`);
    if (!rows.length) throw new Error(issues.size ? 'No eligible weights could be updated.' : 'The selection already has these weights.');
    const { adapter, object } = this.#context!;
    const render = drawVertices(adapter, object, mesh);
    const change = this.viewer.withPose(() => deformation(mesh, render, palette, measures));
    const lost = dropped > 0 ? ` · dropped mass ${format(dropped)}` : '';
    return { rows, report: `${rows.length} vertices${lost} · peak deformation change ${format(change)} scene units` +
      (issues.size ? ` · ${issues.size} skipped` : ''), issues };
  }

  async #numeric(normalize: boolean) {
    try {
      this.#clearDraft();
      const joint = select('joint').value, value = normalize ? 0 : number('value', 0, 1);
      const config = this.#config();
      const result = this.#propose(this.#scope(), (id, row) => {
        if (row.length > 4) throw new Error('Convert the wide row explicitly before ordinary edits.');
        return reconcile(row, row, { ...config, fixed: normalize ? undefined : [joint, value] });
      });
      await this.#commit(result, normalize ? 'Normalize skin weights' : 'Set exact skin weight');
    } catch (error) { this.#report(error); }
  }

  #find() {
    this.#clearDraft();
    const profile = this.#profile;
    if (!profile) return;
    const invalid = new Map([...profile.weights.issues].map(([id, issues]) => [id, issues.join(', ')]));
    this.#issues(invalid);
    this.#info(invalid.size ? `${invalid.size} vertices need attention. Magenta marks the affected IDs.` : 'All active vertices satisfy the weight profile.');
  }

  #convert() {
    try {
      this.#clearDraft();
      const limit = number('limit', 1, 4), config = this.#config();
      if (!Number.isInteger(limit)) throw new Error('Use a whole number of influences.');
      const result = this.#propose(this.#scope(), (_, row) => reconcile(row, row, { ...config, limit, policy: 'limit' }));
      this.#conversion = { ...result, revision: this.#context!.revision };
      ui<HTMLButtonElement>('confirm').disabled = false;
      this.#draw();
      this.#info(`Conversion preview · ${result.report}.`);
    } catch (error) { this.#report(error); }
  }

  async #confirm() {
    const proposed = this.#conversion;
    if (!proposed || proposed.revision !== this.#context?.revision) return;
    this.#clearDraft();
    await this.#commit(proposed, 'Convert skin influence limit');
  }

  async #mirror() {
    try {
      this.#clearDraft();
      const profile = this.#profile!, pairs = bonePairs(field('mirror-pairs').value, true);
      const match = mirrorMatches(profile.data, profile.mesh.matrixWorld, Number(select('axis').value), field('offset').valueAsNumber,
        field('tolerance').valueAsNumber);
      const config = this.#config();
      const result = this.#propose(this.#scope(), (id, row) => {
        const hit = match(id);
        if (hit.issue) throw new Error(hit.issue);
        if (this.#invalid(hit.other).length) throw new Error('The mirror source has invalid weights.');
        const source = profile.weights.rows.get(hit.other)!;
        if (row.length > 4 || source.length > 4) throw new Error('Convert the source and target wide rows explicitly before mirroring.');
        if (!source.length) throw new Error('The mirror source has a zero sum.');
        return reconcile(row, mapRow(source, pairs, profile.palette, true), config);
      }, true);
      await this.#commit(result, 'Mirror skin weights');
    } catch (error) { this.#report(error); }
  }

  #capture() {
    try {
      const object = select('source').value;
      this.#snapshot = { object, snapshot: this.#source(object, false) };
      select('source-mode').value = 'snapshot';
      this.#options();
      this.#info(`Captured ${this.#snapshot.snapshot.rows.size} logical weight rows from revision ${this.#context!.revision}.`);
    } catch (error) { this.#report(error); }
  }

  #source(object: string, original: boolean): Snapshot {
    const profile = this.#read(object, original), matrix = profile.mesh.matrixWorld.clone();
    if (original) {
      const { adapter } = this.#context!, entries = new Map(adapter.entries.map(entry => [entry.id, entry]));
      matrix.identity();
      for (let entry = entries.get(object); entry; entry = entry.parent ? entries.get(entry.parent) : undefined) {
        matrix.premultiply(new Matrix4().fromArray(entry.transform));
      }
      matrix.premultiply(adapter.model.scene.matrixWorld);
    }
    const rows = new Map([...profile.weights.rows].filter(([id, row]) => row.length > 0 &&
      Math.abs(total(row) - 1) <= 1e-5 && !profile.weights.issues.get(id)?.some(issue => issue === 'negative or nonfinite' || issue === 'unsupported bone')));
    return { data: profile.data, matrix, rows };
  }

  async #transfer() {
    try {
      this.#clearDraft();
      const object = select('source').value, profile = this.#profile!, targets = this.#scope();
      const source = select('source-mode').value === 'original' ? this.#source(object, true) : this.#snapshot?.object === object ? this.#snapshot.snapshot : undefined;
      if (!source) throw new Error('Capture this source mesh before using its working weights.');
      const sourceFaces = ids(field('source-faces').value, 'F');
      const active = new Set(source.data.faces.map(face => face.id));
      if (sourceFaces?.some(id => !active.has(id))) throw new Error('The source face list contains a missing face ID.');
      const query = surfaceTransfer(source, sourceFaces && new Set(sourceFaces), profile.data, profile.mesh.matrixWorld, targets,
        field('distance').valueAsNumber, number('angle', 0, 90));
      const pairs = bonePairs(field('transfer-pairs').value, false), config = this.#config();
      const indices = new Map(targets.map((id, i) => [id, i]));
      const result = this.#propose(targets, (id, row) => {
        const proposal = query(indices.get(id)!);
        if (!proposal?.length) throw new Error('No eligible source surface within the distance and normal limits.');
        if (row.length > 4) throw new Error('Convert the wide row explicitly before transfer.');
        return reconcile(row, mapRow(proposal, pairs, profile.palette, false), config);
      }, true);
      await this.#commit(result, 'Transfer skin weights');
    } catch (error) { this.#report(error); }
  }

  #pointer(event: PointerEvent): Point {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  move(event: PointerEvent) {
    const p = this.#pointer(event);
    if (this.#gesture) this.#gesture.stroke.push(p);
    const cursor = ui('cursor'), radius = field('radius').valueAsNumber, bounds = this.canvas.getBoundingClientRect();
    cursor.hidden = this.#maskPick || !this.#profile || p.x < 0 || p.y < 0 || p.x > bounds.width || p.y > bounds.height || !(radius > 0 && radius <= 512);
    if (cursor.hidden) return;
    cursor.style.left = `${p.x}px`; cursor.style.top = `${p.y}px`;
    cursor.style.width = cursor.style.height = `${2 * radius}px`;
  }

  leave() { ui('cursor').hidden = true; }
  cancel() { this.#gesture = undefined; this.leave(); }

  begin(event: PointerEvent) {
    const context = this.#context, camera = this.viewer.camera;
    if (!context || !camera || !this.#profile || this.#locked) return false;
    try {
      this.#clearDraft();
      const radius = number('radius', 1, 512), strength = number('strength', 0, 100) / 100;
      const hardness = number('hardness', 0, 100) / 100, xray = field('xray').checked;
      const { width, height } = this.canvas.getBoundingClientRect();
      const view = this.viewer.withPose(() => paintView(context.adapter, undefined, emptyUv, camera, width, height, { object: context.object, xray }));
      const projection = new Projection(view), p = this.#pointer(event), faces = this.#faces();
      if (this.#maskPick) {
        const hit = projection.hit(p.x, p.y), face = hit && view.faces[hit.face];
        if (face?.vertices) {
          const id = Number(face.source.split('/').at(-1)), mask = faces ?? new Set();
          if (mask.has(id)) mask.delete(id); else mask.add(id);
          field('faces').value = [...mask].sort((a, b) => a - b).join(', ');
          this.#info(mask.size ? `${mask.size} faces in the brush mask.` : 'Brush mask cleared. All faces are eligible.');
        }
        return false;
      }
      const mask = faces && new Set([...faces].map(id => `${context.object}/face/${id}`));
      this.#gesture = { projection, stroke: [p], mask, radius, strength, hardness, xray };
      return true;
    } catch (error) { this.#report(error); return false; }
  }

  async finish(event: PointerEvent) {
    const gesture = this.#gesture, profile = this.#profile;
    this.#gesture = undefined;
    if (!gesture || !profile) return;
    try {
      const { projection, stroke, radius, strength, hardness, xray, mask } = gesture;
      stroke.push(this.#pointer(event));
      const touched = sample(projection, stroke, radius, strength, hardness, xray, mask);
      if (!touched.size) throw new Error('No eligible vertices beneath the brush.');
      const method = select('brush').value, joint = select('joint').value, config = this.#config();
      const target = method === 'replace' ? number('value', 0, 1) : 0;
      const neighbors = method === 'smooth' ? adjacency(profile.data) : undefined;
      const result = this.#propose(touched.keys(), (id, row) => {
        const alpha = touched.get(id)!;
        if (row.length > 4) throw new Error('Convert the wide row explicitly before brushing.');
        if (neighbors) {
          const peers = (neighbors.get(id) ?? []).map(peer => profile.weights.rows.get(peer)!).filter(weight => weight?.length);
          if (!peers.length) throw new Error('The vertex has no weighted topological neighbors.');
          return reconcile(row, blend([[row, 1 - alpha], ...peers.map(peer => [peer, alpha / peers.length] as const)]), config);
        }
        const now = weightOf(row, joint);
        const weight = Math.max(0, Math.min(1, method === 'replace' ? now + (target - now) * alpha : now + alpha * (method === 'add' ? 1 : -1)));
        return reconcile(row, row, { ...config, fixed: [joint, weight] });
      });
      await this.#commit(result, `${method[0].toUpperCase() + method.slice(1)} weight stroke`);
    } catch (error) { this.#report(error); }
  }

  async #commit(result: { rows: WeightEditRow[]; report: string; issues?: Map<number, string> }, label: string) {
    const { revision, object } = this.#context!;
    if (await this.actions.commit({ type: 'weights', object, rows: result.rows }, revision, label)) {
      this.#info(`${label} · ${result.report}.`);
      if (result.issues?.size) this.#issues(result.issues);
    }
  }

  #issues(issues: Map<number, string>) {
    this.#highlight = new Set(issues.keys());
    const summary = [...issues].slice(0, 24).map(([id, text]) => `${id} (${text})`).join(', ');
    ui('issues').textContent = issues.size ? `Vertex IDs ${summary}${issues.size > 24 ? ` and ${issues.size - 24} more` : ''}` : '';
    this.#draw();
  }

  #info(text: string) { ui('info').textContent = text; }
  #report(error: unknown) { this.#info(message(error)); }
}

function number(id: string, min: number, max: number) {
  const value = field(id).valueAsNumber;
  if (!(value >= min && value <= max)) throw new Error(`Enter a value from ${min} to ${max} for ${id}.`);
  return value;
}

function ids(text: string, prefix = '') {
  if (!text.trim()) return;
  const words = text.trim().split(/[\s,]+/), pattern = new RegExp(`^${prefix ? `(?:${prefix})?` : ''}(0|[1-9]\\d{0,9})$`, 'i');
  return [...new Set(words.map(word => {
    const match = pattern.exec(word);
    if (!match || Number(match[1]) > 0x7fffffff) throw new Error('Enter comma-separated logical IDs.');
    return Number(match[1]);
  }))];
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
