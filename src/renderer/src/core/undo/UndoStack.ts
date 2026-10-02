// Generic state-list undo (PLAN §5): a list of immutable states plus an index. States are shared by reference
// (copy-on-write), so an entry costs only what changed. Framework-free.

export interface UndoEntry<T> {
  /** Short action name shown as "Undo <label>" (the base entry's label is ''). */
  label: string;
  state: T;
  /** Consecutive pushes with the same key within mergeMs replace this entry. */
  mergeKey: string | null;
  /** Clock time of the last push into this entry. */
  time: number;
}

export interface PushOptions {
  mergeKey?: string;
  /** Merge window, default 1000 ms. */
  mergeMs?: number;
}

export interface UndoStackOptions {
  /** Max undo + redo steps kept (default 100, min 0). */
  limit?: number;
  /** Injectable clock in ms (default performance.now). */
  clock?: () => number;
}

export type EvictListener<T> = (states: T[]) => void;

export const DEFAULT_UNDO_LIMIT = 100;
export const DEFAULT_MERGE_MS = 1000;

export class UndoStack<T> {
  private entries: UndoEntry<T>[];
  private index = 0;
  private limit: number;
  /** Set by undo/redo/seal: the next push never merges. */
  private sealed = true;
  private readonly clock: () => number;
  private readonly evictListeners = new Set<EvictListener<T>>();

  constructor(initial: T, opts: UndoStackOptions = {}) {
    this.clock = opts.clock ?? ((): number => performance.now());
    this.limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_UNDO_LIMIT));
    this.entries = [{ label: '', state: initial, mergeKey: null, time: this.clock() }];
  }

  /** The state at the current position. */
  get current(): T {
    return this.entries[this.index].state;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  /** Number of undo / redo steps available. */
  get undoCount(): number {
    return this.index;
  }

  get redoCount(): number {
    return this.entries.length - 1 - this.index;
  }

  /**
   * Make `state` current. Drops the redo branch (evicted). Merges into the top entry instead when it has the same
   * mergeKey, was pushed within mergeMs and nothing was undone / sealed since (the replaced state is evicted).
   */
  push(label: string, state: T, opts: PushOptions = {}): void {
    const now = this.clock();
    const dropped = this.entries.splice(this.index + 1).map((e) => e.state);
    const top = this.entries[this.index];
    const key = opts.mergeKey ?? null;
    const canMerge = !this.sealed && key !== null && this.index > 0 && top.mergeKey === key && now - top.time <= (opts.mergeMs ?? DEFAULT_MERGE_MS);
    if (canMerge) {
      dropped.push(top.state);
      this.entries[this.index] = { label, state, mergeKey: key, time: now };
    } else {
      this.entries.push({ label, state, mergeKey: key, time: now });
      this.index++;
    }
    this.sealed = false;
    dropped.push(...this.trim());
    this.emitEvict(dropped);
  }

  /** Step back; returns the undone entry's label and the new current state, or null at the base. */
  undo(): { label: string; state: T } | null {
    if (this.index === 0)
      return null;
    const label = this.entries[this.index].label;
    this.index--;
    this.sealed = true;
    return { label, state: this.entries[this.index].state };
  }

  /** Step forward; returns the redone entry's label and its state, or null at the top. */
  redo(): { label: string; state: T } | null {
    if (this.index >= this.entries.length - 1)
      return null;
    this.index++;
    this.sealed = true;
    const e = this.entries[this.index];
    return { label: e.label, state: e.state };
  }

  peekUndoLabel(): string | null {
    return this.index > 0 ? this.entries[this.index].label : null;
  }

  peekRedoLabel(): string | null {
    return this.index < this.entries.length - 1 ? this.entries[this.index + 1].label : null;
  }

  /** End the current merge run (e.g. on pointerup or field blur). */
  seal(): void {
    this.sealed = true;
  }

  /** Change the limit; excess entries are evicted (oldest undo first, then the far end of the redo branch). */
  setLimit(n: number): void {
    this.limit = Math.max(0, Math.floor(n));
    this.emitEvict(this.trim());
  }

  getLimit(): number {
    return this.limit;
  }

  /** Every state still reachable (undo + current + redo), oldest first; for GC live sets. */
  allStates(): T[] {
    return this.entries.map((e) => e.state);
  }

  /** Read-only view of the entries (oldest first) and the current index. */
  snapshot(): { entries: readonly Readonly<UndoEntry<T>>[]; index: number } {
    return { entries: this.entries.slice(), index: this.index };
  }

  /** Called with the states dropped by limit trimming, redo truncation, merges, clear() or reset(). */
  onEvict(cb: EvictListener<T>): () => void {
    this.evictListeners.add(cb);
    return () => {
      this.evictListeners.delete(cb);
    };
  }

  /** Drop all undo / redo history, keeping the current state as the new base. */
  clear(): void {
    const keep = this.entries[this.index];
    const dropped = this.entries.filter((e) => e !== keep).map((e) => e.state);
    this.entries = [{ label: '', state: keep.state, mergeKey: null, time: this.clock() }];
    this.index = 0;
    this.sealed = true;
    this.emitEvict(dropped);
  }

  /** Replace everything with a single base state (e.g. a doc reloaded from disk). */
  reset(state: T): void {
    const dropped = this.entries.map((e) => e.state);
    this.entries = [{ label: '', state, mergeKey: null, time: this.clock() }];
    this.index = 0;
    this.sealed = true;
    this.emitEvict(dropped);
  }

  private trim(): T[] {
    const dropped: T[] = [];
    while (this.entries.length - 1 > this.limit && this.index > 0) {
      dropped.push(this.entries.shift()!.state);
      this.index--;
    }
    while (this.entries.length - 1 > this.limit)
      dropped.push(this.entries.pop()!.state);
    return dropped;
  }

  private emitEvict(states: T[]): void {
    if (states.length === 0)
      return;
    for (const cb of this.evictListeners)
      cb(states);
  }
}
