import { area, barycentric, corners, Projection, type Triple, type View } from '../paint3d/projection';
import type { Point } from '../texture/stroke';

export type PickShape = 'click' | 'rectangle' | 'lasso';
export interface ElementSelection { vertices: Set<number>; edges: Set<string>; faces: Set<number>; triangles: Set<number> }

export function selectionPath(shape: Exclude<PickShape, 'click'>, points: readonly Point[]) {
  if (shape === 'lasso') return points;
  const a = points[0], b = points[points.length - 1];
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
}

export class SelectionArea {
  readonly bounds;

  constructor(readonly polygon: readonly Point[]) {
    const x = polygon.map(point => point.x), y = polygon.map(point => point.y);
    this.bounds = { x0: Math.min(...x), x1: Math.max(...x), y0: Math.min(...y), y1: Math.max(...y) };
  }

  contains({ x, y }: Point) {
    if (x < this.bounds.x0 || x > this.bounds.x1 || y < this.bounds.y0 || y > this.bounds.y1) return false;
    let inside = false;
    for (let i = 0, j = this.polygon.length - 1; i < this.polygon.length; j = i++) {
      const a = this.polygon[j], b = this.polygon[i];
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (Math.abs(cross) < 1e-7 && x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) &&
          y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) return true;
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  segment(a: Point, b: Point) {
    if (Math.max(a.x, b.x) < this.bounds.x0 || Math.min(a.x, b.x) > this.bounds.x1 ||
        Math.max(a.y, b.y) < this.bounds.y0 || Math.min(a.y, b.y) > this.bounds.y1) return [];
    const t = [0, 1], x = b.x - a.x, y = b.y - a.y;
    for (let i = 0, j = this.polygon.length - 1; i < this.polygon.length; j = i++) {
      const p = this.polygon[j], q = this.polygon[i], u = q.x - p.x, v = q.y - p.y;
      const dx = p.x - a.x, dy = p.y - a.y, det = x * v - y * u;
      if (Math.abs(det) < 1e-9) continue;
      const from = (dx * v - dy * u) / det, to = (dx * y - dy * x) / det;
      if (from > 0 && from < 1 && to >= 0 && to <= 1) t.push(from);
    }
    t.sort((a, b) => a - b);
    const points = t.flatMap((value, i) => i ? [value, (value + t[i - 1]) / 2] : [value]);
    return points.map(t => ({ x: a.x + x * t, y: a.y + y * t })).filter(point => this.contains(point));
  }

  inTriangle(triangle: Triple<Point>, det: number) {
    const [a, b, c] = triangle;
    if (Math.max(a.x, b.x, c.x) < this.bounds.x0 || Math.min(a.x, b.x, c.x) > this.bounds.x1 ||
        Math.max(a.y, b.y, c.y) < this.bounds.y0 || Math.min(a.y, b.y, c.y) > this.bounds.y1) return [];
    const samples = this.polygon.filter(p => Math.min(...barycentric(triangle, det, p.x, p.y)) >= -1e-8);
    for (const i of corners) samples.push(...this.segment(triangle[i], triangle[(i + 1) % 3]));
    if (samples.length) {
      const middle = { x: samples.reduce((sum, p) => sum + p.x, 0) / samples.length,
        y: samples.reduce((sum, p) => sum + p.y, 0) / samples.length };
      if (this.contains(middle)) samples.unshift(middle);
    }
    return samples;
  }

  overlaps(triangle: Triple<Point>) {
    const det = area(triangle);
    return Math.abs(det) > 1e-9 && this.inTriangle(triangle, det).length > 0;
  }
}

export function projectedSelection(view: View, region: SelectionArea, through: boolean, click?: Point) {
  const projection = new Projection(view);
  const objects = new Map<string, ElementSelection>();
  const filled = (id: number, point: Point) => {
    const { triangle, det, z } = projection.screen[id]!;
    const [a, b, c] = barycentric(triangle, det, point.x, point.y);
    const depth = a * z[0] + b * z[1] + c * z[2];
    return depth >= -1 && depth <= 1 && (through || projection.visible(id, { ...point, z: depth }));
  };
  for (const id of projection.around(region.bounds)) {
    const { stable: triangleId, source, vertices } = view.faces[id];
    if (!triangleId) continue;
    const face = projection.screen[id]!, { triangle, det } = face;
    const faceHit = click ? Math.min(...barycentric(triangle, det, click.x, click.y)) >= -1e-8 && filled(id, click)
      : region.inTriangle(triangle, det).some(point => filled(id, point));
    const [object, , rendered] = triangleId.split('/');
    const [, , stable] = source.split('/');
    const result = objects.get(object) ?? { vertices: new Set(), edges: new Set(), faces: new Set(), triangles: new Set() };
    if (faceHit) { result.faces.add(Number(stable)); result.triangles.add(Number(rendered)); }
    if (vertices) for (const i of corners) {
      const j = (i + 1) % 3, a = vertices[i], b = vertices[j];
      if (region.contains(triangle[i]) && filled(id, triangle[i])) result.vertices.add(a);
      if (region.segment(triangle[i], triangle[j]).some(point => filled(id, point))) result.edges.add(a < b ? `${a}/${b}` : `${b}/${a}`);
    }
    if (result.faces.size || result.vertices.size || result.edges.size) objects.set(object, result);
  }
  return objects;
}

export function drawSelection(ctx: CanvasRenderingContext2D, points: readonly Point[]) {
  if (!points.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.fillStyle = '#58c6ff26';
  ctx.strokeStyle = '#7bdaff';
  ctx.setLineDash([4, 3]);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
