import { BufferAttribute, Matrix3, Mesh, SkinnedMesh, Vector3 } from 'three';
import type { ProjectionInput } from '../e00/projection-rays';
import { faceComponents } from '../e00/topology-components';
import type { ModelAdapter } from '../project/adapter';
import type { WorkingState } from '../project/state';
import type { Surface } from './layout';
import { uvSurface } from './surface';

export interface SpatialOptions {
  object: string;
  pairs: string;
  distance: number;
  angle: number;
  offset: number;
  direction: 'forward' | 'backward' | 'both';
  fallback: 'empty' | 'color' | 'nearest';
  color: readonly [number, number, number];
}

export function componentCount(ids: Uint32Array) {
  return ids.reduce((max, id) => Math.max(max, id + 1), 0);
}

export function componentPairs(pairs: string, targets: number, sources: number) {
  if (!pairs.trim() && targets === 1 && sources === 1) return [[0]];
  const result = Array.from({ length: targets }, () => [] as number[]);
  for (const pair of pairs.trim().split(/\s*,\s*/)) {
    const match = /^(\d+)\s*=\s*(\d+)$/.exec(pair);
    if (!match) throw new Error('Assign each target component an eligible source, for example 1=2, 2=1.');
    const a = Number(match[1]) - 1, b = Number(match[2]) - 1;
    if (!result[a] || b < 0 || b >= sources) throw new Error(`Use target components 1–${targets} and source components 1–${sources}.`);
    if (result[a].length) throw new Error('Assign exactly one eligible source to each target component.');
    result[a].push(b);
  }
  if (result.some(list => !list.length)) throw new Error('Assign every target component an eligible source.');
  return result;
}

export function prepareProjection(adapter: ModelAdapter, state: WorkingState, object: string, target: Surface, options: SpatialOptions,
  original: boolean, sourceName: string): ProjectionInput {
  const sourceNode = adapter.objects.get(options.object), targetNode = adapter.objects.get(object);
  if (!(sourceNode instanceof Mesh) || sourceNode instanceof SkinnedMesh || !(targetNode instanceof Mesh) || targetNode instanceof SkinnedMesh ||
      Array.isArray(sourceNode.material) || Array.isArray(targetNode.material)) {
    throw new Error('Spatial transfer requires static source and target meshes with one material each.');
  }
  if (targetNode.geometry.hasAttribute('tangent') || [sourceNode, targetNode].some(node =>
    Object.values(node.geometry.morphAttributes).some(layers => Array.isArray(layers) && layers.length))) {
    throw new Error('Spatial transfer requires a target without authored tangents and meshes without morphs.');
  }
  if (!(options.distance > 0) || !Number.isFinite(options.distance) || !(options.angle >= 0 && options.angle <= 90) ||
      !(options.offset >= 0 && options.offset <= options.distance)) {
    throw new Error('Enter a positive distance, an angle from 0° to 90°, and an offset between zero and the distance.');
  }
  const source = uvSurface(adapter, options.object, original);
  const sourceComponents = faceComponents(source.points), targetComponents = faceComponents(target.points);
  const eligibleSources = componentPairs(options.pairs, componentCount(targetComponents), componentCount(sourceComponents));
  const sourceEdits = !original && adapter.mesh.render.get(options.object)?.state.mesh.faces;
  const transferred = state.uvBakes?.[options.object] || state.extracts?.[options.object]?.bakes[0];
  const noSource = new Set(sourceEdits ? sourceEdits.filter(face => face.needsUv || face.repaired && !transferred).map(face => face.id) : []);
  const excluded = noSource.size ? Uint8Array.from(source.faces, face => Number(noSource.has(face))) : undefined;
  sourceNode.updateWorldMatrix(true, false);
  targetNode.updateWorldMatrix(true, false);
  if ([sourceNode, targetNode].some(node => Math.abs(node.matrixWorld.determinant()) < 1e-12)) {
    throw new Error('Spatial transfer requires nonsingular source and target transforms.');
  }
  const sourceNormal = new Matrix3().getNormalMatrix(sourceNode.matrixWorld);
  const targetNormal = new Matrix3().getNormalMatrix(targetNode.matrixWorld);
  const toWorld = (data: Float32Array<ArrayBuffer>, node: Mesh) => {
    const values = data.slice();
    new BufferAttribute(values, 3).applyMatrix4(node.matrixWorld);
    return values;
  };
  const worldNormals = (data: Float32Array<ArrayBuffer>, matrix: Matrix3) => {
    const values = data.slice(), v = new Vector3();
    for (let i = 0; i < values.length; i += 3) v.fromArray(data, i).applyNormalMatrix(matrix).toArray(values, i);
    return values;
  };
  const directFaces = options.object === object ? identicalFaces(source, target, sourceComponents, targetComponents, eligibleSources, excluded) : undefined;
  return { sourceName, sourcePosition: toWorld(source.positions, sourceNode), sourceComponents, targetComponents, eligibleSources,
    maxDistance: options.distance,
    spatial: { direction: options.direction, minNormalDot: Math.cos(options.angle * Math.PI / 180) - 1e-7,
      offset: options.offset, fallback: options.fallback, color: options.color,
      targetPosition: toWorld(target.positions, targetNode), targetNormal: worldNormals(target.normals, targetNormal),
      sourceLocalPosition: source.positions, sourceLocalNormal: source.normals, sourceWorldNormal: worldNormals(source.normals, sourceNormal),
      sourceNormalToWorld: sourceNormal.toArray(), worldNormalToTarget: targetNormal.invert().toArray(), directFaces, excluded,
    },
  };
}

function identicalFaces(source: Surface, target: Surface, sourceComponents: Uint32Array, targetComponents: Uint32Array,
  allowed: number[][], excluded?: Uint8Array) {
  const key = (surface: Surface, i: number) => `${surface.faces[i]}/${surface.points.subarray(i * 3, i * 3 + 3).join('/')}`;
  const previous = new Map(Array.from(source.faces.keys(), i => [key(source, i), i]));
  return Int32Array.from(target.faces, (_, i) => {
    const j = previous.get(key(target, i));
    if (j === undefined || excluded?.[j] || !allowed[targetComponents[i]].includes(sourceComponents[j])) return -1;
    const equal = (a: Float32Array, b: Float32Array) =>
      a.subarray(i * 9, i * 9 + 9).every((value, k) => Math.abs(value - b[j * 9 + k]) < 1e-7);
    return equal(target.positions, source.positions) && equal(target.normals, source.normals) ? j : -1;
  });
}
