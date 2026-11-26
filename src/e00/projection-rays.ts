import { Box3, Ray, Triangle, Vector3 } from 'three';

export interface ProjectionInput {
  sourceName: string;
  sourcePosition: Float32Array<ArrayBuffer>;
  sourceComponents: Uint32Array<ArrayBuffer>;
  targetComponents: Uint32Array<ArrayBuffer>;
  eligibleSources: number[][];
  maxDistance: number;
}

type SourceTriangle = { triangle: Triangle; normal: Vector3; center: Vector3; box: Box3; face: number };
type Tree = { box: Box3; triangles: SourceTriangle[] } | { box: Box3; children: [Tree, Tree] };

function buildTree(triangles: SourceTriangle[]): Tree {
  const box = new Box3();
  for (const triangle of triangles) box.union(triangle.box);
  if (triangles.length <= 8) return { box, triangles };
  const { x, y, z } = box.getSize(new Vector3());
  const axis = x >= y && x >= z ? 'x' : y >= z ? 'y' : 'z';
  triangles.sort((a, b) => a.center[axis] - b.center[axis]);
  const middle = Math.floor(triangles.length / 2);
  return { box, children: [buildTree(triangles.slice(0, middle)), buildTree(triangles.slice(middle))] };
}

export function projectTextureCoordinates(projection: ProjectionInput, targetPosition: Float32Array,
  targetNormal: Float32Array, sourceUv: Float32Array) {
  const groups = new Map<number, SourceTriangle[]>();
  for (let face = 0; face < projection.sourceComponents.length; face++) {
    const i = face * 9;
    const a = new Vector3().fromArray(projection.sourcePosition, i);
    const b = new Vector3().fromArray(projection.sourcePosition, i + 3);
    const c = new Vector3().fromArray(projection.sourcePosition, i + 6);
    const triangle = new Triangle(a, b, c);
    const entry = { triangle, normal: triangle.getNormal(new Vector3()), center: triangle.getMidpoint(new Vector3()),
      box: new Box3().setFromPoints([a, b, c]), face };
    const component = projection.sourceComponents[face];
    if (!groups.has(component)) groups.set(component, []);
    groups.get(component)!.push(entry);
  }
  const trees = new Map([...groups].map(([component, triangles]) => [component, buildTree(triangles)]));
  const eligible = projection.eligibleSources.map(components => components.map(component => trees.get(component)!));
  const ray = new Ray(), hit = new Vector3(), bestPoint = new Vector3(), barycentric = new Vector3();
  let bestDistance = 0, best: SourceTriangle | undefined;

  function search(tree: Tree) {
    if (!ray.intersectsBox(tree.box) || tree.box.distanceToPoint(ray.origin) > bestDistance) return;
    if ('children' in tree) {
      search(tree.children[0]);
      search(tree.children[1]);
      return;
    }
    for (const item of tree.triangles) {
      if (item.normal.dot(ray.direction) < 0.5 ||
          !ray.intersectTriangle(item.triangle.a, item.triangle.b, item.triangle.c, false, hit)) continue;
      const distance = hit.distanceTo(ray.origin);
      if (distance > bestDistance || (best && distance === bestDistance)) continue;
      best = item;
      bestDistance = distance;
      bestPoint.copy(hit);
    }
  }

  const interpolate = (array: Float32Array, i: number, j: number, a: number, b: number, c: number) =>
    a * array[i + j] + b * array[i + j + 3] + c * array[i + j + 6];
  return (face: number, a: number, b: number, c: number, uv: [number, number]) => {
    const i = face * 9;
    ray.origin.set(interpolate(targetPosition, i, 0, a, b, c), interpolate(targetPosition, i, 1, a, b, c),
      interpolate(targetPosition, i, 2, a, b, c));
    ray.direction.set(interpolate(targetNormal, i, 0, a, b, c), interpolate(targetNormal, i, 1, a, b, c),
      interpolate(targetNormal, i, 2, a, b, c)).normalize();
    bestDistance = projection.maxDistance;
    best = undefined;
    for (const tree of eligible[projection.targetComponents[face]]) search(tree);
    const nearest = best as SourceTriangle | undefined;
    if (!nearest || !nearest.triangle.getBarycoord(bestPoint, barycentric)) return false;
    const { x, y, z } = barycentric;
    const j = nearest.face * 6;
    uv[0] = x * sourceUv[j] + y * sourceUv[j + 2] + z * sourceUv[j + 4];
    uv[1] = x * sourceUv[j + 1] + y * sourceUv[j + 3] + z * sourceUv[j + 5];
    return true;
  };
}
