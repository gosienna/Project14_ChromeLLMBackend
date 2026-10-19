// Turns callback-style token streams into an async iterator.

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private failWaiting: ((e: unknown) => void) | null = null;
  private ended = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = this.failWaiting = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = this.failWaiting = null;
      w({ value: undefined as T, done: true });
    }
  }

  fail(e: unknown): void {
    this.error = e ?? new Error("Stream failed");
    this.ended = true;
    if (this.failWaiting) {
      const f = this.failWaiting;
      this.waiting = this.failWaiting = null;
      f(this.error);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.ended) return;
      const r = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiting = resolve;
        this.failWaiting = reject;
      });
      if (r.done) return;
      yield r.value;
    }
  }
}
