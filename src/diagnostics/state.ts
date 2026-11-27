export type Severity = 'Error' | 'Warning' | 'Info';
export type IssueSample = { kind: 'vertex' | 'face' | 'edge'; index: number };
export interface Issue {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly object?: string;
  readonly count?: number;
  readonly sample?: IssueSample;
}

export interface ScanMesh {
  object: string;
  positions: Float64Array;
  corners: Uint32Array;
  faceEnds: Uint32Array;
  edges: Uint32Array;
  edgeFaceEnds: Uint32Array;
  edgeFaces: Uint32Array;
  triangleCorners: Uint32Array;
  triangleFaces: Uint32Array;
  attributes: readonly { name: string; size: number; values: Float64Array }[];
  skin?: { vertexCount: number; joints: number; entries: Float64Array };
}
