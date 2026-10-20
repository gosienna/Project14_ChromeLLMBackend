// Transformers.js v4 engine: ONNX models on WebGPU, with WASM fallback. Default local engine.
// Text models run through the text-generation pipeline; vision models (Gemma 4, Ministral 3)
// load through AutoProcessor and generate from the processor's inputs, as in Project05.
// The ONNX Runtime .wasm files are bundled under vendor/ort/ so nothing loads from a CDN.

import { abortError } from "../../shared/errors";
import { AsyncQueue } from "../../shared/async-queue";
import type { CatalogModel, DeviceCaps } from "../../shared/catalog";
import type { ChatMessage, ImageInput, Usage } from "../../shared/protocol";
import type { GenerateOptions } from "../backend";
import { ModelStore } from "../model-store";
import { ThinkSplitter } from "./think-splitter";
import { vendorUrl, type LocalEngine } from "./types";

/** Downloaded files, keyed by URL, in IndexedDB instead of Cache Storage. */
const store = new ModelStore("transformers");

// The subset of the Web Cache API that Transformers.js uses for env.customCache.
const modelCache = {
  async match(key: string): Promise<Response | undefined> {
    const blob = await store.read(key);
    return blob ? new Response(blob, { headers: { "content-length": String(blob.size) } }) : undefined;
  },
  async put(key: string, response: Response, onProgress?: (p: { progress: number; loaded: number; total: number }) => void) {
    if (!response.body) return;
    const total = Number(response.headers.get("content-length")) || 0;
    await store.write(key, response.body, (loaded) => onProgress?.({ progress: total ? (loaded / total) * 100 : 0, loaded, total }));
  },
  async delete(key: string): Promise<boolean> {
    await store.delete(key);
    return true;
  },
};

type TF = typeof import("@huggingface/transformers");

let tfPromise: Promise<TF> | null = null;
function loadLibrary(): Promise<TF> {
  tfPromise ??= import("@huggingface/transformers").then((tf) => {
    tf.env.allowLocalModels = false;
    tf.env.allowRemoteModels = true;
    tf.env.useBrowserCache = false;
    tf.env.useCustomCache = true;
    tf.env.customCache = modelCache;
    const onnx = tf.env.backends.onnx as { wasm?: { wasmPaths?: unknown; proxy?: boolean } };
    if (onnx.wasm) {
      onnx.wasm.wasmPaths = {
        mjs: vendorUrl("ort/ort-wasm-simd-threaded.jsep.mjs"),
        wasm: vendorUrl("ort/ort-wasm-simd-threaded.jsep.wasm"),
      };
    }
    return tf;
  });
  return tfPromise;
}

/** Chat for a vision model's processor: parts, with an image placeholder per attached image. */
function toVisionChat(messages: ChatMessage[]) {
  return messages.map((m) =>
    // Gemma's template trims the system message without checking its type, so keep it a string.
    m.role === "system"
      ? { role: m.role, content: m.content }
      : { role: m.role, content: [...(m.images ?? []).map(() => ({ type: "image" })), { type: "text", text: m.content }] },
  );
}

const toBlob = (i: ImageInput) => new Blob([Uint8Array.from(atob(i.data), (c) => c.charCodeAt(0))], { type: i.mimeType });

/** Rough token cost of one image in a vision model's prompt. */
const IMAGE_TOKENS = 256;

export class TransformersEngine implements LocalEngine {
  readonly id = "transformers" as const;
  private model: CatalogModel | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private generator: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private vision: { model: any; processor: any } | null = null;

  async load(model: CatalogModel, caps: DeviceCaps, onProgress: (f: number) => void) {
    const onnx = model.onnx;
    if (!onnx) throw new Error(`${model.name} has no ONNX build`);
    const device = caps.webgpu && !onnx.cpuOnly ? "webgpu" : "wasm";
    const dtype = device === "webgpu" ? onnx.dtype : onnx.wasmDtype;
    if (dtype === null) throw new DOMException(`${model.name} needs WebGPU on Transformers.js`, "NotSupportedError");
    const tf = await loadLibrary();
    const progress_callback = (p: { status: string; progress?: number }) => {
      if (p.status === "progress_total" && p.progress !== undefined) onProgress(Math.min(1, p.progress / 100));
    };
    if (onnx.loader) {
      const processor = await tf.AutoProcessor.from_pretrained(onnx.repo, { progress_callback });
      const Model = onnx.loader === "gemma4" ? tf.Gemma4ForConditionalGeneration : tf.AutoModelForImageTextToText;
      this.vision = { model: await Model.from_pretrained(onnx.repo, { device, dtype: dtype ?? "q4", progress_callback }), processor };
    } else {
      this.generator = await tf.pipeline("text-generation", onnx.repo, { device, dtype: dtype ?? "q4", progress_callback });
    }
    this.model = model;
    onProgress(1);
  }

  async unload() {
    await this.generator?.dispose?.();
    await this.vision?.model.dispose?.();
    this.generator = null;
    this.vision = null;
    this.model = null;
  }

  private get tokenizer() {
    return this.vision ? this.vision.processor.tokenizer : this.generator.tokenizer;
  }

  /** The chat template's output for `messages`, ready to generate from. */
  private prompt(messages: ChatMessage[], reasoning: boolean | undefined): string {
    // Gemma 4 marks its thinking with special tokens the streamer strips, which would mix it
    // into the answer; it answers directly here and thinks on wllama, where llama.cpp parses it.
    const thinking = this.model?.onnx?.loader === "gemma4" ? { enable_thinking: false }
      : this.model?.reasoning === "hybrid" ? { enable_thinking: reasoning !== false } : {};
    const opts = { tokenize: false, add_generation_prompt: true, ...thinking };
    return this.vision
      ? this.vision.processor.apply_chat_template(toVisionChat(messages), opts)
      : this.tokenizer.apply_chat_template(messages, opts);
  }

  async countTokens(messages: ChatMessage[]) {
    const images = messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    return this.tokenizer.encode(this.prompt(messages, true)).length + images * IMAGE_TOKENS;
  }

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage> {
    if (!this.model || (!this.generator && !this.vision)) throw new Error("Model not loaded");
    const tf = await loadLibrary();
    const stopper = new tf.InterruptableStoppingCriteria();
    const onAbort = () => stopper.interrupt();
    signal.addEventListener("abort", onAbort, { once: true });

    const queue = new AsyncQueue<string>();
    let output = "";
    const streamer = new tf.TextStreamer(this.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        output += text;
        queue.push(text);
      },
    });
    const sample = opts.temperature > 0;
    const generation = {
      max_new_tokens: opts.maxTokens ?? 1024,
      do_sample: sample,
      ...(sample ? { temperature: opts.temperature, top_k: opts.topK } : {}),
      streamer,
      stopping_criteria: stopper,
    };
    const prompt = this.prompt(messages, opts.reasoning);
    const { streamer: _s, stopping_criteria: _c, ...config } = generation;
    opts.onTrace?.({
      engine: this.id,
      request: { model: this.model.onnx?.repo, messages: messages.map(({ role, content, images }) => ({ role, content, ...(images?.length ? { images } : {}) })), ...config },
      prompt,
    });
    this.run(prompt, messages, generation).then(
      () => queue.end(),
      (e: unknown) => queue.fail(e),
    );

    // Hybrid reasoning models (Qwen3) write their thinking inline in <think> tags.
    const splitter = new ThinkSplitter();
    try {
      for await (const chunk of queue) {
        const { answer, reasoning } = splitter.push(chunk);
        if (reasoning) opts.onReasoning?.(reasoning);
        if (answer) yield answer;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw abortError();
    const rest = splitter.flush();
    if (rest.reasoning) opts.onReasoning?.(rest.reasoning);
    if (rest.answer) yield rest.answer;
    const inputTokens = await this.countTokens(messages);
    const outputTokens = this.tokenizer.encode(output).length;
    return { inputTokens, outputTokens };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async run(prompt: string, messages: ChatMessage[], generation: Record<string, any>): Promise<void> {
    if (!this.vision) {
      // Same encoding the pipeline applies to chat input once it has rendered the template.
      await this.generator(prompt, generation);
      return;
    }
    const tf = await loadLibrary();
    const { model, processor } = this.vision;
    const blobs = messages.flatMap((m) => (m.images ?? []).map(toBlob));
    const images = blobs.length ? await Promise.all(blobs.map((b) => tf.RawImage.fromBlob(b))) : null;
    const single = images?.length === 1 ? images[0] : images;
    // Gemma 4's processor also takes audio: processor(text, images, audio, options).
    const inputs = this.model?.onnx?.loader === "gemma4"
      ? await processor(prompt, single, null, { add_special_tokens: false })
      : await processor(prompt, single, { add_special_tokens: false });
    await model.generate({ ...inputs, ...generation });
  }

  async deleteCache(model: CatalogModel) {
    if (!model.onnx) return;
    for (const { key } of await store.list()) {
      if (key.includes(`/${model.onnx.repo}/`)) await store.delete(key);
    }
  }
}
