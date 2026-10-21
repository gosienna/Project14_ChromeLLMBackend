import { describe, expect, it } from "vitest";
import { raceAbort, untilAborted } from "../src/offscreen/abortable";
import { LocalRuntime } from "../src/offscreen/local-runtime";

/** A generator that yields once, then hangs forever and ignores its signal, like a wedged engine. */
async function* hangs(): AsyncGenerator<string, number> {
  yield "a";
  await new Promise(() => {});
  return 0;
}

async function* quick(text: string): AsyncGenerator<string, number> {
  yield text;
  return 1;
}

async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<{ out: T[]; result: R }> {
  const out: T[] = [];
  let step = await gen.next();
  while (!step.done) {
    out.push(step.value);
    step = await gen.next();
  }
  return { out, result: step.value };
}

describe("raceAbort", () => {
  it("rejects with AbortError when the signal aborts first", async () => {
    const c = new AbortController();
    const p = raceAbort(new Promise(() => {}), c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
  it("passes the value through otherwise", async () => {
    await expect(raceAbort(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });
});

describe("untilAborted", () => {
  it("relays values and the return value", async () => {
    const { out, result } = await drain(untilAborted(quick("x"), new AbortController().signal, 10, async () => {}));
    expect(out).toEqual(["x"]);
    expect(result).toBe(1);
  });

  it("throws AbortError and calls onStuck when the generator ignores the abort", async () => {
    const c = new AbortController();
    let stuck = 0;
    const gen = untilAborted(hangs(), c.signal, 10, async () => void stuck++);
    expect((await gen.next()).value).toBe("a");
    const next = gen.next();
    c.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(stuck).toBe(1);
  });
});

describe("LocalRuntime FIFO", () => {
  it("a stuck generation releases the queue when aborted", async () => {
    const runtime = new LocalRuntime();
    const c1 = new AbortController();
    const first = runtime.exclusive(hangs, 0, c1.signal);
    expect((await first.next()).value).toBe("a");
    const firstDone = first.next();

    const second = drain(runtime.exclusive(() => quick("b"), 0, new AbortController().signal));
    c1.abort();
    await expect(firstDone).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toEqual({ out: ["b"], result: 1 });
  }, 15_000);

  it("a queued request can leave the line without blocking the ones behind it", async () => {
    const runtime = new LocalRuntime();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const first = drain(runtime.exclusive(async function* () {
      await gate;
      yield "1";
      return 1;
    }, 0, new AbortController().signal));

    const c2 = new AbortController();
    const second = drain(runtime.exclusive(() => quick("2"), 0, c2.signal));
    const third = drain(runtime.exclusive(() => quick("3"), 0, new AbortController().signal));
    c2.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst();
    await expect(first).resolves.toEqual({ out: ["1"], result: 1 });
    await expect(third).resolves.toEqual({ out: ["3"], result: 1 });
  });
});
