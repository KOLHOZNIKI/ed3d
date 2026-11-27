import { edgeKey } from '../mesh/data';
import { cross, editUv, inspectLayout, read, type groups, type Layout, type Pair, type Surface } from './layout';

export interface EdgeSide {
  readonly key: string;
  readonly triangle: number;
}

export function stitchEdge(surface: Surface, layout: Layout, picked: EdgeSide, grouping: ReturnType<typeof groups>): Layout {
  const sides = grouping.sides.get(picked.key);
  if (sides?.length !== 2) throw new Error('Stitch UV edge requires exactly two faces on a shared mesh edge.');
  const anchor = sides.findIndex(([corner]) => Math.floor(corner / 3) === picked.triangle);
  if (anchor < 0) throw new Error('Select the UV edge on the side you want to keep fixed.');
  const fixed = sides[anchor], moving = sides[1 - anchor];
  const targetTriangle = Math.floor(moving[0] / 3), slot = surface.slots[picked.triangle];
  if (surface.faces[picked.triangle] === surface.faces[targetTriangle]) throw new Error('Stitch requires an edge between distinct mesh faces.');
  if (surface.slots[targetTriangle] !== slot) throw new Error('Stitch requires both sides to use the same material.');
  const fixedForward = nextCorner(fixed[0]) === fixed[1], movingForward = nextCorner(moving[0]) === moving[1];
  if (fixedForward === movingForward) {
    throw new Error('Stitch requires opposite winding along the shared mesh edge.');
  }

  const changes = new Map<number, Pair>();
  const triangles = new Set<number>();
  for (const [endpoint, corner] of moving.entries()) {
    if (sameUv(layout.uv, fixed[endpoint], corner)) continue;
    const group = grouping.vertices.get(grouping.vertexOf(corner))!;
    const uv = read(layout.uv, fixed[endpoint]);
    for (const member of group) {
      const triangle = Math.floor(member / 3);
      if (surface.slots[triangle] !== slot) throw new Error('Stitch would move a UV vertex used by another material.');
      changes.set(member, uv);
      triangles.add(triangle);
    }
  }
  const seams = new Set(layout.seams);
  if (!changes.size && !seams.has(picked.key)) throw new Error('The selected UV edge is already continuous.');
  seams.delete(picked.key);
  if (!changes.size) return { ...layout, seams: [...seams] };

  const next = editUv(layout, new Set(changes.keys()), (_u, _v, corner) => changes.get(corner)!);
  for (const triangle of triangles) {
    const start = triangle * 3;
    const before = signedArea(layout.uv, start), after = signedArea(next.uv, start);
    if (Math.abs(after) <= 1e-12 || before * after <= 0) throw new Error('Stitch would collapse or flip a UV triangle.');
  }
  const { conflicts } = inspectLayout(next.uv, false);
  if ([...triangles].some(triangle => conflicts.has(triangle))) throw new Error('Stitch would leave overlapping UVs on an edited face.');

  // Keep other discontinuities even if moving an endpoint makes both sides coincide.
  for (const triangle of triangles) for (let i = triangle * 3; i < triangle * 3 + 3; i++) {
    const key = edgeKey(surface.points[i], surface.points[nextCorner(i)]);
    const neighbors = grouping.sides.get(key);
    if (key === picked.key || seams.has(key) || neighbors?.length !== 2) continue;
    const [[a, b], [c, d]] = neighbors;
    if (!(sameUv(layout.uv, a, c) && sameUv(layout.uv, b, d)) && sameUv(next.uv, a, c) && sameUv(next.uv, b, d)) seams.add(key);
  }
  return { ...next, seams: [...seams] };
}

const nextCorner = (corner: number) => corner % 3 === 2 ? corner - 2 : corner + 1;
const sameUv = (uv: Float32Array, a: number, b: number) => uv[a * 2] === uv[b * 2] && uv[a * 2 + 1] === uv[b * 2 + 1];
const signedArea = (uv: Float32Array, start: number) => cross(read(uv, start), read(uv, start + 1), read(uv, start + 2));
