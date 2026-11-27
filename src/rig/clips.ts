import { AnimationClip, Bone, PropertyBinding, Quaternion, QuaternionKeyframeTrack, type KeyframeTrack, type Object3D } from 'three';
import type { Joint, RigClip, RigState } from './state';

export interface Track {
  track: KeyframeTrack;
  node?: string;
  property: string;
  component?: string;
}

export interface OriginalClip { clip: AnimationClip; tracks: Track[] }
export interface ClipResult { original: OriginalClip; setting: RigClip; clip?: AnimationClip; reason?: string }

export function captureClips(root: Object3D, ids: ReadonlyMap<Object3D, string>) {
  return root.animations.map((clip): OriginalClip => ({ clip, tracks: clip.tracks.map(track => {
    let binding;
    try { binding = PropertyBinding.parseTrackName(track.name); }
    catch { return { track, property: '' }; }
    let node = PropertyBinding.findNode(root, binding.nodeName) as Object3D | undefined;
    if (binding.objectName === 'bones') {
      const bones = (node as Object3D & { skeleton?: { bones: Bone[] } } | undefined)?.skeleton?.bones;
      node = binding.objectIndex !== undefined ? bones?.find(bone => bone?.name === binding.objectIndex) ??
        bones?.[Number(binding.objectIndex)] : undefined;
    }
    if (binding.objectName && binding.objectName !== 'bones') node = undefined;
    return { track, node: node && ids.get(node), property: binding.propertyName, component: binding.propertyIndex };
  }) }));
}

const suffix = (track: Track) => `.${track.property}${track.component === undefined ? '' : `[${track.component}]`}`;

export function makeClips(originals: readonly OriginalClip[], source: ReadonlyMap<string, Joint>, state: RigState,
  changedGroups: ReadonlySet<string>, anchors: ReadonlySet<string> = new Set()) {
  const after = new Map(state.joints.map(joint => [joint.id, joint]));
  const transform = new Set(['position', 'quaternion', 'rotation', 'scale', '']);
  return originals.map((original, i): ClipResult => {
    const setting = state.clips[i] ?? { mode: 'original' }, result = { original, setting };
    if (setting.mode === 'exclude') return result;
    const affected = original.tracks.filter(({ node }) => node && source.has(node) && changedGroups.has(source.get(node)!.group));
    const unsafeBinding = changedGroups.size && original.tracks.some(({ node, property }) => transform.has(property) && (!node || anchors.has(node)));
    if (setting.mode === 'original' && (affected.length || unsafeBinding)) return { ...result, reason: 'Rest or hierarchy changed. Adapt or exclude this clip.' };
    if (setting.mode === 'adapted' && setting.basis !== state.basis) return { ...result, reason: 'The saved adaptation is stale. Rebuild or exclude it.' };
    try {
      const adapted = setting.mode === 'adapted';
      if (adapted && unsafeBinding) throw new Error('A clip animates an external rig parent or has an unresolved transform binding. Exclude it until it can be retargeted.');
      const mapped = new Set<string>();
      const tracks = original.tracks.map(entry => {
        const { node, track, property, component } = entry;
        const old = node && source.get(node), joint = node && after.get(node);
        if (!old) return track;
        if (!joint) throw new Error(`The clip references deleted joint ${old.name}. Exclude it or restore the joint.`);
        if (adapted) for (let ancestor: Joint | undefined = old; ancestor; ancestor = source.get(ancestor.parent ?? '')) {
          if (after.get(ancestor.id)?.parent !== ancestor.parent) {
            throw new Error(`The hierarchy of ${old.name} changed. Exclude this clip until it can be retargeted.`);
          }
        }
        if (adapted && (property === 'rotation' || (property === 'quaternion' || property === 'position') && component !== undefined)) {
          throw new Error('Partial transform tracks cannot be adapted in this stage.');
        }
        if (!adapted && joint.name === old.name) return track;
        const next = track.clone();
        next.name = joint.name + suffix(entry);
        if (!adapted) return next;
        const cubic = (track as KeyframeTrack & { createInterpolant?: { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } })
          .createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline;
        if (cubic && (property === 'position' || property === 'quaternion')) throw new Error('Cubic spline joint tracks require full retargeting.');
        if (property === 'quaternion') {
          mapped.add(joint.id);
          const prefix = new Quaternion(...joint.rotation).multiply(new Quaternion(...old.rotation).invert());
          const offset = new Quaternion(...(setting.offsets?.[joint.id] ?? [0, 0, 0, 1]));
          const value = new Quaternion();
          for (let j = 0; j < next.values.length; j += 4) {
            value.fromArray(next.values, j).premultiply(prefix).multiply(offset).normalize().toArray(next.values, j);
          }
        } else if (property === 'position') {
          for (let j = 0; j < next.values.length; j++) next.values[j] += joint.position[j % 3] - old.position[j % 3];
        }
        return next;
      });
      if (adapted) for (const [id, offset] of Object.entries(setting.offsets ?? {})) {
        const joint = after.get(id);
        if (!joint) throw new Error('A saved correction references a missing joint.');
        if (mapped.has(id)) continue;
        const rotation = new Quaternion(...joint.rotation).multiply(new Quaternion(...offset)).normalize().toArray();
        const times = original.clip.duration > 0 ? [0, original.clip.duration] : [0];
        tracks.push(new QuaternionKeyframeTrack(`${joint.name}.quaternion`, times, times.flatMap(() => rotation)));
      }
      if (tracks.every((track, index) => track === original.clip.tracks[index]) && !adapted) return { ...result, clip: original.clip };
      const clip = new AnimationClip(adapted ? setting.name! : original.clip.name, original.clip.duration, tracks, original.clip.blendMode);
      const raw = original.clip as AnimationClip & { assetFixerFbxRange?: unknown };
      if (raw.assetFixerFbxRange) Object.assign(clip, { assetFixerFbxRange: raw.assetFixerFbxRange });
      return { ...result, clip };
    } catch (error) { return { ...result, reason: error instanceof Error ? error.message : String(error) }; }
  });
}

export function forGhost(original: OriginalClip, nodes: ReadonlyMap<string, Object3D>) {
  const tracks = original.tracks.flatMap(entry => {
    const node = entry.node && nodes.get(entry.node);
    if (!node) return [];
    const track = entry.track.clone();
    track.name = node.uuid + suffix(entry);
    return [track];
  });
  return new AnimationClip(original.clip.name, original.clip.duration, tracks, original.clip.blendMode);
}
