import { edgeVertices, edgesOf, usedVertices, type MeshData } from '../mesh/data';
import { editableLimit, total, weightTolerance, type Influence, type Row } from './data';

export type Weights = ReturnType<typeof readProfile>;
const epsilon = 1e-12;
const ordered = (values: ReadonlyMap<string, number>): Row => [...values].filter(([, weight]) => weight > 0).sort(([a], [b]) => a.localeCompare(b));
export const weightOf = (row: Row, joint: string) => row.find(([id]) => id === joint)?.[1] ?? 0;

export function readProfile(data: MeshData, palette: ReadonlySet<string>, transfers: Readonly<Record<string, string>> = {}) {
  if (!data.weightJoints || !data.weights) throw new Error('The mesh has no resolved skin weights.');
  const rows = new Map<number, Row>(), issues = new Map<number, string[]>();
  for (const vertex of usedVertices(data.faces)) {
    const values = new Map<string, number>(), problems = new Set<string>(), seen = new Set<string>();
    let remapped = false;
    for (const [slot, weight] of data.weights[vertex]) {
      if (!Number.isFinite(weight) || weight < 0) { problems.add('negative or nonfinite'); continue; }
      if (weight === 0) continue;
      const original = data.weightJoints[slot];
      const id = palette.has(original) ? original : transfers[original];
      if (!id || !palette.has(id)) { problems.add('unsupported bone'); continue; }
      remapped ||= id !== original;
      if (seen.has(original)) problems.add('duplicate influences');
      seen.add(original);
      values.set(id, (values.get(id) ?? 0) + weight);
    }
    let row = ordered(values);
    const mass = total(row);
    if (remapped && mass > 0) row = row.map(([id, value]) => [id, value / mass]);
    if (!mass) problems.add('zero sum');
    else if (!remapped && Math.abs(mass - 1) > weightTolerance) problems.add('non-unit sum');
    if (row.length > editableLimit) problems.add('over four influences');
    rows.set(vertex, row);
    if (problems.size) issues.set(vertex, [...problems]);
  }
  return { rows, issues };
}

export function adjacency(data: MeshData) {
  const neighbors = new Map<number, number[]>();
  for (const edge of edgesOf(data).keys()) {
    const [a, b] = edgeVertices(edge);
    if (a === b) continue;
    const left = neighbors.get(a) ?? [], right = neighbors.get(b) ?? [];
    left.push(b); right.push(a);
    neighbors.set(a, left); neighbors.set(b, right);
  }
  return neighbors;
}

export function blend(rows: readonly (readonly [Row, number])[]): Row {
  const merged = new Map<string, number>();
  for (const [row, factor] of rows) for (const [joint, value] of row) {
    merged.set(joint, (merged.get(joint) ?? 0) + value * factor);
  }
  return ordered(merged);
}

interface Options {
  locks: ReadonlySet<string>;
  fixed?: Influence;
  limit?: number;
  policy: 'reject' | 'replace' | 'limit';
  replace?: string;
  fallback?: string;
}

export function reconcile(before: Row, proposal: Row, options: Options) {
  const { locks, fixed, limit = editableLimit, policy, replace, fallback } = options;
  const pinned = new Map(before.filter(([id]) => locks.has(id)));
  if (fixed) {
    const [id, weight] = fixed;
    if (locks.has(id) && weight !== weightOf(before, id)) throw new Error('The selected influence is locked.');
    pinned.set(id, weight);
  }
  const fixedMass = [...pinned.values()].reduce((sum, value) => sum + value, 0);
  if (fixedMass > 1 + epsilon) throw new Error('Locked and exact weights exceed a sum of one.');
  let remaining = Math.max(0, 1 - fixedMass);
  const slots = limit - [...pinned.values()].filter(weight => weight > 0).length;
  if (slots < 0 || slots === 0 && remaining > epsilon) throw new Error('Locked and exact weights leave too few influence slots.');
  let free = proposal.filter(([id, weight]) => !locks.has(id) && !pinned.has(id) && weight > 0);
  const sourceMass = total(free);
  let dropped = 0;
  if (remaining <= epsilon) remaining = 0;
  if (remaining && free.length > slots) {
    const rank = [...free].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (policy === 'replace') {
      if (!replace || !rank.some(([id]) => id === replace) || rank.length - 1 > slots) {
        throw new Error('The replacement influence is locked, absent, or does not resolve the limit.');
      }
      free = rank.filter(([id]) => id !== replace);
    } else if (policy === 'limit') free = rank.slice(0, slots);
    else throw new Error(`The edit would exceed ${limit} influences. Choose an explicit replacement or limit.`);
    dropped = remaining * (sourceMass - total(free)) / sourceMass;
  }
  if (remaining && !free.length) {
    if (!fallback || locks.has(fallback) || pinned.has(fallback)) throw new Error('No unlocked influence can take the remaining weight. Choose a fallback joint.');
    free = [[fallback, 1]];
  }
  const sum = total(free), result = new Map(pinned);
  if (remaining > 0) for (const [id, weight] of free) result.set(id, remaining * weight / sum);
  const row = ordered(result);
  if (!row.length || Math.abs(total(row) - 1) > weightTolerance || row.some(([, weight]) => weight > 1)) {
    throw new Error('The result cannot be normalized within the editable profile.');
  }
  return { row, dropped };
}
