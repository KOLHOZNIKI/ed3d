import { Box3, Ray, Triangle, Vector3 } from 'three';

export interface ProjectionInput {
  sourceName: string;
  sourcePosition: Float32Array<ArrayBuffer>;
  sourceComponents: Uint32Array<ArrayBuffer>;
  targetComponents: Uint32Array<ArrayBuffer>;
  eligibleSources: number[][];
  maxDistance: number;
  spatial?: {
    direction: 'forward' | 'backward' | 'both';
    minNormalDot: number;
    offset: number;
    fallback: 'empty' | 'color' | 'nearest';
    color: readonly [number, number, number];
    targetPosition: Float32Array<ArrayBuffer>;
    targetNormal: Float32Array<ArrayBuffer>;
    sourceLocalPosition: Float32Array<ArrayBuffer>;
    sourceLocalNormal: Float32Array<ArrayBuffer>;
    sourceWorldNormal: Float32Array<ArrayBuffer>;
    sourceNormalToWorld: number[];
    worldNormalToTarget: number[];
    directFaces?: Int32Array<ArrayBuffer>;
    excluded?: Uint8Array<ArrayBuffer>;
  };
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

export interface ProjectionHit { face: number; a: number; b: number; c: number; nearest: boolean }

export function spatialProjection(input: ProjectionInput) {
  const options = input.spatial!;
  const groups = new Map<number, SourceTriangle[]>();
  for (const [face, component] of input.sourceComponents.entries()) {
    if (options.excluded?.[face]) continue;
    const i = face * 9;
    const points = [i, i + 3, i + 6].map(offset => new Vector3().fromArray(input.sourcePosition, offset));
    const triangle = new Triangle(points[0], points[1], points[2]);
    if (!triangle.getArea()) continue;
    const normal = new Vector3();
    for (let corner = 0; corner < 3; corner++) normal.add(new Vector3().fromArray(options.sourceWorldNormal, i + corner * 3));
    if (normal.lengthSq()) normal.normalize();
    else triangle.getNormal(normal);
    const list = groups.get(component) ?? [];
    list.push({ triangle, normal, center: triangle.getMidpoint(new Vector3()), box: new Box3().setFromPoints(points), face });
    groups.set(component, list);
  }
  const trees = new Map([...groups].map(([component, triangles]) => [component, buildTree(triangles)]));
  const eligible = input.eligibleSources.map(components => components.map(component => trees.get(component)).filter(tree => tree !== undefined));
  const ray = new Ray(), origin = new Vector3(), normal = new Vector3();
  const point = new Vector3(), weights = new Vector3(), sampleNormal = new Vector3();
  const result: ProjectionHit = { face: -1, a: 0, b: 0, c: 0, nearest: false };
  let limit = 0;

  function visit(tree: Tree, nearest: boolean) {
    if (tree.box.distanceToPoint(origin) > limit || !nearest && !ray.intersectsBox(tree.box)) return;
    if ('children' in tree) {
      for (const child of tree.children) visit(child, nearest);
      return;
    }
    for (const item of tree.triangles) {
      const sample = nearest ? item.triangle.closestPointToPoint(origin, point) :
        ray.intersectTriangle(item.triangle.a, item.triangle.b, item.triangle.c, false, point);
      if (!sample) continue;
      const distance = origin.distanceTo(sample);
      if (distance > limit || distance === limit && result.face >= 0 && result.face < item.face) continue;
      if (!item.triangle.getBarycoord(sample, weights)) continue;
      interpolate(options.sourceWorldNormal, item.face * 9, weights.x, weights.y, weights.z, sampleNormal).normalize();
      if ((sampleNormal.lengthSq() ? sampleNormal : item.normal).dot(normal) < options.minNormalDot) continue;
      limit = distance;
      result.face = item.face;
      result.a = weights.x; result.b = weights.y; result.c = weights.z;
    }
  }
  const interpolate = (attribute: Float32Array, i: number, a: number, b: number, c: number, out: Vector3) =>
    out.set(a * attribute[i] + b * attribute[i + 3] + c * attribute[i + 6],
      a * attribute[i + 1] + b * attribute[i + 4] + c * attribute[i + 7],
      a * attribute[i + 2] + b * attribute[i + 5] + c * attribute[i + 8]);
  const directions = options.direction === 'both' ? [1, -1] : [options.direction === 'forward' ? 1 : -1];
  return (face: number, a: number, b: number, c: number) => {
    const direct = options.directFaces?.[face] ?? -1;
    result.nearest = false;
    if (direct >= 0) {
      result.face = direct; result.a = a; result.b = b; result.c = c;
      return result;
    }
    result.face = -1;
    interpolate(options.targetPosition, face * 9, a, b, c, origin);
    interpolate(options.targetNormal, face * 9, a, b, c, normal).normalize();
    if (!normal.lengthSq()) return;
    limit = input.maxDistance;
    const candidates = eligible[input.targetComponents[face]];
    for (const direction of directions) {
      ray.origin.copy(origin).addScaledVector(normal, -direction * options.offset);
      ray.direction.copy(normal).multiplyScalar(direction);
      for (const tree of candidates) visit(tree, false);
    }
    if (result.face < 0 && options.fallback === 'nearest') {
      for (const tree of candidates) visit(tree, true);
      result.nearest = result.face >= 0;
    }
    return result.face < 0 ? undefined : result;
  };
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
