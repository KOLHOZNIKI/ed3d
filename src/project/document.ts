import type { Topology } from './topology';

export const defaultHistoryBudget = 256 * 1024 * 1024;
const minBudget = 1024 * 1024;
const maxBudget = 512 * minBudget;

export interface OriginalFile {
  readonly name: string;
  readonly hash: string;
  readonly data: Blob;
}

export interface SceneEntry {
  readonly id: string;
  readonly parent: string | null;
  readonly name: string;
  readonly visible: boolean;
  readonly mesh: boolean;
  readonly transform: readonly number[];
}

export type ObjectOverrides = Readonly<Record<string, { readonly name: string; readonly visible: boolean }>>;

export interface Command<T> {
  readonly id: string;
  readonly label: string;
  readonly baseRevision: number;
  readonly affectedResources: readonly string[];
  readonly state: T;
}

interface Version<T> { label: string; state: T }

export class AssetDocument<T extends object> {
  readonly id: string;
  readonly name: string;
  readonly originals: readonly OriginalFile[];
  readonly scene: readonly SceneEntry[];
  readonly topology: ReadonlyMap<string, Topology>;
  #historyBudget: number;
  #savedBudget: number;
  #revision: number;
  #state: T;
  #saved?: WeakRef<T>;
  #undo: Version<T>[] = [];
  #redo: Version<T>[] = [];
  #retained: (state: T) => Iterable<ArrayBuffer>;

  constructor(data: { id: string; name: string; revision: number; originals: readonly OriginalFile[]; scene: readonly SceneEntry[];
    topology: ReadonlyMap<string, Topology>; historyBudget: number; state: T }, retained: (state: T) => Iterable<ArrayBuffer>) {
    this.id = data.id;
    this.name = data.name;
    this.originals = data.originals;
    this.scene = data.scene;
    this.topology = data.topology;
    this.#historyBudget = this.#savedBudget = data.historyBudget;
    this.#revision = data.revision;
    this.#state = data.state;
    this.markSaved();
    this.#retained = retained;
  }

  get revision() { return this.#revision; }
  get state() { return this.#state; }
  get historyBudget() { return this.#historyBudget; }
  get dirty() { return this.#state !== this.#saved?.deref() || this.#historyBudget !== this.#savedBudget; }
  get undoDepth() { return this.#undo.length; }
  get redoDepth() { return this.#redo.length; }
  get undoTarget() { return this.#undo.at(-1); }
  get redoTarget() { return this.#redo.at(-1); }

  assertRevision(revision: number) {
    if (revision !== this.#revision) throw new Error('The document changed while the operation was running.');
  }

  execute(command: Command<T>) {
    this.assertRevision(command.baseRevision);
    if (command.state === this.#state) return;
    this.#undo.push({ label: command.label, state: this.#state });
    this.#redo.length = 0;
    this.#state = command.state;
    this.#revision++;
    this.#trim();
  }

  navigate(direction: 'undo' | 'redo') {
    const [from, to] = direction === 'undo' ? [this.#undo, this.#redo] : [this.#redo, this.#undo];
    const target = from.pop();
    if (!target) return;
    to.push({ label: target.label, state: this.#state });
    this.#state = target.state;
    this.#revision++;
    this.#trim();
  }

  markSaved() {
    this.#saved = new WeakRef(this.#state);
    this.#savedBudget = this.#historyBudget;
  }
  markRecovered() { this.#saved = undefined; }

  configureHistory(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < minBudget || bytes > maxBudget) throw new Error('Choose a history budget from 1 to 512 MiB.');
    if (bytes === this.#historyBudget) return false;
    this.#historyBudget = bytes;
    this.#revision++;
    this.#trim();
    return true;
  }

  #trim() {
    const active = new Set(this.#retained(this.#state));
    let historyBytes = 0;
    let count = 0;
    for (const stack of [this.#undo, this.#redo]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const added = new Set([...this.#retained(stack[i].state)].filter(bytes => !active.has(bytes)));
        const size = [...added].reduce((sum, bytes) => sum + bytes.byteLength, 0);
        if (historyBytes + size > this.#historyBudget || count === 512) {
          stack.splice(0, i + 1);
          break;
        }
        for (const bytes of added) active.add(bytes);
        historyBytes += size;
        count++;
      }
    }
  }
}
