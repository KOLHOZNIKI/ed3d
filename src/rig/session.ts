import { AnimationMixer, Bone, Group, Matrix4, Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';
import type { SceneEntry } from '../project/document';
import type { Model } from '../project/adapter';
import { matrixDelta, rebindMesh } from './bindings';
import { captureClips, forGhost, makeClips, type ClipResult } from './clips';
import type { Joint, Pose, PoseState, PoseTranslations, Quat, RigAction, RigClip, RigState } from './state';
import type { MeshData, Vec3 } from '../mesh/data';
import type { MeshEdit } from '../mesh/commands';
import { changeRig, jointName, pack, unpack, worldMatrices } from './transforms';

type NodeSnapshot = { node: Object3D; parent: string | null; index: number; local: Matrix4; world: Matrix4; name: string };

export class RigSession {
  readonly originalClips;
  readonly original: RigState;
  #raw = new Map<string, NodeSnapshot>();
  #source = new Map<string, Joint>();
  #rest = new Map<string, Joint>();
  #rebound = new Set<string>();
  #ids = new Map<Object3D, string>();
  #nodes = new Map<string, Bone>();
  #bindings: (() => void)[] = [];
  #touched: string[] = [];
  #clips: ClipResult[];
  #error?: string;
  #ghost?: { root: Group; nodes: Map<string, Object3D> };

  constructor(readonly model: Model, entries: readonly SceneEntry[], readonly objects: ReadonlyMap<string, Object3D>) {
    const root = model.scene;
    root.updateMatrixWorld(true);
    for (const { id, parent } of entries) {
      const node = objects.get(id)!;
      this.#ids.set(node, id);
      this.#raw.set(id, { node, parent, name: node.name, index: node.parent?.children.indexOf(node) ?? 0,
        local: node.matrix.clone(), world: node.matrixWorld.clone() });
      if (node instanceof Bone) this.#nodes.set(id, node);
    }
    const binds = new Map<string, Matrix4>();
    for (const node of objects.values()) if (node instanceof SkinnedMesh) {
      for (const [i, bone] of node.skeleton.bones.entries()) {
        const id = this.#ids.get(bone), inverse = node.skeleton.boneInverses[i];
        if (!id || !inverse || Math.abs(inverse.determinant()) < 1e-12) {
          this.#error = 'A skin has an unresolved joint or a singular inverse bind.';
          continue;
        }
        const world = inverse.clone().invert(), prior = binds.get(id);
        // glTF stores inverse(joint world) * mesh world. The FBX loader already supplies inverse joint worlds.
        if (model.format === 'glb') world.premultiply(node.matrixWorld);
        if (prior && matrixDelta(prior, world) > 1e-5) this.#error = 'The skinned meshes disagree on the shared rest transforms.';
        else binds.set(id, world);
      }
    }
    for (const [id, bone] of this.#nodes) {
      const raw = this.#raw.get(id)!;
      let group = id;
      for (let parent = bone.parent; parent instanceof Bone; parent = parent.parent) group = this.#ids.get(parent) ?? group;
      const parent = binds.get(raw.parent ?? '') ?? this.anchor(raw.parent);
      const world = binds.get(id) ?? raw.world;
      let transform;
      // Float32 inverse bind matrices can introduce small non-orthogonal terms during inversion.
      try { transform = unpack(parent.clone().invert().multiply(world), model.format === 'glb' ? 5e-6 : undefined); }
      catch {
        this.#error = 'The imported rest transforms require shear or contain a singular joint.';
        transform = { position: bone.position.toArray(), rotation: bone.quaternion.toArray(), scale: bone.scale.toArray() };
      }
      this.#source.set(id, { id, group, parent: raw.parent, name: raw.name, ...transform });
    }
    this.original = { joints: [...this.#source.values()], transfers: {}, basis: '', rebind: [], clips: {} };
    this.#rest = this.#source;
    this.originalClips = captureClips(root, this.#ids);
    this.#clips = makeClips(this.originalClips, this.#source, this.original, new Set());
  }

  get available() { return this.#source.size > 0; }
  get blocked() { return this.#error; }
  get clips() { return this.#clips; }
  bone(id: string) { return this.#nodes.get(id); }
  palette(mesh: SkinnedMesh) {
    const ids = new Map([...this.#nodes].map(([id, bone]) => [bone, id]));
    return mesh.skeleton.bones.map(bone => ids.get(bone));
  }
  restRotation(id: string) {
    const bone = this.#nodes.get(id);
    return bone && (this.#error ? bone.quaternion.clone() : new Quaternion(...this.#rest.get(id)!.rotation));
  }
  affectedMeshes(joint: Joint) {
    let count = 0;
    this.model.scene.traverse(node => {
      if (node instanceof SkinnedMesh && node.skeleton.bones.some(bone => {
        const id = this.#ids.get(bone);
        return id && this.#source.get(id)?.group === joint.group || bone === this.#nodes.get(joint.id);
      })) count++;
    });
    return count;
  }

  anchor = (id: string | null) => {
    if (id === null) return this.model.scene.matrixWorld;
    const raw = this.#raw.get(id);
    if (!raw) throw new Error('The rig refers to an unknown parent.');
    return raw.world;
  };

  change(current: RigState | undefined, action: RigAction) {
    if (action.type !== 'rename' && this.#error) throw new Error(this.#error);
    const previous = current ?? this.original;
    const next = changeRig(previous, action, this.anchor);
    this.#validate(next);
    if (action.type === 'rebind') {
      const group = next.joints.find(joint => joint.id === action.joint)!.group;
      if (this.#changed(next).has(group) && !this.#changed(previous).has(group)) return { ...next, basis: crypto.randomUUID() };
    }
    return next;
  }

  withClip(current: RigState | undefined, id: number, mode: RigClip['mode'], offsets?: Pose, translationOffsets?: PoseTranslations): RigState {
    const state = current ?? this.original;
    const original = this.originalClips[id];
    if (!original) throw new Error('Select an original clip.');
    let name = `${original.clip.name.slice(0, 120)}_Adapted_${id + 1}`;
    const taken = new Set(this.originalClips.map(({ clip }) => clip.name));
    while (taken.has(name)) name += '_';
    const setting: RigClip = mode === 'adapted' ? { mode, name, basis: state.basis, offsets, translationOffsets } : { mode };
    const next = { ...state, clips: { ...state.clips, [id]: setting } };
    const changed = this.#changed(next);
    const reason = makeClips(this.originalClips, this.#source, next, changed, this.#anchors(changed))[id].reason;
    if (mode === 'adapted' && reason) throw new Error(reason);
    return next;
  }

  bakePose(current: RigState | undefined, pose: PoseState, dataFor: (object: string) => MeshData, signal?: AbortSignal) {
    if (this.#error) throw new Error(this.#error);
    const prior = current ?? this.original, jointsById = new Map(prior.joints.map(joint => [joint.id, joint]));
    const poseIds = [...Object.keys(pose.current), ...Object.keys(pose.translations ?? {})];
    if (poseIds.some(id => !jointsById.has(id))) throw new Error('The manual pose refers to a missing joint. Reset or repair the pose before baking.');
    const changed = new Map<string, { before: Joint; after: Joint }>();
    const groups = new Set<string>();
    const joints = prior.joints.map(before => {
      const q = pose.current[before.id], shift = pose.translations?.[before.id];
      if (!q && !shift) return before;
      const previous = new Quaternion(...before.rotation), rotation = previous.clone();
      if (q) rotation.multiply(new Quaternion(...q)).normalize();
      if (1 - Math.abs(rotation.dot(previous)) <= 1e-12 && (!shift || new Vector3(...shift).lengthSq() <= 1e-16)) return before;
      const after: Joint = { ...before, rotation: rotation.toArray(),
        position: new Vector3(...before.position).add(new Vector3(...shift ?? [0, 0, 0])).toArray() };
      changed.set(before.id, { before, after });
      groups.add(before.group);
      return after;
    });
    if (!groups.size) throw new Error('Pose the working rig before baking the base pose.');
    const rig: RigState = { ...prior, joints, basis: crypto.randomUUID(), rebind: [...new Set([...prior.rebind, ...groups])],
      bakedGroups: [...new Set([...prior.bakedGroups ?? [], ...groups])] };
    this.#validate(rig);
    const edits: MeshEdit[] = [], bound = new Set<string>();
    const restore = this.applyPose(pose.current, pose.translations);
    try {
      for (const [object, node] of this.objects) {
        signal?.throwIfAborted();
        if (!(node instanceof SkinnedMesh)) continue;
        const palette = this.palette(node);
        const active = palette.flatMap(id => {
          const joint = id && jointsById.get(id);
          return joint && groups.has(joint.group) ? [joint.group] : [];
        });
        if (!active.length) continue;
        if (palette.some(id => id === undefined)) throw new Error('A shared mesh has an unresolved joint.');
        for (const group of active) bound.add(group);
        const rows = dataFor(object), indices = new Map(palette.map((id, i) => [id, i]));
        if (!rows.weightJoints || !rows.weights) throw new Error('A shared mesh has no editable skin palette.');
        const transforms = rows.weightJoints.map(joint => {
          const slot = indices.get(prior.transfers[joint] ?? joint);
          if (slot === undefined) throw new Error('A shared mesh has a missing skin influence.');
          const matrix = node.bindMatrixInverse.clone().multiply(node.skeleton.bones[slot].matrixWorld)
            .multiply(node.skeleton.boneInverses[slot]).multiply(node.bindMatrix);
          return { joint, values: matrix.toArray() };
        });
        edits.push({ object, type: 'bakeBase', transforms });
      }
    } finally { restore(); }
    if (bound.size !== groups.size) throw new Error('Every posed rig group needs at least one bound mesh.');
    // Saved poses keep their old absolute joint transforms under the new base.
    const saved = pose.saved.map(item => {
      const rotations = { ...item.rotations }, translations = { ...item.translations };
      for (const [id, { before, after }] of changed) {
        const q = new Quaternion(...after.rotation).invert().multiply(new Quaternion(...before.rotation))
          .multiply(new Quaternion(...rotations[id] ?? [0, 0, 0, 1])).normalize();
        const move = new Vector3(...before.position).add(new Vector3(...translations[id] ?? [0, 0, 0])).sub(new Vector3(...after.position));
        if (1 - Math.abs(q.w) > 1e-12) rotations[id] = q.toArray();
        else delete rotations[id];
        if (move.lengthSq() > 1e-16) translations[id] = move.toArray();
        else delete translations[id];
      }
      return { ...item, rotations, translations };
    });
    return { rig, poses: { current: {}, saved }, edits };
  }

  assertExportable() {
    const invalid = this.#clips.filter(clip => clip.reason);
    if (invalid.length) throw new Error(`Clip export blocked. Adapt or explicitly exclude ${invalid.map(({ original }) => original.clip.name).join(', ')}.`);
  }

  restore() {
    this.#rest = this.#source;
    this.#rebound.clear();
    for (const restore of this.#bindings.splice(0)) restore();
    for (const [id, node] of this.#nodes) if (!this.#source.has(id)) node.removeFromParent();
    for (const id of this.#touched.splice(0)) {
      const raw = this.#raw.get(id)!;
      const node = raw.node as Bone;
      const parent = raw.parent ? this.#raw.get(raw.parent)!.node : this.model.scene;
      if (node.parent !== parent) parent.add(node);
      node.name = raw.name;
      raw.local.decompose(node.position, node.quaternion, node.scale);
      node.updateMatrix();
      this.#nodes.set(id, node);
    }
    this.#nodes = new Map([...this.#nodes].filter(([id]) => this.#source.has(id)));
    for (const id of this.#source.keys()) {
      const raw = this.#raw.get(id)!;
      const children = raw.node.parent?.children;
      const i = children?.indexOf(raw.node);
      if (children && i !== undefined && i >= 0 && i !== raw.index) children.splice(raw.index, 0, ...children.splice(i, 1));
    }
    this.model.scene.animations = this.originalClips.map(({ clip }) => clip);
    this.model.scene.updateMatrixWorld(true);
    this.#clips = makeClips(this.originalClips, this.#source, this.original, new Set());
  }

  apply(state?: RigState) {
    if (!state) {
      this.model.scene.traverse(node => {
        if (!(node instanceof SkinnedMesh)) return;
        const written: string[] | undefined = node.geometry.userData.assetFixerJointIds;
        if (written?.some((id, slot) => id !== this.#ids.get(node.skeleton.bones[slot]))) {
          throw new Error('The weight history uses a working joint. Transfer its weights or undo those edits before restoring the original rig.');
        }
      });
      return;
    }
    this.#validate(state);
    const changed = this.#changed(state), affected = new Set([...changed, ...state.rebind]);
    if (affected.size && this.#error) throw new Error(this.#error);
    const working = new Map(state.joints.map(joint => [joint.id, joint]));
    const meshes: { node: SkinnedMesh; ids: (string | undefined)[]; groups: Set<string> }[] = [];
    this.model.scene.traverse(node => {
      if (!(node instanceof SkinnedMesh)) return;
      const imported = node.skeleton.bones.map(bone => this.#ids.get(bone));
      const groups = new Set(imported.flatMap(id => id && this.#source.has(id) ? [this.#source.get(id)!.group] : []));
      const written: string[] | undefined = node.geometry.userData.assetFixerJointIds;
      const ids = written ?? imported;
      if (written?.some(id => {
        const joint = working.get(id) ?? working.get(state.transfers[id]);
        return !joint || !groups.has(joint.group);
      })) throw new Error('A skin weight edit references a joint outside its working rig.');
      if (written?.some((id, i) => id !== imported[i])) for (const group of groups) affected.add(group);
      meshes.push({ node, ids, groups });
    });
    if (affected.size && this.#error) throw new Error(this.#error);
    // Scene attachments need independent space compensation. Keep those rigs intact until that workflow is available.
    for (const joint of this.original.joints) if (affected.has(joint.group)) {
      const node = this.#nodes.get(joint.id)!;
      if (node.children.some(child => !(child instanceof Bone))) {
        throw new Error('This rig has non-bone objects attached to joints. Rest edits would move those attachments.');
      }
    }
    this.#touched = this.original.joints.filter(joint => affected.has(joint.group) ||
      state.joints.find(next => next.id === joint.id)?.name !== joint.name).map(joint => joint.id);
    const next = new Map(this.#nodes);
    for (const joint of state.joints) if (!next.has(joint.id)) next.set(joint.id, new Bone());
    this.#nodes = next;
    try {
      // Detach affected joints first so a valid reordered tree cannot transiently form a cycle.
      for (const { id, group } of this.original.joints) if (affected.has(group)) next.get(id)!.removeFromParent();
      for (const joint of state.joints) {
        const node = next.get(joint.id)!;
        node.name = joint.name;
        if (!affected.has(joint.group)) continue;
        const parent = joint.parent ? next.get(joint.parent) ?? this.#raw.get(joint.parent)?.node : this.model.scene;
        parent!.add(node);
        node.position.fromArray(joint.position);
        node.quaternion.fromArray(joint.rotation).normalize();
        node.scale.fromArray(joint.scale);
        node.updateMatrix();
      }
      for (const id of next.keys()) if (!working.has(id)) next.delete(id);
      this.model.scene.updateMatrixWorld(true);
      for (const { node, ids, groups } of meshes) if ([...groups].some(group => affected.has(group))) {
        if (ids.some(id => id === undefined)) throw new Error('A shared skin has an unresolved joint.');
        this.#bindings.push(rebindMesh(node, this.model.format, ids as string[], state.joints, state, next));
      }
      this.#rest = new Map(state.joints.map(joint => [joint.id, joint]));
      this.#rebound = affected;
      this.#clips = makeClips(this.originalClips, this.#source, state, changed, this.#anchors(changed));
      this.model.scene.animations = this.#clips.flatMap(item => item.clip ? [item.clip] : []);
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  applyPose(pose: Pose, translations?: PoseTranslations): () => void {
    const restore: (() => void)[] = [];
    for (const [id, joint] of this.#rest) {
      const offset = pose[id];
      const move = translations?.[id];
      const useBind = !this.#error && !this.#rebound.has(joint.group);
      if (!useBind && !offset && !move) continue;
      const bone = this.#nodes.get(id)!;
      const position = bone.position.clone(), rotation = bone.quaternion.clone(), scale = bone.scale.clone();
      restore.push(() => { bone.position.copy(position); bone.quaternion.copy(rotation); bone.scale.copy(scale); bone.updateMatrix(); });
      if (useBind) {
        bone.position.fromArray(joint.position);
        bone.quaternion.fromArray(joint.rotation);
        bone.scale.fromArray(joint.scale);
      }
      if (offset) bone.quaternion.multiply(new Quaternion(...offset)).normalize();
      if (move) bone.position.add(new Vector3(...move));
      bone.updateMatrix();
    }
    this.model.scene.updateMatrixWorld(true);
    return () => {
      for (const reset of restore) reset();
      this.model.scene.updateMatrixWorld(true);
    };
  }

  capturePose(joints: readonly Joint[]) {
    const rotations: Record<string, Quat> = {}, translations: Record<string, Vec3> = {};
    for (const joint of joints) {
      const bone = this.#nodes.get(joint.id);
      if (!bone) continue;
      const q = new Quaternion(...joint.rotation).invert().multiply(bone.quaternion).normalize();
      const shift = bone.position.clone().sub(new Vector3(...joint.position));
      if (1 - Math.abs(q.w) > 1e-12) rotations[joint.id] = q.toArray();
      if (shift.lengthSq() > 1e-16) translations[joint.id] = shift.toArray();
    }
    return { rotations, translations };
  }

  comparison(clipIndex?: number, time = 0) {
    if (clipIndex === undefined) {
      const world = worldMatrices(this.original.joints, this.anchor);
      return new Map(this.original.joints.map(joint => [joint.id, new Vector3().setFromMatrixPosition(world(joint.id))]));
    }
    const original = this.originalClips[clipIndex];
    if (!original) return new Map<string, Vector3>();
    if (!this.#ghost) {
      const root = new Group(), nodes = new Map<string, Object3D>();
      for (const [id, snapshot] of this.#raw) {
        const node = new Object3D();
        node.name = snapshot.name;
        snapshot.local.decompose(node.position, node.quaternion, node.scale);
        (snapshot.parent ? nodes.get(snapshot.parent)! : root).add(node);
        nodes.set(id, node);
      }
      this.#ghost = { root, nodes };
    }
    const { root, nodes } = this.#ghost, mixer = new AnimationMixer(root);
    const action = mixer.clipAction(forGhost(original, nodes));
    action.play(); action.paused = true;
    action.time = Math.min(time, original.clip.duration);
    mixer.update(0);
    root.updateMatrixWorld(true);
    const result = new Map(this.original.joints.map(joint => [joint.id, nodes.get(joint.id)!.getWorldPosition(new Vector3())]));
    mixer.stopAllAction();
    return result;
  }

  #anchors(groups: ReadonlySet<string>) {
    const anchors = new Set<string>();
    for (const joint of this.#source.values()) if (groups.has(joint.id)) {
      for (let parent = joint.parent; parent; parent = this.#raw.get(parent)!.parent) anchors.add(parent);
    }
    return anchors;
  }

  #changed(state: RigState) {
    const changed = new Set(state.bakedGroups), after = new Map(state.joints.map(joint => [joint.id, joint]));
    const rebound = new Set(state.rebind);
    for (const joint of state.joints) {
      const original = this.#source.get(joint.id);
      const matrix = pack(joint);
      if (!original || original.parent !== joint.parent || matrixDelta(pack(original), matrix) > 1e-8 ||
          rebound.has(joint.group) && matrixDelta(this.#raw.get(joint.id)!.local, matrix) > 1e-8) changed.add(joint.group);
    }
    for (const joint of this.original.joints) if (!after.has(joint.id)) changed.add(joint.group);
    return changed;
  }

  #validate(state: RigState) {
    const joints = new Map(state.joints.map(joint => [joint.id, joint]));
    if (joints.size !== state.joints.length || state.joints.length > 2048) throw new Error('Invalid joint count or duplicate ID.');
    const groups = new Set(this.original.joints.map(joint => joint.group));
    for (const joint of state.joints) {
      const original = this.#source.get(joint.id);
      const parent = joint.parent ? joints.get(joint.parent) : undefined;
      if (original && original.group !== joint.group || !groups.has(joint.group) ||
          !original && !joint.id.startsWith('joint-') || parent && parent.group !== joint.group ||
          !parent && (!original || original.parent !== joint.parent ||
            joint.parent && this.#source.has(joint.parent))) throw new Error('Invalid joint parent or rig membership.');
      if ((!original || original.name !== joint.name) && (jointName(joint.name) !== joint.name ||
          state.joints.some(other => other.id !== joint.id && other.name === joint.name) ||
          [...this.#raw.values()].some(raw => !(raw.node instanceof Bone) && raw.name === joint.name))) throw new Error('A joint name conflicts with another scene node.');
      unpack(pack(joint));
    }
    for (const [id, target] of Object.entries(state.transfers)) {
      const original = this.#source.get(id), next = joints.get(target);
      if (joints.has(id) || !next || (original ? original.group !== next.group : !id.startsWith('joint-'))) {
        throw new Error('Invalid deleted joint weight destination.');
      }
    }
    for (const joint of this.original.joints) if (!joints.has(joint.id) &&
      (!state.transfers[joint.id] || !joint.parent || !this.#source.has(joint.parent))) throw new Error('An imported joint was removed without a valid weight destination.');
    if (state.rebind.some(group => !groups.has(group)) || state.bakedGroups?.some(group => !groups.has(group) || !state.rebind.includes(group)) ||
        Object.keys(state.clips).some(i => !this.originalClips[Number(i)])) {
      throw new Error('A rig edit refers to an unknown binding or clip.');
    }
    worldMatrices(state.joints, this.anchor);
  }
}
