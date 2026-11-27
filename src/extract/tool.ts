import { Mesh, Raycaster, Vector2, type BufferGeometry } from 'three';
import type { MeshData } from '../mesh/data';
import { renderMesh } from '../mesh/render';
import type { ModelAdapter } from '../project/adapter';
import type { WorkingState } from '../project/state';
import type { Viewer } from '../project/viewer';
import { components, cutBoundaries, type Candidate, type ExtractOptions } from './build';

const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`extract-${id}`)! as T;
const choice = (id: string) => ui<HTMLSelectElement>(id).value;
const input = (id: string) => ui<HTMLInputElement>(id);
const button = (id: string) => ui<HTMLButtonElement>(id);

interface Context { adapter: ModelAdapter; state: WorkingState; object: string; revision: number }
interface QueueEntry extends Candidate { included: boolean }
interface Actions {
  create(object: string, revision: number, candidates: Candidate[], options: ExtractOptions): Promise<boolean>;
  export(objects: string[], batch: boolean): Promise<boolean>;
}

export class ExtractTool {
  #panel = ui<HTMLFieldSetElement>('tools');
  #context?: Context;
  #mesh?: Mesh;
  #data?: MeshData;
  #picked = new Set<number>();
  #components: number[][] = [];
  #byFace = new Map<number, number[]>();
  #queue: QueueEntry[] = [];
  #excluded = new Set<string>();
  #preview?: BufferGeometry;
  #pickingPivot = false;

  constructor(readonly viewer: Viewer, readonly canvas: HTMLCanvasElement, readonly actions: Actions) {
    ui('selection').addEventListener('change', () => { this.#picked.clear(); this.#update(); });
    ui('face-apply').addEventListener('click', () => this.#faceInput());
    input('preview').addEventListener('change', () => this.#update());
    button('queue').addEventListener('click', () => this.#enqueue(this.#selection()));
    button('queue-components').addEventListener('click', () => {
      if (this.#queue.length + this.#components.length > 64) return this.#say('Choose components to group. The queue accepts at most 64 output groups.');
      this.#queue.push(...this.#components.map((faces, i) => ({ name: `${input('name').value} ${i + 1}`, faces, included: true })));
      this.#renderQueue();
    });
    button('pick').addEventListener('click', () => {
      this.#pickingPivot = !this.#pickingPivot;
      button('pick').setAttribute('aria-pressed', String(this.#pickingPivot));
      if (this.#pickingPivot) this.#say('Click the desired pivot position on the mesh.');
    });
    button('create').addEventListener('click', () => void this.#create(false));
    button('create-batch').addEventListener('click', () => void this.#create(true));
    button('export').addEventListener('click', () => void this.actions.export([this.#context!.object], false));
    button('export-batch').addEventListener('click', () => {
      const ids = Object.keys(this.#context?.state.extracts ?? {}).filter(id => !this.#excluded.has(id));
      void this.actions.export(ids, true);
    });
  }

  configure(context: Context | undefined, busy: boolean) {
    this.#panel.hidden = !context;
    this.#panel.disabled = busy;
    const prior = this.#context;
    this.#context = context;
    if (prior?.adapter === context?.adapter && prior?.object === context?.object && prior?.revision === context?.revision) return;
    if (prior?.adapter !== context?.adapter) {
      this.#excluded.clear();
    }
    this.#data = undefined;
    const node = context?.adapter.objects.get(context.object);
    this.#mesh = node instanceof Mesh ? node : undefined;
    this.#picked.clear();
    this.#queue = [];
    this.#components = [];
    this.#byFace.clear();
    input('preview').checked = false;
    this.#pickingPivot = false;
    button('pick').setAttribute('aria-pressed', 'false');
    if (context && this.#mesh) {
      input('name').value = `${context.state.objects[context.object]?.name ?? (this.#mesh.name || 'Mesh')} part`.slice(0, 116);
      (ui<HTMLSelectElement>('selection')).value = 'all';
      try {
        context.adapter.mesh.validateExtract(context.object);
        this.#data = context.adapter.mesh.data(context.object);
        this.#components = components(this.#data);
        for (const group of this.#components) for (const id of group) this.#byFace.set(id, group);
        this.#say('');
      } catch (error) { this.#say(error); }
    } else this.#say(context ? 'Select a mesh to extract.' : '');
    this.#renderComponents();
    this.#renderQueue();
    this.#renderAssets();
    this.#update();
  }

  pick(event: PointerEvent) {
    const mesh = this.#mesh, data = this.#data, context = this.#context, camera = this.viewer.camera;
    if (!mesh || !data || !context || !camera) return;
    const box = this.canvas.getBoundingClientRect(), ray = new Raycaster();
    ray.setFromCamera(new Vector2(2 * (event.clientX - box.left) / box.width - 1, 1 - 2 * (event.clientY - box.top) / box.height), camera);
    const hits = ray.intersectObject(mesh, false);
    const working = context.adapter.mesh.render.get(context.object)?.render;
    const topology = context.adapter.workingTopology(context.object)!;
    const id = (triangle: number) => working?.faceIds[topology.renderFaces[triangle]] ?? topology.renderFaces[triangle];
    const selection = new Set(this.#selection());
    const hit = hits.find(hit => hit.faceIndex != null && (!this.#preview || selection.has(id(hit.faceIndex))));
    if (hit?.faceIndex == null) return;
    if (this.#pickingPivot) {
      mesh.worldToLocal(hit.point).toArray().forEach((value, axis) => { input('xyz'[axis]).value = String(value); });
      ui<HTMLSelectElement>('pivot').value = 'point';
      this.#pickingPivot = false;
      button('pick').setAttribute('aria-pressed', 'false');
      this.#say('Pivot point selected.');
      return;
    }
    if (choice('selection') === 'all') return;
    const face = id(hit.faceIndex);
    if (!event.shiftKey) this.#picked.clear();
    this.#toggle(choice('selection') === 'faces' ? [face] : this.#byFace.get(face) ?? []);
  }

  #selection() {
    return choice('selection') === 'all' ? this.#data?.faces.map(face => face.id) ?? [] : [...this.#picked];
  }

  #toggle(faces: readonly number[]) {
    const remove = faces.every(id => this.#picked.has(id));
    for (const id of faces) {
      if (remove) this.#picked.delete(id);
      else this.#picked.add(id);
    }
    this.#update();
  }

  #faceInput() {
    try {
      const ids = new Set<number>();
      for (const term of input('faces').value.trim().split(/[,\s]+/)) {
        const range = /^(\d+)(?:[-–](\d+))?$/.exec(term);
        if (!range) throw new Error('Enter face IDs or ranges, for example 3, 5, 9–14.');
        const a = Number(range[1]), b = range[2] === undefined ? a : Number(range[2]);
        if (a > b || b - a > 200000) throw new Error('Enter a valid face ID range.');
        for (let id = a; id <= b; id++) {
          if (!this.#byFace.has(id)) throw new Error(`Face ${id} does not exist on this mesh.`);
          ids.add(id);
        }
      }
      ui<HTMLSelectElement>('selection').value = 'faces';
      this.#picked = ids;
      this.#say('');
      this.#update();
    } catch (error) { this.#say(error); }
  }

  #renderComponents() {
    ui('components').replaceChildren(...this.#components.slice(0, 256).map((faces, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = `Component ${i + 1} · ${faces.length} faces`;
      item.dataset.component = String(i);
      item.addEventListener('click', () => {
        ui<HTMLSelectElement>('selection').value = 'components';
        this.#toggle(faces);
      });
      return item;
    }));
    if (this.#components.length > 256) ui('components').append('Use the viewport or face IDs for components beyond the first 256.');
  }

  #enqueue(faces: number[]) {
    if (!faces.length || this.#queue.length >= 64) return this.#say('Select faces and keep at most 64 queued groups.');
    this.#queue.push({ name: input('name').value, faces, included: true });
    this.#renderQueue();
  }

  #renderQueue() {
    ui('queue-list').replaceChildren(...this.#queue.map((candidate, i) => {
      const row = document.createElement('div'), checked = document.createElement('input'), name = document.createElement('input');
      row.className = 'actions';
      checked.type = 'checkbox';
      checked.setAttribute('aria-label', `Include group ${i + 1}`);
      checked.checked = candidate.included;
      checked.onchange = () => { candidate.included = checked.checked; this.#updateButtons(); };
      name.value = candidate.name;
      name.maxLength = 120;
      name.setAttribute('aria-label', `Name for group ${i + 1}`);
      name.oninput = () => { candidate.name = name.value; };
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.textContent = 'Preview group';
      preview.onclick = () => {
        ui<HTMLSelectElement>('selection').value = 'faces';
        this.#picked = new Set(candidate.faces);
        input('preview').checked = true;
        this.#update();
      };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.onclick = () => { this.#queue.splice(i, 1); this.#renderQueue(); };
      row.append(checked, name, `${candidate.faces.length} faces`, preview, remove);
      return row;
    }));
    this.#updateButtons();
  }

  #renderAssets() {
    const context = this.#context;
    ui('assets').replaceChildren(...Object.keys(context?.state.extracts ?? {}).map(id => {
      const item = document.createElement('label'), checked = document.createElement('input');
      checked.type = 'checkbox';
      checked.checked = !this.#excluded.has(id);
      checked.onchange = () => {
        if (checked.checked) this.#excluded.delete(id);
        else this.#excluded.add(id);
        this.#updateButtons();
      };
      item.append(checked, context!.state.objects[id]?.name ?? id);
      return item;
    }));
  }

  #update() {
    const ids = this.#selection(), data = this.#data, mesh = this.#mesh, selected = new Set(ids);
    for (const item of ui('components').querySelectorAll('button')) {
      item.setAttribute('aria-pressed', String(this.#components[Number(item.dataset.component)].every(id => selected.has(id))));
    }
    const boundaries = data && cutBoundaries(data, selected);
    const count = data && this.#components.filter(group => group.some(id => selected.has(id))).length;
    ui('selection-info').textContent = boundaries ?
      `${ids.length} faces in ${count} components · ${boundaries.open} existing boundary edges · ${boundaries.cut} edges exposed by the selection. Repair can close openings on the copied geometry.` : '';
    this.#preview?.dispose();
    this.#preview = data && mesh && ids.length && input('preview').checked
      ? renderMesh({ ...data, faces: data.faces.filter(face => selected.has(face.id)) }, mesh.geometry).geometry : undefined;
    this.viewer.inspect(mesh, this.#preview);
    this.#updateButtons();
  }

  #updateButtons() {
    const context = this.#context;
    button('create').disabled = !this.#selection().length;
    button('queue').disabled = button('create').disabled;
    button('queue-components').disabled = !this.#data;
    button('create-batch').disabled = !this.#queue.some(group => group.included);
    button('export').disabled = !context?.state.extracts?.[context.object];
    button('export-batch').disabled = !Object.keys(context?.state.extracts ?? {}).some(id => !this.#excluded.has(id));
  }

  async #create(batch: boolean) {
    if (!this.#context || !this.#data) return;
    const { object, revision } = this.#context;
    try {
      const padding = input('padding').valueAsNumber;
      if (!Number.isInteger(padding) || padding < 0 || padding > 64) throw new Error('Use an integer padding from 0 to 64 pixels.');
      const groups = batch ? this.#queue.filter(candidate => candidate.included).map(({ name, faces }) => ({ name, faces }))
        : [{ name: input('name').value, faces: this.#selection() }];
      await this.actions.create(object, revision, groups, {
        independent: choice('kind') === 'independent', cut: choice('copy') === 'cut',
        layout: choice('layout') as ExtractOptions['layout'], pivot: choice('pivot') as ExtractOptions['pivot'],
        point: ['x', 'y', 'z'].map(axis => input(axis).valueAsNumber) as [number, number, number],
        rotation: ['rx', 'ry', 'rz'].map(axis => input(axis).valueAsNumber) as [number, number, number],
        scale: input('scale').valueAsNumber, size: Number(choice('size')), padding, rotate: true, equalize: false,
        zeroOrigin: input('origin').checked, fillMissing: input('fill').checked,
      });
    } catch (error) { this.#say(error); }
  }

  #say(value: unknown) { ui('info').textContent = value instanceof Error ? value.message : String(value); }
}
