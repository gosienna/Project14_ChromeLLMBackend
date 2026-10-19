import { describe, expect, it } from "vitest";
import { autoSelectEngine, findModel } from "../src/shared/catalog";
import { hostPatternFor } from "../src/shared/providers";
import { normalizeOrigin } from "../src/shared/settings";
import { AsyncQueue } from "../src/shared/async-queue";

describe("engine auto-selection", () => {
  const m = findModel("qwen2.5-0.5b-instruct")!;
  it("prefers WebLLM with WebGPU and an MLC build", () => expect(autoSelectEngine(m, { webgpu: true, maxBufferMB: 1024 })).toBe("webllm"));
  it("uses Transformers.js with WebGPU when no MLC build", () => expect(autoSelectEngine({ ...m, mlc: undefined }, { webgpu: true, maxBufferMB: 1024 })).toBe("transformers"));
  it("falls back to wllama without WebGPU", () => expect(autoSelectEngine(m, { webgpu: false, maxBufferMB: 0 })).toBe("wllama"));
  it("returns null when nothing can run", () => expect(autoSelectEngine({ ...m, gguf: undefined }, { webgpu: false, maxBufferMB: 0 })).toBeNull());
});

describe("origin helpers", () => {
  it("normalizes user input", () => {
    expect(normalizeOrigin("app.example.com")).toBe("https://app.example.com");
    expect(normalizeOrigin("http://localhost:3000/x?y")).toBe("http://localhost:3000");
    expect(() => normalizeOrigin("file:///etc")).toThrow();
  });
  it("builds host patterns for custom endpoints", () => {
    expect(hostPatternFor("http://localhost:11434/v1")).toBe("http://localhost/*");
  });
});

describe("AsyncQueue", () => {
  it("delivers pushed items and propagates failure", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    setTimeout(() => (q.push(2), q.end()), 5);
    const got: number[] = [];
    for await (const x of q) got.push(x);
    expect(got).toEqual([1, 2]);

    const q2 = new AsyncQueue<number>();
    setTimeout(() => q2.fail(new Error("boom")), 5);
    await expect((async () => { for await (const _ of q2) { /* drain */ } })()).rejects.toThrow("boom");
  });
});
