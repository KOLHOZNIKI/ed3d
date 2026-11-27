import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, Vector2, Vector3 } from 'three';
import type { ModelAdapter } from '../project/adapter';
import type { Viewer } from '../project/viewer';
import { edgeKey, edgesOf, type MeshData, type Vec3 } from '../mesh/data';
import { vector } from '../mesh/polygon';
import { authoredKeepOpen, boundaryContours, boundaryPlane, type Boundary } from './boundaries';
import type { Fill, FillMethod } from './fill';
import { planRepair } from './plan';

const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`repair-${id}`)! as T;
const choice = (id: string) => ui<HTMLSelectElement>(id).value;
const toggle = (id: string) => ui<HTMLInputElement>(id).checked;
const number = (id: string) => ui<HTMLInputElement>(id).valueAsNumber;
const xyz = ['x', 'y', 'z'] as const;

interface Context {
  adapter: ModelAdapter;
  object: string;
  revision: number;
  flags?: Readonly<Record<string, boolean>>;
  blocked: boolean;
}

interface Actions {
  keep(object: string, id: string, value: boolean, revision: number): void;
  apply(object: string, patches: Fill[], revision: number): Promise<boolean>;
  manual(vertices: readonly number[], project: boolean, material: string): void;
  selectFaces(ids: number[]): void;
  uvFaces(ids: number[]): void;
  paintFaces(object: string, ids: number[]): void;
}

export class RepairTool {
  #panel = ui<HTMLFieldSetElement>('tools');
  #overlay = new Group();
  #colors = [0x68abbf, 0x39ffef, 0x72e783, 0xf79456, 0xffc854]
    .map(color => new LineBasicMaterial({ color, depthTest: false }));
  #selected = new Set<string>();
  #kept = new Set<string>();
  #context?: Context;
  #data?: MeshData;
  #mesh?: Mesh;
  #contours: Boundary[] = [];
  #preview?: { plan: ReturnType<typeof planRepair>; revision: number };
  #recent?: { adapter: ModelAdapter; object: string; faces: number[]; paint: number[] };
  #locked = false;

  constructor(readonly viewer: Viewer, readonly canvas: HTMLCanvasElement, readonly actions: Actions) {
    this.#overlay.renderOrder = 10;
    viewer.scene.add(this.#overlay);
    for (const id of ['method', 'project', 'material', 'tolerance', 'custom', ...xyz, 'scope', 'max-edges',
      'max-diameter', 'allow-planar', 'allow-fan', 'density', 'iterations', 'grid-corners', 'start-a', 'start-b',
      'twist', 'segments', 'span', 'reverse']) {
      ui(id).addEventListener('input', () => this.#invalidate());
    }
    ui('preview').addEventListener('click', () => this.#prepare(false));
    ui('auto').addEventListener('click', () => this.#prepare(true));
    ui('apply').addEventListener('click', () => void this.#apply());
    ui('cancel').addEventListener('click', () => this.#invalidate());
    ui('manual').addEventListener('click', () => {
      const loop = this.#singleLoop();
      if (!loop || !this.#data || this.#kept.has(loop.id)) return;
      const adjacent = edgesOf(this.#data).get(edgeKey(loop.vertices[0], loop.vertices[1]))?.[0].face.material ?? 0;
      actions.manual(loop.vertices, toggle('project'), choice('material') || String(adjacent));
    });
    ui('select-new').addEventListener('click', () => {
      if (this.#recent) actions.selectFaces(this.#recent.faces);
    });
    ui('uv-new').addEventListener('click', () => {
      if (this.#recent) actions.uvFaces(this.#recent.faces);
    });
    ui('paint-new').addEventListener('click', () => {
      if (this.#recent) actions.paintFaces(this.#recent.object, this.#recent.paint);
    });
  }

  configure(context: Context | undefined, locked: boolean) {
    const previous = this.#context;
    this.#context = context;
    this.#locked = locked;
    this.#panel.hidden = !context;
    this.#panel.disabled = locked;
    if (!context) {
      if (previous) {
        this.#preview = this.#data = this.#mesh = undefined;
        this.#contours = [];
        this.#clearOverlay();
        this.viewer.render();
      }
      return;
    }
    if (previous?.adapter !== context.adapter || previous?.object !== context.object || previous?.blocked !== context.blocked) {
      this.#selected.clear();
      ui<HTMLInputElement>('custom').checked = false;
      if (this.#recent?.adapter !== context.adapter || this.#recent.object !== context.object) this.#recent = undefined;
    }
    if (previous?.adapter === context.adapter && previous.object === context.object &&
        previous.revision === context.revision && previous.blocked === context.blocked) return;
    this.#preview = undefined;
    const node = context.adapter.objects.get(context.object);
    const data = !context.blocked && node instanceof Mesh ? this.#getData(context) : undefined;
    if (this.#data !== data) {
      this.#data = data;
      this.#contours = data ? boundaryContours(data) : [];
    }
    this.#mesh = data && node instanceof Mesh ? node : undefined;
    this.#kept = new Set(this.#contours.filter(contour =>
      context.flags?.[contour.id] ?? authoredKeepOpen(contour, node?.userData.protectedLoop)).map(contour => contour.id));
    const valid = new Set(this.#contours.map(contour => contour.id));
    this.#selected = new Set([...this.#selected].filter(id => valid.has(id)));
    if (this.#recent && (!data || this.#recent.faces.some(id => !data.faces.some(face => face.id === id)))) this.#recent = undefined;
    if (this.#mesh) {
      const list = Array.isArray(this.#mesh.material) ? this.#mesh.material : [this.#mesh.material];
      const selector = ui<HTMLSelectElement>('material'), wanted = selector.value;
      selector.replaceChildren(new Option('Adjacent material', ''), ...list.map((material, i) => new Option(material.name || `Slot ${i + 1}`, String(i))));
      if ([...selector.options].some(option => option.value === wanted)) selector.value = wanted;
    }
    this.#populate();
    this.#draw();
  }

  keyboard(key: string) {
    if (!this.#context || this.#locked) return false;
    if (key === 'Escape' && this.#preview) { this.#invalidate(); return true; }
    if (key === 'Enter') {
      if (this.#preview?.plan.fills.length) void this.#apply();
      else this.#prepare(false);
      return true;
    }
    return false;
  }

  pick(event: PointerEvent) {
    const data = this.#data, camera = this.viewer.camera, mesh = this.#mesh;
    if (!data || !camera || !mesh || this.#locked) return false;
    const rect = this.canvas.getBoundingClientRect(), target = new Vector2(event.clientX - rect.left, event.clientY - rect.top);
    let picked: string | undefined, distance = 12 ** 2, depth = Infinity;
    mesh.updateWorldMatrix(true, false);
    const points = new Map<number, { screen: Vector2; z: number }>();
    const project = (id: number) => {
      let value = points.get(id);
      if (!value) {
        const p = vector(data, id).applyMatrix4(mesh.matrixWorld).project(camera);
        value = { screen: new Vector2((1 + p.x) * rect.width / 2, (1 - p.y) * rect.height / 2), z: p.z };
        points.set(id, value);
      }
      return value;
    };
    for (const contour of this.#contours) for (const [a, b] of contour.edges) {
      const start = project(a), end = project(b);
      const along = end.screen.clone().sub(start.screen);
      const t = Math.min(1, Math.max(0, target.clone().sub(start.screen).dot(along) / (along.lengthSq() || 1)));
      const d = start.screen.clone().addScaledVector(along, t).distanceToSquared(target), z = start.z * (1 - t) + end.z * t;
      if (z < -1 || z > 1 || d > distance || d === distance && z >= depth) continue;
      picked = contour.id;
      distance = d;
      depth = z;
    }
    if (!picked) return false;
    if (!event.shiftKey && !this.#selected.has(picked)) this.#selected.clear();
    this.#select(picked, !this.#selected.has(picked));
    return true;
  }

  #getData(context: Context) {
    try { return context.adapter.mesh.data(context.object); }
    catch { return undefined; }
  }

  #singleLoop() {
    return this.#selected.size === 1 ? this.#contours.find(contour => contour.kind === 'loop' && this.#selected.has(contour.id)) : undefined;
  }

  #select(id: string, checked: boolean) {
    if (checked) this.#selected.add(id);
    else this.#selected.delete(id);
    const loop = this.#singleLoop();
    if (loop && this.#data) {
      const origin = boundaryPlane(this.#data, loop.vertices, loop.diameter).origin.toArray();
      xyz.forEach((key, i) => { ui<HTMLInputElement>(key).value = String(origin[i]); });
    }
    this.#invalidate();
  }

  #prepare(automatic: boolean) {
    const context = this.#context, data = this.#data;
    if (!context || !data || this.#locked) return;
    this.#preview = undefined;
    try {
      const tolerance = number('tolerance') / 100;
      if (!(tolerance >= 0 && tolerance <= 1)) throw new Error('Enter a planarity tolerance from 0 to 100%.');
      const selected = automatic && choice('scope') === 'object' ? undefined : this.#selected;
      if (selected && !selected.size) throw new Error('Select at least one contour.');
      const method = choice('method') as FillMethod;
      const methods: FillMethod[] = automatic ? [] : [method];
      if (automatic && toggle('allow-planar')) methods.push('planar');
      if (automatic && toggle('allow-fan')) methods.push('fan');
      if (!methods.length) throw new Error('Allow at least one method for Auto Fill.');
      const maxEdges = number('max-edges'), maxDiameter = number('max-diameter');
      if (automatic && (!Number.isInteger(maxEdges) || maxEdges < 3 || !(maxDiameter >= 0))) {
        throw new Error('Enter a whole edge limit of at least 3 and a nonnegative diameter limit.');
      }
      let center: Vec3 | undefined;
      if (!automatic && method === 'fan' && toggle('custom')) {
        if (!this.#singleLoop()) throw new Error('Select one simple contour for a custom Fan center.');
        center = [number('x'), number('y'), number('z')];
        if (!center.every(Number.isFinite)) throw new Error('Enter finite X, Y and Z coordinates.');
      }
      const material = choice('material');
      const whole = (name: string, min: number, max: number) => {
        const value = number(name);
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Choose a whole number between ${min} and ${max} for the repair parameter.`);
        return value;
      };
      const smooth = !automatic && method === 'smooth' ? { density: whole('density', 1, 3), iterations: whole('iterations', 0, 50) } : undefined;
      const corners = ui<HTMLInputElement>('grid-corners').value.trim();
      const grid = !automatic && method === 'grid' ? { corners: corners ? corners.split(/[\s,]+/).map(Number) : undefined } : undefined;
      const bridge = !automatic && method === 'bridge' ? { other: '', startA: whole('start-a', 0, 255),
        startB: ui<HTMLInputElement>('start-b').value ? whole('start-b', 0, 255) : undefined,
        twist: whole('twist', -255, 255), segments: whole('segments', 1, 16), span: whole('span', 0, 255), reverse: toggle('reverse') } : undefined;
      const plan = planRepair(data, this.#contours, { selected, protected: this.#kept, methods, tolerance,
        auto: automatic ? { maxEdges, maxDiameter } : undefined, center, smooth, grid, bridge, project: toggle('project'),
        material: material ? Number(material) : undefined });
      this.#preview = { plan, revision: context.revision };
      this.#populate();
      this.#draw();
    } catch (error) {
      this.#populate();
      this.#draw();
      this.#say(error instanceof Error ? error.message : String(error));
    }
    this.canvas.focus({ preventScroll: true });
  }

  async #apply() {
    const context = this.#context, preview = this.#preview;
    if (!context || !preview?.plan.fills.length || this.#locked) return;
    const added = preview.plan.mesh.faces.slice(this.#data!.faces.length);
    if (!await this.actions.apply(context.object, preview.plan.fills, preview.revision)) return;
    this.#recent = { adapter: context.adapter, object: context.object, faces: added.map(face => face.id),
      paint: added.filter(face => !face.needsUv).map(face => face.id) };
    this.#populate();
    this.#draw();
  }

  #invalidate() {
    this.#preview = undefined;
    this.#populate();
    this.#draw();
  }

  #populate() {
    const body = ui('contours'), active = document.activeElement?.id, nodes: HTMLElement[] = [];
    for (const contour of this.#contours) {
      const row = document.createElement('tr');
      const check = document.createElement('input'), label = document.createElement('label');
      const status = this.#preview?.plan.decisions.get(contour.id) ?? contour.reason ?? 'Open';
      row.dataset.contour = contour.id;
      check.type = 'checkbox';
      check.id = `pick-${contour.id}`;
      check.checked = this.#selected.has(contour.id);
      check.addEventListener('change', () => this.#select(contour.id, check.checked));
      label.append(check, ` ${contour.id}`);
      row.append(cell(label), cell(contour.kind), cell(String(contour.edges.length)), cell(format(contour.perimeter)),
        cell(`${contour.approximate ? '≈' : ''}${format(contour.diameter)}`), cell(contour.deviation === undefined ? '—' : `${(contour.deviation * 100).toFixed(2)}%`));
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.id = `keep-${contour.id}`;
      keep.textContent = this.#kept.has(contour.id) ? 'On' : 'Off';
      keep.disabled = contour.kind !== 'loop';
      keep.setAttribute('aria-pressed', String(this.#kept.has(contour.id)));
      keep.setAttribute('aria-label', `Keep ${contour.id} open`);
      keep.addEventListener('click', () => {
        if (this.#context) this.actions.keep(this.#context.object, contour.id, !this.#kept.has(contour.id), this.#context.revision);
      });
      row.append(cell(keep), cell(status));
      nodes.push(row);
    }
    body.replaceChildren(...nodes);
    if (active && (active.startsWith('pick-') || active.startsWith('keep-'))) document.getElementById(active)?.focus({ preventScroll: true });
    const ready = this.#contours.length > 0;
    const count = this.#preview?.plan.fills.length;
    const manual = this.#singleLoop();
    ui('center').hidden = choice('method') !== 'fan';
    for (const method of ['smooth', 'grid', 'bridge']) ui(`${method}-settings`).hidden = choice('method') !== method;
    xyz.forEach(id => { ui<HTMLInputElement>(id).disabled = !toggle('custom'); });
    ui<HTMLButtonElement>('preview').disabled = !ready;
    ui<HTMLButtonElement>('auto').disabled = !ready;
    ui<HTMLButtonElement>('manual').disabled = !manual || this.#kept.has(manual.id);
    ui<HTMLButtonElement>('apply').disabled = !count;
    ui<HTMLButtonElement>('cancel').disabled = count === undefined;
    ui('select-new').hidden = !this.#recent;
    ui('uv-new').hidden = !this.#recent;
    ui('paint-new').hidden = !this.#recent?.paint.length;
    if (count !== undefined) {
      const uv = toggle('project') ? 'New faces have no source texture. Projected UVs may share existing texels.' : 'New faces have no source texture and require UV review.';
      const used = this.#preview!.plan.fills.reduce((total, fill) => total + (fill.method === 'bridge' ? 2 : 1), 0);
      this.#say(`Preview · ${count} to fill · ${this.#contours.length - used} skipped.${count ? ` ${uv}` : ''}`);
    } else if (this.#context?.blocked) this.#say('Discard the generated atlas through the UV tools before repairing the mesh.');
    else if (!this.#data) this.#say(this.#context?.object ? 'The selected mesh does not support topology editing.' : 'Select a mesh object.');
    else if (!ready) this.#say('This object has no open boundaries.');
    else this.#say(`${this.#contours.length} contours · ${this.#selected.size} selected · ${this.#kept.size} Keep Open. Length and diameter use mesh-local units.`);
  }

  #clearOverlay() {
    for (const child of this.#overlay.children) (child as LineSegments).geometry.dispose();
    this.#overlay.clear();
  }

  #draw() {
    this.#clearOverlay();
    const data = this.#data, node = this.#mesh;
    if (!data || !node) { this.viewer.render(); return; }
    node.updateWorldMatrix(true, false);
    const buffers: number[][] = Array.from({ length: this.#colors.length }, () => []);
    const segment = (buffer: number[], mesh: MeshData, a: number, b: number) => {
      for (const id of [a, b]) buffer.push(...vector(mesh, id).applyMatrix4(node.matrixWorld).toArray());
    };
    for (const contour of this.#contours) {
      const color = contour.kind !== 'loop' ? 3 : this.#kept.has(contour.id) ? 2 : this.#selected.has(contour.id) ? 1 : 0;
      for (const [a, b] of contour.edges) segment(buffers[color], data, a, b);
    }
    const preview = this.#preview?.plan.mesh;
    if (preview) for (const face of preview.faces.slice(data.faces.length)) {
      const ids = face.corners.map(corner => corner.vertex);
      ids.forEach((id, i) => segment(buffers[4], preview, id, ids[(i + 1) % ids.length]));
    }
    for (const [i, values] of buffers.entries()) {
      if (!values.length) continue;
      const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(values, 3));
      this.#overlay.add(new LineSegments(geometry, this.#colors[i]));
    }
    this.viewer.render();
  }

  #say(value: string) { ui('info').textContent = value; }
}

function cell(child: string | HTMLElement) {
  const td = document.createElement('td');
  td.append(child);
  return td;
}

function format(length: number) { return String(Number(length.toPrecision(5))); }
