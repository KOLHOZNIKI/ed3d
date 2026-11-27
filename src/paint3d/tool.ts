import { Vector3, type Camera } from 'three';
import type { Model, ModelAdapter } from '../project/adapter';
import type { Viewer } from '../project/viewer';
import { finishWorker } from '../project/worker';
import type { TextureTarget } from '../texture/bindings';
import type { Rgba, TextureImage } from '../texture/image';
import { TextureStroke, type Point, type Region } from '../texture/stroke';
import { area, barycentric, bounds, brushStrength, dab, footprint, Projection, sampleUv, writable,
  type Bounds, type Dab, type Mode, type Triple } from './projection';
import { paintMapping, paintView } from './scene';
import type { Brush, Coverage, StrokeInput } from './stroke-worker';

const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`paint-${id}`)! as T;
const limit = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

interface Context {
  model: Model;
  adapter: ModelAdapter;
  targets: TextureTarget[];
  revision: number;
  region(target: TextureTarget): Region | undefined;
}

interface Gesture {
  brush: Brush;
  color: Rgba;
  projection: Projection;
  target: TextureTarget;
  mapping: ReturnType<typeof paintMapping>;
  points: Point[];
}

export class PaintTool {
  readonly target = ui<HTMLSelectElement>('target');
  #mode = ui<HTMLSelectElement>('mode');
  #size = ui<HTMLInputElement>('size');
  #scope = ui<HTMLSelectElement>('mask');
  #shared = ui<HTMLInputElement>('shared');
  #pick = ui<HTMLButtonElement>('select');
  #clear = ui<HTMLButtonElement>('clear');
  #cursor = ui<HTMLCanvasElement>('cursor');
  #clip = ui<HTMLSelectElement>('clip');
  #seconds = ui<HTMLInputElement>('seconds');
  #sizes: Record<Mode, number> = { surface: 0, screen: 24, pixel: 1 };
  #picking = false;
  #locked = false;
  #active = false;
  #mask = new Set<string>();
  #context?: Context;
  #target?: TextureTarget;
  #mapping?: ReturnType<typeof paintMapping>;
  #projection?: Projection;
  #frame?: number;
  #pointer?: Point;
  #image?: TextureImage;
  #pendingImage?: Promise<TextureImage>;
  #bindingSignature = '';

  constructor(readonly viewer: Viewer, readonly canvas: HTMLCanvasElement,
    readonly load: (target: TextureTarget) => Promise<TextureImage>,
    readonly changeTarget: (id: string) => void) {
    this.target.addEventListener('change', () => changeTarget(this.target.value));
    this.#mode.addEventListener('change', () => { this.#sizeUi(); this.#queueCursor(); });
    this.#size.addEventListener('input', () => {
      const mode = this.#mode.value as Mode, value = this.#size.valueAsNumber;
      if (value > 0) this.#sizes[mode] = mode === 'pixel' ? Math.max(1, Math.round(value)) : value;
      this.#queueCursor();
    });
    for (const id of ['opacity', 'hardness']) ui(id).addEventListener('input', () => this.#queueCursor());
    this.#shared.addEventListener('change', () => { this.#info(); this.#queueCursor(); });
    this.#scope.addEventListener('change', () => { this.#mask.clear(); this.#picking = false; this.#info(); this.#queueCursor(); });
    this.#pick.addEventListener('click', () => { this.#picking = !this.#picking; this.#info(); this.#queueCursor(); });
    this.#clear.addEventListener('click', () => { this.#mask.clear(); this.#info(); this.#queueCursor(); });
    this.#clip.addEventListener('change', () => this.#pose());
    this.#seconds.addEventListener('change', () => this.#pose());
    viewer.onCameraChange = () => { this.#projection = undefined; this.leave(); };
  }

  configure(active: boolean, locked: boolean, context?: Context, wanted?: string) {
    const old = this.#context, wasActive = this.#active;
    const changedModel = old?.adapter !== context?.adapter;
    this.#context = context;
    this.#active = active;
    this.#locked = locked;
    ui('tools').hidden = this.#cursor.hidden = !active;
    if (!active || locked) this.leave();
    if (changedModel) {
      this.#sizes.surface = 0;
      this.#scope.value = '';
      const clips = context?.model.scene.animations ?? [];
      this.#clip.replaceChildren(new Option('Rest pose', ''), ...clips.map((clip, index) => new Option(clip.name || `Clip ${index + 1}`, String(index))));
      this.#seconds.value = '0';
      ui('pose').hidden = !clips.length;
    }
    if (changedModel || old?.revision !== context?.revision || old?.model !== context?.model) this.#projection = undefined;
    const signature = context?.targets.map(t => `${t.binding.id}:${t.key}:${t.binding.label}`).join('\n') ?? '';
    if (signature !== this.#bindingSignature) {
      this.#bindingSignature = signature;
      this.target.replaceChildren(...(context?.targets ?? []).map(t => new Option(`${t.binding.label}${t.atlas ? ' (atlas)' : ''}`, t.binding.id)));
    }
    const target = context?.targets.find(t => t.binding.id === wanted) ?? context?.targets[0];
    this.target.value = target?.binding.id ?? '';
    const changedTarget = changedModel || target?.key !== this.#target?.key || target?.binding.id !== this.#target?.binding.id;
    this.#target = target;
    if (changedTarget) {
      this.#projection = this.#mapping = undefined;
      this.#mask.clear();
      this.#picking = this.#shared.checked = false;
    }
    if (changedTarget || old?.revision !== context?.revision) this.#pendingImage = this.#image = undefined;
    if (active && target && !this.#mapping) this.#mapping = paintMapping(context!.model, target);
    if (active && !locked && target && !this.#mapping?.unsupported) this.#prepareImage(target);
    if (active && (!wasActive || changedModel)) {
      this.#sizeUi();
      this.#pose();
    } else if (!active && wasActive) {
      this.viewer.freeze();
    }
    this.#info();
  }

  #prepareImage(target: TextureTarget) {
    if (this.#image || this.#pendingImage) return;
    const pending = this.load(target);
    this.#pendingImage = pending;
    void pending.then(image => {
      if (this.#pendingImage !== pending) return;
      this.#image = image;
      this.#info();
      this.#queueCursor();
    }).catch(error => {
      if (this.#pendingImage === pending) ui('info').textContent = error instanceof Error ? error.message : String(error);
    });
  }

  #pose() {
    if (!this.#active || !this.#context) return;
    const clip = this.#clip.value ? this.#context.model.scene.animations[Number(this.#clip.value)] : undefined;
    this.#seconds.max = String(clip?.duration ?? 0);
    const time = limit(this.#seconds.valueAsNumber || 0, 0, clip?.duration ?? 0);
    this.#seconds.value = String(time);
    this.viewer.freeze(clip, time);
    this.#projection = undefined;
    this.#info();
    this.#queueCursor();
  }

  #sizeUi() {
    if (!this.#sizes.surface) {
      const camera = this.viewer.camera;
      const span = camera && ('top' in camera ? camera.top - camera.bottom : (camera.far / 100) * 2.55);
      this.#sizes.surface = Number(((span || 1) * .05).toPrecision(3));
    }
    const mode = this.#mode.value as Mode;
    this.#size.min = mode === 'surface' ? '0.000001' : '1';
    this.#size.step = mode === 'surface' ? 'any' : '1';
    this.#size.value = String(this.#sizes[mode]);
    ui('units').textContent = mode === 'surface' ? 'Diameter (scene units)' : mode === 'screen' ? 'Diameter (viewport px)' : 'Width (texels)';
  }

  #info() {
    const { unsupported, overlap } = this.#mapping ?? {};
    const target = this.#target;
    const shared = (target?.shared.length ?? 0) > 1;
    for (const field of [this.target, this.#mode, this.#size, this.#scope, this.#clip, this.#shared, ui<HTMLInputElement>('color'),
      ui<HTMLInputElement>('opacity'), ui<HTMLInputElement>('hardness')]) field.disabled = this.#locked;
    this.target.disabled ||= !target;
    this.#seconds.disabled = this.#locked || !this.#clip.value;
    this.#shared.parentElement!.hidden = !shared;
    this.#pick.disabled = this.#locked || !this.#scope.value || this.#scope.value === 'created' || !target || !!unsupported;
    this.#clear.disabled = this.#locked || !this.#mask.size;
    this.#pick.setAttribute('aria-pressed', String(this.#picking));
    const messages: string[] = [];
    if (!target) messages.push('No editable Base Color binding. Add a color map and UVs to the source or generate an atlas for an eligible FBX.');
    else if (unsupported) messages.push(unsupported);
    else {
      if (overlap) messages.push('Overlapping UVs detected. Shared texels affect every surface that uses them, including outside a mask.');
      if (shared) messages.push(`This image is shared by ${target.shared.length} bindings. Enable Edit shared map or use Copy for this binding in the texture editor.`);
      if (this.#scope.value === 'created') messages.push(`${this.#createdMask(target).size} new faces with paintable UVs.`);
      else if (this.#scope.value) messages.push(`${this.#mask.size} selected ${this.#scope.value === 'face' ? 'faces' : 'islands'}. ${this.#picking ? 'Click a region to toggle it.' : 'Use Pick mask regions to change the selection.'}`);
      if (!this.#image) messages.push('Loading Base Color…');
      if (target.binding.material.transparent || target.binding.material.alphaTest > 0) {
        messages.push('Picking and occlusion use the surface even where its texture is transparent.');
      }
      messages.push('Drag to paint. Right-drag to orbit and scroll to zoom.');
    }
    ui('info').textContent = messages.join(' ');
  }

  #project() {
    const target = this.#target, context = this.#context, camera = this.viewer.camera;
    if (!target || !context || !camera || !this.#mapping || this.#mapping.unsupported) return;
    return this.#projection ??= this.viewer.withPose(() => new Projection(
      paintView(context.adapter, target, this.#mapping!.faces, camera, this.canvas.width, this.canvas.height)));
  }

  #brush(image: TextureImage, target: TextureTarget): Brush {
    const mode = this.#mode.value as Mode, created = this.#scope.value === 'created';
    const kind = created ? 'face' : this.#scope.value as Brush['kind'];
    const cssScale = this.canvas.width / this.canvas.getBoundingClientRect().width;
    return { mode, radius: Math.min(this.#sizes[mode], mode === 'screen' ? 512 : mode === 'pixel' ? 512 : Infinity) / 2 * (mode === 'screen' ? cssScale : 1),
      opacity: limit((ui<HTMLInputElement>('opacity').valueAsNumber || 0) / 100, 0, 1),
      hardness: limit((ui<HTMLInputElement>('hardness').valueAsNumber || 0) / 100, 0, 1),
      width: image.width, height: image.height, kind: kind || undefined, mask: created ? this.#createdMask(target) : kind ? new Set(this.#mask) : undefined,
      region: this.#context?.region(target) };
  }

  #createdMask(target: TextureTarget) {
    const entry = this.#context?.adapter.mesh.render.get(target.binding.object);
    return new Set((entry?.state.mesh.faces ?? []).filter(face => face.created && !face.needsUv && face.material === target.binding.slot)
      .map(face => `${target.binding.object}/face/${face.id}`));
  }

  selectFaces(object: string, ids: readonly number[]) {
    this.#scope.value = 'face';
    this.#picking = false;
    this.#mask = new Set(ids.map(id => `${object}/face/${id}`));
    this.#info();
    this.#queueCursor();
  }

  begin(point: Point): Gesture | string | undefined {
    const target = this.#target, mapping = this.#mapping, image = this.#image;
    if (!target || !mapping || !image || mapping.unsupported) return 'Choose a supported Base Color binding before painting.';
    const projection = this.#project();
    if (!projection) return;
    const hit = projection.hit(point.x, point.y);
    if (this.#picking) {
      if (hit && writable(projection, hit.face)) {
        const face = projection.view.faces[hit.face];
        const id = this.#scope.value === 'face' ? face.source : face.island;
        if (!this.#mask.delete(id)) this.#mask.add(id);
        this.#info();
        this.move(point);
      }
      return;
    }
    if (hit && !projection.view.faces[hit.face].uv) {
      return `The visible face uses ${projection.view.faces[hit.face].material}. Choose its Base Color binding to paint it.`;
    }
    if (target.shared.length > 1 && !this.#shared.checked) return 'Enable Edit shared map or copy the binding before painting.';
    const brush = this.#brush(image, target);
    if (brush.mask && !brush.mask.size) return 'Pick faces or UV islands before painting with a mask.';
    if (!brush.opacity) return 'Increase brush opacity to paint.';
    return { target, projection, mapping, brush, points: [point], color: parseColor(ui<HTMLInputElement>('color').value) };
  }

  async finish(gesture: Gesture, base: TextureImage, signal?: AbortSignal) {
    const { brush, projection, points, mapping, target, color } = gesture;
    const input: StrokeInput = { ...brush, view: projection.view, points,
      padding: target.atlas && this.#context?.model.format === 'fbx' ? this.#context.model.textureBake?.padding ?? 8 : 2,
      occupied: mapping.shared };
    const worker = new Worker(new URL('./stroke-worker.ts', import.meta.url), { type: 'module' });
    const { pixels, strength, padding } = await finishWorker<Coverage>(worker, input, [], signal);
    const draft = new TextureStroke(base, { tool: 'brush', size: brush.radius * 2, opacity: brush.opacity,
      hardness: brush.hardness, square: false, color, alpha: false });
    const texels = draft.applyCoverage(pixels, strength, padding);
    return { image: draft.finish(), texels };
  }

  move(point: Point) {
    this.#pointer = point;
    this.#queueCursor();
  }

  leave() {
    this.#pointer = undefined;
    this.#cursor.getContext('2d')!.clearRect(0, 0, this.#cursor.width, this.#cursor.height);
  }

  #queueCursor() {
    if (this.#frame === undefined && this.#active) this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      this.#drawCursor();
    });
  }

  #drawCursor() {
    const context = this.#cursor.getContext('2d')!, { width, height } = this.#cursor;
    context.clearRect(0, 0, width, height);
    const point = this.#pointer, target = this.#target, image = this.#image;
    if (!this.#active || this.#locked || !point || !target || !image) return;
    const projection = this.#project();
    if (!projection) return;
    const brush = this.#brush(image, target), { radius, mode, kind, mask, region } = brush;
    const sample = dab(projection, point, radius, mode, brush.width, brush.height);
    if (!sample) return;
    if (this.#picking) {
      const face = projection.view.faces[sample.hit.face];
      const id = kind === 'face' ? face.source : face.island;
      context.beginPath();
      for (const [i, af] of projection.view.faces.entries()) {
        if (!af.uv || (kind === 'face' ? af.source : af.island) !== id) continue;
        const screen = projection.screen[i];
        if (!screen?.front) continue;
        const [a, b, c] = screen.triangle;
        context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.lineTo(c.x, c.y); context.closePath();
      }
      context.strokeStyle = this.#mask.has(id) ? '#42ffd2' : '#fff';
      context.stroke();
      return;
    }
    if (target.shared.length > 1 && !this.#shared.checked) return;
    const box = cursorBounds(projection, sample, brush, this.viewer.camera!);
    const x0 = limit(Math.floor(box.x0), 0, width), x1 = limit(Math.ceil(box.x1), 0, width);
    const y0 = limit(Math.floor(box.y0), 0, height), y1 = limit(Math.ceil(box.y1), 0, height);
    if (x0 >= x1 || y0 >= y1) return;
    const preview = context.createImageData(x1 - x0, y1 - y0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const origin = { x: x + .5, y: y + .5 }, hit = projection.hit(origin.x, origin.y);
      if (!hit || !writable(projection, hit.face, mask, kind)) continue;
      const face = projection.view.faces[hit.face];
      if (mode === 'pixel' && face.island !== projection.view.faces[sample.hit.face].island) continue;
      const uv = sampleUv(face.uv!, hit.weights, brush.width, brush.height);
      if (region && (uv.x < region.x0 || uv.x >= region.x1 || uv.y < region.y0 || uv.y >= region.y1)) continue;
      const d = footprint(sample, hit.face, hit.weights, origin, uv, mode, radius);
      const alpha = brushStrength(d, brush.opacity, mode === 'pixel' ? 1 : brush.hardness);
      if (!alpha) continue;
      const pixel = 4 * ((y - y0) * preview.width + x - x0);
      preview.data.set([95, 241, 255, Math.round(60 + 95 * alpha)], pixel);
    }
    context.putImageData(preview, x0, y0);
  }
}

function cursorBounds(projection: Projection, sample: Dab, brush: Brush, camera: Camera): Bounds {
  const { point, pixel, hit } = sample, r = brush.radius;
  if (brush.mode === 'screen') return { x0: point.x - r, y0: point.y - r, x1: point.x + r, y1: point.y + r };
  const { faces, width, height } = projection.view;
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  const include = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  if (brush.mode === 'surface') {
    const [a, b, c] = faces[hit.face].world, [i, j, k] = hit.weights;
    const pos = new Vector3(i * a[0] + j * b[0] + k * c[0], i * a[1] + j * b[1] + k * c[1], i * a[2] + j * b[2] + k * c[2]);
    for (const x of [-r, r]) for (const y of [-r, r]) for (const z of [-r, r]) {
      const corner = pos.clone().add(new Vector3(x, y, z));
      if (corner.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) return { x0: 0, y0: 0, x1: width, y1: height };
      corner.project(camera);
      include((.5 + .5 * corner.x) * width, (.5 - .5 * corner.y) * height);
    }
  } else {
    const island = faces[hit.face].island;
    for (const [id, face] of faces.entries()) {
      const screen = projection.screen[id];
      if (!screen?.front || !face.uv || face.island !== island) continue;
      const uv = face.uv.map(p => ({ x: p.x * brush.width, y: p.y * brush.height })) as unknown as Triple<Point>;
      const box = bounds(uv), det = area(uv);
      if (Math.abs(det) < 1e-12 || box.x1 < pixel.x - r || box.y1 < pixel.y - r || box.x0 > pixel.x + r || box.y0 > pixel.y + r) continue;
      // The viewport bounds are conservative when the pixel rectangle also
      // covers space outside the triangle.
      const clip = screen.bounds;
      for (const x of [pixel.x - r, pixel.x + r]) for (const y of [pixel.y - r, pixel.y + r]) {
        const p = projection.point(id, barycentric(uv, det, x, y));
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          include(clip.x0, clip.y0); include(clip.x1, clip.y1);
        } else include(limit(p.x, clip.x0, clip.x1), limit(p.y, clip.y0, clip.y1));
      }
    }
  }
  return { x0, y0, x1, y1 };
}

function parseColor(hex: string): Rgba {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255];
}
