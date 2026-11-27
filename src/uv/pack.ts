import { bounds, density, groups, type Box, type Layout, type Surface } from './layout';

export interface PackOptions { size: number; padding: number; rotate: boolean; equalize: boolean }
interface Chart { corners: number[]; box: Box; factor: number }
interface Placement { box: Box; rotate: boolean }

export function pack(surface: Surface, layout: Layout, options: PackOptions, selected?: ReadonlySet<number>): Layout {
  const { islands } = groups(surface, layout);
  const gutter = options.padding / options.size;
  const fixed: Box[] = [], charts: Chart[] = [];
  for (const [id, corners] of islands) {
    const box = bounds(layout.uv, corners);
    if (selected && !selected.has(id)) {
      fixed.push({ x0: Math.max(0, box.x0 - gutter), y0: Math.max(0, box.y0 - gutter),
        x1: Math.min(1, box.x1 + gutter), y1: Math.min(1, box.y1 + gutter) });
    } else {
      const scale = density(surface, layout.uv, corners, options.size);
      if (!(scale > 0)) throw new Error('Unwrap degenerate islands before packing.');
      charts.push({ corners, box, factor: options.equalize ? options.size / scale : 1 });
    }
  }
  if (!charts.length) throw new Error('Select one or more UV islands.');
  const width = (chart: Chart) => (chart.box.x1 - chart.box.x0) * chart.factor;
  const height = (chart: Chart) => (chart.box.y1 - chart.box.y0) * chart.factor;
  charts.sort((a, b) => Math.max(width(b), height(b)) - Math.max(width(a), height(a)));
  let best: Placement[] | undefined, lo = 0, hi = 1 / Math.max(...charts.map(chart => Math.max(width(chart), height(chart))));
  for (let attempt = 0; attempt < 22; attempt++) {
    const scale = (lo + hi) / 2;
    let free: Box[] = [{ x0: 0, y0: 0, x1: 1, y1: 1 }];
    for (const box of fixed) free = splitFree(free, box);
    const placed: Placement[] = [];
    for (const chart of charts) {
      const room = fit(free, width(chart) * scale + 2 * gutter, height(chart) * scale + 2 * gutter, options.rotate);
      if (!room) break;
      const { box } = room;
      free = splitFree(free, box);
      placed.push(room);
    }
    if (placed.length === charts.length) { best = placed; lo = scale; }
    else hi = scale;
  }
  if (!best || lo <= 1e-8) throw new Error('The islands cannot fit in one atlas with this padding. Increase resolution, reduce padding or pack all islands.');
  const uv = layout.uv.slice();
  charts.forEach((chart, i) => {
    const { box, rotate } = best![i], scale = lo * chart.factor;
    for (const id of chart.corners) {
      const x = uv[id * 2] - chart.box.x0, y = uv[id * 2 + 1] - chart.box.y0;
      uv[id * 2] = box.x0 + gutter + (rotate ? chart.box.y1 - chart.box.y0 - y : x) * scale;
      uv[id * 2 + 1] = box.y0 + gutter + (rotate ? x : y) * scale;
    }
  });
  return { ...layout, uv };
}

function fit(free: Box[], w: number, h: number, rotate: boolean): Placement | undefined {
  let best: Placement | undefined, score = Infinity;
  for (const available of free) for (const flipped of rotate ? [false, true] : [false]) {
    const width = flipped ? h : w, height = flipped ? w : h;
    const dx = available.x1 - available.x0 - width, dy = available.y1 - available.y0 - height;
    if (dx < 0 || dy < 0) continue;
    const rank = Math.min(dx, dy) + 1e-4 * Math.max(dx, dy);
    if (rank >= score) continue;
    score = rank;
    best = { box: { x0: available.x0, y0: available.y0, x1: available.x0 + width, y1: available.y0 + height }, rotate: flipped };
  }
  return best;
}

function splitFree(free: Box[], used: Box) {
  if (used.x0 >= used.x1 || used.y0 >= used.y1) return free;
  const split: Box[] = [];
  for (const box of free) {
    if (used.x0 >= box.x1 || used.x1 <= box.x0 || used.y0 >= box.y1 || used.y1 <= box.y0) { split.push(box); continue; }
    if (used.x0 > box.x0) split.push({ ...box, x1: used.x0 });
    if (used.x1 < box.x1) split.push({ ...box, x0: used.x1 });
    if (used.y0 > box.y0) split.push({ ...box, y1: used.y0 });
    if (used.y1 < box.y1) split.push({ ...box, y0: used.y1 });
  }
  return split.filter((box, i) => !split.some((other, j) => j !== i &&
    other.x0 <= box.x0 && other.y0 <= box.y0 && other.x1 >= box.x1 && other.y1 >= box.y1 &&
    (j < i || other.x0 < box.x0 || other.y0 < box.y0 || other.x1 > box.x1 || other.y1 > box.y1)));
}
