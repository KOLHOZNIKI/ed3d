import { Matrix4, SkinnedMesh, type Group } from 'three';

const directions = [['CoordAxis', 'right'], ['UpAxis', 'up'], ['FrontAxis', 'front']] as const;
const properties = new Set<string>(directions.flatMap(([axis]) => [axis, `${axis}Sign`]));
const axisNames = ['X', 'Y', 'Z'];
const compatibleExport = 'Export a binary FBX with right-handed axes, or export a GLB.';

// FBXLoader exposes units but omits the complete axis basis.
export function readFbxAxes(bytes: Uint8Array<ArrayBuffer>, filename: string) {
  const decoder = new TextDecoder();
  if (bytes.length < 27 || decoder.decode(bytes.subarray(0, 23)) !== 'Kaydara FBX Binary  \0\x1a\0') {
    throw new Error(`Could not read “${filename}” as a binary FBX. Export in Binary FBX format or export a GLB.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wide = view.getUint32(23, true) >= 7500;
  const field = wide ? 8 : 4;
  const header = 3 * field + 1;
  const offset = (start: number) => wide ? Number(view.getBigUint64(start, true)) : view.getUint32(start, true);

  function* nodes(start: number, limit: number) {
    while (start + header <= limit) {
      const end = offset(start);
      if (end === 0) return;
      const nameStart = start + header;
      const data = nameStart + view.getUint8(nameStart - 1);
      const children = data + offset(start + 2 * field);
      if (end <= start || end > limit || children > end) throw new Error('Invalid FBX node size.');
      yield { name: decoder.decode(bytes.subarray(nameStart, data)), data, children, end };
      start = end;
    }
  }

  const global = [...nodes(27, bytes.length)].find(node => node.name === 'GlobalSettings');
  const props = global && [...nodes(global.children, global.end)].find(node => node.name === 'Properties70');
  const axes = new Map<string, number>();
  if (props) {
    for (const node of nodes(props.children, props.end)) {
      if (node.name !== 'P') continue;
      let cursor = node.data;
      const readString = () => {
        if (cursor + 5 > node.children || bytes[cursor] !== 83) throw new Error('Invalid FBX axis property.');
        const end = cursor + 5 + view.getUint32(cursor + 1, true);
        if (end > node.children) throw new Error('Invalid FBX axis property length.');
        const value = decoder.decode(bytes.subarray(cursor + 5, end));
        cursor = end;
        return value;
      };
      const name = readString();
      if (!properties.has(name)) continue;
      for (let i = 0; i < 3; i++) readString();
      if (cursor + 5 > node.children || bytes[cursor] !== 73) throw new Error('Invalid FBX axis value.');
      axes.set(name, view.getInt32(cursor + 1, true));
    }
  }
  if (axes.size !== properties.size) {
    throw new Error(`“${filename}” is missing FBX coordinate settings. ${compatibleExport}`);
  }
  const basis = directions.map(([name, direction]) => ({ axis: axes.get(name)!, sign: axes.get(`${name}Sign`)!, direction }));
  if (new Set(basis.map(({ axis }) => axis)).size !== directions.length ||
      basis.some(({ axis, sign }) => !axisNames[axis] || sign !== 1 && sign !== -1)) {
    throw new Error(`“${filename}” has invalid FBX coordinate settings. ${compatibleExport}`);
  }
  const source = basis.map(({ axis, sign }) => `${sign > 0 ? '+' : '-'}${axisNames[axis]}`);
  const rotation = new Matrix4();
  for (const [i, { axis, sign }] of basis.entries()) {
    // Each row projects a source point onto one of its declared axes.
    for (let x = 0; x < 3; x++) rotation.elements[x * 4 + i] = x === axis ? sign : 0;
  }
  if (rotation.determinant() !== 1) {
    const actual = basis.map(({ direction }, i) => `${source[i]} ${direction}`).join(', ');
    throw new Error(`Unsupported FBX axes in “${filename}”. The file declares ${actual}, which requires a handedness conversion. ${compatibleExport}`);
  }
  const needsRotation = basis.some(({ axis, sign }, i) => axis !== i || sign !== 1);
  return { source, rotation: needsRotation ? rotation : undefined };
}

export function rotateFbxScene(scene: Group, rotation: Matrix4) {
  // The loader keeps its synthetic scene root for conversion. Rotate it so
  // authored node transforms, animation curves and mesh-local data stay intact.
  scene.quaternion.setFromRotationMatrix(rotation);
  const inverseRotation = rotation.clone().transpose();
  const adjusted = new Set<Matrix4>();
  scene.traverse(node => {
    if (!(node instanceof SkinnedMesh)) return;
    node.bindMatrix.premultiply(rotation);
    for (const inverse of node.skeleton.boneInverses) {
      if (adjusted.has(inverse)) continue;
      inverse.multiply(inverseRotation);
      adjusted.add(inverse);
    }
  });
  scene.updateMatrixWorld(true);
}
