import { readProject, type ProjectData } from './archive';

export interface Checkpoint {
  key: string;
  savedAt: number;
  name: string;
  projectId: string;
  revision: number;
  archive: Blob;
}

const storeName = 'checkpoints';
export const autosaveDelay = 5000;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('assetfixer-workspace', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(storeName, { keyPath: 'key' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The autosave database is blocked by another tab.'));
  });
}

function byLatest(a: Checkpoint, b: Checkpoint) { return b.savedAt - a.savedAt || b.revision - a.revision; }

export async function checkpointList(): Promise<Checkpoint[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).getAll();
      request.onsuccess = () => resolve((request.result as Checkpoint[]).sort(byLatest));
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveCheckpoint(checkpoint: Checkpoint) {
  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < checkpoint.archive.size) {
    throw new Error('There is insufficient browser storage for another checkpoint.');
  }
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('The checkpoint could not be committed.'));
      const store = transaction.objectStore(storeName);
      store.put(checkpoint);
      const recorded = store.getAll();
      recorded.onsuccess = () => {
        const entries = (recorded.result as Checkpoint[]).sort(byLatest);
        for (const old of entries.slice(3)) store.delete(old.key);
      };
    });
  } finally {
    db.close();
  }
}

export async function latestCheckpoint(): Promise<{ data?: ProjectData; checkpoint?: Checkpoint; skipped: number }> {
  let skipped = 0;
  for (const checkpoint of await checkpointList()) {
    try {
      const data = await readProject(checkpoint.archive);
      if (data.id !== checkpoint.projectId || data.revision !== checkpoint.revision) throw new Error('Invalid checkpoint metadata.');
      return { data, checkpoint, skipped };
    } catch {
      skipped++;
    }
  }
  return { skipped };
}
