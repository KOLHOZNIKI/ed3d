import { BufferGeometry, Float32BufferAttribute, Mesh, Uint32BufferAttribute } from 'three';
import { sourceMesh, renderControlPoints } from '../e00/fbx-topology';
import { generateAtlas, type UvAtlasEdit } from '../e00/uv-atlas';
import { faceComponents } from '../e00/topology-components';
import { edgeKey } from '../mesh/data';
import type { MeshEdit } from '../mesh/commands';
import type { Model, ModelAdapter } from '../project/adapter';
import { disjoint, groups, type Layout, type Surface } from './layout';
import { pack, type PackOptions } from './pack';

export const uvName = (channel: number) => channel ? `uv${channel}` : 'uv';

export function flatten(geometry: BufferGeometry, name: string, size: number) {
  const attribute = geometry.getAttribute(name);
  if (!attribute || attribute.itemSize !== size) return;
  const count = geometry.index?.count ?? geometry.getAttribute('position').count;
  const out = new Float32Array(count * size);
  for (let corner = 0; corner < count; corner++) {
    const vertex = geometry.index?.getX(corner) ?? corner;
    for (let k = 0; k < size; k++) out[corner * size + k] = attribute.getComponent(vertex, k);
  }
  return out;
}

export function uvSurface(adapter: ModelAdapter, object: string): Surface {
  const node = adapter.objects.get(object);
  if (!(node instanceof Mesh)) throw new Error('Select a mesh object.');
  const geometry = node.geometry, positions = flatten(geometry, 'position', 3)!;
  const count = positions.length / 3, edited = adapter.mesh.render.get(object)?.render;
  const topology = adapter.workingTopology(object);
  if (!topology || topology.renderFaces.length !== count / 3) throw new Error('The mesh has no stable triangle correspondence.');
  const points = edited?.renderVertices ?? (adapter.model.format === 'fbx'
    ? renderControlPoints(sourceMesh(geometry)) : Uint32Array.from({ length: count }, (_, i) => geometry.index?.getX(i) ?? i));
  return { positions, normals: flatten(geometry, 'normal', 3) ?? new Float32Array(positions.length),
    points: Uint32Array.from(points), faces: Uint32Array.from(topology.renderFaces, id => edited?.faceIds[id] ?? id),
    slots: Uint32Array.from(topology.renderFaces, id => topology.faceMaterials[id]) };
}

export function currentLayout(adapter: ModelAdapter, model: Model, object: string, mesh: Mesh, channel: number, surface: Surface): Layout {
  const atlas = model.format === 'fbx' && channel === 1 && model.uvAtlas?.inputGeometry === mesh.geometry ? model.uvAtlas : undefined;
  const uv = atlas ? flatten(atlas.geometry, atlas.channel, 2) : flatten(mesh.geometry, uvName(channel), 2);
  const seams = atlas?.seams ?? adapter.mesh.render.get(object)?.state.mesh.uvSeams?.[channel] ?? [];
  return { uv: uv ?? new Float32Array(surface.points.length * 2), seams };
}

export function uvCommand(object: string, channel: number, layout: Layout, suppliesTexture: boolean): MeshEdit {
  return { type: 'uv', object, channel, coordinates: Array.from(layout.uv), seams: [...layout.seams],
    ...(suppliesTexture ? { suppliesTexture: true } : {}) };
}

export function fbxAtlas(mesh: Mesh, surface: Surface, layout: Layout, width: number, height = width): UvAtlasEdit {
  const original = mesh.geometry;
  const source = sourceMesh(original);
  if (source.hasMorphTargets || source.uvs.length >= 4 || original.index || original.hasAttribute('tangent')) {
    throw new Error('FBX transfer requires non-indexed source corners, room for one UV channel, and no authored tangents or morph targets.');
  }
  const count = surface.points.length;
  const charts = groups(surface, layout);
  const geometry = original.clone();
  geometry.setIndex(new Uint32BufferAttribute(Uint32Array.from({ length: count }, (_, i) => i), 1));
  geometry.setAttribute('uv1', new Float32BufferAttribute(layout.uv.slice(), 2));
  const counts = new Map<number, number>();
  for (const id of charts.vertices.keys()) {
    const point = surface.points[id];
    counts.set(point, (counts.get(point) ?? 0) + 1);
  }
  return { inputGeometry: original, geometry, sourceCorners: source.renderCorners.slice(), faceComponents: faceComponents(surface.points),
    channel: 'uv1', seams: layout.seams,
    metrics: { width, height, charts: charts.islands.size, separatedFaces: 0, milliseconds: 0,
      controlPoints: source.positions.length / 3, chartVertices: charts.vertices.size, renderVertices: count,
      splitControlPoints: [...counts.values()].filter(value => value > 1).length } };
}

export async function autoUnwrap(surface: Surface, layout: Layout, options: PackOptions, topDown: boolean,
  selection?: ReadonlySet<number>, signal?: AbortSignal): Promise<Layout> {
  const count = surface.points.length;
  const triangles = Array.from({ length: count / 3 }, (_, i) => i).filter(i => !selection || selection.has(i));
  if (!triangles.length) throw new Error('Select one or more faces for Auto Unwrap.');
  const wanted = new Set(triangles);
  const cuts = new Set(layout.seams);
  const connected = disjoint(count / 3);
  const sides = groups(surface, layout).sides;
  const adjacent = (edges: (readonly [number, number])[]) => edges.map(([corner]) => Math.floor(corner / 3)).filter(id => wanted.has(id));
  for (const [key, edges] of sides) {
    if (edges.length !== 2 || cuts.has(key)) continue;
    const [a, b] = adjacent(edges);
    if (a !== undefined && b !== undefined) connected.join(a, b);
  }
  for (const key of cuts) {
    const [a, b] = adjacent(sides.get(key) ?? []);
    if (a !== undefined && b !== undefined && connected.root(a) === connected.root(b)) {
      throw new Error('This manual seam does not partition the unwrap scope. Extend the cut to a boundary or use manual projection.');
    }
  }
  const ids = new Map<number, number>(), positions: number[] = [], corners: number[] = [];
  for (const face of triangles) for (let i = 0; i < 3; i++) {
    const original = face * 3 + i, point = surface.points[original];
    if (!ids.has(point)) {
      ids.set(point, ids.size);
      positions.push(...surface.positions.subarray(original * 3, original * 3 + 3));
    }
    corners.push(ids.get(point)!);
  }
  const region = new Map<string, number>();
  const faceMaterialData = Uint32Array.from(triangles, id => {
    const key = `${connected.root(id)}:${surface.slots[id]}`;
    if (!region.has(key)) region.set(key, region.size);
    return region.get(key)!;
  });
  const result = await generateAtlas({ positions: Float32Array.from(positions), indices: Uint32Array.from(corners),
    faceMaterialData, settings: options }, signal);
  if (result.indices.length !== corners.length) throw new Error('xatlas changed the triangle count.');
  const uv = layout.uv.slice();
  for (let i = 0; i < corners.length; i++) {
    const vertex = result.indices[i];
    if (result.xrefs[vertex] !== corners[i]) throw new Error('xatlas lost triangle corner correspondence.');
    const offset = (triangles[Math.floor(i / 3)] * 3 + i % 3) * 2;
    uv[offset] = result.uv[vertex * 2];
    uv[offset + 1] = topDown ? 1 - result.uv[vertex * 2 + 1] : result.uv[vertex * 2 + 1];
  }
  const updated = { ...layout, uv };
  if (!selection) return pack(surface, updated, options);
  // Give newly unwrapped charts a detached workspace until packing can place
  // them among the islands that must remain stationary.
  let right = 1;
  for (let face = 0; face < count / 3; face++) if (!wanted.has(face)) {
    for (let i = 0; i < 3; i++) right = Math.max(right, uv[2 * (face * 3 + i)]);
  }
  for (const face of triangles) for (let i = 0; i < 3; i++) uv[2 * (face * 3 + i)] += right + 1;
  const grouping = groups(surface, updated);
  return pack(surface, updated, options, new Set(triangles.map(face => grouping.islandOf(face * 3))));
}
