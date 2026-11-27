import type { Vec3 } from '../mesh/data';
import type { Joint, Pose } from '../rig/state';

export const coreRoles = ['hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftForearm', 'leftHand', 'rightUpperArm', 'rightForearm', 'rightHand',
  'leftThigh', 'leftShin', 'leftFoot', 'rightThigh', 'rightShin', 'rightFoot'] as const;
export const optionalRoles = ['upperChest', 'leftShoulder', 'rightShoulder', 'leftToes', 'rightToes',
  'leftArmTwist', 'rightArmTwist', 'leftThighTwist', 'rightThighTwist', 'leftThumb', 'rightThumb',
  'leftIndex', 'rightIndex', 'leftMiddle', 'rightMiddle', 'leftRing', 'rightRing', 'leftPinky', 'rightPinky'] as const;
export const roles = [...coreRoles, ...optionalRoles];
export type Role = typeof roles[number];
export type RoleMap = Readonly<Partial<Record<Role, string>>>;
export type MotionId = 'idle' | 'walk' | 'run' | 'jump' | 'squat' | 'sit' | 'wave' | 'punch' | 'reach' | 'twist';
export type Corrections = { armAbduction: number; legSpacing: number; pelvis: Vec3 };
export type Calibration = { kind: 'T' | 'A'; basis: string; mapping: string; rotations: Pose };

export interface HumanoidProfile {
  readonly group: string;
  readonly mapping: RoleMap;
  readonly calibration?: Calibration;
  readonly axes: Readonly<Partial<Record<Role, Vec3>>>;
  readonly reverseForward: boolean;
  readonly corrections: Corrections;
}

export interface PublishedMotion {
  readonly name: string;
  readonly motion: MotionId;
  readonly basis: string;
  readonly profile: HumanoidProfile;
  readonly corrected: boolean;
  readonly rootMotion: boolean;
}

export interface HumanoidState { readonly profile: HumanoidProfile; readonly published: readonly PublishedMotion[] }

export const zeroCorrections: Corrections = { armAbduction: 0, legSpacing: 0, pelvis: [0, 0, 0] };
export const emptyProfile = (group: string): HumanoidProfile => ({ group, mapping: {}, axes: {}, reverseForward: false, corrections: zeroCorrections });
export const roleLabel = (role: Role) => role.replace(/[A-Z]/g, value => ` ${value.toLowerCase()}`).replace(/^./, value => value.toUpperCase());
export const mappingKey = (mapping: RoleMap) => roles.map(role => mapping[role] ?? '').join('|');
export const hasCorrections = (profile: HumanoidProfile) => !!(profile.corrections.armAbduction || profile.corrections.legSpacing || profile.corrections.pelvis.some(value => value !== 0));

const aliases: Record<string, string[]> = {
  hips: ['hips', 'pelvis', 'hip', 'cog', 'waist'], spine: ['spine', 'spine01', 'spine1', 'lowerback'],
  chest: ['chest', 'spine02', 'spine2', 'upperback', 'thorax'], upperChest: ['upperchest', 'spine03', 'spine3'],
  neck: ['neck', 'neck01', 'neck1'], head: ['head', 'head01', 'skull'],
  UpperArm: ['upperarm', 'arm', 'humerus'], Forearm: ['lowerarm', 'forearm', 'elbow'], Hand: ['hand', 'wrist'],
  Thigh: ['upperleg', 'upleg', 'thigh', 'femur'], Shin: ['lowerleg', 'shin', 'calf', 'knee', 'leg'], Foot: ['foot', 'ankle'],
  Shoulder: ['shoulder', 'clavicle', 'collar'], Toes: ['toes', 'toe', 'toebase'], ArmTwist: ['upperarmtwist', 'armtwist', 'armtwist01'],
  ThighTwist: ['thightwist', 'upperlegtwist', 'thightwist01'], Thumb: ['thumbproximal', 'thumb1', 'thumb01', 'handthumb1'],
  Index: ['indexproximal', 'index1', 'index01', 'handindex1'], Middle: ['middleproximal', 'middle1', 'middle01', 'handmiddle1'],
  Ring: ['ringproximal', 'ring1', 'ring01', 'handring1'], Pinky: ['pinkyproximal', 'littleproximal', 'pinky1', 'little1', 'handpinky1'],
};

function parentRoles(role: Role): Role[] {
  switch (role) {
    case 'hips': return [];
    case 'spine': return ['hips'];
    case 'chest': return ['spine', 'hips'];
    case 'upperChest': return ['chest', 'spine'];
    case 'neck': return ['upperChest', 'chest', 'spine'];
    case 'head': return ['neck', 'upperChest', 'chest'];
  }
  const side = role.startsWith('left') ? 'left' : 'right';
  const part = role.slice(side.length);
  const chain: Record<string, Role[]> = {
    Shoulder: ['upperChest', 'chest', 'spine'], UpperArm: [`${side}Shoulder`, 'upperChest', 'chest', 'spine'],
    Forearm: [`${side}UpperArm`], Hand: [`${side}Forearm`, `${side}UpperArm`], Thigh: ['hips'],
    Shin: [`${side}Thigh`], Foot: [`${side}Shin`, `${side}Thigh`], Toes: [`${side}Foot`],
    ArmTwist: [`${side}UpperArm`], ThighTwist: [`${side}Thigh`],
  };
  return chain[part] ?? [`${side}Hand`];
}

function names(role: Role, label: string) {
  const name = label.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(mixamorig\d*|armature|bip0*\d*|def|joint)/, '');
  const side = role.startsWith('left') ? 'left' : role.startsWith('right') ? 'right' : '';
  const part = role.slice(side.length);
  const choices = aliases[part] ?? [];
  for (const [i, choice] of choices.entries()) {
    if (!side && name === choice || side && (name === side + choice || name === choice + side)) return Math.max(.7, .93 - i * .045);
    if (side && (name === side[0] + choice || name === choice + side[0])) return Math.max(.6, .84 - i * .04);
  }
  return 0;
}

function below(id: string, ancestor: string, joints: ReadonlyMap<string, Joint>) {
  for (let parent = joints.get(id)?.parent; parent; parent = joints.get(parent)?.parent) if (parent === ancestor) return true;
  return false;
}

export function suggestRoles(group: string, input: readonly Joint[]) {
  const joints = new Map(input.filter(joint => joint.group === group).map(joint => [joint.id, joint]));
  const mapping: Partial<Record<Role, string>> = {}, confidence: Partial<Record<Role, number>> = {};
  const taken = new Set<string>();
  for (const role of roles) {
    const parent = parentRoles(role).map(parent => mapping[parent]).find(Boolean);
    const candidates = [...joints.values()].flatMap(joint => {
      const nameScore = names(role, joint.name);
      if (!nameScore || taken.has(joint.id)) return [];
      return [{ id: joint.id, score: parent ? nameScore + (below(joint.id, parent, joints) ? .06 : -.36) : nameScore }];
    }).sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score < .5) continue;
    mapping[role] = best.id;
    confidence[role] = candidates[1]?.score === best.score ? best.score * .65 : best.score;
    taken.add(best.id);
  }
  return { mapping, confidence };
}

export function checkMapping(profile: HumanoidProfile, input: readonly Joint[]) {
  const joints = new Map(input.filter(joint => joint.group === profile.group).map(joint => [joint.id, joint]));
  const counts = new Map<string, number>();
  for (const id of Object.values(profile.mapping)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const mapping: Partial<Record<Role, string>> = {}, issues: Partial<Record<Role, string>> = {};
  for (const role of roles) {
    const id = profile.mapping[role];
    if (!id) { if ((coreRoles as readonly Role[]).includes(role)) issues[role] = 'Missing'; continue; }
    if (!joints.has(id)) issues[role] = 'Joint missing from this rig';
    else if (counts.get(id)! > 1) issues[role] = 'Duplicate joint';
    else {
      const parent = parentRoles(role).map(parent => profile.mapping[parent]).find(id => id && joints.has(id) && counts.get(id) === 1);
      if (parent && !below(id, parent, joints)) issues[role] = 'Unexpected ancestry';
      else mapping[role] = id;
    }
  }
  return { mapping, issues, complete: coreRoles.every(role => !!mapping[role]) };
}
