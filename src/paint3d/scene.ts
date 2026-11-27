import { Matrix4, Mesh, SkinnedMesh, Vector3, Vector4, type Camera, type Object3D } from 'three';
import { renderControlPoints, sourceMesh } from '../e00/fbx-topology';
import type { ModelAdapter, Model } from '../project/adapter';
import type { TextureTarget } from '../texture/bindings';
import { textureFaces, textureOverlap, type UvTriangle } from '../texture/overlay';
import { area, corners, type Face, type Link, type Triple, type Vec3, type View } from './projection';

export function paintMapping(model: Model, target: TextureTarget) {
  const atlas = model.format === 'fbx' ? model.uvAtlas?.geometry : undefined;
  const faces = textureFaces(target, atlas);
  let unsupported = '';
  if (!faces.size) {
    unsupported = model.format === 'fbx'
      ? 'This binding has no UVs. Generate a UV atlas for an eligible FBX or unwrap the source before painting.'
      : 'This binding has no UVs. Unwrap the source GLB and reimport it before painting.';
  } else if ([...faces.values()].some(triangle => triangle.some(p => p.x < -1e-6 || p.x > 1 + 1e-6 || p.y < -1e-6 || p.y > 1 + 1e-6))) {
    unsupported = 'The transformed UVs extend outside the image. Remap them into 0–1 before painting repeated or mirrored copies.';
  } else if (![...faces.values()].some(triangle => Math.abs(area(triangle)) > 1e-12)) {
    unsupported = 'This binding has no usable UV triangles.';
  }
  const shared = target.shared.filter(binding => binding !== target.binding).flatMap(binding =>
    [...textureFaces({ ...target, binding }, atlas).values()]);
  return { faces, shared, unsupported, overlap: !unsupported && textureOverlap(target, atlas) };
}

export function paintView(adapter: ModelAdapter, target: TextureTarget | undefined, uv: ReadonlyMap<number, UvTriangle>, camera: Camera,
  width: number, height: number, weights?: { object: string; xray: boolean }, selection?: { through: boolean; includes(mesh: Mesh): boolean }): View {
  type MutableFace = Omit<Face, 'island' | 'edges'> & { root: number; stable: string; edges: Triple<Link[]> };
  const { model } = adapter;
  camera.updateMatrixWorld();
  model.scene.updateMatrixWorld(true);
  const projection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const faces: MutableFace[] = [];
  for (const [object, mesh] of adapter.objects) {
    if (!(mesh instanceof Mesh) || !visible(mesh) || selection && !selection.includes(mesh)) continue;
    // A skinned bounding box can outlive its original pose. Sample the same
    // morphed and skinned positions used by Three.js in the current frame.
    const geometry = mesh.geometry, index = geometry.index, positions = geometry.getAttribute('position');
    if (mesh instanceof SkinnedMesh) mesh.skeleton.update();
    const edited = adapter.mesh.render.get(object)?.render;
    const topology = adapter.workingTopology(object)!;
    const ids = edited?.renderVertices ?? (model.format === 'fbx' ? renderControlPoints(sourceMesh(geometry)) : undefined);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const count = index?.count ?? positions.count;
    const groups = geometry.groups.length && Array.isArray(mesh.material)
      ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    const point = new Vector3(), projected = new Vector4();
    const points = new Map<number, { world: Vec3; clip: Face['clip'][number] }>();
    const orientation = Math.sign(mesh.matrixWorld.determinant());
    const edges = new Map<string, { face: number; from: number; to: number; i: number }[]>();
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material?.visible) continue;
      const end = Math.min(count, group.start + group.count);
      for (let i = group.start; i + 2 < end; i += 3) {
        const world = [] as Vec3[], clip = [] as Face['clip'][number][], keys: number[] = [];
        for (const corner of corners) {
          const vertex = index?.getX(i + corner) ?? i + corner;
          let sample = points.get(vertex);
          if (!sample) {
            mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld);
            projected.set(point.x, point.y, point.z, 1).applyMatrix4(projection);
            sample = { world: [point.x, point.y, point.z], clip: [projected.x, projected.y, projected.z, projected.w] };
            points.set(vertex, sample);
          }
          world.push(sample.world);
          clip.push(sample.clip);
          keys.push(ids?.[i + corner] ?? vertex);
        }
        const id = faces.length;
        const mapped = target && mesh === target.binding.mesh && (group.materialIndex ?? 0) === target.binding.slot ? uv.get(i / 3) : undefined;
        const polygon = topology.renderFaces[i / 3];
        const face: MutableFace = { world: world as unknown as Face['world'], clip: clip as unknown as Face['clip'],
          uv: mapped, edges: [[], [], []], root: id, stable: `${object}/triangle/${i / 3}`, source: `${object}/face/${edited?.faceIds[polygon] ?? polygon}`,
          material: material.name || `${mesh.name || object} material ${(group.materialIndex ?? 0) + 1}`,
          orientation, side: selection?.through || weights?.object === object && weights.xray ? 2 : material.side,
          vertices: selection || weights?.object === object ? [keys[0], keys[1], keys[2]] : undefined };
        faces.push(face);
        if (!mapped) continue;
        for (const edge of corners) {
          const from = keys[edge], to = keys[(edge + 1) % 3];
          if (from === to) continue;
          const key = from < to ? `${from}/${to}` : `${to}/${from}`;
          const list = edges.get(key);
          const entry = { face: id, from, to, i: edge };
          if (list) list.push(entry);
          else edges.set(key, [entry]);
        }
      }
    }
    for (const list of edges.values()) {
      for (const a of list) for (const b of list) {
        if (a.face === b.face) continue;
        const same = a.from === b.from, i = same ? b.i : (b.i + 1) % 3, j = same ? (b.i + 1) % 3 : b.i;
        faces[a.face].edges[a.i].push({ face: b.face, a: i, b: j });
        const ua = faces[a.face].uv!, ub = faces[b.face].uv!;
        const match = (u: number, v: number) => Math.abs(ua[u].x - ub[v].x) < 1e-6 && Math.abs(ua[u].y - ub[v].y) < 1e-6;
        if (match(a.i, i) && match((a.i + 1) % 3, j)) {
          const first = root(a.face), second = root(b.face);
          faces[Math.max(first, second)].root = Math.min(first, second);
        }
      }
    }
  }
  return { width, height, faces: faces.map(face => ({ ...face, island: faces[root(face.root)].stable })) };

  function root(id: number): number {
    while (faces[id].root !== id) {
      faces[id].root = faces[faces[id].root].root;
      id = faces[id].root;
    }
    return id;
  }
}

function visible(object: Object3D) {
  for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}
