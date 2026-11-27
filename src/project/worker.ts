export async function finishWorker<Result>(worker: Worker, input: unknown, transfer: Transferable[], signal?: AbortSignal): Promise<Result> {
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    return await new Promise<Result>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<Result | { error: string }>) => {
        if (data && typeof data === 'object' && 'error' in data) reject(new Error(String(data.error)));
        else resolve(data as Result);
      };
      worker.onerror = event => reject(new Error(event.message || 'The background worker failed.'));
      worker.onmessageerror = () => reject(new Error('The background worker returned an unreadable response.'));
      abort = () => reject(signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage(input, transfer);
    });
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    worker.terminate();
  }
}
