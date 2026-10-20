import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_CAPS, CATALOG, WLLAMA_HEAP_MAX_MB, autoSelectEngine, canRun, findModel, ioLabel, takesImages, toolMode, whyNot, type DeviceCaps, type EngineId } from "../src/shared/catalog";
import { hostPatternFor } from "../src/shared/providers";
import { normalizeOrigin } from "../src/shared/settings";
import { AsyncQueue } from "../src/shared/async-queue";

const GPU: DeviceCaps = { webgpu: true, maxBufferMB: 1024, jspi: true, mem64: true };
const CPU: DeviceCaps = { webgpu: false, maxBufferMB: 0, jspi: true, mem64: true };

describe("engine auto-selection", () => {
  const m = findModel("qwen2.5-0.5b-instruct")!;
  it("prefers WebLLM with WebGPU and an MLC build", () => expect(autoSelectEngine(m, GPU)).toBe("webllm"));
  it("uses Transformers.js with WebGPU when no MLC build", () => expect(autoSelectEngine({ ...m, mlc: undefined }, GPU)).toBe("transformers"));
  it("falls back to wllama without WebGPU", () => expect(autoSelectEngine(m, CPU)).toBe("wllama"));
  it("returns null when nothing can run", () => expect(autoSelectEngine({ ...m, gguf: undefined }, CPU)).toBeNull());
});

describe("large GGUF models", () => {
  const big = findModel("qwen3-30b-a3b-instruct-2507")!;
  const small = findModel("qwen2.5-3b-instruct")!;
  it("are larger than the wasm heap and GGUF only", () => {
    expect(big.sizeMB).toBeGreaterThan(WLLAMA_HEAP_MAX_MB);
    expect(big.mlc ?? big.onnx).toBeUndefined();
  });
  it("run on wllama with WebGPU, JSPI and Memory64", () => {
    expect(autoSelectEngine(big, GPU)).toBe("wllama");
    expect(whyNot(big, "wllama", GPU)).toBeNull();
  });
  it("need the streamed path", () => {
    expect(autoSelectEngine(big, CPU)).toBeNull();
    expect(canRun(big, "wllama", { ...GPU, jspi: false })).toBe(false);
    expect(canRun(big, "wllama", { ...GPU, mem64: false })).toBe(false);
    expect(whyNot(big, "wllama", CPU)).toMatch(/JSPI/);
  });
  it("leave small GGUFs runnable on CPU", () => {
    expect(canRun(small, "wllama", { webgpu: false, maxBufferMB: 0, jspi: false, mem64: false })).toBe(true);
  });
  it("still prefer WebLLM when a model has both builds", () => {
    const m = findModel("qwen2.5-7b-instruct")!;
    expect(autoSelectEngine(m, GPU)).toBe("webllm");
    expect(canRun(m, "wllama", GPU)).toBe(true);
    expect(whyNot(m, "webllm", CPU)).toBe("needs WebGPU");
  });
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

describe("catalog", () => {
  it("has unique ids and at least one way to run each model", () => {
    expect(new Set(CATALOG.map((m) => m.id)).size).toBe(CATALOG.length);
    for (const m of CATALOG) {
      expect(m.onnx || m.mlc || m.gguf || m.nano || m.dummy, m.id).toBeTruthy();
      expect(autoSelectEngine(m, ALL_CAPS), m.id).not.toBeNull();
    }
  });
  it("lists every WebLLM library in the fetch script", () => {
    const script = readFileSync(join(__dirname, "../scripts/fetch-webllm-libs.mjs"), "utf8");
    for (const m of CATALOG) if (m.mlc) expect(script, m.id).toContain(`"${m.mlc.lib}"`);
  });
});

describe("vision and ONNX device rules", () => {
  const ENGINES: EngineId[] = ["transformers", "webllm", "wllama"];
  it("gives every vision model an engine that takes images, and no text model one", () => {
    for (const m of CATALOG.filter((x) => !x.nano && !x.dummy)) {
      const any = ENGINES.some((e) => canRun(m, e, ALL_CAPS) && takesImages(m, e));
      expect(any, m.id).toBe(!!m.vision);
    }
  });
  it("passes images only to builds with the vision parts", () => {
    const g = findModel("gemma-4-e2b-it")!;
    expect(takesImages(g, "wllama")).toBe(true); // GGUF + mmproj
    expect(takesImages(g, "transformers")).toBe(true); // AutoProcessor loader
    expect(takesImages(g, "webllm")).toBe(false); // WebLLM's Gemma 4 build is text only
    expect(takesImages(findModel("phi-3.5-vision-instruct")!, "webllm")).toBe(true);
  });
  it("needs WebGPU for ONNX builds without CPU weights", () => {
    const m = findModel("qwen3-4b")!;
    expect(whyNot(m, "transformers", CPU)).toBe("needs WebGPU");
    expect(autoSelectEngine(m, CPU)).toBeNull();
    expect(autoSelectEngine(m, GPU)).toBe("transformers");
  });
  it("keeps Qwen2.5 1.5B's ONNX build on CPU", () => {
    expect(findModel("qwen2.5-1.5b-instruct")!.onnx).toMatchObject({ cpuOnly: true, dtype: "q8", wasmDtype: "q8" });
  });
});

describe("capability labels", () => {
  const g = findModel("gemma-4-e2b-it")!;
  it("describe input and output per engine", () => {
    expect(ioLabel(g)).toBe("text+image→text");
    expect(ioLabel(g, "wllama")).toBe("text+image→text");
    expect(ioLabel(g, "webllm")).toBe("text→text");
    expect(ioLabel(findModel("qwen3-8b")!)).toBe("text→text");
  });
  it("call tools natively on wllama where the GGUF template handles tools, prompted elsewhere", () => {
    expect(toolMode(g, "wllama")).toBe("native");
    expect(toolMode(g, "webllm")).toBe("prompted");
    expect(toolMode(findModel("mixtral-8x7b-instruct-q5")!, "wllama")).toBe("prompted"); // template has no tools
    for (const m of CATALOG) if (m.tools) expect(m.gguf, m.id).toBeDefined();
  });
});
