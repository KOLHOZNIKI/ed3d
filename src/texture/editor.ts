import type { BufferGeometry } from 'three';
import { decodeImage, drawImage, drawTile, readPixel, type Rgba, type TextureImage } from './image';
import { TextureStroke, type BrushSettings, type Point, type Region } from './stroke';
import { uvOverlay } from './overlay';
import type { TextureTarget } from './bindings';

interface Session {
  targets: TextureTarget[];
  atlas?: BufferGeometry;
  load(target: TextureTarget): Promise<TextureImage>;
}

interface Actions {
  busy(active: boolean): void;
  live(target?: TextureTarget, canvas?: HTMLCanvasElement): void;
  commit(target: TextureTarget, image: TextureImage, label: string, copy?: boolean): Promise<void>;
  export(target: TextureTarget, image: TextureImage): void;
  selectBinding(target: TextureTarget): void;
  unlit(value: boolean): void;
}

type Gesture = { pointer: number; mode: 'pan' | 'select' | 'stroke'; origin: Point; last: Point; draft?: TextureStroke };

function byId<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(`texture-${id}`)! as T; }
const number = (id: string, min: number, max: number, fallback: number) => {
  const raw = byId<HTMLInputElement>(id).valueAsNumber;
  return Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : fallback));
};
const checked = (id: string) => byId<HTMLInputElement>(id).checked;
const value = (id: string) => byId<HTMLInputElement | HTMLSelectElement>(id).value;
const clampPoint = (x: number, size: number) => Math.min(size, Math.max(0, x));
const texel = (point: Point) => ({ x: Math.floor(point.x), y: Math.floor(point.y) });

export class TextureEditor {
  readonly panel = byId('panel');
  readonly picture = byId<HTMLCanvasElement>('picture');
  #view = byId('viewport');
  #overlay = byId<HTMLCanvasElement>('overlay');
  #chooser = byId<HTMLSelectElement>('target');
  #session?: Session;
  #target?: TextureTarget;
  #image?: TextureImage;
  #paths?: ReturnType<typeof uvOverlay>;
  #scaledPaths?: { boundary: Path2D; interior: Path2D };
  #atlas?: BufferGeometry;
  #geometry?: BufferGeometry;
  #load = 0;
  #zoom = 1;
  #offset: Point = { x: 0, y: 0 };
  #fitMode = true;
  #pointer?: Point;
  #gesture?: Gesture;
  #region?: Region;
  #source?: Point;
  #aligned?: Point;
  #sharedAllowed = new Set<string>();
  #locked = false;
  #actions: Actions;

  constructor(actions: Actions) {
    this.#actions = actions;
    this.#chooser.addEventListener('change', () => {
      const target = this.#session?.targets.find(item => item.binding.id === this.#chooser.value);
      if (target) this.#actions.selectBinding(target);
    });
    byId('edit-shared').addEventListener('click', () => {
      if (!this.#target || this.#locked) return;
      this.#sharedAllowed.add(this.#target.key);
      this.#refresh();
      this.#say('Edits update each binding of this shared Base Color map.');
    });
    byId('copy').addEventListener('click', () => void this.#apply('Copy Base Color binding', this.#image, true));
    byId('fit').addEventListener('click', () => this.fit());
    byId('focus').addEventListener('click', () => this.#focusUvs());
    byId('actual').addEventListener('click', () => this.#zoomAt(1));
    byId('in').addEventListener('click', () => this.#zoomAt(this.#zoom * 2));
    byId('out').addEventListener('click', () => this.#zoomAt(this.#zoom / 2));
    for (const id of ['uv', 'uv-color', 'uv-opacity', 'uv-width', 'tool', 'size', 'color', 'shape', 'stamp', 'alpha']) {
      byId(id).addEventListener('input', () => { this.#refresh(); this.#paintOverlay(); });
    }
    byId('unlit').addEventListener('change', () => this.#actions.unlit(checked('unlit')));
    byId('export').addEventListener('click', () => {
      if (!this.#locked && this.#image && this.#target) this.#actions.export(this.#target, this.#image);
    });
    byId('clear').addEventListener('click', () => {
      this.#region = undefined;
      this.#refresh();
      this.#paintOverlay();
    });
    byId('fill').addEventListener('click', () => {
      if (!this.#image || !this.#region || !this.#canWrite()) return;
      const draft = new TextureStroke(this.#image, this.#brush('brush'));
      draft.fill();
      void this.#apply('Fill texture selection', draft.finish());
    });
    byId<HTMLInputElement>('import').addEventListener('change', event => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.#replace(file);
    });
    this.#view.addEventListener('pointerdown', event => this.#down(event));
    this.#view.addEventListener('pointermove', event => this.#move(event));
    this.#view.addEventListener('pointerup', event => this.#up(event));
    this.#view.addEventListener('lostpointercapture', () => this.cancel());
    this.#view.addEventListener('pointercancel', () => this.cancel());
    this.#view.addEventListener('pointerleave', () => { this.#pointer = undefined; this.#paintOverlay(); });
    this.#view.addEventListener('auxclick', event => event.preventDefault());
    this.#view.addEventListener('wheel', event => {
      event.preventDefault();
      if (this.#gesture) return;
      this.#zoomAt(this.#zoom * (event.deltaY < 0 ? 1.25 : .8), this.#screen(event));
    }, { passive: false });
    this.#view.addEventListener('keydown', event => {
      if (event.key === 'Escape') { this.cancel(); this.#region = undefined; this.#refresh(); this.#paintOverlay(); }
    });
    new ResizeObserver(() => {
      if (this.panel.hidden) return;
      if (this.#fitMode) this.fit();
      else this.#paintOverlay();
    }).observe(this.#view);
  }

  open() { this.panel.hidden = false; this.setSession(this.#session); }

  close() {
    this.cancel();
    this.panel.hidden = true;
    this.#session = this.#target = this.#image = this.#atlas = this.#paths = this.#scaledPaths = this.#geometry = undefined;
    this.#region = this.#source = this.#aligned = undefined;
    this.#sharedAllowed.clear();
    this.picture.width = this.picture.height = 1;
    this.#load++;
    this.#actions.unlit(false);
    byId<HTMLInputElement>('unlit').checked = false;
  }

  setSession(session?: Session, binding?: string) {
    this.#session = session;
    if (this.panel.hidden) return;
    const targets = session?.targets ?? [];
    const target = targets.find(item => item.binding.id === binding);
    this.#chooser.replaceChildren(...targets.map(item => new Option(`${item.binding.label}${item.atlas ? ' (atlas)' : ''}`, item.binding.id)));
    void this.#show(target ?? targets[0]);
  }

  region(target: TextureTarget) {
    return this.#target?.binding.id === target.binding.id && this.#target.key === target.key ? this.#region : undefined;
  }

  lock(locked: boolean) {
    this.#locked = locked;
    this.#refresh();
  }

  fit() {
    if (!this.#image) return;
    const w = this.#view.clientWidth, h = this.#view.clientHeight;
    if (!w || !h) return;
    this.#fitMode = true;
    this.#zoom = Math.min(w / this.#image.width, h / this.#image.height, 12);
    this.#offset = { x: (w - this.#image.width * this.#zoom) / 2, y: (h - this.#image.height * this.#zoom) / 2 };
    this.#transform();
  }

  cancel() {
    const gesture = this.#gesture;
    if (!gesture) return;
    this.#gesture = undefined;
    if (gesture.draft && this.#image) {
      const context = this.picture.getContext('2d')!;
      for (const tile of gesture.draft.tiles.keys()) drawTile(context, this.#image, tile);
      this.#actions.live();
    }
    this.#actions.busy(false);
    this.#paintOverlay();
  }

  async #show(target?: TextureTarget) {
    const generation = ++this.#load;
    const changed = target?.key !== this.#target?.key || target?.binding.id !== this.#target?.binding.id;
    if (target) this.#chooser.value = target.binding.id;
    if (changed) {
      this.#target = target;
      this.#image = this.#paths = this.#scaledPaths = undefined;
      this.#region = this.#source = this.#aligned = undefined;
      this.#fitMode = true;
      this.#say('');
      this.picture.width = this.picture.height = 1;
    }
    this.#refresh();
    if (!target || !this.#session) return;
    try {
      const image = await this.#session.load(target);
      if (generation !== this.#load) return;
      const resize = image.width !== this.#image?.width || image.height !== this.#image.height;
      if (image !== this.#image) {
        this.#image = image;
        if (resize) {
          this.#region = this.#source = this.#aligned = undefined;
          this.picture.width = image.width;
          this.picture.height = image.height;
        }
        drawImage(this.picture.getContext('2d')!, image);
      }
      if (!this.#paths || this.#atlas !== this.#session.atlas || this.#geometry !== target.binding.mesh.geometry ||
          this.#target?.shared.length !== target.shared.length) {
        this.#paths = uvOverlay(target, this.#session.atlas);
        this.#atlas = this.#session.atlas;
        this.#geometry = target.binding.mesh.geometry;
      }
      this.#target = target;
      if (resize || changed) this.fit();
      else this.#transform();
      this.#refresh();
    } catch (error) {
      if (generation === this.#load) this.#say(error instanceof Error ? error.message : String(error));
    }
  }

  #canWrite() {
    return !!this.#target && !this.#locked && (this.#target.shared.length === 1 || this.#sharedAllowed.has(this.#target.key));
  }

  #refresh() {
    const target = this.#target;
    const ready = !!this.#image && !!target && !this.#locked;
    this.#chooser.disabled = this.#locked || !this.#session?.targets.length;
    byId('sharing').hidden = (target?.shared.length ?? 0) < 2;
    byId<HTMLButtonElement>('edit-shared').disabled = !ready || (!!target && this.#sharedAllowed.has(target.key));
    byId<HTMLButtonElement>('copy').disabled = !ready;
    byId<HTMLButtonElement>('fill').disabled = !ready || !this.#canWrite() || !this.#region;
    byId<HTMLButtonElement>('clear').disabled = !ready || !this.#region;
    byId<HTMLButtonElement>('export').disabled = !ready;
    byId<HTMLButtonElement>('focus').disabled = !ready || !this.#paths?.bounds;
    byId<HTMLInputElement>('import').disabled = !ready || !this.#canWrite();
    byId<HTMLInputElement>('alpha-value').disabled = !checked('alpha');
    byId('info').textContent = this.#image && target
      ? `${this.#image.width} × ${this.#image.height} · RGBA8 · Base Color · ${target.atlas ? 'Baked atlas' : `Sampling UV${target.transfer?.channel ?? target.binding.texture.channel}`}` +
        (target.shared.length > 1 ? ` · Shared by ${target.shared.length} bindings` : '') +
        (this.#paths?.overlaps ? ' · Shared UVs detected' : '')
      : target ? 'Loading Base Color…' : 'No editable Base Color map on this model.';
  }

  async #replace(file: File) {
    const target = this.#target;
    if (!target || !this.#canWrite()) return;
    const generation = this.#load;
    try {
      if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('Choose a PNG, JPEG or WebP image.');
      const image = await decodeImage(file);
      if (generation !== this.#load || !this.#canWrite()) return;
      if (target.atlas && (image.width !== this.#image!.width || image.height !== this.#image!.height)) {
        throw new Error('A replacement for the baked atlas must use its current dimensions.');
      }
      this.#source = this.#aligned = undefined;
      await this.#apply('Replace Base Color', image);
    } catch (error) {
      this.#say(error instanceof Error ? error.message : String(error));
    }
  }

  async #apply(label: string, image?: TextureImage, copy?: boolean) {
    const target = this.#target;
    if (!target || !image || this.#locked || (!copy && (!this.#canWrite() || image === this.#image))) return;
    try {
      await this.#actions.commit(target, image, label, copy);
      this.#say(`${label} committed.`);
    } catch (error) {
      this.#say(error instanceof Error ? error.message : String(error));
      if (this.#image) drawImage(this.picture.getContext('2d')!, this.#image);
    }
  }

  #say(message: string) { byId('status').textContent = message; }

  #screen(event: MouseEvent): Point {
    const box = this.#view.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  #imagePoint(point: Point): Point { return { x: (point.x - this.#offset.x) / this.#zoom, y: (point.y - this.#offset.y) / this.#zoom }; }

  #inside(point: Point) {
    return !!this.#image && point.x >= 0 && point.y >= 0 && point.x < this.#image.width && point.y < this.#image.height;
  }

  #zoomAt(zoom: number, at = { x: this.#view.clientWidth / 2, y: this.#view.clientHeight / 2 }) {
    if (!this.#image || this.#gesture) return;
    const point = this.#imagePoint(at);
    this.#zoom = Math.min(16, Math.max(.025, zoom));
    this.#offset = { x: at.x - point.x * this.#zoom, y: at.y - point.y * this.#zoom };
    this.#fitMode = false;
    this.#transform();
  }

  #transform() {
    const image = this.#image, paths = this.#paths;
    if (image && paths) {
      const matrix = new DOMMatrix([this.#zoom * image.width, 0, 0, this.#zoom * image.height, this.#offset.x, this.#offset.y]);
      const boundary = new Path2D(), interior = new Path2D();
      boundary.addPath(paths.boundary, matrix);
      interior.addPath(paths.interior, matrix);
      this.#scaledPaths = { boundary, interior };
    }
    this.picture.style.transform = `translate(${this.#offset.x}px, ${this.#offset.y}px) scale(${this.#zoom})`;
    byId('zoom').textContent = `${Math.round(this.#zoom * 100)}%`;
    this.#paintOverlay();
  }

  #focusUvs() {
    if (!this.#image || !this.#paths?.bounds || this.#gesture) return;
    const { width, height } = this.#image, { x0, x1, y0, y1 } = this.#paths.bounds;
    const w = this.#view.clientWidth, h = this.#view.clientHeight;
    this.#zoom = Math.min(16, w / ((x1 - x0) * width * 1.12), h / ((y1 - y0) * height * 1.12));
    this.#offset = { x: w / 2 - (x0 + x1) * width * this.#zoom / 2, y: h / 2 - (y0 + y1) * height * this.#zoom / 2 };
    this.#fitMode = false;
    this.#transform();
  }

  #brush(tool: BrushSettings['tool'], sourceOffset?: Point): BrushSettings {
    const rgb = parseInt(value('color').slice(1), 16);
    return { tool, color: [rgb >> 16, (rgb >> 8) & 255, rgb & 255, number('alpha-value', 0, 255, 255)],
      opacity: number('opacity', 0, 100, 100) / 100, hardness: number('hardness', 0, 100, 75) / 100,
      size: Math.round(number('size', 1, 512, 24)), square: value('shape') === 'Square', alpha: checked('alpha'),
      region: this.#region, sourceOffset };
  }

  #down(event: PointerEvent) {
    if (!this.#image || !this.#target || this.#locked || this.#gesture || (event.button !== 0 && event.button !== 1)) return;
    const screen = this.#screen(event), point = this.#imagePoint(screen), tool = value('tool');
    const pan = tool === 'pan' || event.button === 1;
    if (!pan && !this.#inside(point)) return;
    event.preventDefault();
    this.#view.focus({ preventScroll: true });
    if (!pan && tool === 'stamp' && event.altKey) {
      this.#source = texel(point);
      this.#aligned = undefined;
      this.#say(`Stamp source set to ${this.#source.x}, ${this.#source.y}.`);
      this.#paintOverlay();
      return;
    }
    if (!pan && tool === 'eyedropper') {
      const { x, y } = texel(point), rgba = readPixel(this.#image, x, y);
      byId<HTMLInputElement>('color').value = `#${rgba.slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
      byId<HTMLInputElement>('alpha-value').value = String(rgba[3]);
      this.#say(`Sampled RGBA ${rgba.join(', ')} at ${x}, ${y}.`);
      this.#paintOverlay();
      return;
    }
    let gesture: Gesture;
    if (pan) gesture = { pointer: event.pointerId, mode: 'pan', origin: screen, last: screen };
    else if (tool === 'select') gesture = { pointer: event.pointerId, mode: 'select', origin: point, last: point };
    else {
      if (!this.#canWrite()) { this.#say('Choose how to edit the shared map first.'); return; }
      if (tool !== 'brush' && tool !== 'pixel' && tool !== 'stamp') return;
      let offset: Point | undefined;
      if (tool === 'stamp') {
        if (!this.#source) { this.#say('Alt+click the image to choose a stamp source.'); return; }
        const aligned = value('stamp') === 'Aligned', start = texel(point);
        offset = aligned && this.#aligned ? this.#aligned : { x: this.#source.x - start.x, y: this.#source.y - start.y };
        if (aligned) this.#aligned = offset;
      }
      const draft = new TextureStroke(this.#image, this.#brush(tool, offset));
      gesture = { pointer: event.pointerId, mode: 'stroke', origin: point, last: point, draft };
    }
    this.#gesture = gesture;
    this.#actions.busy(true);
    this.#view.setPointerCapture(event.pointerId);
    if (gesture.draft) this.#draw(gesture.draft, point, point);
    this.#paintOverlay();
  }

  #move(event: PointerEvent) {
    const screen = this.#screen(event), point = this.#imagePoint(screen);
    this.#pointer = point;
    const gesture = this.#gesture;
    if (gesture?.pointer === event.pointerId) {
      if (gesture.mode === 'pan') {
        this.#offset.x += screen.x - gesture.last.x;
        this.#offset.y += screen.y - gesture.last.y;
        this.#fitMode = false;
        gesture.last = screen;
        this.#transform();
        return;
      }
      if (gesture.draft) this.#draw(gesture.draft, gesture.last, point);
      gesture.last = point;
    }
    this.#paintOverlay();
  }

  #up(event: PointerEvent) {
    const gesture = this.#gesture;
    if (gesture?.pointer !== event.pointerId) return;
    this.#move(event);
    this.#gesture = undefined;
    this.#actions.busy(false);
    if (gesture.mode === 'select') {
      const region = this.#selection(gesture.origin, gesture.last);
      this.#region = region.x1 > region.x0 && region.y1 > region.y0 ? region : undefined;
    }
    if (gesture.draft) {
      this.#actions.live();
      const name = { brush: '2D Brush', pixel: 'Pixel Brush', stamp: 'Clone Stamp' }[gesture.draft.settings.tool];
      void this.#apply(name, gesture.draft.finish());
    }
    this.#refresh();
    this.#paintOverlay();
  }

  #draw(draft: TextureStroke, start: Point, end: Point) {
    const changed = draft.segment(start, end);
    if (!changed.size || !this.#target) return;
    const context = this.picture.getContext('2d')!;
    for (const index of changed) drawTile(context, draft.base, index, draft.tiles.get(index));
    this.#actions.live(this.#target, this.picture);
  }

  #selection(a: Point, b: Point): Region {
    const { width = 0, height = 0 } = this.#image ?? {};
    return { x0: clampPoint(Math.floor(Math.min(a.x, b.x)), width), x1: clampPoint(Math.ceil(Math.max(a.x, b.x)), width),
      y0: clampPoint(Math.floor(Math.min(a.y, b.y)), height), y1: clampPoint(Math.ceil(Math.max(a.y, b.y)), height) };
  }

  #paintOverlay() {
    const image = this.#image;
    const dpr = window.devicePixelRatio || 1;
    const w = this.#view.clientWidth, h = this.#view.clientHeight;
    if (!w || !h) return;
    if (this.#overlay.width !== Math.round(w * dpr) || this.#overlay.height !== Math.round(h * dpr)) {
      this.#overlay.width = Math.round(w * dpr);
      this.#overlay.height = Math.round(h * dpr);
    }
    const ctx = this.#overlay.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!image) return;
    const screen = (point: Point) => ({ x: this.#offset.x + point.x * this.#zoom, y: this.#offset.y + point.y * this.#zoom });
    if (checked('uv') && this.#scaledPaths) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.#offset.x, this.#offset.y, image.width * this.#zoom, image.height * this.#zoom);
      ctx.clip();
      ctx.strokeStyle = value('uv-color');
      ctx.lineWidth = number('uv-width', 1, 5, 1);
      const opacity = number('uv-opacity', 0, 100, 65) / 100;
      ctx.globalAlpha = opacity * .42;
      ctx.stroke(this.#scaledPaths.interior);
      ctx.globalAlpha = opacity;
      ctx.stroke(this.#scaledPaths.boundary);
      ctx.restore();
    }
    const g = this.#gesture;
    const region = g?.mode === 'select' ? this.#selection(g.origin, g.last) : this.#region;
    if (region) {
      const p = screen({ x: region.x0, y: region.y0 });
      const width = (region.x1 - region.x0) * this.#zoom, height = (region.y1 - region.y0) * this.#zoom;
      ctx.fillStyle = '#42eaff1c';
      ctx.fillRect(p.x, p.y, width, height);
      ctx.strokeStyle = '#f5fafb';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(p.x, p.y, width, height);
      ctx.setLineDash([]);
    }
    const tool = value('tool'), pointer = this.#pointer;
    if (tool === 'stamp' && this.#source) {
      const offset = g?.draft?.settings.sourceOffset ?? (value('stamp') === 'Aligned' ? this.#aligned : undefined);
      const source = pointer && offset ? { x: pointer.x + offset.x, y: pointer.y + offset.y } : this.#source;
      const { x, y } = screen({ x: source.x + .5, y: source.y + .5 });
      ctx.beginPath();
      ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
      ctx.strokeStyle = '#ffe28a';
      ctx.stroke();
    }
    if (!pointer || !this.#inside(pointer) || !['brush', 'stamp', 'pixel'].includes(tool)) return;
    const radius = number('size', 1, 512, 24) * this.#zoom / 2;
    const p = screen(pointer);
    ctx.beginPath();
    if (tool === 'pixel' && value('shape') === 'Square') ctx.rect(p.x - radius, p.y - radius, radius * 2, radius * 2);
    else ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = '#102030'; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = value('color'); ctx.lineWidth = 1; ctx.stroke();
  }
}
