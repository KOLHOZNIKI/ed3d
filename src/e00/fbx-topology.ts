import { BufferAttribute, BufferGeometry, Color, Matrix3, SRGBColorSpace, type Matrix4 } from 'three';
import type { UvAtlasEdit } from './uv-atlas';
import type { RepairPatch } from './repair';

type FbxLayer = { dataSize: number };
type FbxWeights = { indices: ArrayLike<number>; weights: ArrayLike<number> };

export interface FbxSourceMesh {
  positions: ArrayLike<number>;
  polygons: ArrayLike<number>;
  renderCorners: Uint32Array<ArrayBuffer>;
  preTransform: Matrix4;
  normal?: FbxLayer;
  color?: FbxLayer;
  uvs: FbxLayer[];
  material?: FbxLayer;
  skin?: FbxWeights[];
  hasMorphTargets: boolean;
  readCorner: (corner: number, polygon: number, controlPoint: number, layer: FbxLayer) => ArrayLike<number>;
}

interface FbxExportMesh {
  geometry: BufferGeometry;
  skin: { clusters: (FbxWeights & { boneIdx: number })[] } | null;
}

export function sourceMesh(geometry: BufferGeometry): FbxSourceMesh {
  const source = geometry.userData.assetFixerFbxSource as FbxSourceMesh | undefined;
  if (!source) throw new Error('The mesh has no source polygon data for export.');
  return source;
}

export function offsetControlPointY(geometry: BufferGeometry, controlPoint: number, offsetY: number): Float64Array {
  const source = sourceMesh(geometry);
  if (!Number.isInteger(controlPoint) || controlPoint < 0 || controlPoint >= source.positions.length / 3) {
    throw new Error('Invalid FBX control point.');
  }
  const positions = Float64Array.from(source.positions);
  const y = 3 * controlPoint + 1;
  const moved = positions[y] + offsetY;
  if (!Number.isFinite(moved) || moved === positions[y]) throw new Error('The offset must produce a finite position change.');
  positions[y] = moved;
  return positions;
}

export function useSourceTopology(mesh: FbxExportMesh, workingPositions?: Float64Array, atlas?: UvAtlasEdit, promoteAtlas = false,
  repair?: RepairPatch): void {
  const original = sourceMesh(mesh.geometry);
  const source = repair ? withRepair(original, repair) : atlas ? withAtlas(original, atlas, promoteAtlas) : original;
  if (source.hasMorphTargets) throw new Error('Export with source topology does not support morph targets yet.');
  if (source.uvs.length > 4) throw new Error('FBX export supports at most four UV sets.');
  if (workingPositions && workingPositions.length !== source.positions.length) throw new Error('The edited FBX has an invalid control point count.');

  // The writer consumes positions by control point and other attributes by polygon corner.
  // This geometry is private to the export plan. The preview still uses triangulated buffers.
  const geometry = new BufferGeometry();
  geometry.name = mesh.geometry.name;
  const positions = new BufferAttribute(workingPositions?.slice() ?? Float64Array.from(source.positions), 3).applyMatrix4(source.preTransform);
  if (!Number.isInteger(positions.count) || !positions.count || !positions.array.every(Number.isFinite)) {
    throw new Error('Invalid FBX control point positions.');
  }
  geometry.setAttribute('position', positions);
  geometry.userData.assetFixerFbxPolygons = Int32Array.from(source.polygons);

  const layers = new Map<string, FbxLayer>();
  if (source.normal) layers.set('normal', source.normal);
  if (source.color) layers.set('color', source.color);
  source.uvs.forEach((layer, index) => layers.set(index === 0 ? 'uv' : `uv${index}`, layer));
  const attributes = Array.from(layers, ([name, layer]) => {
    const values = new Float64Array(source.polygons.length * layer.dataSize);
    geometry.setAttribute(name, new BufferAttribute(values, layer.dataSize));
    return { layer, values };
  });

  const faceMaterials: number[] = [];
  let faceStart = 0;
  for (let corner = 0; corner < source.polygons.length; corner++) {
    const encoded = source.polygons[corner];
    const controlPoint = encoded < 0 ? -encoded - 1 : encoded;
    if (!Number.isInteger(controlPoint) || controlPoint >= positions.count) {
      throw new Error('An FBX polygon refers to an invalid control point.');
    }
    const face = faceMaterials.length;
    for (const { layer, values } of attributes) {
      const data = source.readCorner(corner, face, controlPoint, layer);
      for (let component = 0; component < layer.dataSize; component++) {
        if (!Number.isFinite(data[component])) throw new Error('An FBX polygon has an invalid corner attribute.');
        values[corner * layer.dataSize + component] = data[component];
      }
    }
    if (encoded < 0) {
      if (corner - faceStart < 2) throw new Error('An FBX polygon has fewer than three corners.');
      const material = source.material ? source.readCorner(corner, face, controlPoint, source.material)[0] : 0;
      if (!Number.isInteger(material)) throw new Error('An FBX polygon has an invalid material index.');
      faceMaterials.push(Math.max(0, material));
      faceStart = corner + 1;
    }
  }
  if (!faceMaterials.length || faceStart !== source.polygons.length) throw new Error('Invalid FBX polygon boundaries.');
  geometry.userData.assetFixerFbxFaceMaterials = faceMaterials;

  const normals = geometry.getAttribute('normal');
  normals?.applyNormalMatrix(new Matrix3().getNormalMatrix(source.preTransform));
  const colors = geometry.getAttribute('color');
  if (colors) {
    // FBXLoader decodes vertex RGB into the Three.js working color space.
    const color = new Color();
    for (let corner = 0; corner < colors.count; corner++) {
      color.fromBufferAttribute(colors, corner).getRGB(color, SRGBColorSpace);
      colors.setXYZ(corner, color.r, color.g, color.b);
    }
  }

  if (source.skin?.length !== mesh.skin?.clusters.length) throw new Error('FBX skin does not match its source clusters.');
  for (const cluster of mesh.skin?.clusters ?? []) {
    // The importer keeps bone order aligned with the FBX clusters. Restore their
    // original weights and indices, including vertices absent from the preview.
    const original = source.skin?.[cluster.boneIdx];
    if (!original || original.indices.length !== original.weights.length) throw new Error('An FBX cluster has invalid weights.');
    for (let i = 0; i < original.indices.length; i++) {
      const index = original.indices[i];
      const weight = original.weights[i];
      if (!Number.isInteger(index) || index < 0 || index >= positions.count || !Number.isFinite(weight) || weight < 0) {
        throw new Error('An FBX cluster refers to an invalid weight or control point.');
      }
    }
    cluster.indices = original.indices;
    cluster.weights = original.weights;
  }
  mesh.geometry = geometry;
}

function faceByCorner(original: FbxSourceMesh): Uint32Array<ArrayBuffer> {
  const faces = new Uint32Array(original.polygons.length);
  let face = 0;
  for (let corner = 0; corner < faces.length; corner++) {
    faces[corner] = face;
    if (original.polygons[corner] < 0) face++;
  }
  return faces;
}

function withRepair(original: FbxSourceMesh, repair: RepairPatch): FbxSourceMesh {
  const faces = faceByCorner(original);
  return {
    ...original,
    positions: repair.positions,
    polygons: repair.polygons,
    readCorner(corner, _face, controlPoint, attribute) {
      const source = repair.sourceCorners[corner];
      return original.readCorner(source, faces[source], controlPoint, attribute);
    },
  };
}

function withAtlas(original: FbxSourceMesh, atlas: UvAtlasEdit, promote: boolean): FbxSourceMesh {
  const faces = faceByCorner(original);
  const polygons = Int32Array.from(atlas.sourceCorners, (sourceCorner, corner) => {
    const index = original.polygons[sourceCorner];
    const controlPoint = index < 0 ? -index - 1 : index;
    return corner % 3 === 2 ? -controlPoint - 1 : controlPoint;
  });
  const layer: FbxLayer = { dataSize: 2 };
  const index = atlas.geometry.index;
  if (!index) throw new Error('The FBX atlas must provide indexed triangle corners.');
  const uv = atlas.geometry.getAttribute(atlas.channel);
  const coordinates = [0, 0];
  return {
    ...original,
    polygons,
    uvs: promote ? [layer, ...original.uvs] : [...original.uvs, layer],
    readCorner(corner, _face, controlPoint, attribute) {
      if (attribute === layer) {
        const vertex = index.getX(corner);
        coordinates[0] = uv.getX(vertex);
        coordinates[1] = uv.getY(vertex);
        return coordinates;
      }
      const sourceCorner = atlas.sourceCorners[corner];
      return original.readCorner(sourceCorner, faces[sourceCorner], controlPoint, attribute);
    },
  };
}
