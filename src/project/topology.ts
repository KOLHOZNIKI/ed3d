export interface Topology {
  readonly positions: Float64Array;
  readonly corners: Uint32Array;
  readonly faceEnds: Uint32Array;
  readonly renderFaces: Uint32Array;
  readonly localTriangles: Uint32Array;
  readonly edgeVertices: Uint32Array;
  readonly edgeFaceEnds: Uint32Array;
  readonly edgeFaces: Uint32Array;
  readonly cornerAttributes: ReadonlyMap<string, CornerAttribute>;
  readonly faceMaterials: Uint32Array;
}

export interface CornerAttribute {
  readonly size: number;
  readonly values: Float64Array;
}

export type ElementKind = 'vertex' | 'corner' | 'face' | 'edge';

export function elementId(objectId: string, kind: ElementKind, sourceOrdinal: number): string {
  return `${objectId}/${kind}/${sourceOrdinal}`;
}

export function buildTopology(positions: ArrayLike<number>, encoded: ArrayLike<number>, renderCorners: ArrayLike<number>):
  Omit<Topology, 'cornerAttributes' | 'faceMaterials'> {
  const xyz = Float64Array.from(positions);
  if (!xyz.length || xyz.length % 3 || !xyz.every(Number.isFinite)) throw new Error('Invalid source positions.');
  const corners = new Uint32Array(encoded.length), cornerFaces = new Uint32Array(encoded.length);
  const faceEnds: number[] = [];
  let start = 0;
  for (let i = 0; i < encoded.length; i++) {
    const value = encoded[i], vertex = value < 0 ? -1 - value : value;
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= xyz.length / 3) throw new Error('Invalid source corner index.');
    corners[i] = vertex;
    cornerFaces[i] = faceEnds.length;
    if (value >= 0) continue;
    if (i - start < 2) throw new Error('A source face must have at least three corners.');
    start = i + 1;
    faceEnds.push(start);
  }
  if (!faceEnds.length || start !== encoded.length || renderCorners.length % 3) throw new Error('Invalid source face layout.');

  const renderFaces = new Uint32Array(renderCorners.length / 3), localTriangles = new Uint32Array(renderFaces.length);
  const count = new Uint32Array(faceEnds.length);
  for (let i = 0; i < renderCorners.length; i += 3) {
    const face = cornerFaces[renderCorners[i]];
    if (face === undefined || cornerFaces[renderCorners[i + 1]] !== face || cornerFaces[renderCorners[i + 2]] !== face) {
      throw new Error('A render triangle has invalid source corner correspondence.');
    }
    renderFaces[i / 3] = face;
    localTriangles[i / 3] = count[face]++;
  }

  // Each edge retains all incident polygons, including non-manifold cases.
  const edgeIds = new Map<number, number>();
  const edgeVertices: number[] = [], faceEdges = new Uint32Array(corners.length), incidence: number[] = [];
  const vertices = xyz.length / 3;
  start = 0;
  for (const end of faceEnds) {
    for (let corner = start; corner < end; corner++) {
      const a = corners[corner], b = corners[corner + 1 === end ? start : corner + 1];
      const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * vertices + hi;
      let id = edgeIds.get(key);
      if (id === undefined) {
        id = edgeIds.size;
        edgeIds.set(key, id);
        edgeVertices.push(lo, hi);
        incidence.push(0);
      }
      faceEdges[corner] = id;
      incidence[id]++;
    }
    start = end;
  }
  const edgeFaceEnds = new Uint32Array(incidence.length), edgeFaces = new Uint32Array(corners.length);
  let offset = 0;
  for (let i = 0; i < incidence.length; i++) {
    const length = incidence[i];
    incidence[i] = offset;
    offset += length;
    edgeFaceEnds[i] = offset;
  }
  for (let i = 0; i < faceEdges.length; i++) edgeFaces[incidence[faceEdges[i]]++] = cornerFaces[i];

  return { positions: xyz, corners, faceEnds: Uint32Array.from(faceEnds), renderFaces, localTriangles,
    edgeVertices: Uint32Array.from(edgeVertices), edgeFaceEnds, edgeFaces };
}
