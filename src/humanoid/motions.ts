import type { Vec3 } from '../mesh/data';
import type { MotionId, Role, RoleMap } from './profile';

export type Side = 'left' | 'right';
export const sides = ['left', 'right'] as const;
export interface Frame {
  rotations: Partial<Record<Role, Vec3>>;
  pelvis: Vec3;
  travel: number;
}

export interface Motion {
  id: MotionId;
  name: string;
  seconds: number;
  required: readonly Role[];
  arm?: true;
  rootMotion?: true;
  sample(t: number, side: Side): Frame;
}

const tau = 2 * Math.PI;
const arm = (side: Side, pitch: number, elbow: number, spread = 0, hand = 0): Frame['rotations'] => ({
  [`${side}UpperArm`]: [pitch, 0, spread], [`${side}Forearm`]: [elbow, 0, 0], [`${side}Hand`]: [0, hand, hand * .45],
});
const leg = (side: Side, hip: number, knee: number, ankle: number, spread = 0): Frame['rotations'] => ({
  [`${side}Thigh`]: [hip, 0, spread], [`${side}Shin`]: [knee, 0, 0], [`${side}Foot`]: [ankle, 0, 0],
});
const legs: Role[] = ['hips', 'leftThigh', 'leftShin', 'leftFoot', 'rightThigh', 'rightShin', 'rightFoot'];
const smooth = (n: number) => { const t = Math.min(1, Math.max(0, n)); return t * t * (3 - 2 * t); };
const hold = (t: number, rise: number, fall: number) => smooth(t / rise) * smooth((1 - t) / (1 - fall));

function gait(t: number, run: boolean): Frame {
  const phase = Math.sin(tau * t), twist = (run ? 13 : 7) * phase, bend = run ? 11 : 3;
  const gaitSide = (side: Side, p: number) => ({
    ...leg(side, p * (run ? 54 : 29), -(run ? 17 : 6) - Math.max(0, -p) * (run ? 75 : 34), -p * (run ? 22 : 11), 2),
    ...arm(side, -(run ? 37 : 22) * p, (run ? 83 : 15) + p * (run ? 12 : 6), 4),
  });
  return { rotations: { hips: [bend, twist, 0], spine: [-bend * .6, -twist * .5, 0], chest: [0, -twist * .45, 2 * phase],
    ...gaitSide('left', phase), ...gaitSide('right', -phase) },
  pelvis: [phase * (run ? .025 : .018), Math.abs(phase) * (run ? .085 : .035), 0], travel: t * (run ? 2.6 : 1.22) };
}

export const motions: readonly Motion[] = [
  { id: 'idle', name: 'Idle', seconds: 2.8, required: ['hips', 'spine'], sample(t) {
    const w = Math.sin(tau * t);
    return { rotations: { hips: [0, 3 * w, 2 * w], spine: [2 * w, -2 * w, 0], chest: [3 * w, 0, 1.5 * w], head: [1.5 * w, -3 * w, 0],
      ...arm('left', 2 * w, 8, 4 + w * 2), ...arm('right', -2 * w, 8, 4 - w * 2) }, pelvis: [.012 * w, .012 * (1 - Math.cos(tau * t)), 0], travel: 0 };
  } },
  { id: 'walk', name: 'Walk', seconds: 1.18, required: legs, rootMotion: true, sample: t => gait(t, false) },
  { id: 'run', name: 'Run', seconds: .82, required: legs, rootMotion: true, sample: t => gait(t, true) },
  { id: 'jump', name: 'Jump', seconds: 1.64, required: legs, rootMotion: true, sample(t) {
    const flight = t > .25 && t < .75 ? Math.sin(Math.PI * (t - .25) / .5) : 0;
    const prep = Math.sin(Math.PI * Math.min(1, t / .30));
    const land = t > .66 ? Math.sin(Math.PI * (t - .66) / .34) : 0;
    const crouch = Math.max(prep * .65, land * .58), knee = 86 * crouch + 32 * flight;
    return { rotations: { spine: [28 * crouch - 8 * flight, 0, 0], chest: [9 * crouch - 11 * flight, 0, 0],
      ...leg('left', 54 * crouch + 22 * flight, -knee, 19 * crouch + 13 * flight, 4),
      ...leg('right', 54 * crouch + 22 * flight, -knee, 19 * crouch + 13 * flight, 4),
      ...arm('left', -25 * crouch + 75 * flight, 35 * flight, 12 * flight), ...arm('right', -25 * crouch + 75 * flight, 35 * flight, 12 * flight) },
    pelvis: [0, .56 * flight - .26 * crouch, -.08 * crouch], travel: .65 * smooth((t - .25) / .56) };
  } },
  { id: 'squat', name: 'Squat', seconds: 2.6, required: legs, sample(t) {
    const level = hold(t, .40, .60);
    return { rotations: { hips: [9 * level, 0, 0], spine: [19 * level, 0, 0], chest: [8 * level, 0, 0], head: [-10 * level, 0, 0],
      ...leg('left', 66 * level, -103 * level, 31 * level, 13 * level), ...leg('right', 66 * level, -103 * level, 31 * level, 13 * level),
      ...arm('left', 60 * level, 21 * level, 8), ...arm('right', 60 * level, 21 * level, 8) }, pelvis: [0, -.46 * level, -.23 * level], travel: 0 };
  } },
  { id: 'sit', name: 'Sit', seconds: 3.2, required: legs, sample(t) {
    const level = hold(t, .32, .66);
    const lean = level * (10 + 16 * (1 - Math.cos(tau * (t - .5))));
    return { rotations: { hips: [-7 * level, 0, 0], spine: [lean, 0, 0], chest: [6 * level, 0, 0],
      ...leg('left', 94 * level, -103 * level, 9 * level, 8 * level), ...leg('right', 94 * level, -103 * level, 9 * level, 9 * level),
      ...arm('left', 28 * level, 22 * level, 7), ...arm('right', 32 * level, 26 * level, 9) }, pelvis: [0, -.54 * level, -.32 * level], travel: 0 };
  } },
  { id: 'wave', name: 'Wave', seconds: 2.6, required: ['chest'], arm: true, sample(t, side) {
    const ready = hold(t, .28, .76), wave = Math.sin(tau * 3 * t) * ready, sign = side === 'right' ? 1 : -1;
    return { rotations: { chest: [0, 7 * ready * sign, 4 * ready * sign], head: [0, 8 * ready * sign, 0],
      ...arm(side, 30 * ready, 95 * ready, 75 * ready, 32 * wave) }, pelvis: [0, 0, 0], travel: 0 };
  } },
  { id: 'punch', name: 'Punch', seconds: 1.55, required: ['hips', 'chest'], arm: true, sample(t, side) {
    const load = hold(t, .28, .34), strike = hold(t, .54, .63), sign = side === 'right' ? 1 : -1;
    const opposing = side === 'right' ? 'left' : 'right';
    return { rotations: { hips: [4 * strike, sign * (14 * strike - 9 * load), 0], spine: [8 * strike, sign * (12 * strike - 16 * load), 0],
      chest: [7 * strike, sign * (28 * strike - 18 * load), 0], ...arm(side, 85 * strike - 28 * load, 20 + 78 * load * (1 - strike), 14 * load),
      ...arm(opposing, 21 * load - 20 * strike, 48 * load + 27 * strike, 10) }, pelvis: [0, -.04 * load, .12 * strike], travel: 0 };
  } },
  { id: 'reach', name: 'Bend and Reach', seconds: 2.8, required: ['hips', 'spine'], arm: true, sample(t, side) {
    const reach = hold(t, .40, .58), sign = side === 'right' ? 1 : -1;
    return { rotations: { hips: [19 * reach, 6 * reach * sign, 0], spine: [37 * reach, 4 * reach * sign, 0], chest: [12 * reach, 9 * reach * sign, 0],
      head: [-28 * reach, 0, 0], ...arm(side, 48 * reach, 14 * reach, 12 * reach),
      ...leg('left', 15 * reach, -26 * reach, 8 * reach), ...leg('right', 13 * reach, -25 * reach, 8 * reach) },
    pelvis: [0, -.09 * reach, -.18 * reach], travel: 0 };
  } },
  { id: 'twist', name: 'Torso Twist', seconds: 2.6, required: ['spine', 'chest'], sample(t) {
    const w = Math.sin(tau * t);
    return { rotations: { hips: [0, 8 * w, 0], spine: [0, 28 * w, 4 * w], chest: [0, 34 * w, 0], neck: [0, 13 * w, 0], head: [0, -14 * w, 0],
      ...arm('left', -15 * w, 32, 14), ...arm('right', 15 * w, 32, 14) }, pelvis: [0, 0, 0], travel: 0 };
  } },
];

export function suitability(motion: Motion, mapped: RoleMap) {
  const armSide = ['right', 'left'].find(side => ['UpperArm', 'Forearm', 'Hand'].every(part => !!mapped[`${side}${part}` as Role])) as Side | undefined;
  const missing = motion.required.filter(role => !mapped[role]);
  return { side: armSide ?? 'right', missing, armMissing: !!motion.arm && !armSide, ready: missing.length === 0 && (!motion.arm || !!armSide) };
}

export const presets = ['Working base pose', 'T-Pose', 'A-Pose', 'Arms Up', 'Elbows Bent to 90°', 'Squat', 'Wide Stance', 'Knee Raised', 'Torso Bend'] as const;
export type Preset = typeof presets[number];
