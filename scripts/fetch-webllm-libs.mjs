// Downloads the compiled WebLLM model libraries (.wasm) for the curated catalog into
// vendor/webllm-libs/, so they ship inside the extension (store policy: no remote code).
// Only weights are fetched at runtime.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkg = require("@mlc-ai/web-llm/package.json");
const version = `v${pkg.version.replace(/\./g, "_")}`;
const base = `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/${version}/base`;

// Keep in sync with src/shared/catalog.ts (mlc.lib).
const libs = [
  "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "Llama-3_1-70B-Instruct-q3f16_1_cs1k-webgpu.wasm",
  "Llama-3_1-8B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "Phi-3.5-mini-instruct-q4f16_1_cs1k-webgpu.wasm",
  "Phi-3.5-vision-instruct-q4f16_1_cs4k-webgpu.wasm",
  "Phi-4-mini-instruct-q4f16_1_cs1k-webgpu.wasm",
  "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "Qwen2-7B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm",
  "Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm",
  "Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm",
  "Qwen3.5-9B-q4f16_1_cs1k-webgpu.wasm",
  "SmolLM2-1.7B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "gemma-2-2b-it-q4f16_1_cs1k-webgpu.wasm",
  "gemma-4-E2B-it-q4f16_1_cs512-webgpu.wasm",
  "gemma3-1b-it-q4f16_1_cs1k-webgpu.wasm",
];

const out = join(root, "vendor/webllm-libs");
mkdirSync(out, { recursive: true });
for (const lib of libs) {
  const dest = join(out, lib);
  if (existsSync(dest)) { console.log(`have ${lib}`); continue; }
  const res = await fetch(`${base}/${lib}`);
  if (!res.ok) throw new Error(`${lib}: HTTP ${res.status} from ${base}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`fetched ${lib}`);
}
