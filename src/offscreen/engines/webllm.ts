// WebLLM engine: MLC builds on WebGPU. Fastest chat on capable GPUs.
// Model libraries (.wasm) count as code under store policy, so they are bundled under
// vendor/webllm-libs/ (see scripts/fetch-webllm-libs.mjs); only weights are downloaded.

import { abortError } from "../../shared/errors";
import type { CatalogModel, DeviceCaps } from "../../shared/catalog";
import type { ChatMessage, Usage } from "../../shared/protocol";
import type { GenerateOptions } from "../backend";
import { ThinkSplitter } from "./think-splitter";
import { vendorUrl, type LocalEngine } from "./types";

type WebLLM = typeof import("@mlc-ai/web-llm");

let libPromise: Promise<WebLLM> | null = null;
const loadLibrary = () => (libPromise ??= import("@mlc-ai/web-llm"));

function appConfig(model: CatalogModel) {
  const mlc = model.mlc!;
  return {
    // Weights go to IndexedDB (WebLLM's own "webllm/*" databases) rather than Cache Storage.
    cacheBackend: "indexeddb" as const,
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

/** OpenAI-style message; the vision build gets images as data-URL parts. */
function toWebLLM(m: ChatMessage) {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      { type: "text", text: m.content },
      ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
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
      const request = {
        messages: messages.map(toWebLLM),
        stream: true,
        stream_options: { include_usage: true },
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        // Qwen3.5 and other hybrid reasoning models think unless told not to.
        ...(this.model?.reasoning === "hybrid" ? { extra_body: { enable_thinking: opts.reasoning !== false } } : {}),
      };
      opts.onTrace?.({ engine: this.id, request });
      const stream = await this.engine.chat.completions.create(request);
      // Thinking arrives as reasoning_content, or inline in <think> tags (DeepSeek-R1 distills).
      const splitter = new ThinkSplitter();
      for await (const chunk of stream) {
        if (signal.aborted) break;
        const delta = chunk.choices?.[0]?.delta as { content?: string | null; reasoning_content?: string | null } | undefined;
        if (delta?.reasoning_content) opts.onReasoning?.(delta.reasoning_content);
        if (delta?.content) {
          const { answer, reasoning } = splitter.push(delta.content);
          if (reasoning) opts.onReasoning?.(reasoning);
          if (answer) yield answer;
        }
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
      const rest = splitter.flush();
      if (rest.reasoning) opts.onReasoning?.(rest.reasoning);
      if (rest.answer && !signal.aborted) yield rest.answer;
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
