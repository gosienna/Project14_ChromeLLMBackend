// WebLLM engine: MLC builds on WebGPU. Fastest chat on capable GPUs.
// Model libraries (.wasm) count as code under store policy, so they are bundled under
// vendor/webllm-libs/ (see scripts/fetch-webllm-libs.mjs); only weights are downloaded.

import { abortError } from "../../shared/errors";
import type { CatalogModel, DeviceCaps } from "../../shared/catalog";
import type { ChatMessage, Usage } from "../../shared/protocol";
import type { GenerateOptions } from "../backend";
import { vendorUrl, type LocalEngine } from "./types";

type WebLLM = typeof import("@mlc-ai/web-llm");

let libPromise: Promise<WebLLM> | null = null;
const loadLibrary = () => (libPromise ??= import("@mlc-ai/web-llm"));

function appConfig(model: CatalogModel) {
  const mlc = model.mlc!;
  return {
    model_list: [
      {
        model: mlc.weightsUrl,
        model_id: mlc.modelId,
        model_lib: vendorUrl(`webllm-libs/${mlc.lib}`),
        overrides: { context_window_size: model.contextWindow },
      },
    ],
  };
}

export class WebLLMEngine implements LocalEngine {
  readonly id = "webllm" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private engine: any = null;
  private model: CatalogModel | null = null;

  async load(model: CatalogModel, caps: DeviceCaps, onProgress: (f: number) => void) {
    if (!model.mlc) throw new Error(`${model.name} has no MLC build`);
    if (!caps.webgpu) throw new Error("WebLLM requires WebGPU");
    const webllm = await loadLibrary();
    this.engine = await webllm.CreateMLCEngine(model.mlc.modelId, {
      appConfig: appConfig(model),
      initProgressCallback: (r: { progress: number }) => onProgress(Math.min(1, r.progress)),
    });
    this.model = model;
    onProgress(1);
  }

  async unload() {
    await this.engine?.unload?.();
    this.engine = null;
    this.model = null;
  }

  async countTokens(messages: ChatMessage[]) {
    // WebLLM exposes no public tokenizer; approximate from text length.
    return messages.reduce((n, m) => n + Math.ceil(m.content.length / 4) + 4, 0);
  }

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage> {
    if (!this.engine) throw new Error("Model not loaded");
    const onAbort = () => this.engine?.interruptGenerate();
    signal.addEventListener("abort", onAbort, { once: true });
    let usage: Usage = { inputTokens: await this.countTokens(messages), outputTokens: 0 };
    try {
      await this.engine.resetChat();
      const stream = await this.engine.chat.completions.create({
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      });
      for await (const chunk of stream) {
        if (signal.aborted) break;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw abortError();
    return usage;
  }

  async deleteCache(model: CatalogModel) {
    if (!model.mlc) return;
    const webllm = await loadLibrary();
    await webllm.deleteModelAllInfoInCache(model.mlc.modelId, appConfig(model));
    if (this.model?.id === model.id) await this.unload();
  }
}
