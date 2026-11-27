import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, LineBasicMaterial, LineSegments, MeshBasicMaterial,
  SkinnedMesh, Vector3, type AnimationClip } from 'three';
import type { Vec3 } from '../mesh/data';
import type { ModelAdapter } from '../project/adapter';
import type { WorkingState } from '../project/state';
import type { Viewer } from '../project/viewer';
import { emptyPose, type Joint, type PoseState } from '../rig/state';
import { readProfile, weightOf } from '../weights/operations';
import { drawVertices } from '../weights/sampling';
import { motions, presets, suitability, type Motion, type Preset } from './motions';
import { checkMapping, emptyProfile, hasCorrections, mappingKey, roleLabel, roles, suggestRoles, type HumanoidProfile,
  type HumanoidState, type PublishedMotion, type Role } from './profile';
import { HumanoidRig, inPlaceClip, publishedClips } from './retarget';

const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`diag-${id}`)! as T;
const field = (id: string) => ui<HTMLInputElement>(id);
const select = (id: string) => ui<HTMLSelectElement>(id);
const button = (id: string) => ui<HTMLButtonElement>(id);
const number = (id: string) => field(id).valueAsNumber;
const checked = (id: string) => field(id).checked;
const stepSeconds = 1 / 30;

type Context = { adapter: ModelAdapter; state: WorkingState; object: string; revision: number };
type Choice = { id: string; label: string; motion?: Motion; clip?: AnimationClip; original?: number; blocked?: string };
type Playback = { clip: AnimationClip; comparison?: AnimationClip; original?: number; rootMotion: boolean };
export type FrozenDiagnostic = { adapter: ModelAdapter; clip: AnimationClip; time: number; name: string };

interface Actions {
  apply(revision: number, patch: Partial<Pick<WorkingState, 'humanoid' | 'poses'>>, label: string): Promise<boolean>;
  freeze(frame: FrozenDiagnostic): void;
}

export function humanoidRig(adapter: ModelAdapter, state: WorkingState) {
  return { session: adapter.rig, joints: state.rig?.joints ?? adapter.rig.original.joints, basis: state.rig?.basis ?? '' };
}

export function diagnosticExports(adapter: ModelAdapter, state: WorkingState) {
  const published = state.humanoid?.published;
  if (!published?.length) return [];
  return publishedClips(humanoidRig(adapter, state), published, adapter.model.scene.animations.map(clip => clip.name));
}

export class HumanoidTool {
  #context?: Context;
  #owner?: ModelAdapter;
  #profile?: HumanoidProfile;
  #rig?: HumanoidRig;
  #choices: Choice[] = [];
  #playback?: Playback;
  #choice = '';
  #preset = '';
  #time = 0;
  #request = 0;
  #last = 0;
  #locked = false;
  #active = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x58dddf, depthTest: false }));
  #other = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xffa158, depthTest: false }));
  #edges: [Joint, Joint][] = [];
  #heatmap?: BufferGeometry;
  #heatMaterial = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false });

  constructor(readonly viewer: Viewer, readonly actions: Actions) {
    this.#active.frustumCulled = this.#other.frustumCulled = false;
    this.#active.renderOrder = this.#other.renderOrder = 11;
    this.#active.visible = this.#other.visible = false;
    viewer.scene.add(this.#active, this.#other);
    ui('group').onchange = () => void this.#store(emptyProfile(select('group').value), 'Select humanoid rig');
    ui('suggest').onclick = () => void this.#suggest();
    field('reverse').onchange = () => void this.#store({ ...this.#profile!, reverseForward: checked('reverse') }, 'Set anatomical forward direction');
    ui('calibrate').onclick = () => void this.#calibrate(false);
    ui('capture').onclick = () => void this.#calibrate(true);
    select('axis-role').onchange = () => this.#axisFields();
    ui('save-axes').onclick = () => void this.#axes();
    ui('save-offsets').onclick = () => void this.#offsets();
    select('clip').onchange = () => this.#pickClip(select('clip').value);
    select('preset').onchange = () => { this.#stop(); this.#preset = select('preset').value; this.#render(); };
    ui('base').onclick = () => { this.#stop(); this.#preset = `preset-${presets[0]}`; this.#time = 0; this.#render(); };
    ui('play').onclick = () => this.#request ? this.#stop() : this.#play();
    ui('step-back').onclick = () => this.#step(-1);
    ui('step-forward').onclick = () => this.#step(1);
    field('scrub').oninput = () => { this.#stop(); this.#preset = ''; this.#time = number('scrub'); this.#render(); };
    for (const id of ['range', 'in', 'out']) ui(id).onchange = () => {
      try { this.#time = this.#clamp(this.#time); this.#render(); }
      catch (error) { this.#say(error); }
    };
    for (const id of ['root', 'corrected']) field(id).onchange = () => { this.#prepare(); this.#render(); };
    for (const id of ['overlay', 'compare']) field(id).onchange = () => this.#render();
    select('display').onchange = () => { this.#display(); this.#render(); };
    select('heat-joint').onchange = () => { this.#display(); this.#render(); };
    ui('freeze').onclick = () => this.#freeze();
    ui('save-pose').onclick = () => void this.#savePose();
    ui('publish').onclick = () => void this.#publish();
    ui('remove').onclick = () => void this.#remove();
  }

  configure(context: Context | undefined, locked: boolean) {
    const previous = this.#context;
    this.#context = context;
    this.#locked = locked;
    ui<HTMLFieldSetElement>('tools').disabled = locked;
    ui('tools').hidden = !context;
    if (!context) {
      if (previous) {
        this.#stop();
        this.viewer.onPoseRender = undefined;
        this.viewer.previewUnlit(false);
        this.#clearHeatmap();
        this.#clearLines();
        this.#edges = [];
        this.viewer.manualPose();
        this.viewer.freeze();
        this.#rig = this.#playback = undefined;
      }
      return;
    }
    if (locked) this.#stop();
    if (this.#owner !== context.adapter) this.#reset(context.adapter);
    if (previous?.revision !== context.revision || previous.adapter !== context.adapter || !this.#rig) this.#refresh();
    else if (previous.object !== context.object) { this.#heatChoices(); this.#display(); this.#render(); }
  }

  reset() {
    this.configure(undefined, false);
    this.#owner = this.#profile = undefined;
    this.#choices = [];
  }

  #reset(adapter: ModelAdapter) {
    this.#owner = adapter;
    this.#choice = this.#preset = '';
    this.#time = 0;
    field('root').checked = field('compare').checked = field('range').checked = false;
    field('in').value = field('out').value = '0';
  }

  #refresh() {
    const context = this.#context!, inputs = humanoidRig(context.adapter, context.state);
    const groups = [...new Set(inputs.joints.map(joint => joint.group))];
    this.#profile = context.state.humanoid?.profile ?? emptyProfile(groups[0]);
    try {
      this.#rig = new HumanoidRig(inputs, this.#profile);
      this.#mapping();
      this.#choices = motions.map(motion => {
        const check = suitability(motion, this.#rig!.status.mapping);
        const label = motion.name + (check.ready ? this.#rig!.status.complete ? '' : ' · partial' : ' · unavailable');
        const blocked = check.ready ? undefined : `Requires ${[...check.missing.map(roleLabel), ...(check.armMissing ? ['one complete arm'] : [])].join(', ')}.`;
        return { id: motion.id, label, motion, blocked };
      });
      for (const [i, item] of context.adapter.rig.clips.entries()) {
        if (item.clip) this.#choices.push({ id: `import-${i}`, label: item.clip.name, clip: item.clip,
          original: item.setting.mode === 'adapted' ? i : undefined });
      }
      select('clip').replaceChildren(new Option('Choose a clip', ''), ...this.#choices.map(choice => {
        const item = new Option(choice.label, choice.id);
        item.disabled = !!choice.blocked;
        item.title = choice.blocked ?? '';
        item.dataset.kind = choice.motion ? 'built-in' : 'imported';
        return item;
      }));
      if (!this.#choices.some(choice => choice.id === this.#choice && !choice.blocked)) this.#choice = '';
      select('clip').value = this.#choice;
      const saved = context.state.poses?.saved ?? [];
      select('preset').replaceChildren(new Option('Choose a pose', ''), ...presets.map(pose => {
        const item = new Option(pose, `preset-${pose}`);
        item.disabled = !this.#canPreset(pose);
        return item;
      }), ...saved.map(pose => new Option(pose.name, `saved-${pose.id}`)));
      if (![...select('preset').options].some(item => item.value === this.#preset && !item.disabled)) this.#preset = '';
      const prior = select('published').value;
      select('published').replaceChildren(...(context.state.humanoid?.published ?? []).map(item =>
        new Option(item.name + (item.basis === inputs.basis ? '' : ' · stale'), item.name)));
      if ([...select('published').options].some(option => option.value === prior)) select('published').value = prior;
      this.#edges = this.#rig.group.flatMap(joint => {
        const parent = this.#rig!.group.find(bone => bone.id === joint.parent);
        return parent ? [[parent, joint]] : [];
      });
      this.#clearLines();
      this.#active.geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(this.#edges.length * 6), 3));
      this.#other.geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(this.#edges.length * 6), 3));
      this.#heatChoices();
      this.#display();
      this.#prepare();
      if (this.#playback && !Number(field('out').value)) field('out').value = String(this.#playback.clip.duration);
      this.#render();
    } catch (error) { this.#say(error); }
  }

  #mapping() {
    const rig = this.#rig!, profile = this.#profile!, inputs = rig.rig;
    const groups = [...new Set(inputs.joints.map(joint => joint.group))];
    select('group').replaceChildren(...groups.map(id => new Option(inputs.joints.find(joint => joint.id === id)?.name || id, id)));
    select('group').value = profile.group;
    field('reverse').checked = profile.reverseForward;
    const suggestion = suggestRoles(profile.group, inputs.joints);
    const status = checkMapping(profile, inputs.joints);
    const body = ui('roles');
    body.replaceChildren(...roles.map(role => {
      const row = document.createElement('tr'), name = document.createElement('label'), picker = document.createElement('select');
      picker.id = `diag-map-${role}`;
      name.htmlFor = picker.id;
      name.textContent = roleLabel(role);
      picker.add(new Option('Unassigned', ''));
      for (const joint of rig.group) picker.add(new Option(`${joint.name || joint.id} · ${joint.id}`, joint.id));
      const selected = profile.mapping[role];
      if (selected && !rig.group.some(joint => joint.id === selected)) picker.add(new Option(`Missing ${selected}`, selected));
      picker.value = selected ?? '';
      picker.onchange = () => {
        const mapping = { ...this.#profile!.mapping };
        if (picker.value) mapping[role] = picker.value;
        else delete mapping[role];
        void this.#store({ ...this.#profile!, mapping }, 'Assign humanoid role');
      };
      const label = suggestion.mapping[role] && (!selected || suggestion.mapping[role] === selected) ?
        `${Math.round(suggestion.confidence[role]! * 100)}% suggested match` : '';
      row.insertCell().append(name);
      row.insertCell().append(picker);
      row.insertCell().textContent = [status.issues[role], label].filter(Boolean).join(' · ');
      return row;
    }));
    const count = motions.filter(motion => suitability(motion, status.mapping).ready).length;
    ui('map-summary').textContent = status.complete ? 'Complete humanoid · 10 of 10 diagnostic clips available.' :
      `Partial check · ${count} of 10 diagnostic clips available. Resolve missing, duplicate, or misparented roles to run the full set.`;
    const selection = select('axis-role'), before = selection.value;
    selection.replaceChildren(...roles.filter(role => status.mapping[role]).map(role => new Option(roleLabel(role), role)));
    if ([...selection.options].some(item => item.value === before)) selection.value = before;
    this.#axisFields();
    const correction = profile.corrections;
    field('arm-offset').value = String(correction.armAbduction);
    field('leg-offset').value = String(correction.legSpacing);
    ['x', 'y', 'z'].forEach((axis, i) => { field(`hip-${axis}`).value = String(correction.pelvis[i]); });
    const calibration = profile.calibration;
    if (calibration) select('reference').value = calibration.kind;
    ui('calibration-state').textContent = calibration ? rig.calibrationCurrent ? `${calibration.kind}-pose reference is active.` :
      'The rig or role assignments changed. Recalibrate the reference.' : 'Reference uses working rest. Align or capture a T/A-pose to calibrate.';
    button('save-axes').disabled = !selection.value;
  }

  #axisFields() {
    const axis = this.#profile?.axes[select('axis-role').value as Role] ?? [0, 0, 0];
    ['x', 'y', 'z'].forEach((key, i) => { field(`axis-${key}`).value = String(axis[i]); });
  }

  #canPreset(pose: Preset) {
    const mapping = this.#rig!.status.mapping;
    const arms = !!(mapping.leftUpperArm && mapping.leftForearm || mapping.rightUpperArm && mapping.rightForearm);
    switch (pose) {
      case 'Working base pose': return true;
      case 'T-Pose': case 'A-Pose': case 'Arms Up': case 'Elbows Bent to 90°': return arms;
      case 'Squat': case 'Wide Stance': return suitability(motions.find(motion => motion.id === 'squat')!, mapping).ready;
      case 'Knee Raised': return !!(mapping.leftThigh && mapping.leftShin && mapping.leftFoot);
      case 'Torso Bend': return !!(mapping.spine && mapping.chest);
    }
  }

  async #suggest() {
    const profile = this.#profile!, mapping = suggestRoles(profile.group, this.#rig!.group).mapping;
    await this.#store({ ...profile, mapping }, 'Apply suggested humanoid roles');
  }

  async #axes() {
    try {
      const profile = this.#profile!, role = select('axis-role').value as Role;
      if (!roles.includes(role)) throw new Error('Choose a mapped role.');
      const xyz = ['x', 'y', 'z'].map(axis => bounded(`axis-${axis}`, 180)) as unknown as Vec3;
      await this.#store({ ...profile, axes: { ...profile.axes, [role]: xyz } }, 'Calibrate anatomical axes');
    } catch (error) { this.#say(error); }
  }

  async #offsets() {
    try {
      const corrections = { armAbduction: bounded('arm-offset', 180), legSpacing: bounded('leg-offset', 180),
        pelvis: ['x', 'y', 'z'].map(axis => bounded(`hip-${axis}`, Number.MAX_SAFE_INTEGER)) as unknown as Vec3 };
      await this.#store({ ...this.#profile!, corrections }, 'Save character offsets');
    } catch (error) { this.#say(error); }
  }

  async #calibrate(capture: boolean) {
    try {
      const rig = this.#rig!, profile = this.#profile!, kind = select('reference').value as 'T' | 'A';
      if (!this.#canPreset(kind === 'T' ? 'T-Pose' : 'A-Pose')) throw new Error('Map at least one upper arm and forearm before calibration.');
      const rotations = capture ? Object.fromEntries(Object.entries(this.#context!.state.poses?.current ?? {})
        .filter(([id]) => rig.group.some(joint => joint.id === id))) : rig.calibration(kind);
      await this.#store({ ...profile, calibration: { kind, rotations, basis: rig.rig.basis, mapping: mappingKey(profile.mapping) } },
        `Save ${kind}-pose calibration`);
    } catch (error) { this.#say(error); }
  }

  #store(profile: HumanoidProfile, label: string) {
    const { revision, state } = this.#context!;
    return this.actions.apply(revision, { humanoid: { profile, published: state.humanoid?.published ?? [] } }, label);
  }

  #pickClip(id: string) {
    this.#stop();
    this.#choice = id;
    this.#preset = '';
    this.#time = 0;
    this.#prepare();
    field('range').checked = false;
    field('in').value = '0';
    field('out').value = String(this.#playback?.clip.duration ?? 0);
    field('publish-name').value = '';
    this.#render();
  }

  #prepare() {
    this.#playback = undefined;
    const rig = this.#rig, choice = this.#choices.find(item => item.id === this.#choice), corrected = checked('corrected');
    if (!choice || !rig || choice.blocked) return;
    try {
      if (choice.motion) {
        const motion = choice.motion, root = !!motion.rootMotion;
        const clip = rig.clip(motion, motion.name, corrected, root && checked('root'));
        this.#playback = { clip, rootMotion: root, comparison: corrected && hasCorrections(rig.profile) ?
          rig.clip(motion, `${motion.name} baseline`, false, root && checked('root')) : undefined };
      } else if (choice.clip) {
        const { clip, rootMotion } = inPlaceClip(choice.clip, rig);
        this.#playback = { clip: checked('root') ? choice.clip : clip, rootMotion, original: choice.original };
      }
    } catch (error) { this.#say(error); }
  }

  #range() {
    const duration = this.#playback?.clip.duration ?? 0;
    if (!checked('range')) return [0, duration] as const;
    const start = number('in'), end = number('out');
    if (!(start >= 0 && end <= duration + 1e-8 && end > start)) throw new Error('Choose a repeat range inside the clip.');
    return [start, Math.min(end, duration)] as const;
  }

  #clamp(time: number) {
    const [start, end] = this.#range();
    return Math.max(start, Math.min(time, end));
  }

  #step(direction: number) {
    this.#stop();
    this.#preset = '';
    try { this.#time = this.#clamp(this.#time + direction * stepSeconds); this.#render(); }
    catch (error) { this.#say(error); }
  }

  #play() {
    if (this.#locked || !this.#playback) return;
    try {
      const [start, end] = this.#range();
      if (!(end > start)) throw new Error('Select a clip with a playback range.');
      this.#preset = '';
      if (this.#time < start || this.#time >= end) this.#time = start;
      this.#last = performance.now();
      this.#request = requestAnimationFrame(this.#tick);
      this.#render();
    } catch (error) { this.#say(error); }
  }

  #tick = (now: number) => {
    if (!this.#context || this.#locked || !this.#request) return;
    try {
      const [start, end] = this.#range();
      const selector = select('speed').value;
      const scale = selector === 'custom' ? number('speed-custom') : Number(selector);
      if (!(scale >= .05 && scale <= 4)) throw new Error('Playback speed must be between 0.05× and 4×.');
      this.#time += Math.min(.1, Math.max(0, (now - this.#last) / 1000)) * scale;
      this.#last = now;
      if (this.#time > end) {
        if (checked('range') || checked('loop')) this.#time = start + (this.#time - start) % (end - start);
        else { this.#time = end; this.#stop(); }
      }
      if (this.#request) this.#request = requestAnimationFrame(this.#tick);
      this.#render();
    } catch (error) { this.#stop(); this.#say(error); }
  };

  #stop() {
    if (this.#request) cancelAnimationFrame(this.#request);
    this.#request = 0;
    button('play').textContent = 'Play';
    button('play').setAttribute('aria-pressed', 'false');
  }

  #snapshot() {
    const { state } = this.#context!, rig = this.#rig!;
    if (this.#preset.startsWith('saved-')) {
      const pose = state.poses?.saved.find(item => item.id === this.#preset.slice(6));
      return { rotations: pose?.rotations ?? {}, translations: pose?.translations ?? {} };
    }
    const preset = this.#preset ? this.#preset.slice(7) as Preset : presets[0];
    return rig.preset(preset, checked('corrected'));
  }

  #render() {
    const context = this.#context, rig = this.#rig;
    if (!context || !rig) return;
    const active = !this.#preset && this.#playback, duration = this.#playback?.clip.duration ?? 0;
    this.#time = Math.min(Math.max(this.#time, 0), duration);
    field('scrub').max = String(duration);
    field('scrub').value = String(this.#time);
    ui('time').textContent = `${this.#time.toFixed(3)} s`;
    select('preset').value = this.#preset;
    button('play').disabled = button('step-back').disabled = button('step-forward').disabled = field('scrub').disabled = !this.#playback;
    button('freeze').disabled = !active || ![...context.adapter.objects.values()].some(node => node instanceof SkinnedMesh);
    field('root').disabled = !this.#playback?.rootMotion;
    field('compare').disabled = !(active && (active.comparison || active.original !== undefined));
    button('publish').disabled = !this.#choices.find(choice => choice.id === this.#choice)?.motion || !active;
    button('remove').disabled = !context.state.humanoid?.published.length;
    button('play').textContent = this.#request ? 'Pause' : 'Play';
    button('play').setAttribute('aria-pressed', String(!!this.#request));
    this.#active.visible = checked('overlay');
    this.#other.visible = !!(active && checked('compare') && (active.comparison || active.original !== undefined));
    if (this.#other.visible && active) {
      if (active.original !== undefined) this.#writeLines(this.#other, context.adapter.rig.comparison(active.original, this.#time));
      else this.viewer.samplePose(active.comparison!, this.#time, () => this.#writeLines(this.#other));
    }
    this.viewer.onPoseRender = () => { if (this.#active.visible) this.#writeLines(this.#active); };
    if (active) {
      this.viewer.manualPose();
      this.viewer.freeze(active.clip, this.#time);
    } else {
      const pose = this.#snapshot();
      this.viewer.manualPose(() => context.adapter.rig.applyPose(pose.rotations, pose.translations));
      this.viewer.freeze();
    }
    const choice = this.#choices.find(item => item.id === this.#choice);
    const corrected = checked('corrected') && hasCorrections(rig.profile) && (this.#preset ? this.#preset.startsWith('preset-') &&
      !presets.slice(0, 4).some(pose => this.#preset === `preset-${pose}`) : !!choice?.motion);
    this.#say(`${this.#preset ? select('preset').selectedOptions[0]?.text : choice?.label ?? 'Working rest'} · ` +
      `${corrected ? 'Character offsets active' : 'Character offsets off'}` + (active && active.rootMotion ? checked('root') ? ' · Root motion' : ' · In-place' : '') + '.');
  }

  #clearLines() {
    for (const line of [this.#active, this.#other]) {
      line.visible = false;
      line.geometry.dispose();
      line.geometry = new BufferGeometry();
    }
  }

  #writeLines(line: LineSegments, points?: ReadonlyMap<string, Vector3>) {
    const position = line.geometry.getAttribute('position'), point = new Vector3(), session = this.#context!.adapter.rig;
    for (const [i, edge] of this.#edges.entries()) for (const [k, joint] of edge.entries()) {
      const node = session.bone(joint.id);
      const value = points ? points.get(joint.id) : node?.getWorldPosition(point);
      if (value) position.setXYZ(i * 2 + k, value.x, value.y, value.z);
      else position.setXYZ(i * 2 + k, 0, 0, 0);
    }
    position.needsUpdate = true;
  }

  #heatChoices() {
    const ctx = this.#context!, candidate = ctx.adapter.objects.get(ctx.object);
    const mesh = candidate instanceof SkinnedMesh ? candidate : [...ctx.adapter.objects.values()].find(node => node instanceof SkinnedMesh) as SkinnedMesh | undefined;
    const current = select('heat-joint').value;
    const ids = mesh ? ctx.adapter.rig.palette(mesh) : [];
    select('heat-joint').replaceChildren(...ids.flatMap(id => id ? [new Option(ctx.adapter.rig.bone(id)?.name || id, id)] : []));
    if (ids.includes(current)) select('heat-joint').value = current;
  }

  #clearHeatmap() {
    this.viewer.skinView();
    this.#heatmap?.dispose();
    this.#heatmap = undefined;
  }

  #display() {
    this.#clearHeatmap();
    const mode = select('display').value, ctx = this.#context!;
    this.viewer.previewUnlit(mode === 'unlit');
    select('heat-joint').disabled = mode !== 'heatmap';
    if (mode !== 'heatmap') return;
    const entries = [...ctx.adapter.objects];
    const pair = entries.find(([id, node]) => id === ctx.object && node instanceof SkinnedMesh) ?? entries.find(([, node]) => node instanceof SkinnedMesh);
    if (!pair) return;
    try {
      const [id, node] = pair, mesh = node as SkinnedMesh, influence = select('heat-joint').value;
      const palette = new Set(ctx.adapter.rig.palette(mesh).filter((item): item is string => !!item));
      const { rows } = readProfile(ctx.adapter.mesh.data(id), palette, ctx.state.rig?.transfers);
      const geometry = this.#heatmap = mesh.geometry.clone();
      const colors = new Float32Array(geometry.getAttribute('position').count * 3);
      const cold = new Color(0x243d8b), hot = new Color(0xe24933), color = new Color();
      for (const [draw, vertex] of drawVertices(ctx.adapter, id, mesh)) color.copy(cold)
        .lerp(hot, Math.min(1, weightOf(rows.get(vertex) ?? [], influence))).toArray(colors, draw * 3);
      geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
      this.viewer.skinView({ mesh, geometry, material: this.#heatMaterial });
    } catch (error) { this.#say(error); }
  }

  #freeze() {
    if (!this.#context || !this.#playback || this.#preset) return;
    this.#stop();
    this.actions.freeze({ adapter: this.#context.adapter, clip: this.#playback.clip, time: this.#time, name: this.#playback.clip.name });
  }

  async #savePose() {
    try {
      this.#stop();
      const { revision, state, adapter } = this.#context!, poses = state.poses ?? emptyPose;
      const name = field('pose-name').value.trim();
      if (!name || name.length > 120 || poses.saved.some(pose => pose.name === name)) throw new Error('Enter a unique saved pose name.');
      if (poses.saved.length >= 128) throw new Error('The project holds up to 128 saved poses.');
      const captured = this.viewer.withPose(() => adapter.rig.capturePose(this.#rig!.group));
      const next: PoseState = { ...poses, saved: [...poses.saved, { id: crypto.randomUUID(), name, ...captured }] };
      await this.actions.apply(revision, { poses: next }, 'Save diagnostic pose');
    } catch (error) { this.#say(error); }
  }

  async #publish() {
    try {
      const { state, revision, adapter } = this.#context!, rig = this.#rig!;
      const motion = this.#choices.find(item => item.id === this.#choice)?.motion;
      if (!motion || this.#preset || !this.#playback) throw new Error('Select a supported built-in diagnostic clip.');
      const corrected = checked('corrected') && hasCorrections(rig.profile);
      const name = field('publish-name').value.trim() || `Diagnostic_${motion.id}_${corrected ? 'Corrected' : 'Baseline'}`;
      if (!/^[\p{L}\p{N}_ -]{1,120}$/u.test(name)) throw new Error('Use a distinct clip name with letters, numbers, spaces, underscores or hyphens.');
      const before = state.humanoid?.published ?? [];
      if (before.length >= 24) throw new Error('The project holds up to 24 published clips.');
      const item: PublishedMotion = { name, motion: motion.id, basis: rig.rig.basis, profile: rig.profile, corrected, rootMotion: !!motion.rootMotion && checked('root') };
      const published = [...before, item];
      const taken = new Set([...adapter.rig.originalClips.map(entry => entry.clip.name), ...adapter.model.scene.animations.map(clip => clip.name),
        ...before.map(entry => entry.name)]);
      if (taken.has(name)) throw new Error('This clip name is already in use.');
      await this.actions.apply(revision, { humanoid: { profile: rig.profile, published } }, 'Publish diagnostic clip');
    } catch (error) { this.#say(error); }
  }

  async #remove() {
    const { state, revision } = this.#context!, humanoid = state.humanoid as HumanoidState | undefined;
    if (!humanoid) return;
    const name = select('published').value;
    await this.actions.apply(revision, { humanoid: { ...humanoid, published: humanoid.published.filter(item => item.name !== name) } }, 'Remove published clip');
  }

  #say(value: unknown) {
    const text = value instanceof Error ? value.message : String(value), info = ui('info');
    if (info.textContent !== text) info.textContent = text;
  }
}

function bounded(id: string, limit: number) {
  const value = number(id);
  if (!Number.isFinite(value) || Math.abs(value) > limit) throw new Error(`Enter a valid value for ${id.replaceAll('-', ' ')}.`);
  return value;
}
