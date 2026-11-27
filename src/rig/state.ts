import type { Vec3 } from '../mesh/data';

export type Quat = readonly [number, number, number, number];
export type Pose = Readonly<Record<string, Quat>>;
export type PoseTranslations = Readonly<Record<string, Vec3>>;

export interface Joint {
  readonly id: string;
  readonly group: string;
  readonly parent: string | null;
  readonly name: string;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export interface RigClip {
  readonly mode: 'original' | 'exclude' | 'adapted';
  readonly name?: string;
  readonly basis?: string;
  readonly offsets?: Pose;
  readonly translationOffsets?: PoseTranslations;
}

export interface RigState {
  readonly joints: readonly Joint[];
  readonly transfers: Readonly<Record<string, string>>;
  readonly basis: string;
  readonly rebind: readonly string[];
  readonly clips: Readonly<Record<number, RigClip>>;
  readonly bakedGroups?: readonly string[];
}

export interface PoseState {
  readonly current: Pose;
  readonly translations?: PoseTranslations;
  readonly saved: readonly { id: string; name: string; rotations: Pose; translations?: PoseTranslations }[];
}

export type RigAction =
  | { type: 'transform'; joint: string; position?: Vec3; rotation?: Quat; preserve: boolean;
      mirror?: { joint: string; axis: number; offset: number } }
  | { type: 'rename'; joint: string; name: string }
  | { type: 'add'; joint: string; name: string; offset: Vec3 }
  | { type: 'delete'; joint: string; transfer: string }
  | { type: 'reparent'; joint: string; parent: string; preserve: boolean }
  | { type: 'rebind'; joint: string };

export const emptyPose: PoseState = { current: {}, saved: [] };
