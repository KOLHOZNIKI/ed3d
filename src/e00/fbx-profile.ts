const axisSettings = {
  CoordAxis: 0,
  CoordAxisSign: 1,
  UpAxis: 1,
  UpAxisSign: 1,
  FrontAxis: 2,
  FrontAxisSign: 1,
};

// FBXLoader exposes units but omits axis metadata. Read only the global settings
// required to reject input outside this prototype's coordinate profile.
export function validateFbxAxes(bytes: Uint8Array<ArrayBuffer>): void {
  const decoder = new TextDecoder();
  if (bytes.length < 27 || decoder.decode(bytes.subarray(0, 23)) !== 'Kaydara FBX Binary  \0\x1a\0') {
    throw new Error('Expected a binary FBX file.');
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
      if (!Object.hasOwn(axisSettings, name)) continue;
      for (let i = 0; i < 3; i++) readString();
      if (cursor + 5 > node.children || bytes[cursor] !== 73) throw new Error('Invalid FBX axis value.');
      axes.set(name, view.getInt32(cursor + 1, true));
    }
  }
  if (Object.entries(axisSettings).some(([axis, value]) => axes.get(axis) !== value)) {
    throw new Error('E00 supports binary FBX with +X right, +Y up and +Z front.');
  }
}
