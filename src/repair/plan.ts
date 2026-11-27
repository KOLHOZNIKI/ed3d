import type { MeshData } from '../mesh/data';
import type { Boundary } from './boundaries';
import { bridgeBoundaries, fillBoundary, type Fill, type FillMethod } from './fill';

interface Options extends Omit<Fill, 'id' | 'method'> {
  selected?: ReadonlySet<string>;
  protected: ReadonlySet<string>;
  methods: readonly FillMethod[];
  auto?: { maxEdges: number; maxDiameter: number };
}

export function planRepair(source: MeshData, boundaries: readonly Boundary[], options: Options) {
  let mesh = source;
  const fills: Fill[] = [];
  const decisions = new Map<string, string>();
  if (options.methods[0] === 'bridge') {
    const loops = boundaries.filter(contour => options.selected?.has(contour.id));
    if (loops.length !== 2) throw new Error('Select exactly two closed contours for Bridge.');
    const [a, b] = loops;
    const issues = loops.map(contour => ineligible(contour, options)).filter(Boolean);
    if (issues.length) throw new Error(issues.join(' '));
    const fill: Fill = { id: a.id, method: 'bridge', tolerance: options.tolerance, project: options.project,
      material: options.material, bridge: { ...options.bridge!, other: b.id } };
    mesh = bridgeBoundaries(mesh, a, b, fill);
    decisions.set(a.id, `Bridge · ${mesh.faces.length - source.faces.length} new faces`);
    decisions.set(b.id, `Connected to ${a.id}`);
    return { mesh, fills: [fill], decisions };
  }
  for (const contour of boundaries) {
    const skip = ineligible(contour, options);
    if (skip) { decisions.set(contour.id, `Skip · ${skip}`); continue; }
    const failures: string[] = [];
    for (const method of options.methods) {
      const fill: Fill = { id: contour.id, method, tolerance: options.tolerance, project: options.project,
        material: options.material, center: method === 'fan' ? options.center : undefined,
        smooth: method === 'smooth' ? options.smooth : undefined, grid: method === 'grid' ? options.grid : undefined };
      try {
        const before = mesh.faces.length, next = fillBoundary(mesh, contour, fill);
        mesh = next;
        fills.push(fill);
        decisions.set(contour.id, `${method[0].toUpperCase() + method.slice(1)} · ${mesh.faces.length - before} new faces`);
        break;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!decisions.has(contour.id)) decisions.set(contour.id, `Skip · ${failures.join(' ')}`);
  }
  return { mesh, fills, decisions };
}

function ineligible(contour: Boundary, options: Options) {
  if (options.protected.has(contour.id)) return 'Keep Open';
  if (contour.kind !== 'loop') return contour.reason ?? 'Invalid boundary';
  if (options.selected && !options.selected.has(contour.id)) return 'Outside the selection';
  if (!options.auto) return;
  if (contour.edges.length > options.auto.maxEdges) return 'Above the edge limit';
  if (options.auto.maxDiameter > 0 && contour.diameter > options.auto.maxDiameter) return 'Above the diameter limit';
  if (contour.deviation! > options.tolerance) return 'Above the planarity tolerance';
}
