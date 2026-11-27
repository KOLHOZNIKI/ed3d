import { Matrix4, Mesh, SkinnedMesh, Vector3 } from 'three';
import { renderControlPoints, sourceMesh } from '../e00/fbx-topology';
import { Projection, brushStrength } from '../paint3d/projection';
import type { ModelAdapter } from '../project/adapter';
import type { Point } from '../texture/stroke';
import type { Row } from './data';

export function drawVertices(adapter: ModelAdapter, object: string, mesh: SkinnedMesh) {
  const { geometry } = mesh, index = geometry.index;
  const ids = adapter.mesh.render.get(object)?.render.renderVertices ??
    (adapter.model.format === 'fbx' ? renderControlPoints(sourceMesh(geometry)) : undefined);
  const count = index?.count ?? geometry.getAttribute('position').count;
  const result = new Map<number, number>();
  for (let corner = 0; corner < count; corner++) {
    const i = index?.getX(corner) ?? corner;
    result.set(i, ids?.[corner] ?? i);
  }
  return result;
}

export function sample(projection: Projection, stroke: readonly Point[], radius: number, strength: number,
  hardness: number, xray: boolean, mask?: ReadonlySet<string>) {
  const result = new Map<number, number>();
  const stamp = (p: Point) => {
    for (const face of projection.around({ x0: p.x - radius, y0: p.y - radius, x1: p.x + radius, y1: p.y + radius })) {
      const { vertices, source } = projection.view.faces[face];
      if (!vertices || mask && !mask.has(source) || !xray && !projection.screen[face]?.front) continue;
      for (let i = 0; i < 3; i++) {
        const vertex = vertices[i];
        const bary: [number, number, number] = [0, 0, 0];
        bary[i] = 1;
        const screen = projection.point(face, bary);
        const distance = Math.hypot(p.x - screen.x, p.y - screen.y) / radius;
        const amount = brushStrength(distance, strength, hardness);
        if (amount <= (result.get(vertex) ?? 0)) continue;
        if (xray ? screen.z < -1 || screen.z > 1 : !projection.visible(face, screen)) continue;
        result.set(vertex, amount);
      }
    }
  };
  for (const [i, p] of stroke.entries()) {
    const previous = stroke[i - 1];
    const d = previous ? Math.hypot(p.x - previous.x, p.y - previous.y) : 0;
    if (previous) for (let t = radius / 3; t < d; t += radius / 3) {
      stamp({ x: previous.x + (p.x - previous.x) * t / d, y: previous.y + (p.y - previous.y) * t / d });
    }
    stamp(p);
  }
  return result;
}

export function deformation(mesh: SkinnedMesh, render: ReadonlyMap<number, number>, palette: readonly (string | undefined)[],
  changes: readonly (readonly [number, Row, Row])[]) {
  const matrices = new Map(palette.flatMap((id, i) => id ? [[id, new Matrix4().multiplyMatrices(mesh.skeleton.bones[i].matrixWorld,
    mesh.skeleton.boneInverses[i])]] as const : []));
  const base = new Vector3(), output = new Vector3(), part = new Vector3();
  const logical = new Map([...render].map(([index, id]) => [id, index]));
  const skin = (row: Row) => {
    output.set(0, 0, 0);
    for (const [id, weight] of row) output.addScaledVector(part.copy(base).applyMatrix4(matrices.get(id)!), weight);
    return output.clone().applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
  };
  let max = 0;
  for (const [id, before, after] of changes) {
    if (!before.length) continue;
    // Mesh supplies the current morph position without the SkinnedMesh override.
    Mesh.prototype.getVertexPosition.call(mesh, logical.get(id)!, base).applyMatrix4(mesh.bindMatrix);
    max = Math.max(max, skin(before).distanceTo(skin(after)));
  }
  return max;
}
