import { BufferGeometry, Float32BufferAttribute, Matrix3, Matrix4, Uint16BufferAttribute, Uint32BufferAttribute,
  Vector3, type Mesh } from 'three';
import { sourceMesh, type FbxSourceMesh } from '../e00/fbx-topology';
import { buildTopology, type Topology } from '../project/topology';
import { point, type Corner, type Face, type MeshData, type Weight } from './data';
import { faceNormal } from './polygon';

export interface RenderMesh {
  geometry: BufferGeometry;
  topology: Topology;
  renderVertices: Uint32Array;
  faceIds: number[];
}

export function editableMesh(mesh: Mesh, topology: Topology, glb: boolean, geometry = mesh.geometry): MeshData {
  const source = glb ? undefined : sourceMesh(geometry);
  if (source?.hasMorphTargets) throw new Error('Mesh editing requires an FBX without morph targets because the FBX exporter cannot preserve them.');
  const positions = topology.positions.slice(), matrix = source && new Matrix3().getNormalMatrix(source.preTransform);
  if (source) for (let i = 0; i < positions.length; i += 3) new Vector3().fromArray(positions, i).applyMatrix4(source.preTransform).toArray(positions, i);
  const attributes = [...topology.cornerAttributes];
  const channels = attributes.map(([name, attr]) => ({ name, size: attr.size }));
  for (const [name, layers] of Object.entries(geometry.morphAttributes)) {
    for (const [i, layer] of layers.entries()) channels.push({ name: `morph:${name}:${i}`, size: layer.itemSize });
  }
  const normalSlot = channels.findIndex(c => c.name === 'normal');
  if (normalSlot < 0) channels.push({ name: 'normal', size: 3 });
  const faces: Face[] = [];
  const triangles: number[][] = Array.from({ length: topology.faceEnds.length }, () => []);
  const starts = Uint32Array.from(topology.faceEnds, (_, i) => topology.faceEnds[i - 1] ?? 0);
  if (source) {
    for (let i = 0; i < source.renderCorners.length; i++) {
      const face = topology.renderFaces[Math.floor(i / 3)];
      triangles[face].push(source.renderCorners[i] - starts[face]);
    }
  } else for (const list of triangles) list.push(0, 1, 2);
  const materialCount = Array.isArray(mesh.material) ? mesh.material.length : 1;
  const result = { positions, faces, channels, weights: readWeights(geometry, positions.length / 3, source),
    nextFace: topology.faceEnds.length, glb, materialCount };
  for (const [id, end] of topology.faceEnds.entries()) {
    const corners: Corner[] = [];
    for (let corner = starts[id]; corner < end; corner++) {
      const vertex = topology.corners[corner];
      const values: number[][] = attributes.map(([, { size, values }]) => Array.from(values.subarray(corner * size, (corner + 1) * size)));
      if (matrix && normalSlot >= 0) values[normalSlot] = new Vector3().fromArray(values[normalSlot]).applyNormalMatrix(matrix).toArray();
      for (const layers of Object.values(geometry.morphAttributes)) {
        for (const layer of layers) values.push(Array.from({ length: layer.itemSize }, (_, k) => layer.getComponent(vertex, k)));
      }
      corners.push({ vertex, attributes: values });
    }
    if (normalSlot < 0) {
      const normal = faceNormal(result, { corners }).normalize().toArray();
      for (const corner of corners) (corner.attributes as number[][]).push(normal);
    }
    faces.push({ id, corners, triangles: triangles[id], material: materialCount > 1 ? topology.faceMaterials[id] : 0 });
  }
  return result;
}

function readWeights(geometry: BufferGeometry, count: number, source?: FbxSourceMesh) {
  if (source?.skin) {
    const weights: Weight[][] = Array.from({ length: count }, () => []);
    for (const [bone, cluster] of source.skin.entries()) for (let i = 0; i < cluster.indices.length; i++) {
      weights[cluster.indices[i]].push([bone, cluster.weights[i]]);
    }
    return weights;
  }
  const joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
  if (joints && weights) return Array.from({ length: count }, (_, i) =>
    Array.from({ length: joints.itemSize }, (_, k): Weight => [joints.getComponent(i, k), weights.getComponent(i, k)]));
}

export function renderMesh(data: MeshData, original: BufferGeometry): RenderMesh {
  const geometry = new BufferGeometry();
  geometry.name = original.name;
  geometry.morphTargetsRelative = original.morphTargetsRelative;
  const renderCorners: number[] = [], logicalVertices: number[] = [], corners: Corner[] = [], polygons: number[] = [];
  const faceMaterials: number[] = [];
  let group = 0, slot = data.faces[0].material;
  for (const face of data.faces) {
    if (face.material !== slot) {
      geometry.addGroup(group, renderCorners.length - group, slot);
      group = renderCorners.length;
      slot = face.material;
    }
    for (const index of face.triangles) {
      renderCorners.push(corners.length + index);
      logicalVertices.push(face.corners[index].vertex);
    }
    for (const [i, corner] of face.corners.entries()) polygons.push(i === face.corners.length - 1 ? ~corner.vertex : corner.vertex);
    corners.push(...face.corners);
    faceMaterials.push(face.material);
  }
  geometry.addGroup(group, renderCorners.length - group, slot);
  const render = buildTopology(data.positions, polygons, renderCorners);
  const cornerAttributes = new Map(data.channels.map(({ name, size }, i) => [name, { size, values: Float64Array.from(corners.flatMap(c => [...c.attributes[i]])) }]));
  const topology: Topology = { ...render, cornerAttributes, faceMaterials: Uint32Array.from(faceMaterials) };

  let samples: Corner[];
  if (data.glb) {
    // A GLB vertex stores all attributes together. Distinct UV, normal, or
    // morph values need distinct render indices even on one logical vertex.
    const tuples = new Map<string, number>(), indices: number[] = [];
    samples = [];
    for (const i of renderCorners) {
      const corner = corners[i];
      const key = `${corner.vertex};${corner.attributes.map(tuple => tuple.join(',')).join(';')}`;
      let id = tuples.get(key);
      if (id === undefined) { id = samples.length; samples.push(corner); tuples.set(key, id); }
      indices.push(id);
    }
    const order = samples.map((_, i) => i).sort((a, b) => samples[a].vertex - samples[b].vertex);
    const inverse = Uint32Array.from(order);
    order.forEach((id, i) => { inverse[id] = i; });
    samples = order.map(id => samples[id]);
    geometry.setIndex(new Uint32BufferAttribute(indices.map(id => inverse[id]), 1));
  } else {
    samples = renderCorners.map(i => corners[i]);
    geometry.userData.assetFixerFbxSource = fbxSource(data, sourceMesh(original), polygons, renderCorners, corners, faceMaterials);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(samples.flatMap(c => point(data, c.vertex)), 3));
  for (const [i, { name, size }] of data.channels.entries()) {
    const attr = new Float32BufferAttribute(samples.flatMap(c => [...c.attributes[i]]), size);
    if (name.startsWith('morph:')) {
      const [, property, i] = name.split(':');
      const key = property as keyof BufferGeometry['morphAttributes'];
      attr.name = original.morphAttributes[key]![Number(i)].name;
      (geometry.morphAttributes[key] ??= [])[Number(i)] = attr;
    } else geometry.setAttribute(name === 'uv0' ? 'uv' : name, attr);
  }
  if (data.weights) {
    const joints: number[] = [], weights: number[] = [];
    for (const { vertex } of samples) {
      const source = data.weights[vertex];
      const preview = data.glb ? source : [...source].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
      const sum = data.glb ? 1 : preview.reduce((value, pair) => value + pair[1], 0) || 1;
      for (let i = 0; i < 4; i++) {
        joints.push(preview[i]?.[0] ?? 0);
        weights.push((preview[i]?.[1] ?? 0) / sum);
      }
    }
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, topology, renderVertices: Uint32Array.from(logicalVertices), faceIds: data.faces.map(face => face.id) };
}

function fbxSource(mesh: MeshData, source: FbxSourceMesh, polygons: number[], renderCorners: number[], corners: Corner[], faceMaterials: number[]): FbxSourceMesh {
  const materials = { dataSize: 1 };
  const layers = mesh.channels.map(({ size }) => ({ dataSize: size }));
  const layer = (name: string) => layers[mesh.channels.findIndex(c => c.name === name)];
  const indices: number[] = [], positions: number[] = [];
  const used = new Set(corners.map(c => c.vertex));
  for (let id = 0; id < mesh.positions.length / 3; id++) {
    if (!used.has(id)) continue;
    indices[id] = positions.length / 3;
    positions.push(...point(mesh, id));
  }
  const skin = source.skin?.map(() => ({ indices: [] as number[], weights: [] as number[] }));
  let maxSkinInfluences = 0, pointsOverPreviewLimit = 0;
  if (skin) for (const id of used) {
    const weights = mesh.weights![id].filter(weight => weight[1] > 0);
    maxSkinInfluences = Math.max(weights.length, maxSkinInfluences);
    if (weights.length > 4) pointsOverPreviewLimit++;
    for (const [bone, weight] of weights) {
      skin[bone].indices.push(indices[id]);
      skin[bone].weights.push(weight);
    }
  }
  return { ...source, positions, maxSkinInfluences, pointsOverPreviewLimit,
    polygons: Int32Array.from(polygons, index => index < 0 ? ~indices[~index] : indices[index]),
    preTransform: new Matrix4(), renderCorners: Uint32Array.from(renderCorners),
    uvs: mesh.channels.filter(c => /^uv\d+$/.test(c.name)).map(c => layer(c.name)), normal: layer('normal'), color: layer('color'),
    material: materials, skin,
    readCorner(corner, face, _controlPoint, layer) {
      return layer === materials ? [faceMaterials[face]] : corners[corner].attributes[layers.indexOf(layer)];
    },
  };
}
