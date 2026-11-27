import { BufferGeometry, Euler, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh,
  Object3D, Points, PointsMaterial, Quaternion, Raycaster, Vector2, Vector3, type Camera } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Viewer } from '../project/viewer';
import type { ModelAdapter } from '../project/adapter';
import type { MeshEdit } from './commands';
import { connected, edgesOf, edgeKey, edgeVertices, verticesOf, type Face, type Kind, type MeshData, type Vec3 } from './data';
import { applyMeshEdit, center } from './edit';
import { faceNormal, vector } from './polygon';

const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`mesh-${id}`)! as T;
const choice = (id: string) => ui<HTMLSelectElement>(id).value;
const number = (id: string) => ui<HTMLInputElement>(id).valueAsNumber;
const toggle = (id: string) => ui<HTMLInputElement>(id).checked;
const xyz = ['x', 'y', 'z'] as const;
const transforms = new Set<MeshEdit['type']>(['move', 'rotate', 'scale']);

interface Context {
  adapter: ModelAdapter;
  id: string;
  revision: number;
  blocked: boolean;
}

export class MeshTool {
  #panel = ui<HTMLFieldSetElement>('tools');
  #kind = ui<HTMLSelectElement>('kind');
  #ids = ui<HTMLInputElement>('ids');
  #operation = ui<HTMLSelectElement>('operation');
  #outline = new Group();
  #line = new LineBasicMaterial({ color: 0x5fe6fd });
  #previewLine = new LineBasicMaterial({ color: 0xffb64d, depthTest: false });
  #points = new PointsMaterial({ color: 0x5fe6fd, size: 7, sizeAttenuation: false, depthTest: false });
  #handle = new Object3D();
  #gizmo?: TransformControls;
  #camera?: Camera;
  #context?: Context;
  #mesh?: Mesh;
  #data?: MeshData;
  #selection = { vertex: [] as number[], edge: [] as string[], face: [] as number[] };
  #preview?: { edit: MeshEdit; revision: number; geometry: ReturnType<typeof applyMeshEdit> };
  #locked = false;

  constructor(readonly viewer: Viewer, readonly canvas: HTMLCanvasElement, readonly applyEdit: (edit: MeshEdit, revision: number) => Promise<boolean>,
    readonly orbit: (dragging: boolean) => void) {
    viewer.scene.add(this.#outline, this.#handle);
    this.#kind.addEventListener('change', () => this.#selectionChanged());
    this.#ids.addEventListener('change', () => this.#typedSelection());
    this.#operation.addEventListener('change', () => {
      this.#resetNumbers();
      this.#cancel();
      this.#syncFields();
    });
    for (const name of [...xyz, 'axis', 'pivot', 'material', 'project', 'weld-mode', 'tolerance', 'fraction']) {
      ui(name).addEventListener('input', () => this.#cancel());
    }
    ui('connected').addEventListener('click', () => this.#selectConnected());
    ui('winding').addEventListener('click', () => {
      this.#selection.vertex.reverse();
      this.#selectionChanged();
      this.preview();
    });
    ui('preview').addEventListener('click', () => { this.preview(); this.canvas.focus({ preventScroll: true }); });
    ui('apply').addEventListener('click', () => void this.apply());
    ui('cancel').addEventListener('click', () => this.#cancel());
  }

  get dragging() { return !!this.#gizmo?.dragging; }
  get gizmoHit() { return !!this.#gizmo?.axis && !!this.#gizmo.object; }
  get context() { return this.#context; }

  configure(context: Context | undefined, locked: boolean) {
    const previous = this.#context;
    this.#context = context;
    this.#locked = locked;
    this.#panel.hidden = !context;
    this.#panel.disabled = locked;
    if (!context) {
      if (previous) {
        this.#preview = this.#data = this.#mesh = undefined;
        this.#selection = { vertex: [], edge: [], face: [] };
        this.#clearOutline();
        this.#teardownGizmo();
        this.viewer.render();
      }
      return;
    }
    if (previous?.adapter !== context.adapter || previous?.id !== context.id || previous?.blocked !== context.blocked) {
      this.#selection = { vertex: [], edge: [], face: [] };
      this.#resetNumbers();
    }
    if (previous?.adapter !== context.adapter || previous?.id !== context.id ||
        previous?.revision !== context.revision || previous?.blocked !== context.blocked || this.#camera !== this.viewer.camera) {
      this.#preview = this.#data = this.#mesh = undefined;
      const node = context.adapter.objects.get(context.id);
      this.#say(context.blocked ? 'Discard the generated atlas through the UV tools before editing source topology.'
        : 'Select a mesh object to edit.');
      if (node instanceof Mesh && !context.blocked) {
        try {
          this.#mesh = node;
          this.#data = context.adapter.mesh.data(context.id);
          const live = new Set(this.#data.faces.flatMap(verticesOf)), edge = edgesOf(this.#data), faces = new Set(this.#data.faces.map(f => f.id));
          this.#selection = { vertex: this.#selection.vertex.filter(id => live.has(id)), edge: this.#selection.edge.filter(id => edge.has(id)),
            face: this.#selection.face.filter(id => faces.has(id)) };
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          const picker = ui<HTMLSelectElement>('material');
          const previous = picker.value;
          picker.replaceChildren(...materials.map((material, i) => new Option(material.name || `Material ${i + 1}`, String(i))));
          if ([...picker.options].some(option => option.value === previous)) picker.value = previous;
          this.#summary();
        } catch (error) { this.#say(error instanceof Error ? error.message : String(error)); }
      }
      this.#ids.value = this.#currentSelection().join(', ');
      this.#attachGizmo();
      this.#draw();
    }
    if (this.#gizmo) this.#gizmo.enabled = !locked;
    this.#syncFields();
  }

  keyboard(key: string) {
    if (!this.#context || this.#locked) return false;
    const kind = ({ '1': 'vertex', '2': 'edge', '3': 'face' } as Record<string, Kind>)[key];
    const op = ({ w: 'move', e: 'rotate', r: 'scale', Delete: 'delete' } as Record<string, string>)[key];
    if (kind) { this.#kind.value = kind; this.#selectionChanged(); return true; }
    if (op) { this.#operation.value = op; this.#resetNumbers(); this.#cancel(); this.#syncFields(); return true; }
    if (key === 'Escape' && this.#preview) { this.#cancel(); return true; }
    if (key === 'Enter') {
      if (this.#preview) void this.apply();
      else this.preview();
      return true;
    }
    return false;
  }

  pick(event: PointerEvent) {
    const mesh = this.#mesh, data = this.#data, context = this.#context, camera = this.viewer.camera;
    if (!mesh || !data || !context || !camera) return;
    const rect = this.canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(2 * x / rect.width - 1, 1 - 2 * y / rect.height), camera);
    const hit = ray.intersectObject(mesh, false)[0];
    if (hit?.faceIndex == null) return;
    const topo = context.adapter.workingTopology(context.id);
    const face = data.faces[topo?.renderFaces[hit.faceIndex] ?? -1];
    if (!face) return;
    const vertices = verticesOf(face);
    const projected = vertices.map(id => vector(data, id).applyMatrix4(mesh.matrixWorld).project(camera))
      .map(v => new Vector2((v.x + 1) * rect.width / 2, (1 - v.y) * rect.height / 2));
    const distance = (p: Vector2) => p.distanceToSquared(new Vector2(x, y));
    const nearest = (measure: (i: number) => number) => projected.reduce((best, _, i) => measure(i) < measure(best) ? i : best, 0);
    const kind = this.#kind.value as Kind;
    if (kind === 'face') this.#selection.face = picked(this.#selection.face, face.id, event.shiftKey);
    else if (kind === 'vertex') this.#selection.vertex = picked(this.#selection.vertex, vertices[nearest(i => distance(projected[i]))], event.shiftKey);
    else {
      const edge = nearest(i => {
        const a = projected[i], b = projected[(i + 1) % projected.length], d = b.clone().sub(a);
        const t = Math.max(0, Math.min(1, new Vector2(x, y).sub(a).dot(d) / (d.lengthSq() || 1)));
        return distance(a.clone().addScaledVector(d, t));
      });
      this.#selection.edge = picked(this.#selection.edge, edgeKey(vertices[edge], vertices[(edge + 1) % vertices.length]), event.shiftKey);
    }
    this.#selectionChanged();
  }

  preview() {
    const data = this.#data, context = this.#context;
    if (!data || !context || this.#locked) return;
    this.#preview = undefined;
    try {
      const edit = this.#command(context), geometry = applyMeshEdit(data, edit);
      this.#preview = { edit, revision: context.revision, geometry };
      const after = geometry.mesh.faces.length;
      const retained = new Set(geometry.mesh.faces);
      const affected = data.faces.filter(face => !retained.has(face) || face.corners.some(({ vertex }) =>
        [0, 1, 2].some(k => data.positions[3 * vertex + k] !== geometry.mesh.positions[3 * vertex + k]))).length;
      const warning = edit.type === 'create' && !edit.project ? ' New face requires UV unwrapping.' : '';
      this.#say(`Preview · ${affected} existing faces affected · ${data.faces.length} → ${after} faces${geometry.piece ? ` + ${geometry.piece.faces.length} in the new object` : ''}.${warning}`);
    } catch (error) { this.#say(error instanceof Error ? error.message : String(error)); }
    this.#syncFields();
    this.#draw();
  }

  async apply() {
    const preview = this.#preview;
    if (!preview || this.#locked) return;
    const ok = await this.applyEdit(preview.edit, preview.revision);
    if (!ok) return;
    if (preview.edit.type === 'create' && toggle('chain')) {
      const { vertices } = preview.edit;
      this.#kind.value = 'vertex';
      this.#selection.vertex = [vertices.at(-1)!, vertices.at(-2)!];
    }
    this.#resetNumbers();
    this.#selectionChanged();
  }

  #command({ adapter, id }: Context): MeshEdit {
    const object = id, type = choice('operation') as MeshEdit['type'];
    const vertices = this.#selection.vertex;
    const edge = () => {
      if (this.#selection.edge.length !== 1) throw new Error('Select exactly one edge.');
      return this.#selection.edge[0];
    };
    switch (type) {
      case 'move': case 'rotate': case 'scale': {
        const vertices = this.#selectedVertices();
        if (!vertices.length) throw new Error('Select vertices, edges or faces to transform.');
        const axis = choice('axis').toLowerCase();
        const value = xyz.map(key => axis && key !== axis ? Number(type === 'scale') : number(key)) as unknown as Vec3;
        if (!value.every(Number.isFinite)) throw new Error('Enter finite values for all axes.');
        return { type, object, vertices, value, pivot: choice('pivot') ? [0, 0, 0] : undefined };
      }
      case 'create':
        if (vertices.length < 3) throw new Error('Select three or more vertices in contour order.');
        return { type, object, vertices: [...vertices], material: Number(choice('material')), project: toggle('project') };
      case 'weld':
        if (vertices.length < 2) throw new Error('Select at least two vertices.');
        if (!(number('tolerance') > 0)) throw new Error('Enter a positive weld tolerance.');
        return { type, object, vertices: [...vertices], mode: choice('weld-mode') as 'first' | 'average' | 'tolerance', tolerance: number('tolerance') };
      case 'splitEdge': {
        const fraction = number('fraction');
        if (!(fraction > 0 && fraction < 1)) throw new Error('Choose a position strictly between 0 and 1.');
        return { type, object, edge: edge(), fraction };
      }
      case 'splitFace':
        if (this.#selection.face.length !== 1 || vertices.length !== 2) throw new Error('Select one face and two of its non-adjacent vertices.');
        return { type, object, face: this.#selection.face[0], diagonal: [...vertices] };
      case 'dissolve': case 'flipEdge': return { type, object, edge: edge() };
      default: {
        const faces = this.#selectedFaces();
        if (!faces.length) throw new Error('Select affected faces or the vertices or edges they use.');
        if (type !== 'separate') return { type, object, faces };
        adapter.mesh.validateSeparate(object);
        const next = Math.max(...[...adapter.objects.keys()].map(key => Number(key.slice(7)))) + 1;
        return { type, object, faces, piece: `object-${next}` };
      }
    }
  }

  #syncFields() {
    const type = choice('operation') as MeshEdit['type'];
    const fields = { transform: transforms.has(type), create: type === 'create', weld: type === 'weld', split: type === 'splitEdge' };
    for (const [id, show] of Object.entries(fields)) ui(id).hidden = !show;
    const ok = !!this.#data && !this.#locked;
    ui<HTMLButtonElement>('preview').disabled = !ok;
    ui<HTMLButtonElement>('connected').disabled = !ok;
    ui<HTMLButtonElement>('apply').disabled = !ok || !this.#preview;
    ui<HTMLButtonElement>('cancel').disabled = !ok || !this.#preview;
    this.#ids.disabled = !ok;
  }

  #selectedFaces() {
    const data = this.#data!;
    const kind = this.#kind.value as Kind;
    if (kind === 'face') return [...this.#selection.face];
    const vertices = new Set(this.#selection.vertex);
    const sides = new Set(this.#selection.edge.flatMap(edge => (edgesOf(data).get(edge) ?? []).map(side => side.face.id)));
    return data.faces.filter(face => kind === 'edge' ? sides.has(face.id) : face.corners.some(c => vertices.has(c.vertex))).map(face => face.id);
  }

  #selectedVertices() {
    if (this.#kind.value === 'vertex') return [...this.#selection.vertex];
    const ids = new Set(this.#selection.face);
    return [...new Set(this.#kind.value === 'edge' ? this.#selection.edge.flatMap(edgeVertices) :
      this.#data!.faces.filter(face => ids.has(face.id)).flatMap(verticesOf))];
  }

  #selectConnected() {
    if (!this.#data) return;
    const faces = connected(this.#data, this.#selectedFaces());
    this.#kind.value = 'face';
    this.#selection.face = [...faces];
    this.#selectionChanged();
  }

  #currentSelection() { return this.#selection[this.#kind.value as Kind]; }
  #typedSelection() {
    if (!this.#data) return;
    const tokens = this.#ids.value.trim().split(/[\s,]+/).filter(Boolean), kind = this.#kind.value as Kind;
    try {
      if (kind === 'edge') {
        const actual = edgesOf(this.#data);
        const edges = tokens.map(value => /^\d+\/\d+$/.test(value) ? edgeKey(Number(value.split('/')[0]), Number(value.split('/')[1])) : '');
        if (!edges.every(edge => actual.has(edge))) throw new Error('Enter existing edge IDs as vertex/vertex pairs.');
        this.#selection.edge = [...new Set(edges)];
      } else {
        if (!tokens.every(id => /^\d+$/.test(id))) throw new Error('Enter existing numeric IDs.');
        const ids = tokens.map(Number), actual = new Set(kind === 'face' ? this.#data.faces.map(face => face.id) : this.#data.faces.flatMap(verticesOf));
        if (!ids.every(id => actual.has(id))) throw new Error('One or more IDs do not belong to this object.');
        this.#selection[kind] = [...new Set(ids)];
      }
      this.#selectionChanged();
    } catch (error) {
      this.#cancel();
      this.#say(error instanceof Error ? error.message : String(error));
    }
  }

  #selectionChanged() {
    this.#ids.value = this.#currentSelection().join(', ');
    this.#cancel();
  }

  #cancel() {
    this.#preview = undefined;
    if (this.#data) this.#summary();
    this.#syncFields();
    this.#poseGizmo();
    this.#draw();
  }

  #resetNumbers() {
    for (const axis of xyz) ui<HTMLInputElement>(axis).value = this.#operation.value === 'scale' ? '1' : '0';
  }

  #summary() {
    const data = this.#data!;
    const pending = data.faces.filter(face => face.needsUv).length;
    const detail = this.#kind.value === 'edge' ? 'Edge IDs use vertex/vertex.' : 'Shift-click adds or removes an element.';
    this.#say(`${this.#currentSelection().length} selected · ${data.faces.length} faces. ${detail}${pending ? ` ${pending} faces require UV unwrapping.` : ''}`);
  }

  #say(text: string) { ui('info').textContent = text; }

  #clearOutline() {
    for (const node of this.#outline.children) (node as LineSegments | Points).geometry.dispose();
    this.#outline.clear();
  }

  #draw() {
    this.#clearOutline();
    const data = this.#data, mesh = this.#mesh;
    if (!data || !mesh) { this.viewer.render(); return; }
    mesh.updateWorldMatrix(true, false);
    const world = (source: MeshData, id: number) => vector(source, id).applyMatrix4(mesh.matrixWorld).toArray();
    const selected = new Set(this.#selection.face), lines: number[] = [];
    for (const key of this.#selection.edge) for (const id of edgeVertices(key)) lines.push(...world(data, id));
    for (const face of data.faces) if (selected.has(face.id)) this.#outlineFace(data, face, lines, world);
    if (lines.length) this.#outline.add(new LineSegments(positions(lines), this.#line));
    if (this.#selection.vertex.length) this.#outline.add(new Points(positions(this.#selection.vertex.flatMap(id => world(data, id))), this.#points));
    const preview = this.#preview?.geometry;
    if (preview) {
      const known = new Set(data.faces), annotation: number[] = [];
      for (const face of preview.mesh.faces) if (!known.has(face) || face.corners.some(c =>
        !vector(data, c.vertex).equals(vector(preview.mesh, c.vertex)))) {
        for (let i = 0; i < face.triangles.length; i += 3) {
          for (let j = 0; j < 3; j++) {
            annotation.push(...world(preview.mesh, face.corners[face.triangles[i + j]].vertex),
              ...world(preview.mesh, face.corners[face.triangles[i + (j + 1) % 3]].vertex));
          }
        }
        if (this.#preview?.edit.type === 'create') {
          const pivot = center(preview.mesh, verticesOf(face)), size = pivot.distanceTo(vector(preview.mesh, face.corners[0].vertex)) * .5;
          const end = pivot.clone().addScaledVector(faceNormal(preview.mesh, face).normalize(), size);
          annotation.push(...pivot.applyMatrix4(mesh.matrixWorld).toArray(), ...end.applyMatrix4(mesh.matrixWorld).toArray());
        }
      }
      const removed = new Set(preview.mesh.faces.map(face => face.id));
      for (const face of data.faces) if (!removed.has(face.id)) this.#outlineFace(data, face, annotation, world);
      if (annotation.length) this.#outline.add(new LineSegments(positions(annotation), this.#previewLine));
    }
    this.viewer.render();
  }

  #outlineFace(data: MeshData, face: Face, output: number[], world: (source: MeshData, id: number) => number[]) {
    const vertices = verticesOf(face);
    for (let i = 0; i < vertices.length; i++) output.push(...world(data, vertices[i]), ...world(data, vertices[(i + 1) % vertices.length]));
  }

  #teardownGizmo() {
    if (!this.#gizmo) return;
    this.#gizmo.getHelper().removeFromParent();
    this.#gizmo.dispose();
    this.#gizmo = undefined;
    this.#camera = undefined;
  }

  #attachGizmo() {
    if (this.#camera !== this.viewer.camera) {
      this.#teardownGizmo();
      const camera = this.viewer.camera;
      if (camera) {
        this.#camera = camera;
        const gizmo = this.#gizmo = new TransformControls(camera, this.canvas);
        gizmo.setSpace('local');
        gizmo.setSize(.7);
        this.viewer.scene.add(gizmo.getHelper());
        gizmo.addEventListener('dragging-changed', event => this.orbit(Boolean(event.value)));
        gizmo.addEventListener('change', () => this.viewer.render());
        gizmo.addEventListener('mouseUp', () => this.#gizmoTransform());
      }
    }
    this.#poseGizmo();
  }

  #poseGizmo() {
    const gizmo = this.#gizmo, data = this.#data, mesh = this.#mesh;
    const mode = this.#operation.value as MeshEdit['type'];
    if (!gizmo || gizmo.dragging) return;
    const ids = data ? this.#selectedVertices() : [];
    if (!mesh || !data || !ids.length || !transforms.has(mode)) { gizmo.detach(); return; }
    const pivot = choice('pivot') ? new Vector3() : center(data, ids);
    this.#handle.position.copy(mesh.localToWorld(pivot));
    mesh.getWorldQuaternion(this.#handle.quaternion);
    this.#handle.scale.setScalar(1);
    gizmo.setMode(mode === 'move' ? 'translate' : mode as 'rotate' | 'scale');
    const axis = choice('axis');
    gizmo.showX = !axis || axis === 'X';
    gizmo.showY = !axis || axis === 'Y';
    gizmo.showZ = !axis || axis === 'Z';
    gizmo.attach(this.#handle);
  }

  #gizmoTransform() {
    const mesh = this.#mesh, data = this.#data;
    if (!mesh || !data) return;
    const type = this.#operation.value;
    const pivot = choice('pivot') ? new Vector3() : center(data, this.#selectedVertices());
    const values = type === 'move' ? mesh.worldToLocal(this.#handle.position.clone()).sub(pivot).toArray()
      : type === 'scale' ? this.#handle.scale.toArray()
      : new Euler().setFromQuaternion(mesh.getWorldQuaternion(new Quaternion()).invert().multiply(this.#handle.quaternion))
        .toArray().slice(0, 3).map(value => Number(value) * 180 / Math.PI);
    for (const [i, axis] of xyz.entries()) ui<HTMLInputElement>(axis).value = String(values[i]);
    this.preview();
  }
}

function picked<T>(selected: T[], item: T, toggle: boolean) {
  return toggle ? selected.includes(item) ? selected.filter(value => value !== item) : [...selected, item] : [item];
}

function positions(values: number[]) {
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(values, 3));
}
