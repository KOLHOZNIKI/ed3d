import { BufferGeometry, Float32BufferAttribute } from 'three';

// These fixtures use tightly packed, little-endian accessors and one embedded buffer.
export function glbFixture() {
  const doc = { asset: { version: '2.0', generator: 'AssetFixer E00 fixture generator' }, scene: 0,
    scenes: [{ nodes: [] }], nodes: [], meshes: [], bufferViews: [], accessors: [] };
  const chunks = [];
  let byteLength = 0;
  function view(data, target) {
    const entry = { buffer: 0, byteOffset: byteLength, byteLength: data.byteLength, ...(target ? { target } : {}) };
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const padding = Buffer.alloc((4 - bytes.length % 4) % 4);
    chunks.push(bytes, padding);
    byteLength += bytes.length + padding.length;
    return doc.bufferViews.push(entry) - 1;
  }
  function accessor(data, type, target, bounds) {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5121;
    const entry = { bufferView: view(data, target), componentType, count: data.length / size, type };
    if (bounds) {
      entry.min = Array(size).fill(Infinity);
      entry.max = Array(size).fill(-Infinity);
      data.forEach((value, i) => {
        entry.min[i % size] = Math.min(entry.min[i % size], value);
        entry.max[i % size] = Math.max(entry.max[i % size], value);
      });
    }
    return doc.accessors.push(entry) - 1;
  }
  function primitive({ positions, indices, uv, uv1, joints, weights, material, corrupt }) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions.flat(), 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const attributes = { POSITION: accessor(geometry.attributes.position.array, 'VEC3', 34962, true),
      NORMAL: accessor(geometry.attributes.normal.array, 'VEC3', 34962) };
    if (uv) attributes.TEXCOORD_0 = accessor(Float32Array.from(uv.flat()), 'VEC2', 34962);
    if (uv1) attributes.TEXCOORD_1 = accessor(Float32Array.from(uv1.flat()), 'VEC2', 34962);
    if (joints) attributes.JOINTS_0 = accessor(Uint16Array.from(joints.flat()), 'VEC4', 34962);
    if (weights) attributes.WEIGHTS_0 = accessor(Float32Array.from(weights.flat()), 'VEC4', 34962);
    return { attributes, indices: accessor(Uint16Array.from(corrupt ?? indices), 'SCALAR', 34963),
      ...(material === undefined ? {} : { material }) };
  }
  function node(entry, root = true) {
    const index = doc.nodes.push(entry) - 1;
    if (root) doc.scenes[0].nodes.push(index);
    return index;
  }
  function mesh(name, primitives, entry = {}, root = true) {
    const index = doc.meshes.push({ name, primitives }) - 1;
    return node({ name, mesh: index, ...entry }, root);
  }
  function png(name, bytes) {
    const images = doc.images ??= [], textures = doc.textures ??= [];
    const source = images.push({ name, mimeType: 'image/png', bufferView: view(bytes) }) - 1;
    return textures.push({ source }) - 1;
  }
  function finish() {
    doc.buffers = [{ byteLength }];
    const json = Buffer.from(JSON.stringify(doc));
    const padding = Buffer.alloc((4 - json.length % 4) % 4, 0x20);
    const header = Buffer.alloc(20), bin = Buffer.alloc(8);
    header.write('glTF');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + json.length + padding.length + byteLength, 8);
    header.writeUInt32LE(json.length + padding.length, 12);
    header.write('JSON', 16);
    bin.writeUInt32LE(byteLength);
    bin.write('BIN', 4);
    return Buffer.concat([header, json, padding, bin, ...chunks]);
  }
  return { doc, accessor, primitive, node, mesh, png, finish };
}
