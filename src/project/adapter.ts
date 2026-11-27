import { BufferAttribute, BufferGeometry, Mesh, type Object3D, type TypedArray } from 'three';
import { sourceMesh } from '../e00/fbx-topology';
import { importGlb, type ImportedGlb } from '../e00/glb-round-trip';
import { importAsset, sourceDeformation, type ImportedAsset } from '../e00/round-trip';
import type { UvAtlasEdit } from '../e00/uv-atlas';
import type { OriginalFile, SceneEntry } from './document';
import type { AtlasState, WorkingState } from './state';
import { buildTopology, type CornerAttribute, type Topology } from './topology';
import { MeshSession } from '../mesh/session';
import { sceneStats } from '../e00/scene-stats';

export type Model = ImportedAsset | ImportedGlb;

async function importModel(input: readonly File[]): Promise<Model> {
  const glb = input.find(file => /\.glb$/i.test(file.name));
  if (glb && input.length !== 1) throw new Error('Select one GLB file at a time.');
  return glb ? importGlb(glb) : importAsset(input);
}

export function importOriginals(files: readonly OriginalFile[]) {
  return importModel(files.map(file => new File([file.data], file.name)));
}

export class ModelAdapter {
  readonly model: Model;
  readonly entries: SceneEntry[] = [];
  readonly topology = new Map<string, Topology>();
  readonly objects = new Map<string, Object3D>();
  readonly mesh: MeshSession;
  #atlasState?: AtlasState;
  #atlas?: UvAtlasEdit;

  constructor(model: Model) {
    this.model = model;
    const visit = (object: Object3D, parent: string | null) => {
      const id = `object-${this.entries.length}`;
      object.updateMatrix();
      const mesh = object instanceof Mesh;
      this.entries.push({ id, parent, mesh, visible: object.visible, name: object.name || (mesh ? 'Mesh' : 'Group'),
        transform: [...object.matrix.elements] });
      this.objects.set(id, object);
      if (mesh) this.topology.set(id, topologyFor(model, object.geometry));
      for (const child of object.children) visit(child, id);
    };
    for (const child of model.scene.children) visit(child, null);
    this.mesh = new MeshSession(model, this.entries, this.topology, this.objects);
  }

  get viewEntries() { return this.mesh.pieces.length ? [...this.entries, ...this.mesh.pieces] : this.entries; }
  workingTopology(id: string) { return this.mesh.render.get(id)?.render.topology ?? this.topology.get(id); }

  materialize(state: WorkingState): Model {
    if (this.model.format === 'glb') {
      if (state.atlas || state.bake || state.paint) throw new Error('The project contains FBX working data for a GLB source.');
      this.mesh.materialize(state.meshEdits);
      return this.mesh.active ? { ...this.model, stats: sceneStats(this.model.scene, 'GLB'), skins: this.mesh.glbSkins() } : this.model;
    }
    this.mesh.materialize(state.meshEdits);
    const node = state.atlas && this.model.scene.getObjectByProperty('isMesh', true);
    if (state.atlas !== this.#atlasState || node instanceof Mesh && this.#atlas?.inputGeometry !== node.geometry) {
      const atlas = state.atlas && restoreAtlas(this.model, state.atlas);
      this.#atlas?.geometry.dispose();
      this.#atlas = atlas;
      this.#atlasState = state.atlas;
    }
    return { ...this.model, uvAtlas: this.#atlas, textureBake: state.bake, texturePaint: state.paint,
      stats: this.mesh.active ? sceneStats(this.model.scene, 'FBX') : this.model.stats,
      deformation: this.mesh.active ? sourceDeformation(this.model.scene) : this.model.deformation };
  }

  applyVisibility(state: WorkingState) {
    for (const entry of this.viewEntries) this.objects.get(entry.id)!.visible = state.objects[entry.id]?.visible ?? entry.visible;
  }

  dispose() { this.#atlas?.geometry.dispose(); this.mesh.dispose(); }
}

function topologyFor(model: Model, geometry: BufferGeometry): Topology {
  if (model.format === 'fbx') {
    const source = sourceMesh(geometry);
    const topology = buildTopology(source.positions, source.polygons, source.renderCorners);
    const layers: [string, { dataSize: number }][] = source.uvs.map((layer, i) => [`uv${i}`, layer]);
    if (source.normal) layers.push(['normal', source.normal]);
    if (source.color) layers.push(['color', source.color]);
    const cornerAttributes = new Map<string, CornerAttribute>();
    const faceMaterials = new Uint32Array(topology.faceEnds.length);
    for (const [name, layer] of layers) {
      const values = new Float64Array(topology.corners.length * layer.dataSize);
      let corner = 0;
      for (const [face, end] of topology.faceEnds.entries()) {
        for (; corner < end; corner++) {
          const data = source.readCorner(corner, face, topology.corners[corner], layer);
          for (let k = 0; k < layer.dataSize; k++) values[corner * layer.dataSize + k] = data[k];
        }
      }
      if (!values.every(Number.isFinite)) throw new Error(`Invalid ${name} on a source FBX corner.`);
      cornerAttributes.set(name, { size: layer.dataSize, values });
    }
    if (source.material) for (const [face, end] of topology.faceEnds.entries()) {
      const corner = end - 1, material = source.readCorner(corner, face, topology.corners[corner], source.material)[0];
      if (!Number.isInteger(material) || material < -1) throw new Error('Invalid material on a source FBX face.');
      faceMaterials[face] = Math.max(0, material);
    }
    return { ...topology, cornerAttributes, faceMaterials };
  }
  const position = geometry.getAttribute('position'), index = geometry.index;
  const positions = new Float64Array(position.count * 3);
  for (let i = 0; i < position.count; i++) positions.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
  const corners = Uint32Array.from({ length: index?.count ?? position.count }, (_, i) => i);
  const encoded = Int32Array.from(corners, i => {
    const vertex = index?.getX(i) ?? i;
    return i % 3 === 2 ? -1 - vertex : vertex;
  });
  const topology = buildTopology(positions, encoded, corners);
  const cornerAttributes = new Map<string, CornerAttribute>();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (['position', 'skinIndex', 'skinWeight'].includes(name)) continue;
    const size = attribute.itemSize, values = new Float64Array(topology.corners.length * size);
    for (const [corner, vertex] of topology.corners.entries()) for (let k = 0; k < size; k++) {
      values[corner * size + k] = attribute.getComponent(vertex, k);
    }
    if (!values.every(Number.isFinite)) throw new Error(`Invalid ${name} on a source GLB corner.`);
    cornerAttributes.set(name, { size, values });
  }
  const faceMaterials = new Uint32Array(topology.faceEnds.length);
  for (const group of geometry.groups) faceMaterials.fill(group.materialIndex ?? 0, group.start / 3, (group.start + group.count) / 3);
  return { ...topology, cornerAttributes, faceMaterials };
}

export function captureAtlas(atlas: UvAtlasEdit): AtlasState {
  const uv = atlas.geometry.getAttribute(atlas.channel);
  return { indices: Uint32Array.from(atlas.geometry.index!.array), uv: Float32Array.from(uv.array),
    sourceCorners: atlas.sourceCorners, faceComponents: atlas.faceComponents, metrics: atlas.metrics, seams: atlas.seams };
}

function restoreAtlas(asset: ImportedAsset, state: AtlasState): UvAtlasEdit {
  const object = asset.scene.getObjectByProperty('isMesh', true);
  if (!(object instanceof Mesh) || sceneStats(asset.scene, 'FBX').meshes !== 1) throw new Error('The saved atlas requires one source mesh.');
  const original = object.geometry, source = sourceMesh(original);
  const { indices, uv, sourceCorners, faceComponents, metrics } = state;
  const vertices = uv.length / 2;
  if (!Number.isInteger(vertices) || !vertices || indices.length !== source.renderCorners.length ||
      sourceCorners.length !== indices.length || faceComponents.length !== indices.length / 3 || vertices !== metrics.renderVertices ||
      !uv.every(value => value >= 0 && value <= 1)) throw new Error('The saved atlas has invalid dimensions or coverage.');
  const representative = new Int32Array(vertices).fill(-1);
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i];
    if (vertex >= vertices || sourceCorners[i] !== source.renderCorners[i]) throw new Error('The saved atlas has invalid source corners.');
    if (representative[vertex] < 0) representative[vertex] = i;
    const other = representative[vertex];
    const cp = (render: number) => {
      const encoded = source.polygons[sourceCorners[render]];
      return encoded < 0 ? ~encoded : encoded;
    };
    if (cp(i) !== cp(other)) throw new Error('The saved atlas joins independent control points.');
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.setAttribute('uv1', new BufferAttribute(uv, 2));
  for (const [name, attribute] of Object.entries(original.attributes)) {
    if (name === 'uv1') continue;
    if (!(attribute instanceof BufferAttribute)) throw new Error(`Unsupported saved atlas attribute: ${name}.`);
    const size = attribute.itemSize;
    const ArrayType = attribute.array.constructor as new (length: number) => TypedArray;
    const values = new ArrayType(vertices * size);
    for (let i = 0; i < vertices; i++) {
      if (representative[i] < 0) throw new Error('The saved atlas contains an unused render vertex.');
      const start = representative[i] * size;
      values.set(attribute.array.subarray(start, start + size), i * size);
    }
    for (let i = 0; i < indices.length; i++) for (let k = 0; k < size; k++) {
      if (!Object.is(values[indices[i] * size + k], attribute.array[i * size + k])) throw new Error(`The saved atlas changes source ${name}.`);
    }
    geometry.setAttribute(name, new BufferAttribute(values, size, attribute.normalized));
  }
  for (const group of original.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  return { inputGeometry: original, geometry, sourceCorners, faceComponents, channel: 'uv1', metrics, seams: state.seams };
}
