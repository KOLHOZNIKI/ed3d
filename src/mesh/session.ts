import { Mesh, PropertyBinding, SkinnedMesh, type Object3D } from 'three';
import type { Model } from '../project/adapter';
import type { SceneEntry } from '../project/document';
import type { Topology } from '../project/topology';
import { decodeEdit } from './commands';
import { applyMeshEdit } from './edit';
import type { MeshData } from './data';
import { editableMesh, renderMesh, type RenderMesh } from './render';

type State = { root: string; mesh: MeshData };
type Source = { entry: SceneEntry; node: Mesh; geometry: Mesh['geometry']; extensions: Mesh['userData']['gltfExtensions'] };
type Render = { state: State; node: Mesh; render: RenderMesh };
const noCommands: readonly Uint8Array<ArrayBuffer>[] = [];

export class MeshSession {
  #sources = new Map<string, Source>();
  #original = new Map<string, MeshData>();
  #commands: readonly Uint8Array<ArrayBuffer>[] = noCommands;
  #states = new Map<string, State>();
  #renders = new Map<string, Render>();
  #pieces: SceneEntry[] = [];

  constructor(readonly model: Model, entries: readonly SceneEntry[], readonly topology: ReadonlyMap<string, Topology>,
    readonly objects: Map<string, Object3D>) {
    for (const entry of entries) {
      const node = objects.get(entry.id);
      if (node instanceof Mesh) this.#sources.set(entry.id, { entry, node, geometry: node.geometry, extensions: node.userData.gltfExtensions });
    }
  }

  get pieces() { return this.#pieces; }
  get render() { return this.#renders; }
  get active() { return this.#commands.length > 0; }
  originalGeometry(id: string) { return this.#sources.get(id)?.geometry; }
  get pendingUv() {
    let count = 0;
    for (const { mesh } of this.#states.values()) for (const face of mesh.faces) if (face.needsUv) count++;
    return count;
  }
  get hasRepairFaces() {
    for (const { mesh } of this.#states.values()) if (mesh.faces.some(face => face.repaired)) return true;
    return false;
  }
  get omittedPolygonMetadata() {
    for (const { state, node } of this.#renders.values()) {
      if (this.#sources.get(state.root)?.extensions?.FB_ngon_encoding && !node.userData.gltfExtensions?.FB_ngon_encoding) return true;
    }
    return false;
  }

  data(id: string) {
    const edited = this.#states.get(id);
    if (edited) return edited.mesh;
    if (!this.#sources.has(id)) throw new Error('Select a mesh object.');
    return this.#originalMesh(id);
  }

  validateSeparate(id: string) {
    const root = this.#states.get(id)?.root ?? id;
    this.#allowSeparate(this.#sources.get(root)!.node);
  }

  materialize(edits = noCommands) {
    if (edits === this.#commands) return;
    const prefix = this.#commands.length <= edits.length && this.#commands.every((edit, i) => edit === edits[i]);
    const states = prefix ? new Map(this.#states) : new Map<string, State>();
    for (const bytes of edits.slice(prefix ? this.#commands.length : 0)) {
      const edit = decodeEdit(bytes), state = states.get(edit.object);
      const root = state?.root ?? edit.object, source = this.#sources.get(root);
      if (!source) throw new Error('A mesh edit refers to an unknown source object.');
      const base = state?.mesh ?? this.#originalMesh(root);
      const result = applyMeshEdit(base, edit);
      states.set(edit.object, { root, mesh: result.mesh });
      if (edit.type === 'separate' && result.piece) {
        this.#allowSeparate(source.node);
        if (this.#sources.has(edit.piece) || states.has(edit.piece) || this.objects.get(edit.piece) && !this.#renders.has(edit.piece)) {
          throw new Error('A saved separate operation reuses an object ID.');
        }
        states.set(edit.piece, { root, mesh: result.piece });
      }
    }
    const built = new Map<string, Render>();
    try {
      for (const [id, state] of states) {
        const prior = this.#renders.get(id);
        if (prior?.state === state) { built.set(id, prior); continue; }
        const source = this.#sources.get(state.root)!;
        const node = id === state.root ? source.node : prior?.node ?? this.#clonePiece(source.node, id);
        built.set(id, { state, node, render: renderMesh(state.mesh, source.geometry) });
      }
    } catch (error) {
      for (const [id, value] of built) if (this.#renders.get(id) !== value) value.render.geometry.dispose();
      throw error;
    }

    for (const [id, previous] of this.#renders) {
      if (built.get(id) === previous) continue;
      previous.render.geometry.dispose();
      if (!built.has(id)) this.#restore(id, previous);
    }
    const pieces: SceneEntry[] = [];
    for (const [id, { state, node, render }] of built) {
      const source = this.#sources.get(state.root)!;
      node.geometry = render.geometry;
      if (node instanceof SkinnedMesh) { node.computeBoundingBox(); node.computeBoundingSphere(); }
      if (this.model.format === 'glb' && source.extensions?.FB_ngon_encoding) {
        if (id === state.root && sameIndices(source.geometry, render.geometry) &&
            state.mesh.faces.every(face => face.corners.length === 3) && state.mesh.faces.length === this.topology.get(id)!.faceEnds.length) {
          node.userData.gltfExtensions = source.extensions;
        } else {
          const { FB_ngon_encoding: _, ...extensions } = source.extensions;
          node.userData.gltfExtensions = extensions;
        }
      }
      if (id !== state.root) {
        if (!node.parent) source.node.parent!.add(node);
        this.objects.set(id, node);
        pieces.push({ ...source.entry, id, name: node.name });
      }
    }
    this.#pieces = pieces;
    this.#renders = built;
    this.#states = states;
    this.#commands = edits;
  }

  glbSkins() {
    if (this.model.format !== 'glb') throw new Error('Expected a GLB scene.');
    const skins = new Map(this.model.skins);
    for (const [id, { state, node }] of this.#renders) {
      if (id === state.root || !(node instanceof SkinnedMesh)) continue;
      const source = this.#sources.get(state.root)!.node as SkinnedMesh;
      const skin = skins.get(source);
      if (skin) skins.set(node, skin);
    }
    return skins;
  }

  dispose() {
    for (const [id, render] of this.#renders) {
      render.render.geometry.dispose();
      this.#restore(id, render);
    }
    this.#renders.clear();
    this.#states.clear();
    this.#original.clear();
    this.#pieces = [];
    this.#commands = noCommands;
  }

  #originalMesh(id: string) {
    let mesh = this.#original.get(id);
    if (!mesh) {
      const source = this.#sources.get(id)!;
      mesh = editableMesh(source.node, this.topology.get(id)!, this.model.format === 'glb', source.geometry);
      this.#original.set(id, mesh);
    }
    return mesh;
  }

  #clonePiece(node: Mesh, id: string) {
    const clone = node.clone(false);
    clone.name = `${node.name || 'Mesh'}_part_${id.slice(7)}`;
    return clone;
  }

  #allowSeparate(node: Mesh) {
    for (const track of this.model.scene.animations.flatMap(clip => clip.tracks)) {
      const binding = PropertyBinding.parseTrackName(track.name);
      if (PropertyBinding.findNode(this.model.scene, binding.nodeName) === node) {
        throw new Error('This mesh has animation tracks on the object itself. Separate a bone-driven or static mesh to preserve the animation.');
      }
    }
  }

  #restore(id: string, prior: Render) {
    const source = this.#sources.get(id);
    if (!source) {
      prior.node.removeFromParent();
      this.objects.delete(id);
      return;
    }
    source.node.geometry = source.geometry;
    if (source.node instanceof SkinnedMesh) { source.node.computeBoundingBox(); source.node.computeBoundingSphere(); }
    if (source.extensions !== undefined) source.node.userData.gltfExtensions = source.extensions;
  }
}

function sameIndices(a: Mesh['geometry'], b: Mesh['geometry']) {
  if (a.getAttribute('position').count !== b.getAttribute('position').count) return false;
  const count = a.index?.count ?? a.getAttribute('position').count;
  if (b.index?.count !== count) return false;
  for (let i = 0; i < count; i++) if ((a.index?.getX(i) ?? i) !== b.index.getX(i)) return false;
  return true;
}
