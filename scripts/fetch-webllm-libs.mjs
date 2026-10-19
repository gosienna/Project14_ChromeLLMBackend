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
const libs = ["Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm", "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm"];

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
