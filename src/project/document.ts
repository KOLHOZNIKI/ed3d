import type { Topology } from './topology';

export const defaultHistoryBudget = 256 * 1024 * 1024;
const minBudget = 1024 * 1024;
const maxBudget = 512 * minBudget;

export interface OriginalFile {
  readonly name: string;
  readonly hash: string;
  readonly data: Blob;
}

export type TextureAssignments = Readonly<Record<string, string>>;

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
export interface HistoryCheckpoint<T> { revision: number; state: T; historyBudget: number }

export class AssetDocument<T extends object> {
  readonly id: string;
  readonly name: string;
  readonly originals: readonly OriginalFile[];
  readonly textureAssignments?: TextureAssignments;
  readonly scene: readonly SceneEntry[];
  readonly topology: ReadonlyMap<string, Topology>;
  #historyBudget: number;
  #savedBudget: number;
  #revision: number;
  #state: T;
  #saved?: WeakRef<T>;
  #undo: Version<T>[] = [];
  #redo: Version<T>[] = [];
  #checkpointPending = false;
  #retained: (state: T) => Iterable<ArrayBuffer>;

  constructor(data: { id: string; name: string; revision: number; originals: readonly OriginalFile[]; scene: readonly SceneEntry[];
    topology: ReadonlyMap<string, Topology>; historyBudget: number; state: T; textureAssignments?: TextureAssignments },
    retained: (state: T) => Iterable<ArrayBuffer>,
    readonly checkpoint?: (document: AssetDocument<T>, snapshot: HistoryCheckpoint<T>) => Promise<void>) {
    this.id = data.id;
    this.name = data.name;
    this.originals = data.originals;
    this.textureAssignments = data.textureAssignments;
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
    return this.#advance(command.state, this.#historyBudget, [...this.#undo, { label: command.label, state: this.#state }], []);
  }

  navigate(direction: 'undo' | 'redo') {
    const undo = this.#undo.slice(), redo = this.#redo.slice();
    const [from, to] = direction === 'undo' ? [undo, redo] : [redo, undo];
    const target = from.pop();
    if (!target) return;
    to.push({ label: target.label, state: this.#state });
    return this.#advance(target.state, this.#historyBudget, undo, redo);
  }

  markSaved() {
    this.#saved = new WeakRef(this.#state);
    this.#savedBudget = this.#historyBudget;
  }
  markRecovered() { this.#saved = undefined; }

  configureHistory(bytes: number): boolean | Promise<boolean> {
    if (!Number.isSafeInteger(bytes) || bytes < minBudget || bytes > maxBudget) throw new Error('Choose a history budget from 1 to 512 MiB.');
    if (bytes === this.#historyBudget) return false;
    const result = this.#advance(this.#state, bytes, this.#undo.slice(), this.#redo.slice());
    return result ? result.then(() => true) : true;
  }

  #advance(state: T, historyBudget: number, undo: Version<T>[], redo: Version<T>[]) {
    if (this.#checkpointPending) throw new Error('Wait for the history checkpoint to finish.');
    const revision = this.#revision;
    const commit = () => {
      this.assertRevision(revision);
      this.#state = state;
      this.#historyBudget = historyBudget;
      this.#undo = undo;
      this.#redo = redo;
      this.#revision++;
    };
    const truncated = this.#trim(state, historyBudget, [undo, redo]);
    // Keep the committed history intact until the replacement checkpoint is durable.
    if (truncated && this.checkpoint) {
      this.#checkpointPending = true;
      return this.checkpoint(this, { state, historyBudget, revision: revision + 1 }).then(commit).finally(() => { this.#checkpointPending = false; });
    }
    commit();
  }

  #trim(state: T, budget: number, stacks: Version<T>[][]) {
    const active = new Set(this.#retained(state));
    let historyBytes = 0;
    let count = 0;
    let truncated = false;
    for (const stack of stacks) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const added = new Set([...this.#retained(stack[i].state)].filter(bytes => !active.has(bytes)));
        const size = [...added].reduce((sum, bytes) => sum + bytes.byteLength, 0);
        if (historyBytes + size > budget || count === 512) {
          stack.splice(0, i + 1);
          truncated = true;
          break;
        }
        for (const bytes of added) active.add(bytes);
        historyBytes += size;
        count++;
      }
    }
    return truncated;
  }
}
