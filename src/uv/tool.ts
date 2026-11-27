import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, Mesh, Raycaster, Texture, Triangle, Vector2, Vector3 } from 'three';
import type { Model, ModelAdapter } from '../project/adapter';
import type { Viewer } from '../project/viewer';
import type { WorkingState } from '../project/state';
import { sourceImage, type TextureCatalog, type TextureTarget } from '../texture/bindings';
import { decodeImage, decodePng } from '../texture/image';
import { edgeKey } from '../mesh/data';
import { bounds, cross, density, diagnose, editUv, groups, planar, read, type Layout, type Pair, type Surface } from './layout';
import { pack, type PackOptions } from './pack';
import { autoUnwrap, currentLayout, uvName, uvSurface } from './surface';
import type { TransferOptions } from './transfer';

const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`uv-${id}`)! as T;
const choice = (id: string) => ui<HTMLSelectElement>(id).value;
const checked = (id: string) => ui<HTMLInputElement>(id).checked;
const number = (id: string) => ui<HTMLInputElement>(id).valueAsNumber;
const indices = (count: number) => Array.from({ length: count }, (_, i) => i);
const mapNames: Readonly<Record<string, string>> = { map: 'Base Color', normalMap: 'Normal', emissiveMap: 'Emissive',
  aoMap: 'Ambient Occlusion', alphaMap: 'Alpha', metalnessMap: 'Metallic', roughnessMap: 'Roughness',
  metalRough: 'Metallic / Roughness', metallic: 'Metallic', roughness: 'Roughness' };

interface Context {
  model: Model;
  adapter: ModelAdapter;
  catalog: TextureCatalog;
  state: WorkingState;
  revision: number;
  object: string;
}

export interface UvRequest {
  object: string;
  revision: number;
  channel: number;
  layout: Layout;
  surface: Surface;
  preserve: boolean;
  options: TransferOptions;
}

interface Actions {
  run(work: (signal?: AbortSignal) => Promise<Layout>): Promise<Layout | undefined>;
  commit(request: UvRequest): Promise<boolean>;
}

type Transform = 'move' | 'rotate' | 'scale';
type Gesture = { pointer: number; start: Pair; pan: boolean; last: Pair; base: Layout; prior?: Layout;
  corners: ReadonlySet<number>; transform: Transform; pivot?: Pair };

export class UvTool {
  #panel = ui<HTMLFieldSetElement>('tools');
  #canvas = ui<HTMLCanvasElement>('canvas');
  #context?: Context;
  #mesh?: Mesh;
  #surface?: Surface;
  #base = new Map<number, Layout>();
  #draft = new Map<number, Layout>();
  #target?: TextureTarget;
  #map?: HTMLCanvasElement;
  #coverage?: HTMLCanvasElement;
  #imageTicket = 0;
  #groups?: ReturnType<typeof groups>;
  #lastLayout?: Layout;
  #findings?: ReturnType<typeof diagnose>;
  #selection = new Set<number>();
  #edge?: string;
  #offset: Pair = [0, 0];
  #zoom = 1;
  #gesture?: Gesture;
  #locked = false;
  #wire = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x4ee8ff, depthTest: false }));

  constructor(readonly viewer: Viewer, readonly viewport: HTMLCanvasElement, readonly actions: Actions) {
    viewer.scene.add(this.#wire);
    this.#wire.visible = false;
    ui('channel').addEventListener('change', () => { this.#selection.clear(); this.#update(); this.#fit(false); });
    ui('material').addEventListener('change', () => { this.#selection.clear(); this.#loadImage(); this.#update(); });
    ui('map').addEventListener('change', () => { this.#loadImage(); this.#update(); });
    ui('kind').addEventListener('change', () => { this.#selection.clear(); this.#edge = undefined; this.#update(); });
    ui('background').addEventListener('change', () => this.#draw());
    ui('pivot').addEventListener('change', () => this.#draw());
    ui('size').addEventListener('change', () => this.#update());
    ui('operation').addEventListener('change', () => { this.#operationFields(true); this.#draw(); });
    ui('mode-select').addEventListener('change', () => this.#update());
    ui('source').addEventListener('change', () => this.#update());
    ui('fit').addEventListener('click', () => this.#fit(false));
    ui('fit-selection').addEventListener('click', () => this.#fit(true));
    ui('select-all').addEventListener('click', () => {
      this.#selection = new Set(this.#corners().filter(i => this.#visible(i)));
      this.#update();
    });
    ui('clear-selection').addEventListener('click', () => { this.#selection.clear(); this.#edge = undefined; this.#update(); });
    ui('run').addEventListener('click', () => this.#operation());
    ui('pack').addEventListener('click', () => this.#pack());
    ui('unwrap').addEventListener('click', () => void this.#unwrap());
    ui('apply').addEventListener('click', () => void this.#apply());
    ui('cancel').addEventListener('click', () => this.#cancel());
    this.#canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.#canvas.addEventListener('pointerdown', event => this.#down(event));
    this.#canvas.addEventListener('pointermove', event => this.#move(event));
    this.#canvas.addEventListener('pointerup', event => this.#up(event));
    this.#canvas.addEventListener('pointercancel', () => {
      if (this.#gesture && !this.#gesture.pan) {
        if (this.#gesture.prior) this.#draft.set(this.#channel, this.#gesture.prior);
        else this.#draft.delete(this.#channel);
      }
      this.#gesture = undefined;
      this.#update();
    });
    this.#canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const point = this.#pointer(event), before = this.#unproject(point);
      this.#zoom = Math.max(3, Math.min(20000, this.#zoom * Math.exp(-event.deltaY * .0015)));
      this.#offset = [point[0] - before[0] * this.#zoom, point[1] - (this.#topDown ? before[1] : 1 - before[1]) * this.#zoom];
      this.#draw();
    }, { passive: false });
  }

  get dragging() { return !!this.#gesture; }
  get #channel() { return Number(choice('channel')); }
  get #topDown() { return this.#context?.model.format === 'glb'; }
  get #layout() {
    const channel = this.#channel, old = this.#base.get(channel), context = this.#context;
    if (this.#draft.has(channel)) return this.#draft.get(channel);
    if (old) return old;
    if (!context || !this.#mesh || !this.#surface) return;
    const layout = currentLayout(context.adapter, context.model, context.object, this.#mesh, channel, this.#surface);
    this.#base.set(channel, layout);
    return layout;
  }

  configure(context: Context | undefined, locked: boolean) {
    this.#locked = locked;
    this.#panel.disabled = locked;
    this.#panel.hidden = !context;
    const old = this.#context;
    this.#context = context;
    if (old?.adapter === context?.adapter && old?.object === context?.object && old?.revision === context?.revision) return;
    this.#base.clear();
    this.#draft.clear();
    this.#lastLayout = undefined;
    this.#selection.clear();
    this.#surface = this.#mesh = this.#target = this.#map = this.#coverage = undefined;
    this.#imageTicket++;
    const node = context && context.adapter.objects.get(context.object);
    if (context && node instanceof Mesh) {
      this.#mesh = node;
      this.#surface = uvSurface(context.adapter, context.object);
      if (old?.adapter !== context.adapter) ui<HTMLSelectElement>('source').value = 'working';
      const targets = context.catalog.targets(context.state).filter(item => item.binding.object === context.object);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      ui<HTMLSelectElement>('material').replaceChildren(new Option('All faces', ''),
        ...materials.map((material, slot) => new Option(material.name || `Material ${slot + 1}`, String(slot))));
      const channels = indices(4).filter(channel => node.geometry.hasAttribute(uvName(channel)));
      if (context.model.format === 'fbx' && context.model.uvAtlas && !channels.includes(1)) channels.push(1);
      const missing = indices(4).find(channel => !channels.includes(channel));
      if (missing !== undefined) channels.push(missing);
      channels.sort((a, b) => a - b);
      const preferred = context.state.uvBakes?.[context.object]?.channel ?? (context.state.bake ? 1 : targets[0]?.binding.texture.channel ?? 0);
      const selector = ui<HTMLSelectElement>('channel');
      selector.replaceChildren(...channels.map(channel => new Option(`UV${channel}${!node.geometry.hasAttribute(uvName(channel)) &&
        !(channel === 1 && context.model.format === 'fbx' && context.model.uvAtlas) ? ' (new)' : ''}`, String(channel))));
      if (channels.includes(preferred)) selector.value = String(preferred);
      this.#loadImage();
      this.#fit(false);
    }
    this.#update();
  }

  keyboard(key: string) {
    if (!this.#context || this.#locked) return false;
    if (key === 'Escape' && this.#draft.has(this.#channel)) { this.#cancel(); return true; }
    if (key === 'Enter' && this.#draft.has(this.#channel)) { void this.#apply(); return true; }
    const kind = ({ '1': 'vertex', '2': 'edge', '3': 'face', '4': 'island' } as Record<string, string>)[key];
    if (!kind) return false;
    ui<HTMLSelectElement>('kind').value = kind;
    this.#selection.clear();
    this.#update();
    return true;
  }

  pick3d(event: PointerEvent) {
    const mesh = this.#mesh, surface = this.#surface, camera = this.viewer.camera;
    if (!mesh || !surface || !camera) return;
    const rect = this.viewport.getBoundingClientRect(), ray = new Raycaster();
    ray.setFromCamera(new Vector2(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height), camera);
    const hit = ray.intersectObject(mesh, false)[0];
    const grouping = this.#groups;
    if (hit?.faceIndex == null || !hit.face || !grouping) return;
    const first = hit.faceIndex * 3;
    if (!this.#visible(first)) return;
    const kind = choice('kind');
    let ids: number[];
    if (kind === 'island') ids = grouping.islands.get(grouping.islandOf(first)) ?? [];
    else if (kind === 'face') ids = this.#corners().filter(i => surface.faces[Math.floor(i / 3)] === surface.faces[hit.faceIndex!]);
    else {
      const { a, b, c } = hit.face;
      const [p, q, r] = [a, b, c].map(index => mesh.getVertexPosition(index, new Vector3()));
      const weights = Triangle.getBarycoord(mesh.worldToLocal(hit.point), p, q, r, new Vector3())?.toArray();
      if (!weights) return;
      const vertices = (corner: number) => grouping.vertices.get(grouping.vertexOf(corner))!;
      if (kind === 'vertex') ids = vertices(first + weights.indexOf(Math.max(...weights)));
      else {
        const opposite = weights.indexOf(Math.min(...weights));
        const a = first + (opposite + 1) % 3, b = first + (opposite + 2) % 3;
        this.#edge = edgeKey(surface.points[a], surface.points[b]);
        ids = [...vertices(a), ...vertices(b)];
      }
    }
    this.#select(ids, event.shiftKey);
  }

  #corners() { return indices(this.#surface?.points.length ?? 0); }
  #visible(i: number) { return choice('material') === '' || Number(choice('material')) === this.#surface?.slots[Math.floor(i / 3)]; }

  #loadImage() {
    const context = this.#context, mesh = this.#mesh;
    if (!context || !mesh) return;
    const slot = Number(choice('material'));
    const targets = context.catalog.targets(context.state).filter(target => target.binding.object === context.object);
    this.#target = targets.find(target => target.binding.slot === slot);
    const material = Array.isArray(mesh.material) ? mesh.material[slot] : mesh.material;
    const textures = new Map(Object.entries(material).filter((entry): entry is [string, Texture] => entry[1] instanceof Texture));
    const bake = context.model.format === 'fbx' ? context.state.bake : context.state.uvBakes?.[context.object]?.bake;
    const slots = bake ? bake.maps.map(map => map.slot) : [...textures.keys()];
    if (this.#target && !slots.includes('map')) slots.unshift('map');
    const selector = ui<HTMLSelectElement>('map'), selected = selector.value;
    selector.replaceChildren(...slots.map(name => new Option(mapNames[name] ?? name, name)));
    selector.disabled = slots.length <= 1;
    if (slots.includes(selected)) selector.value = selected;
    const ticket = ++this.#imageTicket;
    this.#map = this.#coverage = undefined;
    if (bake?.coverage) this.#coverage = sourceImage(decodePng(bake.coverage));
    const map = selector.value;
    const load = async () => {
      if (map === 'map' && this.#target) return context.catalog.load(this.#target, context.state);
      const baked = bake?.maps.find(entry => entry.slot === map);
      if (baked) return decodePng(baked.png);
      const image = textures.get(map)?.image;
      if (context.model.format === 'glb') {
        const embedded = image && typeof image === 'object' ? context.model.images.get(image) : undefined;
        if (embedded) return decodeImage(embedded.blob);
      } else if (image instanceof HTMLImageElement) {
        const path = context.model.imagePathsByUrl.get(image.src), bytes = path && context.model.images.get(path);
        if (bytes) return decodeImage(new Blob([bytes]));
      }
    };
    void load().then(image => {
      if (ticket !== this.#imageTicket) return;
      if (image) this.#map = sourceImage(image);
      this.#update();
    }).catch(error => { if (ticket === this.#imageTicket) this.#say(error); });
  }

  #options(): PackOptions {
    const size = Number(choice('size')), padding = number('padding');
    if (!Number.isInteger(padding) || padding < 0 || padding > 64) throw new Error('Choose padding from 0 to 64 pixels.');
    return { size, padding, rotate: checked('allow-rotate'), equalize: checked('equalize') };
  }

  #set(layout: Layout) {
    this.#draft.set(this.#channel, layout);
    this.#update();
  }

  #operationFields(reset = false) {
    const operation = choice('operation'), scale = operation === 'scale';
    ui('u-label').textContent = operation === 'rotate' ? 'Degrees' : 'U';
    for (const id of ['u', 'v']) {
      const field = ui<HTMLInputElement>(id);
      if (reset) field.value = scale ? '1' : '0';
      field.disabled = !['move', 'rotate', 'scale'].includes(operation) || id === 'v' && operation === 'rotate';
    }
    ui<HTMLSelectElement>('plane').disabled = operation !== 'planar';
  }

  #operation() {
    const layout = this.#layout, surface = this.#surface;
    if (!layout || !surface) return;
    try {
      if (!this.#selection.size) throw new Error('Select UV vertices, edges, faces or islands.');
      const op = choice('operation');
      if (op === 'cut' || op === 'uncut') {
        if (choice('kind') !== 'edge' || !this.#edge) throw new Error('Select a UV edge to mark or clear.');
        const seams = new Set(layout.seams);
        if (op === 'cut') seams.add(this.#edge);
        else seams.delete(this.#edge);
        this.#set({ ...layout, seams: [...seams] });
        return;
      }
      const box = bounds(layout.uv, this.#selection);
      const [u, v] = this.#pivot(layout);
      const x = number('u'), y = number('v');
      if (op === 'planar') {
        const faces = this.#faces(this.#selection);
        this.#set(planar(surface, layout, new Set([...faces].flatMap(id => [id * 3, id * 3 + 1, id * 3 + 2])), choice('plane')));
        return;
      }
      const available = op === 'vertex' ? [...this.#groups!.vertices.keys()].filter(index => !this.#selection.has(index)) : [];
      if (op === 'vertex' && !available.length) throw new Error('Leave at least one UV vertex unselected.');
      const width = this.#map?.width ?? Number(choice('size')), height = this.#map?.height ?? width;
      this.#set(editUv(layout, this.#selection, (a, b) => {
        switch (op) {
          case 'move': return [a + x, b + y];
          case 'scale': return [u + (a - u) * x, v + (b - v) * y];
          case 'rotate': {
            const angle = x * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
            return [u + (a - u) * c - (b - v) * s, v + (a - u) * s + (b - v) * c];
          }
          case 'alignU': return [(box.x0 + box.x1) / 2, b];
          case 'alignV': return [a, (box.y0 + box.y1) / 2];
          case 'pixel': return [Math.round(a * width) / width, Math.round(b * height) / height];
          case 'boundary': {
            const d = [Math.abs(a), Math.abs(1 - a), Math.abs(b), Math.abs(1 - b)], best = d.indexOf(Math.min(...d));
            return best < 2 ? [best, b] : [a, best - 2];
          }
          default: {
            let point: Pair = [a, b], best = Infinity;
            for (const i of available) {
              const p = read(layout.uv, i), distance = (p[0] - a) ** 2 + (p[1] - b) ** 2;
              if (distance < best) { best = distance; point = p; }
            }
            return point;
          }
        }
      }));
    } catch (error) { this.#say(error); }
  }

  #pack() {
    const layout = this.#layout, surface = this.#surface;
    if (!layout || !surface) return;
    try {
      const selected = checked('selected-only') ? new Set([...this.#selection].map(i => this.#groups!.islandOf(i))) : undefined;
      this.#set(pack(surface, layout, this.#options(), selected));
      this.#fit(false);
    } catch (error) { this.#say(error); }
  }

  async #unwrap() {
    const layout = this.#layout, surface = this.#surface, context = this.#context;
    if (!layout || !surface || !context) return;
    try {
      const options = this.#options(), scope = checked('selected-only') ? this.#faces(this.#selection) : undefined;
      const next = await this.actions.run(signal => autoUnwrap(surface, layout, options, this.#topDown, scope, signal));
      if (next && this.#context?.revision === context.revision && this.#context?.object === context.object) {
        this.#set(next);
        this.#fit(false);
      }
    } catch (error) { this.#say(error); }
  }

  async #apply() {
    const context = this.#context, surface = this.#surface, layout = this.#draft.get(this.#channel);
    if (!context || !surface || !layout) return;
    try {
      const { size, padding } = this.#options();
      await this.actions.commit({ object: context.object, revision: context.revision, layout, surface, channel: this.#channel,
        preserve: choice('mode-select') === 'preserve', options: { size, padding, filter: choice('filter') === 'nearest' ? 'nearest' : 'linear',
          original: choice('source') === 'original', fillMissing: checked('missing') } });
    } catch (error) { this.#say(error); }
  }

  #cancel() {
    this.#draft.delete(this.#channel);
    this.#selection.clear();
    this.#update();
    this.#fit(false);
  }

  #faces(corners: Iterable<number>) { return new Set([...corners].map(i => Math.floor(i / 3))); }

  #select(ids: number[], shift: boolean) {
    const remove = shift && ids.every(id => this.#selection.has(id));
    if (!shift) this.#selection.clear();
    for (const id of ids) {
      if (remove) this.#selection.delete(id);
      else this.#selection.add(id);
    }
    this.#update();
  }

  #pointer(event: MouseEvent): Pair {
    const rect = this.#canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) * this.#canvas.width / rect.width, (event.clientY - rect.top) * this.#canvas.height / rect.height];
  }

  #project([u, v]: Pair): Pair { return [this.#offset[0] + u * this.#zoom, this.#offset[1] + (this.#topDown ? v : 1 - v) * this.#zoom]; }
  #unproject([x, y]: Pair): Pair {
    const v = (y - this.#offset[1]) / this.#zoom;
    return [(x - this.#offset[0]) / this.#zoom, this.#topDown ? v : 1 - v];
  }

  #pivot(layout: Layout): Pair {
    if (choice('pivot') === 'origin') return [0, 0];
    if (choice('pivot') === 'tile') return [.5, .5];
    const box = bounds(layout.uv, this.#selection);
    return [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
  }

  #handle(layout: Layout): { operation: Transform; pivot: Pair; center: Pair; handle: Pair } | undefined {
    const operation = choice('operation');
    if (!this.#selection.size || operation !== 'move' && operation !== 'rotate' && operation !== 'scale') return;
    const pivot = this.#pivot(layout), center = this.#project(pivot);
    const handle: Pair = [center[0] + (operation === 'move' ? 16 : 32), center[1] - (operation === 'scale' ? 23 : 0)];
    return { operation, pivot, center, handle };
  }

  #down(event: PointerEvent) {
    const layout = this.#layout;
    if (this.#locked || !layout || event.button > 2) return;
    const start = this.#pointer(event), pan = event.button !== 0 || event.altKey;
    const control = this.#handle(layout);
    const handle = !pan && !event.shiftKey && control && Math.hypot(start[0] - control.handle[0], start[1] - control.handle[1]) < 10 ? control : undefined;
    if (!pan && !handle) {
      const hit = this.#pick(start);
      if (hit || !event.shiftKey) this.#select(hit ?? [], event.shiftKey);
    }
    this.#canvas.setPointerCapture(event.pointerId);
    this.#gesture = { pointer: event.pointerId, pan, start, base: layout, last: start, prior: this.#draft.get(this.#channel),
      corners: new Set(this.#selection), transform: handle?.operation ?? 'move', pivot: handle?.pivot };
    this.#canvas.focus({ preventScroll: true });
    event.preventDefault();
  }

  #pick(point: Pair) {
    const layout = this.#layout, grouping = this.#groups, surface = this.#surface;
    if (!layout || !grouping || !surface) return;
    const kind = choice('kind'), uv = this.#unproject(point);
    if (kind === 'face' || kind === 'island') {
      for (let i = 0; i < surface.points.length; i += 3) {
        if (!this.#visible(i)) continue;
        const [a, b, c] = [read(layout.uv, i), read(layout.uv, i + 1), read(layout.uv, i + 2)];
        if (Math.abs(cross(a, b, c)) < 1e-12) continue;
        const signs = [cross(a, b, uv), cross(b, c, uv), cross(c, a, uv)];
        if (Math.min(...signs) < -1e-8 && Math.max(...signs) > 1e-8) continue;
        if (kind === 'island') return grouping.islands.get(grouping.islandOf(i));
        return this.#corners().filter(n => surface.faces[Math.floor(n / 3)] === surface.faces[i / 3]);
      }
      return;
    }
    let distance = 14 ** 2, picked: number[] | undefined;
    const d = ([x, y]: Pair) => (x - point[0]) ** 2 + (y - point[1]) ** 2;
    if (kind === 'vertex') {
      for (const [i, corners] of grouping.vertices) {
        if (!corners.some(index => this.#visible(index))) continue;
        const metric = d(this.#project(read(layout.uv, i)));
        if (metric < distance) { distance = metric; picked = corners; }
      }
      return picked;
    }
    this.#edge = undefined;
    for (const [key, sides] of grouping.sides) for (const [a, b] of sides) {
      if (!this.#visible(a)) continue;
      const [x, y] = this.#project(read(layout.uv, a)), [xx, yy] = this.#project(read(layout.uv, b));
      const t = Math.max(0, Math.min(1, ((point[0] - x) * (xx - x) + (point[1] - y) * (yy - y)) / ((xx - x) ** 2 + (yy - y) ** 2 || 1)));
      const metric = d([x + t * (xx - x), y + t * (yy - y)]);
      if (metric < distance) {
        distance = metric;
        picked = [...grouping.vertices.get(grouping.vertexOf(a))!, ...grouping.vertices.get(grouping.vertexOf(b))!];
        this.#edge = key;
      }
    }
    return picked;
  }

  #move(event: PointerEvent) {
    const p = this.#pointer(event), [u, v] = this.#unproject(p);
    const w = this.#map?.width ?? Number(choice('size')), h = this.#map?.height ?? w;
    ui('coordinate').textContent = `UV ${u.toFixed(3)}, ${v.toFixed(3)} · ${Math.floor(u * w)}, ${Math.floor((this.#topDown ? v : 1 - v) * h)} px`;
    const gesture = this.#gesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (gesture.pan) {
      this.#offset = [this.#offset[0] + p[0] - gesture.last[0], this.#offset[1] + p[1] - gesture.last[1]];
    } else if (gesture.corners.size && Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) >= 2) {
      const [startU, startV] = this.#unproject(gesture.start);
      let transform: (x: number, y: number) => Pair = (x, y) => [x + u - startU, y + v - startV];
      if (gesture.pivot && gesture.transform !== 'move') {
        const [pu, pv] = gesture.pivot;
        const angle = Math.atan2(v - pv, u - pu) - Math.atan2(startV - pv, startU - pu);
        const ratio = gesture.transform === 'scale' ? Math.max(.001, Math.hypot(u - pu, v - pv) / Math.hypot(startU - pu, startV - pv)) : 1;
        const c = gesture.transform === 'rotate' ? Math.cos(angle) : ratio, s = gesture.transform === 'rotate' ? Math.sin(angle) : 0;
        transform = (x, y) => [pu + (x - pu) * c - (y - pv) * s, pv + (x - pu) * s + (y - pv) * c];
      }
      this.#draft.set(this.#channel, editUv(gesture.base, gesture.corners, transform));
    }
    gesture.last = p;
    this.#draw();
  }

  #up(event: PointerEvent) {
    if (event.pointerId !== this.#gesture?.pointer) return;
    this.#gesture = undefined;
    this.#update();
  }

  #fit(selection: boolean) {
    const layout = this.#layout;
    const region = layout && (selection ? this.#selection : this.#corners());
    if (!layout || !region || !this.#surface || selection && !this.#selection.size) return;
    const box = bounds(layout.uv, region);
    const x0 = selection ? box.x0 : Math.min(0, box.x0), x1 = selection ? box.x1 : Math.max(1, box.x1);
    const y0 = selection ? box.y0 : Math.min(0, box.y0), y1 = selection ? box.y1 : Math.max(1, box.y1);
    this.#zoom = .88 * Math.min(this.#canvas.width / Math.max(.04, x1 - x0), this.#canvas.height / Math.max(.04, y1 - y0));
    const center = (y0 + y1) / 2;
    this.#offset = [this.#canvas.width / 2 - this.#zoom * (x0 + x1) / 2, this.#canvas.height / 2 - this.#zoom * (this.#topDown ? center : 1 - center)];
    this.#draw();
  }

  #update() {
    const layout = this.#layout, surface = this.#surface;
    if (layout !== this.#lastLayout || layout && !this.#groups) {
      this.#lastLayout = layout;
      this.#groups = layout && surface ? groups(surface, layout) : undefined;
      this.#findings = layout ? diagnose(layout.uv, this.#topDown) : undefined;
    }
    const dirty = this.#draft.has(this.#channel), preserve = choice('mode-select') === 'preserve';
    const apply = ui<HTMLButtonElement>('apply');
    apply.textContent = preserve ? 'Rebake and Apply' : 'Apply Mapping';
    apply.disabled = ui<HTMLButtonElement>('cancel').disabled = !dirty;
    for (const id of ['source', 'filter', 'missing']) ui<HTMLInputElement>(id).disabled = !preserve;
    for (const id of ['unwrap', 'pack', 'run', 'select-all']) ui<HTMLButtonElement>(id).disabled = !layout;
    this.#operationFields();
    if (!layout || !surface) {
      ui('diagnostics').textContent = '';
      this.#say('Select a mesh object to edit UVs.');
    } else {
      const finding = this.#findings!, size = Number(choice('size'));
      const stats = [...this.#groups!.islands.values()].filter(list => !this.#selection.size || list.some(i => this.#selection.has(i)))
        .map(list => density(surface, layout.uv, list, size)).sort((a, b) => a - b);
      ui('diagnostics').textContent = `${this.#groups!.islands.size} islands · ${finding.outside} outside · ${finding.overlaps} overlapping · ${finding.flipped} flipped · ${finding.degenerate} degenerate` +
        (stats.length ? ` · Density ${Math.round(stats[0])}–${Math.round(stats.at(-1)!)} px/unit` : '');
      const state = this.#context!.state;
      const bake = state.bake?.direct ? state.bake : state.uvBakes?.[this.#context!.object]?.bake;
      const info = dirty ? 'UV draft.' : 'Drag a selection or its transform handle. Middle-drag to pan.';
      const currentBake = bake?.direct ? ` Last bake used ${bake.direct.sourceName}. ${bake.direct.misses}/${bake.covered} occupied texels have no source (${(100 * bake.direct.misses / bake.covered).toFixed(2)}%).` : '';
      const fbx = preserve && this.#context?.model.format === 'fbx' ? ' FBX export uses the baked layout in UV0.' : '';
      this.#say(`${info}${preserve ? ` Bake source is ${choice('source') === 'original' ? 'the original import' : `working revision ${this.#context!.revision}`}.` : ''}${fbx}${currentBake}`);
    }
    this.#draw();
    this.#drawWire();
  }

  #draw() {
    const ctx = this.#canvas.getContext('2d')!, layout = this.#layout, { width, height } = this.#canvas;
    ctx.fillStyle = '#171c25';
    ctx.fillRect(0, 0, width, height);
    if (!layout) return;
    const [x, y] = this.#offset, s = this.#zoom, background = choice('background');
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, s, s);
    ctx.clip();
    ctx.fillStyle = '#303847';
    ctx.fillRect(x, y, s, s);
    if (background !== 'solid') {
      const size = s / 16;
      ctx.fillStyle = '#3b4454';
      for (let row = 0; row < 16; row++) for (let col = row % 2; col < 16; col += 2) ctx.fillRect(x + col * size, y + row * size, size, size);
    }
    const image = background === 'texture' ? this.#map : background === 'coverage' ? this.#coverage : undefined;
    if (image) ctx.drawImage(image, x, y, s, s);
    ctx.strokeStyle = '#adb5c55c';
    ctx.beginPath();
    for (let i = 0; i <= 10; i++) {
      const q = s * i / 10;
      ctx.moveTo(x + q, y); ctx.lineTo(x + q, y + s);
      ctx.moveTo(x, y + q); ctx.lineTo(x + s, y + q);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#a2b4cc';
    ctx.strokeRect(x, y, s, s);
    for (const highlighted of [false, true]) {
      ctx.beginPath();
      for (let i = 0; i < layout.uv.length / 2; i += 3) {
        if (!this.#visible(i) || [i, i + 1, i + 2].some(j => this.#selection.has(j)) !== highlighted) continue;
        ctx.moveTo(...this.#project(read(layout.uv, i)));
        ctx.lineTo(...this.#project(read(layout.uv, i + 1)));
        ctx.lineTo(...this.#project(read(layout.uv, i + 2)));
        ctx.closePath();
      }
      ctx.strokeStyle = highlighted ? '#ffbe62' : '#51d8ecd5';
      ctx.lineWidth = highlighted ? 1.8 : 1;
      ctx.stroke();
    }
    ctx.fillStyle = '#ffe9aa';
    if (layout.seams.length) {
      ctx.beginPath();
      for (const seam of layout.seams) for (const [a, b] of this.#groups?.sides.get(seam) ?? []) {
        if (!this.#visible(a)) continue;
        ctx.moveTo(...this.#project(read(layout.uv, a)));
        ctx.lineTo(...this.#project(read(layout.uv, b)));
      }
      ctx.strokeStyle = '#ff805d';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    for (const i of this.#selection) {
      const [x, y] = this.#project(read(layout.uv, i));
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    const control = this.#handle(this.#gesture?.base ?? layout);
    if (control) {
      ctx.beginPath();
      ctx.moveTo(...control.center);
      ctx.lineTo(...control.handle);
      ctx.strokeStyle = '#ffe9aa';
      ctx.stroke();
      ctx.fillRect(control.handle[0] - 5, control.handle[1] - 5, 10, 10);
    }
  }

  #drawWire() {
    const mesh = this.#mesh, surface = this.#surface;
    this.#wire.visible = !!mesh && !!surface && this.#selection.size > 0;
    this.#wire.geometry.dispose();
    this.#wire.geometry = new BufferGeometry();
    if (mesh && surface && this.#wire.visible) {
      mesh.updateWorldMatrix(true, false);
      const vertices: number[] = [], v = new Vector3();
      for (const face of this.#faces(this.#selection)) for (const i of [0, 1, 1, 2, 2, 0]) {
        vertices.push(...v.fromArray(surface.positions, (face * 3 + i) * 3).applyMatrix4(mesh.matrixWorld).toArray());
      }
      this.#wire.geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    }
    this.viewer.render();
  }

  #say(value: unknown) { ui('info').textContent = value instanceof Error ? value.message : String(value); }
}
