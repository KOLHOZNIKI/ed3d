import type { AssetDocument } from './document';
import { workingBuffers, type WorkingState } from './state';

export interface ProjectJob {
  readonly id: string;
  readonly baseRevision: number;
  readonly inputHashes: string[];
  status: 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
}

const fingerprints = new WeakMap<ArrayBuffer, string>();
const blockSize = 1024 * 1024;

export function startJob(document: AssetDocument<WorkingState>): ProjectJob {
  return { id: crypto.randomUUID(), baseRevision: document.revision, inputHashes: document.originals.map(file => file.hash), status: 'preparing' };
}

export async function identifyWorkingInputs(job: ProjectJob, state: WorkingState, signal: AbortSignal) {
  const { snapshots: _, ...working } = state;
  const buffers = new Set(workingBuffers(working));
  if (!buffers.size) return;
  const block = new Uint8Array(blockSize), header = new DataView(block.buffer);
  let offset = 0;
  const appendHash = async (bytes: BufferSource) => {
    signal.throwIfAborted();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const flush = async () => {
    if (offset) job.inputHashes.push(await appendHash(block.subarray(0, offset)));
    offset = 0;
  };
  // Prefix small resources with lengths so ordered tile blocks have unambiguous boundaries.
  for (const buffer of buffers) {
    if (buffer.byteLength + 4 > blockSize) {
      await flush();
      let key = fingerprints.get(buffer);
      if (!key) { key = await appendHash(buffer); fingerprints.set(buffer, key); }
      job.inputHashes.push(key);
      continue;
    }
    if (offset + buffer.byteLength + 4 > blockSize) await flush();
    header.setUint32(offset, buffer.byteLength, true);
    block.set(new Uint8Array(buffer), offset + 4);
    offset += buffer.byteLength + 4;
  }
  await flush();
}
