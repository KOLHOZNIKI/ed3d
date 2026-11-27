import { usedVertices, type MeshData, type Weight } from '../mesh/data';

export type Influence = readonly [joint: string, weight: number];
export type Row = readonly Influence[];
export type WeightEditRow = readonly [vertex: number, weights: Row];
export const weightTolerance = 1e-5;
export const editableLimit = 4;
export const jointId = (value: unknown): value is string => typeof value === 'string' &&
  /^(?:object-(?:0|[1-9]\d{0,7})|joint-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(value);
export const total = (row: Row) => row.reduce((sum, [, weight]) => sum + weight, 0);

export function validWeightEdits(value: unknown): value is WeightEditRow[] {
  if (!Array.isArray(value) || !value.length || value.length > 1_000_000) return false;
  const vertices = new Set<number>();
  return value.every(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) || entry[0] < 0 || entry[0] > 0x7fffffff ||
        vertices.has(entry[0]) || !Array.isArray(entry[1]) || !entry[1].length || entry[1].length > editableLimit) return false;
    vertices.add(entry[0]);
    const joints = new Set<string>();
    return entry[1].every(pair => {
      if (!Array.isArray(pair) || pair.length !== 2 || !jointId(pair[0]) || joints.has(pair[0]) ||
          typeof pair[1] !== 'number' || !Number.isFinite(pair[1]) || !(pair[1] > 0 && pair[1] <= 1)) return false;
      joints.add(pair[0]);
      return true;
    }) && Math.abs(total(entry[1]) - 1) <= weightTolerance;
  });
}

export function applyWeightEdits(mesh: MeshData, rows: WeightEditRow[]): MeshData {
  if (!mesh.weights || !mesh.weightJoints || !validWeightEdits(rows)) throw new Error('Invalid skin weight edit.');
  const vertices = new Set(usedVertices(mesh.faces));
  const weights = [...mesh.weights], weightJoints = [...mesh.weightJoints];
  const lookup = new Map(weightJoints.map((id, i) => [id, i]));
  for (const [vertex, values] of rows) {
    if (!vertices.has(vertex)) throw new Error(`Weight edit refers to missing vertex ${vertex}.`);
    weights[vertex] = values.map(([joint, weight]): Weight => {
      let slot = lookup.get(joint);
      if (slot === undefined) { slot = weightJoints.length; weightJoints.push(joint); lookup.set(joint, slot); }
      return [slot, weight];
    });
  }
  return { ...mesh, weights, weightJoints };
}
