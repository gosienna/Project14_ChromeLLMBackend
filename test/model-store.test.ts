import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ModelStore } from "../src/offscreen/model-store";

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 251);

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

describe("ModelStore", () => {
  it("round-trips a file written in several chunks", async () => {
    const store = new ModelStore("t1", 10);
    const data = bytes(35, 7);
    const seen: number[] = [];
    await store.write("a.gguf", streamOf(data.slice(0, 12), data.slice(12, 20), data.slice(20)), (n) => seen.push(n));
    expect(seen.at(-1)).toBe(35);
    expect(await store.size("a.gguf")).toBe(35);
    const blob = await store.read("a.gguf");
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(data);
    expect(new Uint8Array(await blob!.slice(30, 35).arrayBuffer())).toEqual(data.slice(30));
  });

  it("stores empty files", async () => {
    const store = new ModelStore("t2");
    await store.write("empty", streamOf());
    expect((await store.read("empty"))!.size).toBe(0);
  });

  it("keeps namespaces apart and lists without the prefix", async () => {
    const a = new ModelStore("ns-a");
    const b = new ModelStore("ns-b");
    await a.write("x", streamOf(bytes(3)));
    await b.write("y", streamOf(bytes(4)));
    expect(await a.list()).toEqual([{ key: "x", size: 3 }]);
    expect(await b.read("x")).toBeNull();
  });

  it("replaces and deletes files, chunks included", async () => {
    const store = new ModelStore("t3", 4);
    await store.write("f", streamOf(bytes(20)));
    await store.write("f", streamOf(bytes(5, 3)));
    expect(new Uint8Array(await (await store.read("f"))!.arrayBuffer())).toEqual(bytes(5, 3));
    await store.delete("f");
    expect(await store.read("f")).toBeNull();
    expect(await store.size("f")).toBe(-1);
  });

  it("treats an interrupted write as absent", async () => {
    const store = new ModelStore("t4", 4);
    const failing = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(10));
        c.error(new Error("network dropped"));
      },
    });
    await expect(store.write("g", failing)).rejects.toThrow("network dropped");
    expect(await store.read("g")).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
