// wllama engine: GGUF models on CPU via multi-threaded WASM. Fallback when WebGPU is missing.
// Multi-threading needs cross-origin isolation (manifest COOP/COEP keys); otherwise single-thread.

import { abortError } from "../../shared/errors";
import type { CatalogModel, DeviceCaps } from "../../shared/catalog";
import type { ChatMessage, Usage } from "../../shared/protocol";
import type { GenerateOptions } from "../backend";
import { vendorUrl, type LocalEngine } from "./types";

type WllamaLib = typeof import("@wllama/wllama");

let libPromise: Promise<WllamaLib> | null = null;
const loadLibrary = () => (libPromise ??= import("@wllama/wllama"));

export class WllamaEngine implements LocalEngine {
  readonly id = "wllama" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wllama: any = null;

  async load(model: CatalogModel, _caps: DeviceCaps, onProgress: (f: number) => void) {
    if (!model.gguf) throw new Error(`${model.name} has no GGUF build`);
    const { Wllama } = await loadLibrary();
    this.wllama = new Wllama({ default: vendorUrl("wllama/wllama.wasm") }, { suppressNativeLog: true });
    await this.wllama.loadModelFromUrl(model.gguf.url, {
      n_ctx: model.contextWindow,
      progressCallback: ({ loaded, total }: { loaded: number; total: number }) => total && onProgress(Math.min(1, loaded / total)),
    });
    onProgress(1);
  }

  async unload() {
    await this.wllama?.exit();
    this.wllama = null;
  }

  async countTokens(messages: ChatMessage[]) {
    return messages.reduce((n, m) => n + Math.ceil(m.content.length / 4) + 4, 0);
  }

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage> {
    if (!this.wllama) throw new Error("Model not loaded");
    let usage: Usage = { inputTokens: await this.countTokens(messages), outputTokens: 0 };
    const stream = await this.wllama.createChatCompletion({
      messages,
      stream: true,
      abortSignal: signal,
      temperature: opts.temperature,
      top_k: opts.topK,
      max_tokens: opts.maxTokens ?? 1024,
    });
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
    } catch (e) {
      if (signal.aborted) throw abortError();
      throw e;
    }
    if (signal.aborted) throw abortError();
    return usage;
  }

  async deleteCache(model: CatalogModel) {
    if (!model.gguf) return;
    const { CacheManager } = await loadLibrary();
    await new CacheManager().delete(model.gguf.url);
  }
}
