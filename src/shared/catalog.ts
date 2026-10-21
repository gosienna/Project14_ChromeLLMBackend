// Curated local model catalog. Each entry names the build for each engine that can run it.

export type EngineId = "transformers" | "webllm" | "wllama" | "nano" | "dummy";

export interface CatalogModel {
  id: string;
  name: string;
  params: string;
  sizeMB: number;
  /**
   * The model's maximum context in tokens, as its published build declares it (GGUF
   * context_length, mlc-chat-config, config.json). Sessions get the smaller of this and the
   * user's "Max context tokens"; wllama and WebLLM size their KV cache to that at load.
   */
  contextWindow: number;
  minVramMB: number;
  /** Transformers.js ONNX build. */
  onnx?: {
    repo: string;
    /** Weights used on WebGPU. */
    dtype: OnnxDtype;
    /** Weights used on CPU (WASM); default "q4". null: the repo has no CPU weights, so WebGPU is required. */
    wasmDtype?: OnnxDtype | null;
    /** Always run on CPU, even with WebGPU (the model misbehaves on WebGPU). */
    cpuOnly?: boolean;
    /** Vision models load through AutoProcessor rather than the text-generation pipeline. */
    loader?: "gemma4" | "image-text-to-text";
  };
  /** WebLLM prebuilt id; the model library .wasm is bundled under vendor/webllm-libs/. */
  mlc?: {
    modelId: string;
    weightsUrl: string;
    lib: string;
    /** The WebLLM build takes images. */
    vision?: boolean;
    /** The build's own context limit, when below the model's. */
    contextWindow?: number;
  };
  /** wllama GGUF file; for a split model, the first shard. `mmprojUrl` is a vision model's image projector. */
  gguf?: { url: string; mmprojUrl?: string };
  /** Deterministic echo engine for development and tests; downloads nothing. */
  dummy?: boolean;
  /** Chrome's built-in model, used through the Prompt API inside the extension. */
  nano?: boolean;
  /**
   * Reasoning model: thinks before answering. "hybrid" can be told not to think (Qwen3);
   * "always" cannot, only to think less (gpt-oss).
   */
  reasoning?: "hybrid" | "always";
  /** Accepts images (with an engine that has the vision parts; see takesImages). */
  vision?: boolean;
  /**
   * The GGUF's chat template handles tool calls, so llama.cpp can format tool definitions and
   * parse calls on wllama. Checked against each template on Hugging Face, not assumed per family.
   */
  tools?: boolean;
}

export type OnnxDtype = "q4" | "q4f16" | "q8" | "fp16";

export const CATALOG: CatalogModel[] = [
  {
    id: "qwen2.5-0.5b-instruct",
    name: "Qwen2.5 0.5B Instruct (default)",
    params: "0.5B",
    sizeMB: 469,
    contextWindow: 32768,
    minVramMB: 945,
    onnx: { repo: "onnx-community/Qwen2.5-0.5B-Instruct", dtype: "q4f16" },
    mlc: {
      modelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      lib: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf" },
    tools: true,
  },
  {
    id: "smollm2-360m-instruct",
    name: "SmolLM2 360M Instruct",
    params: "0.36B",
    sizeMB: 258,
    contextWindow: 8192,
    minVramMB: 376,
    onnx: { repo: "HuggingFaceTB/SmolLM2-360M-Instruct", dtype: "q4f16" },
    mlc: {
      modelId: "SmolLM2-360M-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f16_1-MLC",
      lib: "SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf" },
  },
  // Vision models: wllama loads the GGUF with its image projector (mmproj).
  {
    id: "smolvlm-256m-instruct",
    name: "SmolVLM 256M Instruct",
    params: "0.26B",
    sizeMB: 266,
    contextWindow: 8192,
    minVramMB: 805,
    gguf: {
      url: "https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/SmolVLM-256M-Instruct-Q8_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-256M-Instruct-Q8_0.gguf",
    },
    vision: true,
  },
  {
    id: "lfm2.5-vl-450m",
    name: "LFM2.5-VL 450M",
    params: "0.45B",
    sizeMB: 307,
    contextWindow: 128000,
    minVramMB: 850,
    gguf: {
      url: "https://huggingface.co/LiquidAI/LFM2.5-VL-450M-GGUF/resolve/main/LFM2.5-VL-450M-Q4_0.gguf",
      mmprojUrl: "https://huggingface.co/LiquidAI/LFM2.5-VL-450M-GGUF/resolve/main/mmproj-LFM2.5-VL-450m-Q8_0.gguf",
    },
    vision: true,
    tools: true,
  },
  {
    id: "qwen3-0.6b",
    name: "Qwen3 0.6B",
    params: "0.6B",
    sizeMB: 378,
    contextWindow: 40960,
    minVramMB: 928,
    gguf: { url: "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwen3.5-0.8b",
    name: "Qwen3.5 0.8B",
    params: "0.8B",
    sizeMB: 404,
    contextWindow: 262144,
    minVramMB: 1629,
    mlc: {
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen3.5-0.8B-q4f16_1-MLC",
      lib: "Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm",
    },
    reasoning: "hybrid",
  },
  {
    id: "smolvlm-500m-instruct",
    name: "SmolVLM 500M Instruct",
    params: "0.5B",
    sizeMB: 520,
    contextWindow: 8192,
    minVramMB: 1084,
    gguf: {
      url: "https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/SmolVLM-500M-Instruct-Q8_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
    },
    vision: true,
  },
  {
    id: "gemma-3-1b-it",
    name: "Gemma 3 1B Instruct",
    params: "1B",
    sizeMB: 769,
    contextWindow: 32768,
    minVramMB: 711,
    onnx: { repo: "onnx-community/gemma-3-1b-it-ONNX", dtype: "q4f16" },
    mlc: {
      modelId: "gemma3-1b-it-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/gemma3-1b-it-q4f16_1-MLC",
      lib: "gemma3-1b-it-q4f16_1_cs1k-webgpu.wasm",
      contextWindow: 8192,
    },
    gguf: { url: "https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf" },
  },
  {
    id: "llama-3.2-1b-instruct",
    name: "Llama 3.2 1B Instruct",
    params: "1.2B",
    sizeMB: 770,
    contextWindow: 131072,
    minVramMB: 879,
    onnx: { repo: "onnx-community/Llama-3.2-1B-Instruct", dtype: "q4f16" },
    mlc: {
      modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
      lib: "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "internvl3-1b-instruct",
    name: "InternVL3 1B Instruct",
    params: "1B",
    sizeMB: 961,
    contextWindow: 32768,
    minVramMB: 1569,
    gguf: {
      url: "https://huggingface.co/ggml-org/InternVL3-1B-Instruct-GGUF/resolve/main/InternVL3-1B-Instruct-Q8_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/InternVL3-1B-Instruct-GGUF/resolve/main/mmproj-InternVL3-1B-Instruct-Q8_0.gguf",
    },
    vision: true,
    tools: true,
  },
  {
    id: "smollm2-1.7b-instruct",
    name: "SmolLM2 1.7B Instruct",
    params: "1.7B",
    sizeMB: 1007,
    contextWindow: 8192,
    minVramMB: 1774,
    onnx: { repo: "HuggingFaceTB/SmolLM2-1.7B-Instruct", dtype: "q4f16" },
    mlc: {
      modelId: "SmolLM2-1.7B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/SmolLM2-1.7B-Instruct-q4f16_1-MLC",
      lib: "SmolLM2-1.7B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/bartowski/SmolLM2-1.7B-Instruct-GGUF/resolve/main/SmolLM2-1.7B-Instruct-Q4_K_M.gguf" },
  },
  {
    id: "qwen3.5-2b",
    name: "Qwen3.5 2B",
    params: "2B",
    sizeMB: 1010,
    contextWindow: 262144,
    minVramMB: 2245,
    mlc: {
      modelId: "Qwen3.5-2B-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f16_1-MLC",
      lib: "Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm",
    },
    reasoning: "hybrid",
  },
  {
    id: "qwen3-1.7b",
    name: "Qwen3 1.7B",
    params: "1.7B",
    sizeMB: 1056,
    contextWindow: 40960,
    minVramMB: 1674,
    gguf: { url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  // ONNX on CPU with q8: WebGPU's KV-cache carry-over corrupts this model's output (found in Project05).
  {
    id: "qwen2.5-1.5b-instruct",
    name: "Qwen2.5 1.5B Instruct",
    params: "1.5B",
    sizeMB: 1066,
    contextWindow: 32768,
    minVramMB: 1630,
    onnx: { repo: "onnx-community/Qwen2.5-1.5B-Instruct", dtype: "q8", wasmDtype: "q8", cpuOnly: true },
    mlc: {
      modelId: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      lib: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf" },
    tools: true,
  },
  {
    id: "qwen2-vl-2b-instruct",
    name: "Qwen2-VL 2B Instruct",
    params: "2B",
    sizeMB: 1617,
    contextWindow: 32768,
    minVramMB: 2291,
    gguf: {
      url: "https://huggingface.co/ggml-org/Qwen2-VL-2B-Instruct-GGUF/resolve/main/Qwen2-VL-2B-Instruct-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/Qwen2-VL-2B-Instruct-GGUF/resolve/main/mmproj-Qwen2-VL-2B-Instruct-Q8_0.gguf",
    },
    vision: true,
  },
  {
    id: "gemma-2-2b-it",
    name: "Gemma 2 2B Instruct",
    params: "2.6B",
    sizeMB: 1629,
    contextWindow: 8192,
    minVramMB: 1895,
    mlc: {
      modelId: "gemma-2-2b-it-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/gemma-2-2b-it-q4f16_1-MLC",
      lib: "gemma-2-2b-it-q4f16_1_cs1k-webgpu.wasm",
      contextWindow: 4096,
    },
    gguf: { url: "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf" },
  },
  {
    id: "llama-3.2-3b-instruct",
    name: "Llama 3.2 3B Instruct",
    params: "3.2B",
    sizeMB: 1926,
    contextWindow: 131072,
    minVramMB: 2264,
    onnx: { repo: "onnx-community/Llama-3.2-3B-Instruct", dtype: "q4f16" },
    mlc: {
      modelId: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC",
      lib: "Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "qwen2.5-3b-instruct",
    name: "Qwen2.5 3B Instruct",
    params: "3.1B",
    sizeMB: 2007,
    contextWindow: 32768,
    minVramMB: 2505,
    mlc: {
      modelId: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC",
      lib: "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" },
    tools: true,
  },
  {
    id: "phi-4-mini-instruct",
    name: "Phi-4 mini Instruct",
    params: "3.8B",
    sizeMB: 2058,
    contextWindow: 131072,
    minVramMB: 3438,
    mlc: {
      modelId: "Phi-4-mini-instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Phi-4-mini-instruct-q4f16_1-MLC",
      lib: "Phi-4-mini-instruct-q4f16_1_cs1k-webgpu.wasm",
    },
  },
  {
    id: "qwen3.5-4b",
    name: "Qwen3.5 4B",
    params: "4B",
    sizeMB: 2257,
    contextWindow: 262144,
    minVramMB: 3868,
    mlc: {
      modelId: "Qwen3.5-4B-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen3.5-4B-q4f16_1-MLC",
      lib: "Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm",
    },
    reasoning: "hybrid",
  },
  // The ONNX build has WebGPU (q4f16) weights only.
  {
    id: "phi-3.5-mini-instruct",
    name: "Phi-3.5 mini Instruct",
    params: "3.8B",
    sizeMB: 2282,
    contextWindow: 131072,
    minVramMB: 3672,
    onnx: { repo: "onnx-community/Phi-3.5-mini-instruct-onnx-web", dtype: "q4f16", wasmDtype: null },
    mlc: {
      modelId: "Phi-3.5-mini-instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Phi-3.5-mini-instruct-q4f16_1-MLC",
      lib: "Phi-3.5-mini-instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf" },
  },
  {
    id: "qwen3-4b-instruct-2507",
    name: "Qwen3 4B Instruct 2507",
    params: "4B",
    sizeMB: 2382,
    contextWindow: 262144,
    minVramMB: 3132,
    onnx: { repo: "onnx-community/Qwen3-4B-Instruct-2507-ONNX", dtype: "q4f16" },
    gguf: { url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" },
    tools: true,
  },
  // Transformers.js vision models load through AutoProcessor instead of the text-generation pipeline.
  {
    id: "ministral-3-3b-instruct-2512",
    name: "Ministral 3 3B Instruct",
    params: "3B",
    sizeMB: 2557,
    contextWindow: 262144,
    minVramMB: 3325,
    onnx: { repo: "mistralai/Ministral-3-3B-Instruct-2512-ONNX", dtype: "q4f16", loader: "image-text-to-text" },
    vision: true,
  },
  {
    id: "phi-3.5-vision-instruct",
    name: "Phi-3.5 vision Instruct",
    params: "4.2B",
    sizeMB: 2641,
    contextWindow: 131072,
    minVramMB: 4522,
    mlc: {
      modelId: "Phi-3.5-vision-instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Phi-3.5-vision-instruct-q4f16_1-MLC",
      lib: "Phi-3.5-vision-instruct-q4f16_1_cs4k-webgpu.wasm",
      vision: true,
    },
    vision: true,
  },
  {
    id: "qwen2.5-vl-3b-instruct",
    name: "Qwen2.5-VL 3B Instruct",
    params: "3B",
    sizeMB: 2646,
    contextWindow: 128000,
    minVramMB: 3423,
    gguf: {
      url: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
    },
    vision: true,
  },
  // The ONNX build has WebGPU (q4f16) weights only.
  {
    id: "qwen3-4b",
    name: "Qwen3 4B",
    params: "4B",
    sizeMB: 2702,
    contextWindow: 40960,
    minVramMB: 3484,
    onnx: { repo: "onnx-community/Qwen3-4B-ONNX", dtype: "q4f16", wasmDtype: null },
    reasoning: "hybrid",
  },
  {
    id: "nemotron-3-nano-4b",
    name: "Nemotron 3 Nano 4B",
    params: "4B",
    sizeMB: 2766,
    contextWindow: 1048576,
    minVramMB: 3555,
    gguf: { url: "https://huggingface.co/unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF/resolve/main/NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "holo2-4b",
    name: "Holo2 4B",
    params: "4B",
    sizeMB: 3023,
    contextWindow: 262144,
    minVramMB: 3837,
    gguf: {
      url: "https://huggingface.co/mradermacher/Holo2-4B-GGUF/resolve/main/Holo2-4B.Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/mradermacher/Holo2-4B-GGUF/resolve/main/Holo2-4B.mmproj-Q8_0.gguf",
    },
    vision: true,
    tools: true,
  },
  {
    id: "medgemma-1.5-4b-it",
    name: "MedGemma 1.5 4B Instruct",
    params: "4B",
    sizeMB: 3186,
    contextWindow: 131072,
    minVramMB: 4017,
    gguf: {
      url: "https://huggingface.co/unsloth/medgemma-1.5-4b-it-GGUF/resolve/main/medgemma-1.5-4b-it-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/unsloth/medgemma-1.5-4b-it-GGUF/resolve/main/mmproj-F16.gguf",
    },
    vision: true,
  },
  {
    id: "medgemma-4b-it",
    name: "MedGemma 4B Instruct",
    params: "4B",
    sizeMB: 3186,
    contextWindow: 131072,
    minVramMB: 4017,
    gguf: {
      url: "https://huggingface.co/unsloth/medgemma-4b-it-GGUF/resolve/main/medgemma-4b-it-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/unsloth/medgemma-4b-it-GGUF/resolve/main/mmproj-F16.gguf",
    },
    vision: true,
  },
  // Gemma 4 GGUFs also accept audio in llama.cpp; the Prompt API path here passes text and images only.
  {
    id: "gemma-4-e2b-it",
    name: "Gemma 4 E2B Instruct",
    params: "5B",
    sizeMB: 3241,
    contextWindow: 131072,
    minVramMB: 3387,
    onnx: { repo: "onnx-community/gemma-4-E2B-it-ONNX", dtype: "q4f16", loader: "gemma4" },
    mlc: {
      modelId: "gemma-4-E2B-it-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/gemma-4-E2B-it-q4f16_1-MLC",
      lib: "gemma-4-E2B-it-q4f16_1_cs512-webgpu.wasm",
      contextWindow: 4096,
    },
    gguf: {
      url: "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/mmproj-gemma-4-E2B-it-Q8_0.gguf",
    },
    vision: true,
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "moondream2",
    name: "Moondream2",
    params: "1.9B",
    sizeMB: 3576,
    contextWindow: 2048,
    minVramMB: 4446,
    gguf: {
      url: "https://huggingface.co/ggml-org/moondream2-20250414-GGUF/resolve/main/moondream2-text-model-f16_ct-vicuna.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/moondream2-20250414-GGUF/resolve/main/moondream2-mmproj-f16-20250414.gguf",
    },
    vision: true,
  },
  {
    id: "deepseek-r1-distill-qwen-7b",
    name: "DeepSeek-R1 Distill Qwen 7B",
    params: "7.6B",
    sizeMB: 4086,
    contextWindow: 131072,
    minVramMB: 5107,
    mlc: {
      modelId: "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC",
      lib: "Qwen2-7B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    reasoning: "always",
  },
  {
    id: "deepseek-r1-distill-llama-8b",
    name: "DeepSeek-R1 Distill Llama 8B",
    params: "8B",
    sizeMB: 4308,
    contextWindow: 131072,
    minVramMB: 5001,
    mlc: {
      modelId: "DeepSeek-R1-Distill-Llama-8B-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/DeepSeek-R1-Distill-Llama-8B-q4f16_1-MLC",
      lib: "Llama-3_1-8B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    reasoning: "always",
  },
  // Split GGUF: wllama fetches every -0000N-of-00002 shard from the first URL.
  {
    id: "qwen2.5-7b-instruct",
    name: "Qwen2.5 7B Instruct",
    params: "7.6B",
    sizeMB: 4466,
    contextWindow: 131072,
    minVramMB: 5107,
    mlc: {
      modelId: "Qwen2.5-7B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen2.5-7B-Instruct-q4f16_1-MLC",
      lib: "Qwen2-7B-Instruct-q4f16_1_cs1k-webgpu.wasm",
      contextWindow: 32768,
    },
    gguf: { url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf" },
    tools: true,
  },
  {
    id: "llama-3.1-8b-instruct",
    name: "Llama 3.1 8B Instruct",
    params: "8B",
    sizeMB: 4693,
    contextWindow: 131072,
    minVramMB: 5001,
    mlc: {
      modelId: "Llama-3.1-8B-Instruct-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Llama-3.1-8B-Instruct-q4f16_1-MLC",
      lib: "Llama-3_1-8B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    },
    gguf: { url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "medgemma-4b-it-q8",
    name: "MedGemma 4B Instruct (Q8_0)",
    params: "4B",
    sizeMB: 4751,
    contextWindow: 131072,
    minVramMB: 5738,
    gguf: {
      url: "https://huggingface.co/unsloth/medgemma-4b-it-GGUF/resolve/main/medgemma-4b-it-Q8_0.gguf",
      mmprojUrl: "https://huggingface.co/unsloth/medgemma-4b-it-GGUF/resolve/main/mmproj-F16.gguf",
    },
    vision: true,
  },
  {
    id: "qwen3-8b",
    name: "Qwen3 8B",
    params: "8.2B",
    sizeMB: 4795,
    contextWindow: 40960,
    minVramMB: 5786,
    gguf: { url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwen3.5-9b",
    name: "Qwen3.5 9B",
    params: "9B",
    sizeMB: 4805,
    contextWindow: 262144,
    minVramMB: 6433,
    mlc: {
      modelId: "Qwen3.5-9B-q4f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Qwen3.5-9B-q4f16_1-MLC",
      lib: "Qwen3.5-9B-q4f16_1_cs1k-webgpu.wasm",
    },
    reasoning: "hybrid",
  },
  {
    id: "internvl3-8b-instruct",
    name: "InternVL3 8B Instruct",
    params: "8B",
    sizeMB: 4805,
    contextWindow: 32768,
    minVramMB: 5798,
    gguf: {
      url: "https://huggingface.co/ggml-org/InternVL3-8B-Instruct-GGUF/resolve/main/InternVL3-8B-Instruct-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/InternVL3-8B-Instruct-GGUF/resolve/main/mmproj-InternVL3-8B-Instruct-Q8_0.gguf",
    },
    vision: true,
    tools: true,
  },
  {
    id: "gemma-4-e4b-it",
    name: "Gemma 4 E4B Instruct",
    params: "8B",
    sizeMB: 4912,
    contextWindow: 131072,
    minVramMB: 5915,
    onnx: { repo: "onnx-community/gemma-4-E4B-it-ONNX", dtype: "q4f16", loader: "gemma4" },
    gguf: {
      url: "https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/mmproj-gemma-4-E4B-it-Q8_0.gguf",
    },
    vision: true,
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwen2.5-vl-7b-instruct",
    name: "Qwen2.5-VL 7B Instruct",
    params: "7B",
    sizeMB: 5280,
    contextWindow: 128000,
    minVramMB: 6320,
    gguf: {
      url: "https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf",
    },
    vision: true,
  },
  {
    id: "gemma-4-12b-it",
    name: "Gemma 4 12B Instruct",
    params: "12B",
    sizeMB: 6885,
    contextWindow: 262144,
    minVramMB: 8086,
    gguf: { url: "https://huggingface.co/ggml-org/gemma-4-12B-it-GGUF/resolve/main/gemma-4-12B-it-Q4_0.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "gemma-3-12b-it",
    name: "Gemma 3 12B Instruct",
    params: "12B",
    sizeMB: 6962,
    contextWindow: 131072,
    minVramMB: 8170,
    gguf: { url: "https://huggingface.co/ggml-org/gemma-3-12b-it-GGUF/resolve/main/gemma-3-12b-it-Q4_K_M.gguf" },
  },
  {
    id: "qwen3-14b",
    name: "Qwen3 14B",
    params: "14.8B",
    sizeMB: 8585,
    contextWindow: 40960,
    minVramMB: 9956,
    gguf: { url: "https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "moonlight-16b-a3b-instruct",
    name: "Moonlight 16B-A3B Instruct (MoE)",
    params: "16B",
    sizeMB: 10052,
    contextWindow: 8192,
    minVramMB: 11569,
    gguf: { url: "https://huggingface.co/gabriellarson/Moonlight-16B-A3B-Instruct-GGUF/resolve/main/Moonlight-16B-A3B-Instruct-Q4_K_M.gguf" },
  },
  {
    id: "kimi-vl-a3b-thinking-2506",
    name: "Kimi-VL A3B Thinking 2506 (MoE)",
    params: "16B",
    sizeMB: 10642,
    contextWindow: 131072,
    minVramMB: 12218,
    gguf: {
      url: "https://huggingface.co/ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF/resolve/main/Kimi-VL-A3B-Thinking-2506-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF/resolve/main/mmproj-Kimi-VL-A3B-Thinking-2506-Q8_0.gguf",
    },
    vision: true,
    reasoning: "always",
  },
  {
    id: "gpt-oss-20b-q4",
    name: "gpt-oss 20B (MoE, Q4_K_M)",
    params: "21B",
    sizeMB: 11086,
    contextWindow: 131072,
    minVramMB: 12707,
    gguf: { url: "https://huggingface.co/unsloth/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-Q4_K_M.gguf" },
    reasoning: "always",
    tools: true,
  },
  // Mixture of experts: ~3.6B parameters active per token, so it generates faster than its size suggests.
  {
    id: "gpt-oss-20b",
    name: "gpt-oss 20B (MoE)",
    params: "21B",
    sizeMB: 11549,
    contextWindow: 131072,
    minVramMB: 13216,
    gguf: { url: "https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-MXFP4.gguf" },
    reasoning: "always",
    tools: true,
  },
  {
    id: "mistral-small-3.2-24b-instruct",
    name: "Mistral Small 3.2 24B Instruct",
    params: "24B",
    sizeMB: 13670,
    contextWindow: 131072,
    minVramMB: 15549,
    gguf: { url: "https://huggingface.co/bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF/resolve/main/mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "gemma-4-26b-a4b-it",
    name: "Gemma 4 26B-A4B Instruct (MoE)",
    params: "26B",
    sizeMB: 14710,
    contextWindow: 262144,
    minVramMB: 16693,
    gguf: {
      url: "https://huggingface.co/ggml-org/gemma-4-26B-A4B-it-GGUF/resolve/main/gemma-4-26B-A4B-it-Q4_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/gemma-4-26B-A4B-it-GGUF/resolve/main/mmproj-gemma-4-26B-A4B-it-Q8_0.gguf",
    },
    vision: true,
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "medgemma-27b-text-it",
    name: "MedGemma 27B Text Instruct",
    params: "27B",
    sizeMB: 15780,
    contextWindow: 131072,
    minVramMB: 17870,
    gguf: { url: "https://huggingface.co/unsloth/medgemma-27b-text-it-GGUF/resolve/main/medgemma-27b-text-it-Q4_K_M.gguf" },
  },
  {
    id: "medgemma-27b-it",
    name: "MedGemma 27B Instruct",
    params: "27B",
    sizeMB: 16598,
    contextWindow: 131072,
    minVramMB: 18770,
    gguf: {
      url: "https://huggingface.co/unsloth/medgemma-27b-it-GGUF/resolve/main/medgemma-27b-it-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/unsloth/medgemma-27b-it-GGUF/resolve/main/mmproj-F16.gguf",
    },
    vision: true,
  },
  {
    id: "kimi-vl-a3b-thinking-2506-q8",
    name: "Kimi-VL A3B Thinking 2506 (MoE, Q8_0)",
    params: "16B",
    sizeMB: 16778,
    contextWindow: 131072,
    minVramMB: 18968,
    gguf: {
      url: "https://huggingface.co/ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF/resolve/main/Kimi-VL-A3B-Thinking-2506-Q8_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF/resolve/main/mmproj-Kimi-VL-A3B-Thinking-2506-Q8_0.gguf",
    },
    vision: true,
    reasoning: "always",
  },
  {
    id: "glm-4.7-flash",
    name: "GLM-4.7 Flash (MoE)",
    params: "30B",
    sizeMB: 17464,
    contextWindow: 202752,
    minVramMB: 19722,
    gguf: { url: "https://huggingface.co/unsloth/GLM-4.7-Flash-GGUF/resolve/main/GLM-4.7-Flash-Q4_K_M.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwen3-30b-a3b-instruct-2507",
    name: "Qwen3 30B-A3B Instruct 2507 (MoE)",
    params: "30.5B",
    sizeMB: 17697,
    contextWindow: 262144,
    minVramMB: 19979,
    gguf: { url: "https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF/resolve/main/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "gemma-4-31b-it",
    name: "Gemma 4 31B Instruct",
    params: "31B",
    sizeMB: 17931,
    contextWindow: 262144,
    minVramMB: 20236,
    gguf: {
      url: "https://huggingface.co/ggml-org/gemma-4-31B-it-GGUF/resolve/main/gemma-4-31B-it-Q4_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/gemma-4-31B-it-GGUF/resolve/main/mmproj-gemma-4-31B-it-Q8_0.gguf",
    },
    vision: true,
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8 27B",
    params: "27B",
    sizeMB: 18695,
    contextWindow: 262144,
    minVramMB: 21076,
    gguf: {
      url: "https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/main/mmproj-Qwen3.8-27B-Q8_0.gguf",
    },
    vision: true,
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "glm-4-32b-0414",
    name: "GLM-4 32B 0414",
    params: "32B",
    sizeMB: 18768,
    contextWindow: 32768,
    minVramMB: 21157,
    gguf: { url: "https://huggingface.co/unsloth/GLM-4-32B-0414-GGUF/resolve/main/GLM-4-32B-0414-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "qwen3-32b",
    name: "Qwen3 32B",
    params: "32.8B",
    sizeMB: 18847,
    contextWindow: 40960,
    minVramMB: 21244,
    gguf: { url: "https://huggingface.co/unsloth/Qwen3-32B-GGUF/resolve/main/Qwen3-32B-Q4_K_M.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwen2.5-32b-instruct",
    name: "Qwen2.5 32B Instruct",
    params: "32.8B",
    sizeMB: 18932,
    contextWindow: 32768,
    minVramMB: 21337,
    gguf: { url: "https://huggingface.co/bartowski/Qwen2.5-32B-Instruct-GGUF/resolve/main/Qwen2.5-32B-Instruct-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "nemotron-3-nano-30b-a3b",
    name: "Nemotron 3 Nano 30B-A3B (MoE)",
    params: "30B",
    sizeMB: 23436,
    contextWindow: 1048576,
    minVramMB: 26292,
    gguf: { url: "https://huggingface.co/unsloth/Nemotron-3-Nano-30B-A3B-GGUF/resolve/main/Nemotron-3-Nano-30B-A3B-Q4_K_M.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "nemotron-3-nano-omni-30b-a3b-reasoning",
    name: "Nemotron 3 Nano Omni 30B-A3B Reasoning (MoE)",
    params: "30B",
    sizeMB: 24294,
    contextWindow: 1048576,
    minVramMB: 27235,
    gguf: {
      url: "https://huggingface.co/unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF/resolve/main/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf",
      mmprojUrl: "https://huggingface.co/unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF/resolve/main/mmproj-F16.gguf",
    },
    vision: true,
    reasoning: "always",
    tools: true,
  },
  {
    id: "medgemma-27b-text-it-q8",
    name: "MedGemma 27B Text Instruct (Q8_0)",
    params: "27B",
    sizeMB: 27378,
    contextWindow: 131072,
    minVramMB: 30628,
    gguf: { url: "https://huggingface.co/unsloth/medgemma-27b-text-it-GGUF/resolve/main/medgemma-27b-text-it-Q8_0.gguf" },
  },
  {
    id: "qwen3.8-27b-q8",
    name: "Qwen3.8 27B (Q8_0)",
    params: "27B",
    sizeMB: 27871,
    contextWindow: 262144,
    minVramMB: 31170,
    gguf: {
      url: "https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q8_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/main/mmproj-Qwen3.8-27B-Q8_0.gguf",
    },
    vision: true,
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "medgemma-27b-it-q8",
    name: "MedGemma 27B Instruct (Q8_0)",
    params: "27B",
    sizeMB: 28196,
    contextWindow: 131072,
    minVramMB: 31528,
    gguf: {
      url: "https://huggingface.co/unsloth/medgemma-27b-it-GGUF/resolve/main/medgemma-27b-it-Q8_0.gguf",
      mmprojUrl: "https://huggingface.co/unsloth/medgemma-27b-it-GGUF/resolve/main/mmproj-F16.gguf",
    },
    vision: true,
  },
  {
    id: "kimi-linear-48b-a3b-instruct",
    name: "Kimi Linear 48B-A3B Instruct (MoE)",
    params: "48B",
    sizeMB: 28668,
    contextWindow: 1048576,
    minVramMB: 32047,
    gguf: { url: "https://huggingface.co/bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF/resolve/main/moonshotai_Kimi-Linear-48B-A3B-Instruct-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "llama-3.1-70b-instruct",
    name: "Llama 3.1 70B Instruct (q3)",
    params: "70.6B",
    sizeMB: 30304,
    contextWindow: 131072,
    minVramMB: 31153,
    mlc: {
      modelId: "Llama-3.1-70B-Instruct-q3f16_1-MLC",
      weightsUrl: "https://huggingface.co/mlc-ai/Llama-3.1-70B-Instruct-q3f16_1-MLC",
      lib: "Llama-3_1-70B-Instruct-q3f16_1_cs1k-webgpu.wasm",
    },
  },
  {
    id: "mixtral-8x7b-instruct-q5",
    name: "Mixtral 8x7B Instruct (MoE, Q5_K_M)",
    params: "46.7B",
    sizeMB: 31688,
    contextWindow: 32768,
    minVramMB: 35369,
    gguf: { url: "https://huggingface.co/second-state/Mixtral-8x7B-Instruct-v0.1-GGUF/resolve/main/Mixtral-8x7B-Instruct-v0.1-Q5_K_M.gguf" },
  },
  {
    id: "gemma-4-31b-it-q8",
    name: "Gemma 4 31B Instruct (Q8_0)",
    params: "31B",
    sizeMB: 31896,
    contextWindow: 262144,
    minVramMB: 35598,
    gguf: {
      url: "https://huggingface.co/ggml-org/gemma-4-31B-it-GGUF/resolve/main/gemma-4-31B-it-Q8_0.gguf",
      mmprojUrl: "https://huggingface.co/ggml-org/gemma-4-31B-it-GGUF/resolve/main/mmproj-gemma-4-31B-it-Q8_0.gguf",
    },
    vision: true,
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "nemotron-3-nano-30b-a3b-q6",
    name: "Nemotron 3 Nano 30B-A3B (MoE, Q6_K)",
    params: "30B",
    sizeMB: 31956,
    contextWindow: 1048576,
    minVramMB: 35664,
    gguf: { url: "https://huggingface.co/unsloth/Nemotron-3-Nano-30B-A3B-GGUF/resolve/main/Nemotron-3-Nano-30B-A3B-Q6_K.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwen3-32b-q8",
    name: "Qwen3 32B (Q8_0)",
    params: "32.8B",
    sizeMB: 33205,
    contextWindow: 40960,
    minVramMB: 37038,
    gguf: { url: "https://huggingface.co/unsloth/Qwen3-32B-GGUF/resolve/main/Qwen3-32B-Q8_0.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwq-32b-q8",
    name: "QwQ 32B (Q8_0)",
    params: "32.8B",
    sizeMB: 33208,
    contextWindow: 40960,
    minVramMB: 37041,
    gguf: { url: "https://huggingface.co/DhruvalLabs/QwQ-32B-GGUF/resolve/main/QwQ-32B-Q8_0.gguf" },
    reasoning: "always",
    tools: true,
  },
  {
    id: "kimi-linear-48b-a3b-instruct-q5",
    name: "Kimi Linear 48B-A3B Instruct (MoE, Q5_K_M)",
    params: "48B",
    sizeMB: 33472,
    contextWindow: 1048576,
    minVramMB: 37331,
    gguf: { url: "https://huggingface.co/bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF/resolve/main/moonshotai_Kimi-Linear-48B-A3B-Instruct-Q5_K_M.gguf" },
    tools: true,
  },
  {
    id: "qwen2.5-72b-instruct-q3",
    name: "Qwen2.5 72B Instruct (Q3_K_M)",
    params: "72.7B",
    sizeMB: 35952,
    contextWindow: 32768,
    minVramMB: 40059,
    gguf: { url: "https://huggingface.co/bartowski/Qwen2.5-72B-Instruct-GGUF/resolve/main/Qwen2.5-72B-Instruct-Q3_K_M.gguf" },
    tools: true,
  },
  {
    id: "mixtral-8x7b-instruct-q6",
    name: "Mixtral 8x7B Instruct (MoE, Q6_K)",
    params: "46.7B",
    sizeMB: 36601,
    contextWindow: 32768,
    minVramMB: 40773,
    gguf: { url: "https://huggingface.co/second-state/Mixtral-8x7B-Instruct-v0.1-GGUF/resolve/main/Mixtral-8x7B-Instruct-v0.1-Q6_K.gguf" },
  },
  // Needs ~44 GB of GPU memory: a 64 GB+ Apple Silicon Mac or a 48 GB GPU.
  {
    id: "llama-3.3-70b-instruct",
    name: "Llama 3.3 70B Instruct",
    params: "70.6B",
    sizeMB: 40551,
    contextWindow: 131072,
    minVramMB: 45118,
    gguf: { url: "https://huggingface.co/unsloth/Llama-3.3-70B-Instruct-GGUF/resolve/main/Llama-3.3-70B-Instruct-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "qwen2.5-72b-instruct",
    name: "Qwen2.5 72B Instruct",
    params: "72.7B",
    sizeMB: 45219,
    contextWindow: 32768,
    minVramMB: 50253,
    gguf: { url: "https://huggingface.co/bartowski/Qwen2.5-72B-Instruct-GGUF/resolve/main/Qwen2.5-72B-Instruct-Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "kimi-dev-72b",
    name: "Kimi-Dev 72B",
    params: "72.7B",
    sizeMB: 45219,
    contextWindow: 131072,
    minVramMB: 50253,
    gguf: { url: "https://huggingface.co/mradermacher/Kimi-Dev-72B-GGUF/resolve/main/Kimi-Dev-72B.Q4_K_M.gguf" },
    tools: true,
  },
  {
    id: "mixtral-8x7b-instruct-q8",
    name: "Mixtral 8x7B Instruct (MoE, Q8_0)",
    params: "46.7B",
    sizeMB: 47325,
    contextWindow: 32768,
    minVramMB: 52570,
    gguf: { url: "https://huggingface.co/second-state/Mixtral-8x7B-Instruct-v0.1-GGUF/resolve/main/Mixtral-8x7B-Instruct-v0.1-Q8_0.gguf" },
  },
  {
    id: "kimi-linear-48b-a3b-instruct-q8",
    name: "Kimi Linear 48B-A3B Instruct (MoE, Q8_0)",
    params: "48B",
    sizeMB: 49828,
    contextWindow: 1048576,
    minVramMB: 55323,
    gguf: { url: "https://huggingface.co/bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF/resolve/main/moonshotai_Kimi-Linear-48B-A3B-Instruct-Q8_0/moonshotai_Kimi-Linear-48B-A3B-Instruct-Q8_0-00001-of-00002.gguf" },
    tools: true,
  },
  {
    id: "gpt-oss-120b",
    name: "gpt-oss 120B (MoE)",
    params: "117B",
    sizeMB: 59861,
    contextWindow: 131072,
    minVramMB: 66359,
    gguf: { url: "https://huggingface.co/unsloth/gpt-oss-120b-GGUF/resolve/main/Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf" },
    reasoning: "always",
    tools: true,
  },
  {
    id: "gpt-oss-120b-q8",
    name: "gpt-oss 120B (MoE, Q8_0)",
    params: "117B",
    sizeMB: 60451,
    contextWindow: 131072,
    minVramMB: 67008,
    gguf: { url: "https://huggingface.co/unsloth/gpt-oss-120b-GGUF/resolve/main/Q8_0/gpt-oss-120b-Q8_0-00001-of-00002.gguf" },
    reasoning: "always",
    tools: true,
  },
  {
    id: "llama-3.3-70b-instruct-q8",
    name: "Llama 3.3 70B Instruct (Q8_0)",
    params: "70.6B",
    sizeMB: 71502,
    contextWindow: 131072,
    minVramMB: 79164,
    gguf: { url: "https://huggingface.co/unsloth/Llama-3.3-70B-Instruct-GGUF/resolve/main/Llama-3.3-70B-Instruct-Q8_0/Llama-3.3-70B-Instruct-Q8_0-00001-of-00002.gguf" },
    tools: true,
  },
  // Workstation scale: needs 80 GB+ of GPU memory (unified memory on a 96-128 GB Mac).
  {
    id: "qwen3.5-122b-a10b",
    name: "Qwen3.5 122B-A10B (MoE)",
    params: "122B",
    sizeMB: 72991,
    contextWindow: 262144,
    minVramMB: 80802,
    gguf: { url: "https://huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF/resolve/main/Q4_K_M/Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf" },
    reasoning: "hybrid",
    tools: true,
  },
  {
    id: "qwen3.5-122b-a10b-q5",
    name: "Qwen3.5 122B-A10B (MoE, Q5_K_M)",
    params: "122B",
    sizeMB: 87280,
    contextWindow: 262144,
    minVramMB: 96520,
    gguf: { url: "https://huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF/resolve/main/Q5_K_M/Qwen3.5-122B-A10B-Q5_K_M-00001-of-00003.gguf" },
    reasoning: "hybrid",
    tools: true,
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
  /** WebAssembly JS Promise Integration: lets wllama read the GGUF on demand instead of copying it. */
  jspi: boolean;
  /** WebAssembly Memory64, required by wllama's non-compat build. */
  mem64: boolean;
}

/** Caps of a device that can run everything; for listing every engine a model has a build for. */
export const ALL_CAPS: DeviceCaps = { webgpu: true, maxBufferMB: Infinity, jspi: true, mem64: true };

/**
 * Largest GGUF wllama can run on CPU: there the whole model lives in the 4 GB wasm heap.
 * Above it, wllama must stream weights from the cached file into WebGPU buffers, which needs
 * WebGPU, JSPI and Memory64; model size is then bounded by GPU memory, not wasm.
 */
export const WLLAMA_HEAP_MAX_MB = 3500;

export const ENGINE_PREFERENCE: EngineId[] = ["webllm", "transformers", "wllama"];

/** Auto-selection: WebGPU -> first of WebLLM, Transformers.js, wllama that can run the model; no WebGPU -> wllama. */
export function autoSelectEngine(model: CatalogModel, caps: DeviceCaps): EngineId | null {
  if (model.dummy) return "dummy";
  if (model.nano) return "nano";
  const order: EngineId[] = caps.webgpu ? ENGINE_PREFERENCE : ["wllama"];
  return order.find((e) => canRun(model, e, caps)) ?? null;
}

/** The engine a model runs on: its pin if that build can run here, else auto-selection. */
export function resolveEngine(model: CatalogModel, pin: EngineId | "auto", caps: DeviceCaps): EngineId | null {
  if (pin !== "auto") return canRun(model, pin, caps) ? pin : null;
  return autoSelectEngine(model, caps);
}

export function canRun(model: CatalogModel, engine: EngineId, caps: DeviceCaps): boolean {
  return !!model[BUILD_FIELD[engine]] && whyNot(model, engine, caps) === null;
}

const BUILD_FIELD = { transformers: "onnx", webllm: "mlc", wllama: "gguf", dummy: "dummy", nano: "nano" } as const;

/** Why a model's build for `engine` can't run on this device, or null if it can (or has no build). */
export function whyNot(model: CatalogModel, engine: EngineId, caps: DeviceCaps): string | null {
  if (engine === "webllm" && !caps.webgpu) return "needs WebGPU";
  if (engine === "transformers" && model.onnx?.wasmDtype === null && !caps.webgpu) return "needs WebGPU";
  if (engine === "wllama" && model.sizeMB > WLLAMA_HEAP_MAX_MB && !(caps.webgpu && caps.jspi && caps.mem64)) {
    return "needs WebGPU with JSPI and Memory64 (Chrome 137+)";
  }
  return null;
}

/** Largest context `engine` can give `model`: the model's, or its WebLLM build's lower limit. */
export function contextLimit(model: CatalogModel, engine: EngineId): number {
  return engine === "webllm" ? Math.min(model.contextWindow, model.mlc?.contextWindow ?? Infinity) : model.contextWindow;
}

/** Whether `engine` passes images to `model`: only builds that carry the vision parts do. */
export function takesImages(model: CatalogModel, engine: EngineId): boolean {
  switch (engine) {
    case "nano":
    case "dummy":
      return true;
    case "wllama":
      return !!model.gguf?.mmprojUrl;
    case "webllm":
      return !!model.mlc?.vision;
    case "transformers":
      return !!model.onnx?.loader;
  }
}

/**
 * How `engine` does tool calling with `model`. "native": wllama running a GGUF whose template
 * handles tools (llama.cpp formats and parses them), or the echo test engine. "prompted": every
 * other engine; tools are described in the prompt and calls parsed from the reply.
 */
export function toolMode(model: CatalogModel, engine: EngineId): "native" | "prompted" {
  return engine === "dummy" || (engine === "wllama" && !!model.tools && !!model.gguf) ? "native" : "prompted";
}

/**
 * Input and output types, e.g. "text+image→text". With an engine, what that engine passes to the
 * model; without one, the best any of the model's builds offers.
 */
export function ioLabel(model: CatalogModel, engine?: EngineId): string {
  const image = engine ? takesImages(model, engine) : !!model.vision || !!model.nano;
  return `${image ? "text+image" : "text"}→text`;
}
