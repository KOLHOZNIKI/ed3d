import { Box3, Mesh, Texture, Vector3 } from 'three';
import { encodeEdit, type MeshEdit } from '../mesh/commands';
import { edgeKey, edgesOf, edgeVertices, point, usedVertices, type MeshData, type Vec3 } from '../mesh/data';
import type { Model, ModelAdapter } from '../project/adapter';
import type { ExtractedAsset, UvBake, WorkingState } from '../project/state';
import type { TextureCatalog } from '../texture/bindings';
import { disjoint, type Layout, type Surface } from '../uv/layout';
import { pack, type PackOptions } from '../uv/pack';
import { autoUnwrap, currentLayout, uvCommand, uvSurface } from '../uv/surface';
import { transfer } from '../uv/transfer';

export interface Candidate { name: string; faces: number[] }
export interface ExtractOptions extends PackOptions {
  independent: boolean;
  cut: boolean;
  layout: ExtractedAsset['layout'];
  pivot: 'original' | 'center' | 'bottom' | 'point';
  point: Vec3;
  rotation: Vec3;
  scale: number;
  zeroOrigin: boolean;
  fillMissing: boolean;
}

export function components(mesh: MeshData) {
  const index = new Map(mesh.faces.map((face, i) => [face.id, i]));
  const union = disjoint(mesh.faces.length);
  for (const sides of edgesOf(mesh).values()) {
    const a = index.get(sides[0].face.id)!;
    for (const { face } of sides.slice(1)) union.join(a, index.get(face.id)!);
  }
  const result = new Map<number, number[]>();
  mesh.faces.forEach(({ id }, i) => {
    const root = union.root(i), list = result.get(root);
    if (list) list.push(id);
    else result.set(root, [id]);
  });
  return [...result.values()];
}

export function cutBoundaries(mesh: MeshData, faces: ReadonlySet<number>) {
  let open = 0, cut = 0;
  for (const sides of edgesOf(mesh).values()) {
    const included = sides.filter(side => faces.has(side.face.id)).length;
    if (included === 1) sides.length === 1 ? open++ : cut++;
  }
  return { open, cut };
}

function placement(mesh: Mesh, data: MeshData, faces: ReadonlySet<number>, options: ExtractOptions): Vec3 {
  if (options.pivot === 'original') return [0, 0, 0];
  if (options.pivot === 'point') return options.point;
  mesh.updateWorldMatrix(true, false);
  const world = new Box3(), p = new Vector3();
  for (const face of data.faces) if (faces.has(face.id)) {
    for (const corner of face.corners) world.expandByPoint(p.set(...point(data, corner.vertex)).applyMatrix4(mesh.matrixWorld));
  }
  const center = world.getCenter(p);
  if (options.pivot === 'bottom') center.y = world.min.y;
  return mesh.worldToLocal(center).toArray();
}

function sliceSurface(surface: Surface, triangles: readonly number[]): Surface {
  const positions = new Float32Array(triangles.length * 9), normals = positions.slice();
  const points = new Uint32Array(triangles.length * 3), faces = new Uint32Array(triangles.length), slots = faces.slice();
  triangles.forEach((face, i) => {
    positions.set(surface.positions.subarray(face * 9, face * 9 + 9), i * 9);
    normals.set(surface.normals.subarray(face * 9, face * 9 + 9), i * 9);
    points.set(surface.points.subarray(face * 3, face * 3 + 3), i * 3);
    faces[i] = surface.faces[face];
    slots[i] = surface.slots[face];
  });
  return { positions, normals, points, faces, slots };
}

function sliceLayout(layout: Layout, triangles: readonly number[]): Layout {
  const uv = new Float32Array(triangles.length * 6);
  triangles.forEach((face, i) => uv.set(layout.uv.subarray(face * 6, face * 6 + 6), i * 6));
  return { uv, seams: layout.seams };
}

export async function buildExtraction(adapter: ModelAdapter, model: Model, catalog: TextureCatalog, state: WorkingState,
  revision: number, object: string, candidates: readonly Candidate[], options: ExtractOptions, signal?: AbortSignal) {
  adapter.mesh.validateExtract(object);
  if (model.format === 'fbx' && state.atlas) throw new Error('Discard the legacy FBX atlas before extracting. The UV Editor can prepare a new atlas on the independent result.');
  if (!candidates.length || candidates.length > 64) throw new Error('Choose 1 to 64 output groups.');
  if (!Number.isFinite(options.scale) || options.scale <= 0 || options.rotation.some(x => !Number.isFinite(x)) ||
      options.point.some(x => !Number.isFinite(x))) throw new Error('Enter finite transform values and a positive scale.');
  const data = adapter.mesh.data(object), mesh = adapter.objects.get(object) as Mesh;
  const surface = uvSurface(adapter, object), available = new Set(data.faces.map(face => face.id)), cut = new Set<number>();
  const bindings = catalog.targets(state).filter(target => target.binding.object === object);
  const extracted = { ...state.extracts }, objects = { ...state.objects }, textures = { ...state.textures };
  const edits = [...state.meshEdits ?? []], output: string[] = [];
  let next = Math.max(...[...adapter.objects.keys()].map(id => Number(id.slice(7)))) + 1;
  for (const { name, faces } of candidates) {
    signal?.throwIfAborted();
    const selected = new Set(faces);
    if (!name.trim() || name.length > 120 || !selected.size || selected.size > 200000 || !faces.every(id => available.has(id))) {
      throw new Error('Every output group needs a name and existing faces.');
    }
    if (options.cut) for (const id of selected) {
      if (cut.has(id)) throw new Error('Cut groups must use different source faces.');
      cut.add(id);
    }
    if (cut.size >= available.size) throw new Error('Cut must leave at least one source face.');
    const piece = `object-${next++}`;
    const extract: MeshEdit = { type: 'extract', object, piece, faces: [...selected], cut: options.cut,
      pivot: placement(mesh, data, selected, options), rotation: options.rotation, scale: options.scale };
    edits.push(encodeEdit(extract));
    objects[piece] = { name: name.trim(), visible: true };
    output.push(piece);
    if (!options.independent) {
      for (const target of bindings) {
        if (target.transfer) throw new Error('Use Make Independent Asset when copying a previously baked binding.');
        const image = state.textures?.[target.binding.id];
        if (image) textures[`slot/${piece}/${target.binding.slot}`] = image;
      }
      continue;
    }
    const triangles = Array.from(surface.faces.keys()).filter(id => selected.has(surface.faces[id]));
    const slots = new Map<number, number[]>();
    triangles.forEach((id, i) => {
      const slot = surface.slots[id], indices = slots.get(slot);
      if (indices) indices.push(i);
      else slots.set(slot, [i]);
    });
    const bakes: Record<number, UvBake> = {};
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const coordinates = sliceLayout(currentLayout(adapter, model, object, mesh, 0, surface), triangles).uv;
    const pieceSurface = sliceSurface(surface, triangles);
    const original = (channel: number) => currentLayout(adapter, model, object, mesh, channel, surface);
    for (const [slot, indices] of slots) {
      const target = bindings.find(item => item.binding.slot === slot);
      if (!target) {
        if (Object.values(materials[slot] ?? {}).some(value => value instanceof Texture)) {
          throw new Error('Independent texture transfer requires a supported Base Color binding on every textured material.');
        }
        continue;
      }
      const subset = indices.map(i => triangles[i]), input = sliceSurface(surface, subset);
      const source = original(target.transfer?.channel ?? target.binding.texture.channel);
      let layout = sliceLayout(source, subset);
      if (options.layout === 'pack') layout = pack(input, layout, options);
      else if (options.layout === 'unwrap') {
        layout = await autoUnwrap(input, layout, options, model.format === 'glb', undefined, signal);
      }
      const bake = await transfer(adapter, model, catalog, state, revision, object, layout, input,
        { ...options, original: false, filter: 'linear', scope: { slot, triangles: subset, clearUnused: options.layout === 'keep' } }, signal);
      bakes[slot] = { channel: 0, bake };
      indices.forEach((index, i) => coordinates.set(layout.uv.subarray(i * 6, i * 6 + 6), index * 6));
    }
    if (Object.keys(bakes).length) {
      const seams = new Set<string>();
      const points = pieceSurface.points;
      for (let i = 0; i < points.length; i++) {
        const q = points[i % 3 === 2 ? i - 2 : i + 1], p = points[i];
        seams.add(edgeKey(p, q));
      }
      const vertices = usedVertices(data.faces.filter(face => selected.has(face.id)));
      const remap = new Map(vertices.map((id, i) => [id, i]));
      const selectedSeams = (data.uvSeams?.[0] ?? []).filter(key => seams.has(key))
        .map(key => { const [a, b] = edgeVertices(key); return edgeKey(remap.get(a)!, remap.get(b)!); });
      edits.push(encodeEdit(uvCommand(piece, 0, { uv: coordinates, seams: selectedSeams },
        slots.size === Object.keys(bakes).length)));
    }
    extracted[piece] = { source: object, layout: options.layout, zeroOrigin: options.zeroOrigin, bakes };
  }
  const nextState: WorkingState = { ...state, objects, textures, meshEdits: edits, extracts: extracted };
  return { state: nextState, output };
}
