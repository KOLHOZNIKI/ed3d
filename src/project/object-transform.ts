import { Bone, Euler, Matrix4, PropertyBinding, Quaternion, SkinnedMesh, Vector3, type Object3D } from 'three';
import type { ModelAdapter } from './adapter';

export type ObjectTransforms = Readonly<Record<string, readonly number[]>>;
export type TransformSpec = { operation: 'move' | 'rotate' | 'scale'; axes: 'world' | 'local';
  pivot: 'median' | 'active' | 'cursor'; value: Vector3; cursor: Vector3 };

export function validatedTransform(values: readonly number[]) {
  const matrix = new Matrix4().fromArray(values);
  if (values.length !== 16 || !values.every(value => Number.isFinite(Math.fround(value))) || Math.abs(matrix.determinant()) < 1e-12) {
    throw new Error('Object transforms must be finite and invertible.');
  }
  const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  const result = new Matrix4().compose(position, quaternion, scale);
  if (result.elements.some((value, i) => Math.abs(value - values[i]) > 1e-6 * Math.max(1, Math.abs(values[i])))) {
    throw new Error('This transform would shear the object. Try local axes or uniform scaling.');
  }
  return { position, quaternion, scale };
}

export function validateObject(adapter: ModelAdapter, node: Object3D) {
  let skinned = false;
  node.traverse(child => { skinned ||= child instanceof Bone || child instanceof SkinnedMesh; });
  if (skinned) throw new Error('Use Rig & Pose for skinned objects and their joint hierarchy.');
  const sourceClips = adapter.rig.originalClips.map(item => item.clip);
  for (const clip of sourceClips) for (const track of clip.tracks) {
    const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
    if (['position', 'quaternion', 'scale'].includes(propertyName) && PropertyBinding.findNode(adapter.model.scene, nodeName) === node) {
      throw new Error('The selected object transform is animated.');
    }
  }
}

export function transformObjects(adapter: ModelAdapter, ids: ReadonlySet<string>, active: string, spec: TransformSpec, prior?: ObjectTransforms) {
  const nodes = new Map([...ids].map(id => [id, adapter.objects.get(id)!]).filter((pair): pair is [string, Object3D] => !!pair[1]));
  const object = nodes.get(active);
  if (!object) throw new Error('Select an active object.');
  const included = new Set(nodes.values());
  const roots = [...nodes].filter(([, node]) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (included.has(parent)) return false;
    return true;
  });
  const p = spec.pivot === 'cursor' ? spec.cursor : spec.pivot === 'active' ? object.getWorldPosition(new Vector3())
    : roots.reduce((sum, [, node]) => sum.add(node.getWorldPosition(new Vector3())), new Vector3()).divideScalar(roots.length);
  const basis = new Matrix4();
  if (spec.axes === 'local') basis.makeRotationFromQuaternion(object.getWorldQuaternion(new Quaternion()).normalize());
  const delta = new Matrix4();
  if (spec.operation === 'move') delta.makeTranslation(spec.value);
  else if (spec.operation === 'rotate') delta.makeRotationFromEuler(new Euler(spec.value.x * Math.PI / 180, spec.value.y * Math.PI / 180, spec.value.z * Math.PI / 180));
  else delta.makeScale(spec.value.x, spec.value.y, spec.value.z);
  const world = new Matrix4().makeTranslation(p).multiply(basis).multiply(delta).multiply(basis.clone().invert())
    .multiply(new Matrix4().makeTranslation(p.clone().negate()));
  const transforms = { ...prior };
  for (const [id, node] of roots) {
    validateObject(adapter, node);
    node.updateWorldMatrix(true, false);
    const local = (node.parent?.matrixWorld.clone().invert() ?? new Matrix4()).multiply(world).multiply(node.matrixWorld);
    validatedTransform(local.elements);
    transforms[id] = local.toArray();
  }
  return transforms;
}
