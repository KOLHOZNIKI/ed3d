import { Matrix3, Matrix4, Vector3 } from 'three';
import { usedVertices, type MeshData } from './data';

export interface BakeJointMatrix {
  readonly joint: string;
  readonly values: readonly number[];
}

export function bakeBaseGeometry(mesh: MeshData, transforms: readonly BakeJointMatrix[]): MeshData {
  if (!mesh.weights || !mesh.weightJoints || transforms.length !== mesh.weightJoints.length ||
      transforms.some((entry, i) => entry.joint !== mesh.weightJoints![i])) {
    throw new Error('The base pose bake does not match the mesh joint palette.');
  }
  if (mesh.channels.some(channel => channel.name.startsWith('morph:'))) throw new Error('Base pose baking requires a mesh without morph targets.');
  const positions = mesh.positions.slice(), basis = new Float64Array(positions.length * 3);
  const blend = new Matrix4(), linear = new Matrix3(), point = new Vector3();
  for (const vertex of usedVertices(mesh.faces)) {
    const row = mesh.weights[vertex];
    if (!row || row.some(([slot, weight]) => !Number.isFinite(weight) || weight < 0 || !transforms[slot])) {
      throw new Error(`Control point ${vertex} has invalid weights. Correct the weights before baking.`);
    }
    const weighted = row.filter(([, value]) => value > 0);
    const sum = weighted.reduce((n, [, value]) => n + value, 0);
    if (Math.abs(sum - 1) > 1e-5 || weighted.length > 4) {
      throw new Error(`Control point ${vertex} needs normalized weights and at most four influences to match the preview.`);
    }
    blend.elements.fill(0);
    // Bake the displayed linear blend, retaining the original skin weight rows.
    for (const [slot, weight] of weighted) {
      const values = transforms[slot].values, normalized = weight / sum;
      for (let i = 0; i < 16; i++) blend.elements[i] += values[i] * normalized;
    }
    linear.setFromMatrix4(blend);
    if (!(linear.determinant() > 1e-8)) throw new Error(`The pose has a singular or inverted skin frame at control point ${vertex}.`);
    linear.toArray(basis, vertex * 9);
    const offset = vertex * 3;
    point.fromArray(mesh.positions, offset).applyMatrix4(blend);
    if (!point.toArray().every(value => Number.isFinite(Math.fround(value)))) throw new Error('The pose produces unsupported coordinates.');
    point.toArray(positions, offset);
  }
  const normal = mesh.channels.findIndex(channel => channel.name === 'normal');
  const tangent = mesh.channels.findIndex(channel => channel.name === 'tangent');
  const n = new Vector3(), t = new Vector3();
  const faces = mesh.faces.map(face => ({ ...face, corners: face.corners.map(corner => {
    linear.fromArray(basis, corner.vertex * 9);
    const attributes = corner.attributes.slice();
    if (normal >= 0) attributes[normal] = n.fromArray(attributes[normal]).applyMatrix3(linear).normalize().toArray();
    if (tangent >= 0) {
      t.fromArray(attributes[tangent]).applyMatrix3(linear);
      if (normal >= 0) t.addScaledVector(n, -t.dot(n));
      attributes[tangent] = [...t.normalize().toArray(), attributes[tangent][3]];
    }
    return { ...corner, attributes };
  }) }));
  return { ...mesh, positions, faces };
}
