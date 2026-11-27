import { edgesOf, next, type MeshData } from './data';

export interface SmoothSelectionSettings {
  strength: number;
  iterations: number;
  fixBoundary: boolean;
}

export function validSmoothSelection(settings: Partial<SmoothSelectionSettings> | undefined): settings is SmoothSelectionSettings {
  return typeof settings?.strength === 'number' && settings.strength > 0 && settings.strength <= 1 &&
    typeof settings.iterations === 'number' && Number.isInteger(settings.iterations) && settings.iterations >= 1 && settings.iterations <= 50 &&
    typeof settings.fixBoundary === 'boolean';
}

export function smoothSelection(mesh: MeshData, selection: ReadonlySet<number>, faces: ReadonlySet<number> | undefined, settings: SmoothSelectionSettings) {
  if (!validSmoothSelection(settings)) throw new Error('Choose a smoothing strength greater than 0 and at most 1, with 1–50 iterations.');
  if (!selection.size) throw new Error('Select vertices, edges or faces to smooth.');

  const region = faces ?? new Set(mesh.faces.filter(face => face.corners.every(corner => selection.has(corner.vertex))).map(face => face.id));
  const neighbors = new Map([...selection].map(id => [id, [] as number[]]));
  const pinned = new Set<number>();
  for (const sides of edgesOf(mesh).values()) {
    const { face, corner } = sides[0];
    const a = face.corners[corner].vertex, b = face.corners[next(face, corner)].vertex;
    neighbors.get(a)?.push(b);
    neighbors.get(b)?.push(a);
    // Open edges and edges with a side outside the selected surface belong to its boundary.
    if (settings.fixBoundary && (sides.length !== 2 || sides.some(side => !region.has(side.face.id)))) {
      if (selection.has(a)) pinned.add(a);
      if (selection.has(b)) pinned.add(b);
    }
  }

  const movable = [...neighbors].filter(([id, row]) => !pinned.has(id) && row.length);
  if (!movable.length) throw new Error('The selection has no movable interior vertices. Expand it or turn off Fix boundary.');
  const positions = mesh.positions.slice();
  const pending = new Float64Array(movable.length * 3);
  for (let pass = 0; pass < settings.iterations; pass++) {
    // Read a single position snapshot per iteration so the selection order cannot affect the result.
    for (const [i, [id, row]] of movable.entries()) {
      for (let axis = 0; axis < 3; axis++) {
        let sum = 0;
        for (const adjacent of row) sum += positions[adjacent * 3 + axis];
        const start = positions[id * 3 + axis];
        pending[i * 3 + axis] = start + (sum / row.length - start) * settings.strength;
      }
    }
    for (const [i, [id]] of movable.entries()) {
      for (let axis = 0; axis < 3; axis++) positions[id * 3 + axis] = pending[i * 3 + axis];
    }
  }
  const changed = new Set(movable.map(([id]) => id).filter(id =>
    [0, 1, 2].some(axis => positions[id * 3 + axis] !== mesh.positions[id * 3 + axis])));
  if (!changed.size) throw new Error('Smoothing does not move any selected vertices.');
  return { positions, changed, pinned };
}
