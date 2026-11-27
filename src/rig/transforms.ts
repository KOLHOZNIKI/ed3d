import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Joint, RigAction, RigState } from './state';

export function unpack(matrix: Matrix4, tolerance = 1e-6) {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  matrix.decompose(p, q, s);
  if (!matrix.elements.every(Number.isFinite) || !q.lengthSq() || Math.min(...s.toArray().map(Math.abs)) < 1e-8) {
    throw new Error('The joint transform is singular.');
  }
  q.normalize();
  const check = new Matrix4().compose(p, q, s);
  if (!check.elements.every((v, i) => Math.abs(v - matrix.elements[i]) <= tolerance * (i < 12 ? Math.abs(s.getComponent(Math.floor(i / 4))) : 1))) {
    throw new Error('The operation would require a sheared joint transform.');
  }
  return { position: p.toArray(), rotation: q.toArray(), scale: s.toArray() };
}

export function pack(joint: Joint) {
  return new Matrix4().compose(new Vector3(...joint.position), new Quaternion(...joint.rotation), new Vector3(...joint.scale));
}

export function worldMatrices(joints: readonly Joint[], anchor: (id: string | null) => Matrix4) {
  const map = new Map(joints.map(joint => [joint.id, joint])), world = new Map<string, Matrix4>(), path = new Set<string>();
  const resolve = (id: string | null): Matrix4 => {
    const joint = id && map.get(id);
    if (!joint) return anchor(id);
    const prior = world.get(joint.id);
    if (prior) return prior;
    if (path.has(joint.id)) throw new Error('The joint hierarchy would contain a cycle.');
    path.add(joint.id);
    const result = resolve(joint.parent).clone().multiply(pack(joint));
    world.set(joint.id, result);
    path.delete(joint.id);
    return result;
  };
  for (const joint of joints) resolve(joint.id);
  return resolve;
}

export function jointName(value: string) {
  const name = value.trim();
  if (!/^[\p{L}\p{N}_ -]{1,80}$/u.test(name)) throw new Error('Use a unique joint name with letters, numbers, spaces, underscores or hyphens.');
  return name.replace(/ +/g, '_');
}

export function changeRig(state: RigState, action: RigAction, anchor: (id: string | null) => Matrix4) {
  const joints = new Map(state.joints.map(joint => [joint.id, joint]));
  const selected = joints.get(action.joint);
  if (!selected) throw new Error('Select an existing joint.');
  const transfers = { ...state.transfers };
  const before = worldMatrices(state.joints, anchor);
  const chooseName = (value: string, own?: string) => {
    const name = jointName(value);
    if (state.joints.some(joint => joint.id !== own && joint.name === name)) throw new Error('Choose a unique joint name.');
    return name;
  };
  const choosePeer = (id: string) => {
    const peer = joints.get(id);
    if (!peer || peer.id === selected.id || peer.group !== selected.group) throw new Error('Choose a different joint in the same rig.');
    return peer;
  };
  const setWorld = (joint: Joint, matrix: Matrix4) => {
    const parent = worldMatrices([...joints.values()], anchor)(joint.parent);
    joints.set(joint.id, { ...joint, ...unpack(parent.clone().invert().multiply(matrix)) });
  };
  const preserveChildren = (id: string) => {
    for (const child of joints.values()) if (child.parent === id) setWorld(child, before(child.id));
  };
  const isBelow = (a: Joint, b: Joint) => {
    for (let id = a.parent; id; id = joints.get(id)?.parent ?? null) if (id === b.id) return true;
    return false;
  };

  switch (action.type) {
    case 'rename':
      joints.set(selected.id, { ...selected, name: chooseName(action.name, selected.id) });
      return { ...state, joints: [...joints.values()] };
    case 'add': {
      const id = `joint-${crypto.randomUUID()}`;
      joints.set(id, { id, group: selected.group, parent: selected.id, name: chooseName(action.name),
        position: action.offset, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
      break;
    }
    case 'delete': {
      const target = choosePeer(action.transfer);
      if (!selected.parent || !joints.has(selected.parent)) throw new Error('Keep the imported rig root.');
      for (const child of joints.values()) if (child.parent === selected.id) {
        setWorld({ ...child, parent: selected.parent }, before(child.id));
      }
      for (const [id, previous] of Object.entries(transfers)) if (previous === selected.id) transfers[id] = target.id;
      if (selected.id.startsWith('object-')) transfers[selected.id] = target.id;
      joints.delete(selected.id);
      break;
    }
    case 'reparent': {
      const parent = choosePeer(action.parent);
      if (!selected.parent || !joints.has(selected.parent)) throw new Error('Keep the imported rig root attached to its original scene parent.');
      if (isBelow(parent, selected)) throw new Error('A joint cannot be parented under its descendant.');
      const moved = { ...selected, parent: parent.id };
      if (action.preserve) setWorld(moved, before(selected.id));
      else joints.set(selected.id, moved);
      break;
    }
    case 'rebind':
      return { ...state, rebind: [...new Set([...state.rebind, selected.group])] };
    case 'transform': {
      const parent = before(selected.parent), original = unpack(before(selected.id));
      const local = pack(selected);
      if (action.position) {
        local.setPosition(new Vector3(...action.position).applyMatrix4(parent.clone().invert()));
      }
      if (action.rotation) {
        const rotation = new Quaternion(...unpack(parent).rotation).invert().multiply(new Quaternion(...action.rotation)).normalize();
        local.compose(new Vector3().setFromMatrixPosition(local), rotation, new Vector3(...selected.scale));
      }
      joints.set(selected.id, { ...selected, ...unpack(local) });
      if (action.preserve) preserveChildren(selected.id);
      if (action.mirror) {
        const pair = choosePeer(action.mirror.joint), { axis, offset } = action.mirror;
        if (isBelow(pair, selected) || isBelow(selected, pair)) throw new Error('Mirror pairs must be on separate joint branches.');
        const transform = unpack(before(pair.id));
        if (action.position) {
          transform.position = [...action.position];
          transform.position[axis] = 2 * offset - transform.position[axis];
        }
        if (action.rotation) {
          const delta = new Quaternion(...action.rotation).multiply(new Quaternion(...original.rotation).invert());
          const sign = [axis === 0 ? -1 : 1, axis === 1 ? -1 : 1, axis === 2 ? -1 : 1] as const;
          const reflection = new Matrix4().makeScale(...sign);
          const mirrored = reflection.clone().multiply(new Matrix4().makeRotationFromQuaternion(delta)).multiply(reflection);
          transform.rotation = new Quaternion().setFromRotationMatrix(mirrored)
            .multiply(new Quaternion(...transform.rotation)).normalize().toArray();
        }
        setWorld(pair, pack({ ...pair, ...transform }));
        if (action.preserve) preserveChildren(pair.id);
      }
      break;
    }
  }
  return { ...state, joints: [...joints.values()], transfers, basis: crypto.randomUUID() };
}
