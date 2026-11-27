import { AnimationClip, Euler, Matrix3, Matrix4, PropertyBinding, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack, type Object3D } from 'three';
import type { Vec3 } from '../mesh/data';
import type { RigSession } from '../rig/session';
import type { Joint, Pose, PoseTranslations, Quat } from '../rig/state';
import { worldMatrices } from '../rig/transforms';
import { motions, sides, suitability, type Frame, type Motion, type Preset } from './motions';
import { checkMapping, mappingKey, type HumanoidProfile, type PublishedMotion, type Role } from './profile';

const deg = Math.PI / 180;
const identity = new Quaternion();
const positionOf = (world: Matrix4) => new Vector3().setFromMatrixPosition(world);
const xyz = (v: Vector3) => v.toArray() as Vec3;

function rotation(world: Matrix4) {
  const q = new Quaternion();
  world.decompose(new Vector3(), q, new Vector3());
  return q.normalize();
}

type Axes = readonly [Vector3, Vector3, Vector3];
type Sample = { rotations: Pose; translations: PoseTranslations };
type Rig = { session: RigSession; joints: readonly Joint[]; basis: string };

export class HumanoidRig {
  readonly status;
  readonly calibrationCurrent;
  readonly group;
  readonly hips?: Joint;
  readonly frame: { right: Vector3; up: Vector3; front: Vector3; length: number };
  #reference: Map<string, Quat>;
  #neutral: Map<string, Quat>;
  #axes = new Map<Role, Axes>();
  #rest: ReadonlyMap<string, Joint>;
  #parentInverse?: Matrix4;

  constructor(readonly rig: Rig, readonly profile: HumanoidProfile) {
    this.status = checkMapping(profile, rig.joints);
    this.group = rig.joints.filter(joint => joint.group === profile.group);
    this.#rest = new Map(this.group.map(joint => [joint.id, joint]));
    const calibration = profile.calibration;
    this.calibrationCurrent = !!calibration && calibration.basis === rig.basis && calibration.mapping === mappingKey(profile.mapping);
    this.#reference = new Map(this.group.map(joint => {
      const offset = this.calibrationCurrent ? calibration?.rotations[joint.id] : undefined;
      return [joint.id, offset ? new Quaternion(...joint.rotation).multiply(new Quaternion(...offset)).normalize().toArray() : joint.rotation];
    }));
    this.hips = this.#bone('hips');
    const world = this.#world(this.#reference);
    const point = (role: Role) => this.#pos(role, world);
    const left = point('leftUpperArm') ?? point('leftThigh'), right = point('rightUpperArm') ?? point('rightThigh');
    const top = point('head') ?? point('neck') ?? point('chest') ?? point('spine'), base = point('hips');
    const up = top && base ? top.clone().sub(base).normalize() : new Vector3(0, 1, 0);
    if (up.lengthSq() < .5) up.set(0, 1, 0);
    const across = left && right ? right.clone().sub(left) : new Vector3(1, 0, 0);
    across.addScaledVector(up, -across.dot(up));
    if (across.lengthSq() < 1e-10) across.set(0, 0, 1).addScaledVector(up, -up.z);
    across.normalize();
    const front = across.clone().cross(up).normalize();
    const feet = new Vector3();
    for (const side of sides) {
      const foot = point(`${side}Foot`), toe = point(`${side}Toes`);
      if (foot && toe) feet.add(toe.sub(foot).normalize());
    }
    // Toe positions resolve the sign of the fitted front axis on either handedness convention.
    if (feet.lengthSq() > .1 && feet.normalize().dot(front) < -.25) front.negate();
    if (profile.reverseForward) front.negate();
    const lengths = sides.flatMap(side => {
      const hip = point(`${side}Thigh`), knee = point(`${side}Shin`), foot = point(`${side}Foot`);
      return hip && knee && foot ? [hip.distanceTo(knee) + knee.distanceTo(foot)] : [];
    });
    const length = lengths.length ? lengths.reduce((sum, n) => sum + n, 0) / lengths.length : top && base ? top.distanceTo(base) : 1;
    this.frame = { right: across, up, front, length: Math.max(1e-4, length) };
    this.#neutral = this.#alignArms(-76);
    const neutralWorld = this.#world(this.#neutral);
    if (this.hips) this.#parentInverse = neutralWorld(this.hips.parent).clone().invert();
    for (const [role, id] of Object.entries(this.status.mapping) as [Role, string][]) this.#axes.set(role, this.#anatomicalAxes(role, id, neutralWorld));
  }

  #bone(role: Role) { return this.#rest.get(this.status.mapping[role] ?? ''); }

  #world(rotations: ReadonlyMap<string, Quat>) {
    return worldMatrices(this.rig.joints.map(joint => rotations.has(joint.id) ? { ...joint, rotation: rotations.get(joint.id)! } : joint), this.rig.session.anchor);
  }

  #pos(role: Role, world: ReturnType<typeof worldMatrices>) {
    const bone = this.#bone(role);
    return bone ? positionOf(world(bone.id)) : undefined;
  }

  #aim(rotations: Map<string, Quat>, role: Role, child: Role, direction: Vector3) {
    const bone = this.#bone(role), end = this.#bone(child);
    if (!bone || !end) return;
    const world = this.#world(rotations), parent = world(bone.parent).clone().invert();
    const start = positionOf(world(bone.id)).applyMatrix4(parent), tip = positionOf(world(end.id)).applyMatrix4(parent);
    const current = tip.sub(start).normalize(), desired = direction.clone().transformDirection(parent);
    if (current.lengthSq() < .5) return;
    const swing = new Quaternion().setFromUnitVectors(current, desired);
    rotations.set(bone.id, swing.multiply(new Quaternion(...rotations.get(bone.id)!)).normalize().toArray());
  }

  #alignArms(angle: number) {
    const { right, up } = this.frame, rotations = new Map(this.#reference);
    for (const side of sides) {
      const direction = right.clone().multiplyScalar(Math.cos(angle * deg) * (side === 'left' ? -1 : 1)).addScaledVector(up, Math.sin(angle * deg));
      this.#aim(rotations, `${side}UpperArm`, `${side}Forearm`, direction);
      this.#aim(rotations, `${side}Forearm`, `${side}Hand`, direction);
    }
    return rotations;
  }

  #anatomicalAxes(role: Role, id: string, world: ReturnType<typeof worldMatrices>): Axes {
    const { right, up, front } = this.frame;
    const side = role.startsWith('left') ? 'left' : role.startsWith('right') ? 'right' : '';
    let bend = up.clone().cross(front).normalize(), twist = up.clone(), spread = up.clone().cross(right).normalize();
    if (side && /UpperArm|Forearm|Hand|Thigh|Shin|Foot$/.test(role)) {
      const part = role.slice(side.length);
      const distal = { UpperArm: 'Forearm', Forearm: 'Hand', Hand: 'Index', Thigh: 'Shin', Shin: 'Foot', Foot: 'Toes' }[part];
      const endpoint = distal && this.#pos(`${side}${distal}` as Role, world);
      twist = endpoint ? endpoint.sub(positionOf(world(id))).normalize() : part === 'Foot' ? front.clone() : up.clone().negate();
      if (twist.lengthSq() < .5) twist.copy(up).negate();
      bend = twist.clone().cross(front);
      if (bend.lengthSq() < .008) bend = twist.clone().cross(up);
      if (bend.lengthSq() < .008) bend = twist.clone().cross(right);
      bend.normalize();
      const out = right.clone().multiplyScalar(side === 'left' ? -1 : 1);
      spread = twist.clone().cross(out);
      if (spread.lengthSq() < .008) spread = twist.clone().cross(up);
      spread.addScaledVector(bend, -spread.dot(bend));
      if (spread.lengthSq() < .008) spread = twist.clone().cross(bend).multiplyScalar(side === 'left' ? 1 : -1);
      spread.normalize();
    }
    const inverse = rotation(world(id)).invert(), correction = this.profile.axes[role];
    const axisCorrection = correction ? new Quaternion().setFromEuler(new Euler(...correction.map(angle => angle * deg) as [number, number, number])) : identity;
    return [bend, twist, spread].map(axis => axis.applyQuaternion(inverse).applyQuaternion(axisCorrection).normalize()) as unknown as Axes;
  }

  #offsets(rotations: ReadonlyMap<string, Quat>, translations: PoseTranslations = {}): Sample {
    const offsets: Record<string, Quat> = {};
    for (const [id, orientation] of rotations) {
      const q = new Quaternion(...this.#rest.get(id)!.rotation).invert().multiply(new Quaternion(...orientation)).normalize();
      if (1 - Math.abs(q.w) > 1e-12) offsets[id] = q.toArray();
    }
    return { rotations: offsets, translations };
  }

  calibration(kind: 'T' | 'A'): Pose { return this.#offsets(this.#alignArms(kind === 'T' ? 0 : -37)).rotations; }

  #local(frame: Frame, corrected: boolean, rootMotion: boolean) {
    const rotations = new Map(this.#neutral);
    for (const [role, id] of Object.entries(this.status.mapping) as [Role, string][]) {
      const axes = this.#axes.get(role)!, motion = frame.rotations[role] ?? [0, 0, 0];
      const spread = corrected ? role.endsWith('UpperArm') ? this.profile.corrections.armAbduction :
        role.endsWith('Thigh') ? this.profile.corrections.legSpacing : 0 : 0;
      if (!motion.some(Boolean) && !spread) continue;
      const q = new Quaternion(...rotations.get(id)!);
      const sample = new Quaternion();
      if (spread) q.multiply(sample.setFromAxisAngle(axes[2], deg * spread));
      for (let i = 0; i < 3; i++) if (motion[i]) q.multiply(sample.setFromAxisAngle(axes[i], deg * motion[i]));
      rotations.set(id, q.normalize().toArray());
    }
    const translations: Record<string, Vec3> = {};
    if (this.hips && this.#parentInverse) {
      const { right, up, front, length } = this.frame, [x, y, z] = frame.pelvis;
      const [side, height, forward] = corrected ? this.profile.corrections.pelvis : [0, 0, 0];
      const offset = right.clone().multiplyScalar(length * x + side).addScaledVector(up, length * y + height)
        .addScaledVector(front, length * (z + (rootMotion ? frame.travel : 0)) + forward);
      // Transform a displacement into its parent's space while cancelling the translation column.
      offset.applyMatrix4(this.#parentInverse).sub(positionOf(this.#parentInverse));
      if (offset.lengthSq() > 1e-16) translations[this.hips.id] = xyz(offset);
    }
    return { rotations, translations };
  }

  preset(name: Preset, corrected: boolean): Sample {
    if (name === 'Working base pose') return { rotations: {}, translations: {} };
    if (name === 'T-Pose' || name === 'A-Pose' || name === 'Arms Up') return this.#offsets(this.#alignArms(name === 'T-Pose' ? 0 : name === 'A-Pose' ? -37 : 83));
    let frame: Frame;
    if (name === 'Squat') frame = motions.find(motion => motion.id === 'squat')!.sample(.5, 'right');
    else if (name === 'Elbows Bent to 90°') frame = { rotations: { leftForearm: [90, 0, 0], rightForearm: [90, 0, 0] }, pelvis: [0, 0, 0], travel: 0 };
    else if (name === 'Wide Stance') frame = { rotations: { leftThigh: [0, 0, 26], rightThigh: [0, 0, 26], leftShin: [-12, 0, 0], rightShin: [-12, 0, 0] }, pelvis: [0, -.08, 0], travel: 0 };
    else if (name === 'Knee Raised') frame = { rotations: { leftThigh: [75, 0, 6], leftShin: [-95, 0, 0], leftFoot: [20, 0, 0], rightUpperArm: [25, 0, 5] }, pelvis: [.06, -.04, 0], travel: 0 };
    else frame = { rotations: { hips: [13, 0, 0], spine: [32, 0, 0], chest: [16, 0, 0], head: [-20, 0, 0] }, pelvis: [0, -.04, -.1], travel: 0 };
    const local = this.#local(frame, corrected, false);
    return this.#offsets(local.rotations, local.translations);
  }

  clip(motion: Motion, name: string, corrected: boolean, rootMotion: boolean) {
    const options = suitability(motion, this.status.mapping);
    if (!options.ready) throw new Error(`${motion.name} needs ${[...options.missing, ...(options.armMissing ? ['one complete arm'] : [])].join(', ')}.`);
    const frames = Math.ceil(motion.seconds * 30);
    const times = Array.from({ length: frames + 1 }, (_, i) => motion.seconds * i / frames);
    const samples = times.map((_, i) => this.#local(motion.sample(i / frames, options.side), corrected, rootMotion));
    const tracks = this.group.flatMap(joint => {
      const node = this.rig.session.bone(joint.id);
      if (!node) throw new Error(`The diagnostic joint ${joint.name} is missing.`);
      const track = new QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times,
        samples.flatMap(sample => [...sample.rotations.get(joint.id)!]));
      const position = new VectorKeyframeTrack(`${node.uuid}.position`, times,
        samples.flatMap(sample => joint.position.map((n, i) => n + (sample.translations[joint.id]?.[i] ?? 0))));
      const scale = new VectorKeyframeTrack(`${node.uuid}.scale`, [0, motion.seconds], [...joint.scale, ...joint.scale]);
      return [track, position, scale];
    });
    return new AnimationClip(name, motion.seconds, tracks).optimize();
  }
}

export function publishedClips(rig: Rig, published: readonly PublishedMotion[], taken: readonly string[]) {
  const names = new Set(taken);
  return published.map(item => {
    if (item.basis !== rig.basis) throw new Error(`Published clip ${item.name} is stale. Remove it or publish it again on the current rig.`);
    if (names.has(item.name)) throw new Error(`Animation name ${item.name} is already in use.`);
    names.add(item.name);
    return new HumanoidRig(rig, item.profile).clip(motions.find(motion => motion.id === item.motion)!, item.name, item.corrected, item.rootMotion);
  });
}

export function inPlaceClip(clip: AnimationClip, rig: HumanoidRig) {
  if (!rig.hips) return { clip, rootMotion: false };
  const target = rig.rig.session.bone(rig.hips.id);
  const chain = new Set<Object3D | undefined>([target]);
  for (let node = target?.parent; node && node !== rig.rig.session.model.scene; node = node.parent) chain.add(node);
  let rootMotion = false;
  const tracks = clip.tracks.map(track => {
    let binding;
    try { binding = PropertyBinding.parseTrackName(track.name); }
    catch { return track; }
    if (binding.propertyName !== 'position' || binding.propertyIndex !== undefined || binding.objectName) return track;
    const node = PropertyBinding.findNode(rig.rig.session.model.scene, binding.nodeName) as Object3D | null;
    if (!node || !chain.has(node)) return track;
    const parent = new Matrix3().setFromMatrix4(node.parent?.matrixWorld ?? new Matrix4());
    const inverse = parent.clone().invert(), up = rig.frame.up;
    const cubic = (track as typeof track & { createInterpolant?: { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } })
      .createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline;
    const output = track.clone(), first = new Vector3().fromArray(track.values, cubic ? 3 : 0), value = new Vector3();
    for (let i = 0; i < track.values.length; i += 3) {
      const tangent = cubic && i % 9 !== 3;
      value.fromArray(track.values, i);
      if (!tangent) value.sub(first);
      value.applyMatrix3(parent);
      const vertical = value.dot(up);
      if (value.clone().addScaledVector(up, -vertical).lengthSq() > 1e-10) rootMotion = true;
      value.copy(up).multiplyScalar(vertical).applyMatrix3(inverse);
      if (!tangent) value.add(first);
      value.toArray(output.values, i);
    }
    return output;
  });
  return { clip: rootMotion ? new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode) : clip, rootMotion };
}
