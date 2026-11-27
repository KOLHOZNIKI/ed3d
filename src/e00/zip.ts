import { unzip, zip } from 'fflate';

const MiB = 1024 * 1024;
export const inputLimit = 160 * MiB;
const entryLimit = 128 * MiB;
const totalLimit = 256 * MiB;

export type Files = Map<string, Uint8Array<ArrayBuffer>>;

export async function unpack(bytes: Uint8Array): Promise<Files> {
  return readPackage(bytes, { input: inputLimit, entry: entryLimit, total: totalLimit, entries: 256 },
    (path, size) => /\.(fbx|png|jpe?g)$/i.test(path) || (path === 'manifest.json' && size <= 64 * 1024));
}

export async function readPackage(bytes: Uint8Array, limits: { input: number; entry: number; total: number; entries: number },
  accepts: (path: string, size: number) => boolean): Promise<Files> {
  if (bytes.byteLength > limits.input) throw new Error(`ZIP exceeds the ${limits.input / MiB} MiB input limit.`);
  let total = 0;
  const paths = new Set<string>();
  const accepted = new Map<string, number>();

  // Check every directory entry before starting any decompression workers.
  await readZip(bytes, ({ name, size, originalSize, compression }) => {
    const normalized = name.replaceAll('\\', '/');
    const path = normalized.replace(/\/$/, '');
    const key = path.toLowerCase();
    if (path.split('/').some(isInvalidSegment)) throw new Error(`Invalid ZIP path: ${name}`);
    if (paths.has(key)) throw new Error(`Duplicate ZIP path: ${name}`);
    paths.add(key);
    total += originalSize;
    if (paths.size > limits.entries || !Number.isSafeInteger(originalSize) || originalSize < 0 || originalSize > limits.entry || total > limits.total) {
      throw new Error('ZIP exceeds the file count or expanded size limit.');
    }
    if (!normalized.endsWith('/') && accepts(path, originalSize)) {
      if ((compression === 0 && size !== originalSize) || size > bytes.byteLength) throw new Error(`Invalid ZIP entry size: ${name}`);
      accepted.set(name, originalSize);
    }
    return false;
  });
  const entries = await readZip(bytes, ({ name }) => accepted.has(name));
  return new Map([...accepted].map(([name, size]) => {
    const data = entries[name];
    if (!data || data.byteLength !== size) throw new Error(`Invalid expanded size for ZIP entry: ${name}`);
    return [name.replaceAll('\\', '/'), data];
  }));
}

function isInvalidSegment(part: string): boolean {
  return !part || /[ .]$/.test(part) || /[<>:"|?*\x00-\x1f\x7f]/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
}

function readZip(bytes: Uint8Array, filter: import('fflate').UnzipFileFilter): Promise<import('fflate').Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(bytes, { filter }, (error, entries) => {
      if (error) reject(error);
      else resolve(entries);
    });
  });
}

export function pack(files: Files): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    zip(Object.fromEntries(files), { level: 0 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}
