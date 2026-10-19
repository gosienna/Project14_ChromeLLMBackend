// Curated local model catalog. Each entry names the build for each engine that can run it.

export type EngineId = "transformers" | "webllm" | "wllama" | "nano" | "dummy";

export interface CatalogModel {
  id: string;
  name: string;
  params: string;
  sizeMB: number;
  contextWindow: number;
  minVramMB: number;
  /** Transformers.js ONNX repo + dtype. */
  onnx?: { repo: string; dtype: "q4" | "q4f16" };
  /** WebLLM prebuilt id; the model library .wasm is bundled under vendor/webllm-libs/. */
  mlc?: { modelId: string; weightsUrl: string; lib: string };
  /** wllama GGUF file. */
  gguf?: { url: string };
  /** Deterministic echo engine for development and tests; downloads nothing. */
  dummy?: boolean;
  /** Chrome's built-in model, used through the Prompt API inside the extension. */
  nano?: boolean;
}

export const CATALOG: CatalogModel[] = [
  {
    id: "qwen2.5-0.5b-instruct",
    name: "Qwen2.5 0.5B Instruct (default)",
    params: "0.5B",
    sizeMB: 480,
    contextWindow: 4096,
    minVramMB: 1000,
    onnx: { repo: "onnx-community/Qwen2.5-0.5B-Instruct", dtype: "q4f16" },
    mlc: {
      modelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      lib: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf" },
  },
  {
    id: "llama-3.2-1b-instruct",
    name: "Llama 3.2 1B Instruct",
    params: "1.2B",
    sizeMB: 1100,
    contextWindow: 4096,
    minVramMB: 1500,
    onnx: { repo: "onnx-community/Llama-3.2-1B-Instruct", dtype: "q4f16" },
    mlc: {
      modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
      lib: "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf" },
  },
  {
    id: "chrome-nano",
    name: "Chrome built-in model (Gemini Nano)",
    params: "~3B",
    sizeMB: 0,
    contextWindow: 6144,
    minVramMB: 0,
    nano: true,
  },
  {
    id: "echo-test",
    name: "Echo (test engine, no model)",
    params: "0",
    sizeMB: 0,
    contextWindow: 4096,
    minVramMB: 0,
    dummy: true,
  },
];

/** Hosts weights are downloaded from (data, not code). Documented for store review. */
export const WEIGHT_HOSTS = ["huggingface.co", "cdn-lfs.huggingface.co", "cas-bridge.xethub.hf.co"];

export function findModel(id: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === id);
}

export interface DeviceCaps {
  webgpu: boolean;
  /** adapter.limits.maxStorageBufferBindingSize in MB (0 without WebGPU). */
  maxBufferMB: number;
}

/** Auto-selection: WebGPU -> WebLLM when an MLC build exists, else Transformers.js; no WebGPU -> wllama. */
export function autoSelectEngine(model: CatalogModel, caps: DeviceCaps): EngineId | null {
  if (model.dummy) return "dummy";
  if (model.nano) return "nano";
  if (caps.webgpu) {
    if (model.mlc) return "webllm";
    if (model.onnx) return "transformers";
  }
  return model.gguf ? "wllama" : null;
}

export function canRun(model: CatalogModel, engine: EngineId, caps: DeviceCaps): boolean {
  switch (engine) {
    case "transformers":
      return !!model.onnx; // WASM fallback exists
    case "webllm":
      return !!model.mlc && caps.webgpu;
    case "wllama":
      return !!model.gguf;
    case "dummy":
      return !!model.dummy;
    case "nano":
      return !!model.nano;
  }
}
