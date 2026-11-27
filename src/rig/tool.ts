import { BufferGeometry, Euler, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh,
  Object3D, Points, PointsMaterial, Quaternion, Raycaster, Vector2, Vector3, type Camera } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { WorkingState } from '../project/state';
import type { Viewer } from '../project/viewer';
import type { RigSession } from './session';
import { emptyPose, type Joint, type Pose, type PoseState, type PoseTranslations, type Quat, type RigAction, type RigClip } from './state';
import { unpack, worldMatrices } from './transforms';

const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`rig-${id}`)! as T;
const select = (id: string) => ui<HTMLSelectElement>(id);
const field = (id: string) => ui<HTMLInputElement>(id);
const button = (id: string) => ui<HTMLButtonElement>(id);
const checked = (id: string) => field(id).checked;
const radians = Math.PI / 180;

interface Context { session: RigSession; state: WorkingState; revision: number }
interface Actions {
  apply(revision: number, state: WorkingState, label: string): Promise<boolean>;
  orbit(dragging: boolean): void;
}

export class RigTool {
  #panel = ui<HTMLFieldSetElement>('tools');
  #context?: Context;
  #locked = false;
  #overlay = new Group();
  #handle = new Object3D();
  #camera?: Camera;
  #gizmo?: TransformControls;
  #lines = new LineBasicMaterial({ color: 0x5ee7ed, depthTest: false });
  #originalLines = new LineBasicMaterial({ color: 0xffaa6d, depthTest: false });
  #axes = new LineBasicMaterial({ color: 0xffffff, vertexColors: true, depthTest: false });
  #points = new PointsMaterial({ color: 0x5ee7ed, size: 6, sizeAttenuation: false, depthTest: false });
  #activePoint = new PointsMaterial({ color: 0xfaf29c, size: 10, sizeAttenuation: false, depthTest: false });
  #preview?: Pose;
  #savedId = '';
  #sweep = 0;
  #labelPosition?: Vector3;

  constructor(readonly viewer: Viewer, readonly canvas: HTMLCanvasElement, readonly actions: Actions) {
    viewer.scene.add(this.#overlay, this.#handle);
    viewer.onCameraChange(() => this.#positionLabel());
    for (const id of ['joint', 'edit-mode', 'operation', 'space', 'xray', 'compare', 'clip', 'preview-clip', 'time']) {
      ui(id).addEventListener('change', () => {
        this.#preview = undefined;
        if (id === 'joint') this.#jointFields();
        if (id === 'edit-mode' && this.#posing) field('preview-clip').checked = false;
        this.#sync();
      });
    }
    ui('apply').onclick = () => void this.#numeric();
    ui('rename').onclick = () => void this.#act({ type: 'rename', joint: this.#id, name: field('name').value }, 'Rename joint');
    ui('add').onclick = () => void this.#act({ type: 'add', joint: this.#id, name: field('name').value,
      offset: [0, field('child-length').valueAsNumber, 0] }, 'Add child joint');
    ui('delete').onclick = () => void this.#act({ type: 'delete', joint: this.#id, transfer: select('other').value }, 'Delete joint and transfer weights');
    ui('reparent').onclick = () => void this.#act({ type: 'reparent', joint: this.#id, parent: select('other').value,
      preserve: this.#preserve }, 'Reparent joint');
    ui('rebind').onclick = () => void this.#act({ type: 'rebind', joint: this.#id }, 'Rebind rig');
    ui('reset').onclick = () => void this.#write({ rig: undefined }, 'Restore original rig');
    ui('adapt').onclick = () => void this.#clip('adapted');
    ui('use-original').onclick = () => void this.#clip('original');
    ui('exclude').onclick = () => void this.#clip('exclude');
    ui('reset-bone').onclick = () => {
      const current = { ...this.#poses.current };
      const translations = { ...this.#poses.translations };
      delete current[this.#id];
      delete translations[this.#id];
      void this.#pose(current, 'Reset bone pose', translations);
    };
    ui('reset-pose').onclick = () => void this.#pose({}, 'Reset manual pose', {});
    ui('save').onclick = () => void this.#save('save');
    ui('rename-pose').onclick = () => void this.#save('rename');
    ui('copy-pose').onclick = () => void this.#save('duplicate');
    ui('delete-pose').onclick = () => void this.#save('delete');
    ui('saved').onchange = () => this.#load(select('saved').value);
    ui('curl').onclick = () => void this.#fingers(true);
    ui('sweep').onclick = () => void this.#fingers(false);
  }

  get dragging() { return !!this.#gizmo?.dragging; }
  get gizmoHit() { return !!this.#gizmo?.object && !!this.#gizmo.axis; }
  get #id() { return select('joint').value; }
  get #poses() { return this.#context?.state.poses ?? emptyPose; }
  get #joints() { return this.#context?.state.rig?.joints ?? this.#context?.session.original.joints ?? []; }
  get #preset() { return this.#poses.saved.find(pose => pose.id === this.#savedId); }
  get #posing() { return select('edit-mode').value === 'pose'; }
  get #rotating() { return this.#posing || select('operation').value === 'axes'; }
  get #preserve() { return select('descendants').value === 'preserve'; }
  get #time() { return Math.max(0, field('time').valueAsNumber || 0); }
  get #clipId() { return select('clip').value ? Number(select('clip').value) : undefined; }

  configure(context: Context | undefined, locked: boolean) {
    const previous = this.#context, changed = previous?.session !== context?.session || previous?.revision !== context?.revision;
    this.#context = context;
    this.#locked = locked;
    this.#panel.hidden = !context;
    this.#panel.disabled = locked;
    if (!context) {
      if (previous) {
        this.#disposeGizmo();
        this.#clearOverlay();
        this.#labelPosition = undefined;
        this.#positionLabel();
        this.viewer.manualPose();
        this.viewer.freeze();
      }
      return;
    }
    if (changed) {
      if (previous?.session !== context.session) {
        field('preview-clip').checked = false;
        this.#savedId = '';
      }
      this.#preview = undefined;
      const joint = this.#id, clip = select('clip').value;
      const byParent = new Map<string | null, Joint[]>();
      const joints = new Set(this.#joints.map(item => item.id)), choices: HTMLOptionElement[] = [];
      for (const item of this.#joints) {
        const parent = item.parent && joints.has(item.parent) ? item.parent : null;
        byParent.set(parent, [...byParent.get(parent) ?? [], item]);
      }
      const tree = (parent: string | null, depth: number) => {
        for (const item of byParent.get(parent) ?? []) {
          choices.push(new Option(`${'  '.repeat(Math.min(depth, 20))}${item.name || item.id}`, item.id));
          tree(item.id, depth + 1);
        }
      };
      tree(null, 0);
      select('joint').replaceChildren(...choices);
      if (joints.has(joint)) select('joint').value = joint;
      select('clip').replaceChildren(...context.session.originalClips.map(({ clip }, i) => new Option(clip.name, String(i))));
      if ([...select('clip').options].some(option => option.value === clip)) select('clip').value = clip;
      const presets = ui('presets');
      presets.replaceChildren(...this.#poses.saved.map(pose => {
        const shortcut = document.createElement('button');
        shortcut.type = 'button';
        const missing = this.#missing(pose.rotations, pose.translations);
        shortcut.textContent = pose.name + (missing.length ? ` (${missing.length} missing)` : '');
        shortcut.title = missing.join(', ');
        shortcut.setAttribute('aria-pressed', String(pose.id === this.#savedId));
        shortcut.onclick = () => this.#load(pose.id);
        return shortcut;
      }));
      presets.hidden = !this.#poses.saved.length;
      select('saved').replaceChildren(new Option('Choose a pose', ''), ...this.#poses.saved.map(pose => new Option(pose.name, pose.id)));
      select('saved').value = this.#preset?.id ?? '';
      this.#jointFields();
    }
    if (changed || this.#camera !== this.viewer.camera) this.#sync();
    if (this.#gizmo) this.#gizmo.enabled = !locked && !checked('preview-clip');
  }

  #jointFields() {
    const joint = this.#joints.find(joint => joint.id === this.#id);
    if (!joint) return;
    field('name').value = joint.name;
    for (const id of ['other', 'mirror']) {
      const picker = select(id), previous = picker.value;
      const peers = this.#joints.filter(item => item.id !== joint.id && item.group === joint.group);
      picker.replaceChildren(new Option(id === 'other' ? 'Select joint' : 'None', ''), ...peers.map(item => new Option(item.name, item.id)));
      if (peers.some(item => item.id === previous)) picker.value = previous;
    }
  }

  #sync() {
    const context = this.#context;
    if (!context) return;
    ui('structure').hidden = this.#posing;
    ui('pose-settings').hidden = !this.#posing;
    select('operation').disabled = select('descendants').disabled = this.#posing;
    const clip = this.#clipId === undefined ? undefined : context.session.clips[this.#clipId];
    ui('clip-info').textContent = clip?.reason ?? (clip?.setting.mode === 'exclude' ? 'Excluded from export. The original is retained.' :
      clip?.setting.mode === 'adapted' ? `Export uses ${clip.clip?.name ?? 'the adaptation'}.` : clip ? 'The original clip is included.' : 'No imported animation clips.');
    for (const id of ['adapt', 'use-original', 'exclude']) button(id).disabled = !clip;
    for (const id of ['rename-pose', 'copy-pose', 'delete-pose']) button(id).disabled = !this.#preset;
    field('preview-clip').disabled = !clip?.clip;
    if (!clip?.clip) field('preview-clip').checked = false;
    const trim = checked('preview-clip') && clip?.clip;
    const pose = this.#posing ? this.#preview ?? this.#poses.current : emptyPose.current;
    const manual = trim ? undefined : () => context.session.applyPose(pose, this.#posing ? this.#poses.translations : undefined);
    this.viewer.manualPose(manual);
    this.viewer.freeze(trim || undefined, trim ? Math.min(this.#time, trim.duration) : 0);
    const joint = this.#joints.find(item => item.id === this.#id);
    if (joint) {
      const position = new Vector3().setFromMatrixPosition(worldMatrices(this.#joints, context.session.anchor)(joint.id));
      const missing = this.#missing(this.#poses.current, this.#poses.translations);
      const affected = context.session.affectedMeshes(joint);
      this.#say(`${joint.name || joint.id} · ${joint.id} · ${affected} bound meshes · Rest XYZ ${position.toArray().map(v => v.toFixed(4)).join(', ')}. ` +
        (this.#rotating ? 'Offsets are degrees.' : 'Offsets are scene units.') +
        (missing.length ? ` Pose joints missing ${missing.join(', ')}.` : '') +
        (context.session.blocked ? ` ${context.session.blocked}` : ''));
    }
    this.#attachGizmo();
    this.#draw();
  }

  #world() {
    const context = this.#context;
    if (!context) return;
    const node = context.session.bone(this.#id);
    if (!node) return;
    if (this.#posing) return this.viewer.withPose(() => ({
      position: node.getWorldPosition(new Vector3()), rotation: node.getWorldQuaternion(new Quaternion()),
    }));
    const rest = unpack(worldMatrices(this.#joints, context.session.anchor)(this.#id));
    return { position: new Vector3(...rest.position), rotation: new Quaternion(...rest.rotation) };
  }

  async #numeric() {
    try {
      field('preview-clip').checked = false;
      this.#sync();
      const start = this.#world(), values = ['x', 'y', 'z'].map(id => field(id).valueAsNumber) as [number, number, number];
      if (!start || values.some(value => !Number.isFinite(value))) throw new Error('Enter finite joint offsets.');
      if (values.every(v => !v)) return;
      if (this.#rotating) {
        const [x, y, z] = values.map(value => value * radians);
        const delta = new Quaternion().setFromEuler(new Euler(x, y, z));
        const rotation = select('space').value === 'world' ? start.rotation.premultiply(delta) : start.rotation.multiply(delta);
        await this.#transform(undefined, rotation.normalize());
      } else {
        const move = new Vector3(...values);
        if (select('space').value === 'local') move.applyQuaternion(start.rotation);
        await this.#transform(start.position.add(move));
      }
      for (const id of ['x', 'y', 'z']) field(id).value = '0';
    } catch (error) { this.#say(error); }
  }

  #poseOffset(world: Quaternion) {
    const session = this.#context?.session, bone = session?.bone(this.#id), rest = session?.restRotation(this.#id);
    if (!bone || !rest) throw new Error('Select an existing joint.');
    const parent = this.viewer.withPose(() => bone.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion());
    return rest.invert().multiply(parent.invert().multiply(world)).normalize().toArray() as Quat;
  }

  async #transform(position?: Vector3, rotation?: Quaternion) {
    if (this.#posing) {
      if (rotation) await this.#pose({ ...this.#poses.current, [this.#id]: this.#poseOffset(rotation) }, 'Rotate manual pose joint');
      return;
    }
    const other = select('mirror').value, offset = field('plane-offset').valueAsNumber;
    if (other && !Number.isFinite(offset)) throw new Error('Enter a finite symmetry plane offset.');
    await this.#act({ type: 'transform', joint: this.#id, position: position?.toArray(), rotation: rotation?.toArray(),
      preserve: this.#preserve, mirror: other ? { joint: other, axis: Number(select('plane').value), offset } : undefined },
    position ? 'Move joint and rebind' : 'Rotate rest axes and rebind');
  }

  async #act(action: RigAction, label: string) {
    const context = this.#context;
    if (!context) return;
    try {
      await this.#write({ rig: context.session.change(context.state.rig, action) }, label);
    } catch (error) { this.#say(error); }
  }

  async #clip(mode: RigClip['mode']) {
    const context = this.#context, id = this.#clipId;
    if (!context || id === undefined) return;
    try {
      const offsets = checked('include-offsets') ? this.#poses.current : undefined;
      const translations = checked('include-offsets') ? this.#poses.translations : undefined;
      const rig = context.session.withClip(context.state.rig, id, mode, offsets, translations);
      await this.#write({ rig }, mode === 'adapted' ? 'Save adapted clip' : 'Set clip export mode');
    } catch (error) { this.#say(error); }
  }

  async #pose(current: Pose, label: string, translations = this.#poses.translations) {
    field('preview-clip').checked = false;
    this.#preview = undefined;
    await this.#write({ poses: { ...this.#poses, current, translations } }, label);
  }

  #missing(pose: Pose, translations?: PoseTranslations) {
    const session = this.#context!.session;
    return [...new Set([...Object.keys(pose), ...Object.keys(translations ?? {})])].filter(id => !session.bone(id))
      .map(id => session.original.joints.find(joint => joint.id === id)?.name || id);
  }

  #load(id: string) {
    this.#savedId = id;
    select('saved').value = id;
    const saved = this.#preset;
    if (saved) {
      field('pose-name').value = saved.name;
      void this.#pose(saved.rotations, 'Load saved pose', saved.translations ?? {});
    } else {
      for (const item of ui('presets').children) item.setAttribute('aria-pressed', 'false');
      this.#sync();
    }
  }

  async #save(mode: 'save' | 'rename' | 'duplicate' | 'delete') {
    try {
      const prior = this.#preset, data = this.#poses;
      let saved = [...data.saved];
      if (mode !== 'save' && !prior) throw new Error('Choose a saved pose.');
      if (mode === 'delete') {
        saved = saved.filter(pose => pose.id !== prior!.id);
        this.#savedId = '';
      } else {
        const entered = field('pose-name').value.trim();
        let name = mode === 'duplicate' && entered === prior!.name ? `${prior!.name.slice(0, 112)} copy` : entered;
        if (!name) name = mode === 'duplicate' ? `${prior!.name.slice(0, 112)} copy` : '';
        if (!name || name.length > 120 || saved.some(pose => pose.name === name && (mode !== 'rename' || pose !== prior))) {
          throw new Error('Enter a distinct pose name.');
        }
        if (mode === 'rename') saved = saved.map(pose => pose === prior ? { ...pose, name } : pose);
        else {
          if (saved.length >= 128) throw new Error('The project holds up to 128 saved poses.');
          this.#savedId = crypto.randomUUID();
          saved.push({ id: this.#savedId, name, rotations: mode === 'duplicate' ? prior!.rotations : data.current,
            translations: mode === 'duplicate' ? prior!.translations : data.translations });
        }
      }
      await this.#write({ poses: { ...data, saved } }, `${mode[0].toUpperCase() + mode.slice(1)} saved pose`);
      this.#sync();
    } catch (error) { this.#say(error); }
  }

  async #fingers(apply: boolean) {
    const context = this.#context;
    if (!context) return;
    try {
      const ids = field('fingers').value.trim().split(/[\s,]+/), byId = new Map(this.#joints.map(joint => [joint.id, joint]));
      if (!ids.length || ids.length > 8 || !ids.every((id, i) => byId.has(id) && (!i || byId.get(id)?.parent === ids[i - 1]))) {
        throw new Error('Enter consecutive finger joint IDs in parent-to-child order.');
      }
      const amount = field('curl-angle').valueAsNumber;
      if (!Number.isFinite(amount)) throw new Error('Enter a finite curl angle.');
      const axis = new Vector3().setComponent(Number(select('curl-axis').value), 1);
      const q = new Quaternion().setFromAxisAngle(axis, amount * radians).toArray() as Quat;
      if (apply) await this.#pose({ ...this.#poses.current, ...Object.fromEntries(ids.map(id => [id, q])) }, 'Curl finger chain');
      else {
        const id = ids[this.#sweep++ % ids.length];
        const pose = { ...this.#poses.current };
        for (const item of ids) delete pose[item];
        this.#preview = { ...pose, [id]: q };
        this.#sync();
        this.#say(`Sweep preview on ${byId.get(id)!.name}. Press Preview joint sweep to inspect the next joint.`);
      }
    } catch (error) { this.#say(error); }
  }

  #attachGizmo() {
    const camera = this.viewer.camera;
    if (camera !== this.#camera) {
      this.#disposeGizmo();
      this.#camera = camera;
      if (camera) {
        const gizmo = this.#gizmo = new TransformControls(camera, this.canvas);
        gizmo.setSize(.68);
        this.viewer.scene.add(gizmo.getHelper());
        gizmo.addEventListener('dragging-changed', event => this.actions.orbit(Boolean(event.value)));
        gizmo.addEventListener('objectChange', () => {
          if (this.#posing && this.dragging && this.#context) {
            const { session } = this.#context;
            const preview = this.#preview = { ...this.#poses.current, [this.#id]: this.#poseOffset(this.#handle.quaternion) };
            this.viewer.manualPose(() => session.applyPose(preview, this.#poses.translations));
          }
          this.#draw();
        });
        gizmo.addEventListener('mouseUp', () => {
          const position = this.#rotating ? undefined : this.#handle.position.clone();
          const rotation = this.#rotating ? this.#handle.quaternion.clone() : undefined;
          void this.#transform(position, rotation).catch(error => { this.#say(error); this.#sync(); });
        });
      }
    }
    const gizmo = this.#gizmo;
    if (!gizmo) return;
    try {
      const state = this.#world();
      if (!state || checked('preview-clip') || this.#context?.session.blocked && !this.#posing) { gizmo.detach(); return; }
      this.#handle.position.copy(state.position);
      this.#handle.quaternion.copy(state.rotation);
      this.#handle.updateMatrixWorld(true);
      gizmo.setMode(this.#rotating ? 'rotate' : 'translate');
      gizmo.setSpace(select('space').value === 'local' ? 'local' : 'world');
      gizmo.enabled = !this.#locked;
      gizmo.attach(this.#handle);
    } catch (error) { gizmo.detach(); this.#say(error); }
  }

  #disposeGizmo() {
    this.#gizmo?.getHelper().removeFromParent();
    this.#gizmo?.dispose();
    this.#gizmo = this.#camera = undefined;
  }

  pick(event: PointerEvent) {
    const camera = this.viewer.camera, context = this.#context;
    if (!camera || !context || this.#locked) return;
    const rect = this.canvas.getBoundingClientRect();
    const mouse = new Vector2(event.clientX - rect.left, event.clientY - rect.top);
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(2 * mouse.x / rect.width - 1, 1 - 2 * mouse.y / rect.height), camera);
    let nearest = 15 ** 2, depth = Infinity, selected: string | undefined;
    this.viewer.withPose(() => {
      const meshes: Mesh[] = [];
      if (!checked('xray')) context.session.model.scene.traverseVisible(node => { if (node instanceof Mesh) meshes.push(node); });
      const occlusion = ray.intersectObjects(meshes, false)[0]?.distance ?? Infinity;
      for (const joint of this.#joints) {
        const point = context.session.bone(joint.id)?.getWorldPosition(new Vector3());
        if (!point || point.distanceTo(ray.ray.origin) > occlusion + .002) continue;
        const projected = point.project(camera);
        const dx = mouse.x - (projected.x + 1) * rect.width / 2, dy = mouse.y - (1 - projected.y) * rect.height / 2;
        const distance = dx * dx + dy * dy;
        if (projected.z < -1 || projected.z > 1 || distance > nearest || distance === nearest && projected.z >= depth) continue;
        nearest = distance; depth = projected.z; selected = joint.id;
      }
    });
    if (selected) { select('joint').value = selected; this.#jointFields(); this.#sync(); }
  }

  #clearOverlay() {
    for (const child of this.#overlay.children) (child as LineSegments).geometry.dispose();
    this.#overlay.clear();
  }

  #draw() {
    this.#clearOverlay();
    const context = this.#context;
    if (!context) return;
    const positions = new Map<string, Vector3>();
    const axes: number[] = [], colors: number[] = [];
    this.viewer.withPose(() => {
      for (const joint of this.#joints) {
        const node = context.session.bone(joint.id)!;
        const point = node.getWorldPosition(new Vector3());
        positions.set(joint.id, point);
        if (joint.id !== this.#id) continue;
        const scale = this.viewer.camera?.position.distanceTo(point) ?? 1;
        const rotation = node.getWorldQuaternion(new Quaternion());
        for (let i = 0; i < 3; i++) {
          const color = new Vector3().setComponent(i, 1), direction = color.clone().applyQuaternion(rotation);
          axes.push(...point.toArray(), ...point.clone().addScaledVector(direction, scale * .055).toArray());
          colors.push(...color.toArray(), ...color.toArray());
        }
      }
    });
    this.#lines.depthTest = this.#points.depthTest = this.#activePoint.depthTest = this.#axes.depthTest = !checked('xray');
    const draw = (joints: readonly Joint[], world: ReadonlyMap<string, Vector3>, material: LineBasicMaterial) => {
      const lines = joints.flatMap(joint => {
        const a = world.get(joint.id), b = joint.parent && world.get(joint.parent);
        return a && b ? [...a.toArray(), ...b.toArray()] : [];
      });
      if (lines.length) this.#overlay.add(new LineSegments(geometry(lines), material));
    };
    draw(this.#joints, positions, this.#lines);
    if (positions.size) this.#overlay.add(new Points(geometry([...positions.values()].flatMap(p => p.toArray())), this.#points));
    const selected = positions.get(this.#id);
    if (selected) this.#overlay.add(new Points(geometry(selected.toArray()), this.#activePoint));
    this.#labelPosition = selected;
    ui('label').textContent = select('joint').selectedOptions[0]?.text.trim() ?? '';
    this.#positionLabel();
    if (axes.length) this.#overlay.add(new LineSegments(geometry(axes).setAttribute('color', new Float32BufferAttribute(colors, 3)), this.#axes));
    if (checked('compare')) draw(context.session.original.joints,
      context.session.comparison(checked('preview-clip') ? this.#clipId : undefined, this.#time), this.#originalLines);
    this.viewer.render();
  }

  #positionLabel() {
    const label = ui('label'), camera = this.viewer.camera;
    const point = camera && this.#labelPosition?.clone().project(camera);
    label.hidden = !point || [point.x, point.y, point.z].some(value => Math.abs(value) > 1);
    if (point) {
      label.style.left = `${50 * (point.x + 1)}%`;
      label.style.top = `${50 * (1 - point.y)}%`;
    }
  }

  async #write(changes: Pick<WorkingState, 'rig'> | { poses: PoseState }, label: string) {
    if (!this.#context || this.#locked) return;
    const { revision, state } = this.#context;
    if (!await this.actions.apply(revision, { ...state, ...changes }, label)) this.#sync();
  }

  #say(value: unknown) { ui('info').textContent = value instanceof Error ? value.message : String(value); }
}

function geometry(position: number[]) {
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(position, 3));
}
