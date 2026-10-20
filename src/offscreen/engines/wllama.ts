// wllama engine: GGUF models through llama.cpp compiled to WASM, on WebGPU when available and
// CPU otherwise. In Chrome (JSPI + Memory64) llama.cpp reads the cached GGUF on demand instead of
// copying it into the 4 GB wasm heap, and with every layer offloaded the weights live in WebGPU
// buffers, so model size is bounded by GPU memory (catalog.ts WLLAMA_HEAP_MAX_MB).
// Multi-threading needs cross-origin isolation (manifest COOP/COEP keys); otherwise single-thread.

import { abortError } from "../../shared/errors";
import { CATALOG, type CatalogModel, type DeviceCaps } from "../../shared/catalog";
import type { ChatMessage, ImageInput, Usage } from "../../shared/protocol";
import type { GenerateOptions, GenerateResult } from "../backend";
import { ModelStore } from "../model-store";
import { openAIToolFields, openAITools, ToolCallAccumulator } from "../tools/openai";
import { ThinkSplitter } from "./think-splitter";
import { vendorUrl, type LocalEngine } from "./types";

type WllamaLib = typeof import("@wllama/wllama");
type CacheManager = InstanceType<WllamaLib["CacheManager"]>;
type StorageBackend = NonNullable<ConstructorParameters<WllamaLib["CacheManager"]>[0]>[number];

let libPromise: Promise<WllamaLib> | null = null;
const loadLibrary = () => (libPromise ??= import("@wllama/wllama"));

/** wllama's file cache, kept in IndexedDB instead of its default OPFS. */
let cachePromise: Promise<CacheManager> | null = null;
const modelCache = () =>
  (cachePromise ??= loadLibrary().then(({ CacheManager }) => {
    const store = new ModelStore("wllama");
    const backend: StorageBackend = {
      isSupported: () => typeof indexedDB !== "undefined",
      read: (key) => store.read(key),
      write: (key, stream) => store.write(key, stream),
      getSize: (key) => store.size(key),
      list: () => store.list(),
      delete: (key) => store.delete(key),
    };
    return new CacheManager([backend]);
  }));

const OOM = /out of memory|failed to allocate|\boom\b/i;

/** All shards of a split GGUF share the URL before `-0000N-of-0000M.gguf`. */
const shardBase = (url: string) => url.replace(/-\d{5}-of-\d{5}\.gguf$/, "");

/** Long edge cap for images sent to llama.cpp; larger ones only cost time in the projector. */
const IMAGE_MAX_EDGE = 1280;

/** llama.cpp's image decoder (stb_image) is picky; re-encode everything as JPEG, as Project05 does. */
async function toJpeg(image: ImageInput): Promise<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 })).arrayBuffer();
}

/** wllama messages: images become `{ type: "image", data }` parts ahead of the text; tool turns use OpenAI's shape. */
async function toWllama(messages: ChatMessage[]) {
  return Promise.all(
    messages.map(async (m) => {
      if (!m.images?.length) return { role: m.role, content: m.content, ...openAIToolFields(m) };
      const images = await Promise.all(m.images.map(async (i) => ({ type: "image" as const, data: await toJpeg(i) })));
      return { role: m.role, content: [...images, { type: "text" as const, text: m.content || "Describe this image." }] };
    }),
  );
}

/** Turn reasoning down when the user switched it off. */
function templateKwargs(model: CatalogModel, reasoning: boolean | undefined): Record<string, unknown> | undefined {
  if (reasoning !== false || !model.reasoning) return undefined;
  return model.reasoning === "hybrid" ? { enable_thinking: false } : { reasoning_effort: "low" };
}

export class WllamaEngine implements LocalEngine {
  readonly id = "wllama" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wllama: any = null;
  private model: CatalogModel | null = null;

  async load(model: CatalogModel, caps: DeviceCaps, onProgress: (f: number) => void, nCtx: number) {
    if (!model.gguf) throw new Error(`${model.name} has no GGUF build`);
    try {
      try {
        await this.open(model, caps, onProgress, nCtx, true);
      } catch (e) {
        // A partial or stale cache entry: drop every shard and download again once.
        if (!/Model file not found/i.test(String((e as Error)?.message ?? e))) throw e;
        await this.unload();
        await this.deleteCache(model);
        await this.open(model, caps, onProgress, nCtx, false);
      }
    } catch (e) {
      await this.unload().catch(() => {});
      if (OOM.test(String((e as Error)?.message ?? e))) {
        throw new DOMException(
          `${model.name} does not fit in this device's GPU memory (needs about ${Math.ceil(model.minVramMB / 1024)} GB). Pick a smaller model.`,
          "NotSupportedError",
        );
      }
      throw e;
    }
    this.model = model;
    onProgress(1);
  }

  private async open(model: CatalogModel, caps: DeviceCaps, onProgress: (f: number) => void, nCtx: number, useCache: boolean) {
    const { Wllama } = await loadLibrary();
    this.wllama = new Wllama(
      { default: vendorUrl("wllama/wllama.wasm") },
      // DEBUG(wllama-stall): native INFO logs (slot/KV/token counts, no prompt text) to the offscreen console.
      { suppressNativeLog: false, parallelDownloads: 4, allowOffline: true, cacheManager: await modelCache() },
    );
    const { url, mmprojUrl } = model.gguf!;
    await this.wllama.loadModelFromUrl(mmprojUrl ? { url, mmprojUrl } : url, {
      useCache,
      n_ctx: nCtx,
      // Every layer on the GPU; 0 skips WebGPU initialisation entirely.
      n_gpu_layers: caps.webgpu ? 999 : 0,
      ...(mmprojUrl ? { mmproj_offload: caps.webgpu } : {}),
      // The GGUF's own chat template, which reasoning models (Qwen3, gpt-oss) need.
      jinja: true,
      // llama.cpp moves thinking into delta.reasoning_content.
      reasoning_format: "deepseek",
      progressCallback: ({ loaded, total }: { loaded: number; total: number }) => total && onProgress(Math.min(1, loaded / total)),
    });
  }

  async unload() {
    await this.wllama?.exit();
    this.wllama = null;
    this.model = null;
  }

  async countTokens(messages: ChatMessage[]) {
    return messages.reduce((n, m) => n + Math.ceil(m.content.length / 4) + 4, 0);
  }

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, GenerateResult> {
    if (!this.wllama || !this.model) throw new Error("Model not loaded");
    let usage: Usage = { inputTokens: await this.countTokens(messages), outputTokens: 0 };
    const request = {
      messages: await toWllama(messages),
      stream: true,
      temperature: opts.temperature,
      top_k: opts.topK,
      max_tokens: opts.maxTokens ?? 1024,
      chat_template_kwargs: templateKwargs(this.model, opts.reasoning),
      // The GGUF's template formats the tools; llama.cpp parses calls into delta.tool_calls.
      ...(opts.tools?.length ? { tools: openAITools(opts.tools) } : {}),
    };
    opts.onTrace?.({ engine: this.id, request });
    const stream = await this.wllama.createChatCompletion({ ...request, abortSignal: signal });
    const splitter = new ThinkSplitter();
    const calls = new ToolCallAccumulator();
    // DEBUG(wllama-stall): counts only, never text.
    const t0 = performance.now();
    let nChunks = 0, nThink = 0, nAnswer = 0, lastAt = t0;
    let lastFinish: unknown = null;
    const beat = setInterval(() => console.info(`[wllama] +${((performance.now() - t0) / 1000).toFixed(0)}s chunks=${nChunks} think=${nThink} answer=${nAnswer} idle=${((performance.now() - lastAt) / 1000).toFixed(0)}s`), 10_000);
    console.info(`[wllama] start msgs=${messages.length} estTokens=${usage.inputTokens} max_tokens=${request.max_tokens} tools=${opts.tools?.length ?? 0} temp=${opts.temperature} topK=${opts.topK} reasoning=${opts.reasoning}`);
    try {
      for await (const chunk of stream) {
        nChunks++;
        lastAt = performance.now();
        const d = chunk.choices?.[0]?.delta;
        if (d?.reasoning_content) nThink++;
        if (d?.content) nAnswer++;
        if (chunk.choices?.[0]?.finish_reason) lastFinish = chunk.choices[0].finish_reason;
        const delta = chunk.choices?.[0]?.delta as
          | { content?: string | null; reasoning_content?: string | null; tool_calls?: Parameters<ToolCallAccumulator["add"]>[0] }
          | undefined;
        calls.add(delta?.tool_calls);
        if (delta?.reasoning_content) opts.onReasoning?.(delta.reasoning_content);
        if (delta?.content) {
          const { answer, reasoning } = splitter.push(delta.content);
          if (reasoning) opts.onReasoning?.(reasoning);
          if (answer) yield answer;
        }
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
    } catch (e) {
      console.info(`[wllama] threw after ${((performance.now() - t0) / 1000).toFixed(1)}s aborted=${signal.aborted}`, e);
      if (signal.aborted) throw abortError();
      throw e;
    } finally {
      clearInterval(beat);
    }
    console.info(`[wllama] end ${((performance.now() - t0) / 1000).toFixed(1)}s chunks=${nChunks} think=${nThink} answer=${nAnswer} usage=${JSON.stringify(usage)} finish=${JSON.stringify(lastFinish)}`);
    if (signal.aborted) throw abortError();
    const rest = splitter.flush();
    if (rest.reasoning) opts.onReasoning?.(rest.reasoning);
    if (rest.answer) yield rest.answer;
    const toolCalls = calls.finish();
    return toolCalls.length ? { ...usage, toolCalls } : usage;
  }

  async deleteCache(model: CatalogModel) {
    if (!model.gguf) return;
    const base = shardBase(model.gguf.url);
    // Quant variants of one model share its projector; keep it while another variant uses it.
    const mmproj = model.gguf.mmprojUrl;
    const mmprojShared = CATALOG.some((m) => m.id !== model.id && m.gguf?.mmprojUrl === mmproj);
    const cache = await modelCache();
    await cache.deleteMany((e) => !!e.metadata?.originalURL?.startsWith(base) || (!!mmproj && !mmprojShared && e.metadata?.originalURL === mmproj));
    await cache.delete(model.gguf.url);
  }
}
