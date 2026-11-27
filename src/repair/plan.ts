import type { MeshData } from '../mesh/data';
import type { Boundary } from './boundaries';
import { fillBoundary, type Fill, type FillMethod } from './fill';

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
  for (const contour of boundaries) {
    const skip = ineligible(contour, options);
    if (skip) { decisions.set(contour.id, `Skip · ${skip}`); continue; }
    const failures: string[] = [];
    for (const method of options.methods) {
      const fill: Fill = { id: contour.id, method, tolerance: options.tolerance, project: options.project,
        material: options.material, center: method === 'fan' ? options.center : undefined };
      try {
        const before = mesh.faces.length, next = fillBoundary(mesh, contour, fill);
        mesh = next;
        fills.push(fill);
        decisions.set(contour.id, `${method === 'planar' ? 'Planar' : 'Fan'} · ${mesh.faces.length - before} new faces`);
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
