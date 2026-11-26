export function faceComponents(controlPoints: Uint32Array): Uint32Array<ArrayBuffer> {
  const parent = Uint32Array.from({ length: controlPoints.length / 3 }, (_, face) => face);
  const edges = new Map<string, number>();
  const root = (face: number) => {
    while (parent[face] !== face) {
      parent[face] = parent[parent[face]];
      face = parent[face];
    }
    return face;
  };
  for (let face = 0; face < parent.length; face++) {
    for (let edge = 0; edge < 3; edge++) {
      const a = controlPoints[face * 3 + edge], b = controlPoints[face * 3 + (edge + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const other = edges.get(key);
      if (other === undefined) edges.set(key, face);
      else parent[root(face)] = root(other);
    }
  }
  const ids = new Map<number, number>();
  return parent.map((_, face) => {
    const component = root(face);
    if (!ids.has(component)) ids.set(component, ids.size);
    return ids.get(component)!;
  });
}
