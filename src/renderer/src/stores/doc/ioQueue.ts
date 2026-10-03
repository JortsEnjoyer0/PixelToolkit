// Serial async queue (docs/skelanim/skelanim.md "Saving, DocIO and image GC"): one per open doc (saves, renames, image
// imports and moves, GC) and one per character json. Ops run strictly one after another; pause() parks a barrier in the
// queue so explorer operations can run while nothing of the doc is in flight (DocumentsStoreApi.runExclusive).

export class IoQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  /** `onCount(+1 / -1)` mirrors queued + running ops (the store sums them into ioBusy). */
  constructor(private readonly onCount: (delta: number) => void = () => undefined) {}

  /** Queued or running ops (including a pause barrier). */
  get pending(): number {
    return this.count;
  }

  /** Run `op` after everything queued before it has settled. A failing op never blocks the ones after it. */
  run<T>(op: () => Promise<T>): Promise<T> {
    this.count++;
    this.onCount(1);
    const run = this.tail.then(op);
    const settle = (): void => {
      this.count--;
      this.onCount(-1);
    };
    this.tail = run.then(settle, settle);
    return run;
  }

  /** Resolves once every op queued so far has settled. */
  drain(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  /**
   * Wait until every op queued so far has settled, then hold the queue: later ops wait until the returned release
   * function is called (idempotent). Several pauses stack; each holds until its own release.
   */
  async pause(): Promise<() => void> {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atBarrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    void this.run(() => {
      reached();
      return hold;
    });
    await atBarrier;
    let done = false;
    return () => {
      if (done)
        return;
      done = true;
      release();
    };
  }
}
