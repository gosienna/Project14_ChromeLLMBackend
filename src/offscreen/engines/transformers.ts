// Transformers.js v4 engine: ONNX models on WebGPU, with WASM fallback. Default local engine.
// The ONNX Runtime .wasm files are bundled under vendor/ort/ so nothing loads from a CDN.

import { abortError } from "../../shared/errors";
import { AsyncQueue } from "../../shared/async-queue";
import type { CatalogModel, DeviceCaps } from "../../shared/catalog";
import type { ChatMessage, Usage } from "../../shared/protocol";
import type { GenerateOptions } from "../backend";
import { vendorUrl, type LocalEngine } from "./types";

type TF = typeof import("@huggingface/transformers");

let tfPromise: Promise<TF> | null = null;
function loadLibrary(): Promise<TF> {
  tfPromise ??= import("@huggingface/transformers").then((tf) => {
    tf.env.allowLocalModels = false;
    tf.env.allowRemoteModels = true;
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

export class TransformersEngine implements LocalEngine {
  readonly id = "transformers" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private generator: any = null;

  async load(model: CatalogModel, caps: DeviceCaps, onProgress: (f: number) => void) {
    if (!model.onnx) throw new Error(`${model.name} has no ONNX build`);
    const tf = await loadLibrary();
    const device = caps.webgpu ? "webgpu" : "wasm";
    this.generator = await tf.pipeline("text-generation", model.onnx.repo, {
      device,
      dtype: caps.webgpu ? model.onnx.dtype : "q4",
      progress_callback: (p) => {
        if (p.status === "progress_total") onProgress(Math.min(1, p.progress / 100));
      },
    });
    onProgress(1);
  }

  async unload() {
    await this.generator?.dispose?.();
    this.generator = null;
  }

  private tokenize(messages: ChatMessage[]): number[] {
    const ids = this.generator.tokenizer.apply_chat_template(messages, {
      tokenize: true,
      add_generation_prompt: true,
      return_tensor: false,
    });
    return ids as number[];
  }

  async countTokens(messages: ChatMessage[]) {
    return this.tokenize(messages).length;
  }

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage> {
    if (!this.generator) throw new Error("Model not loaded");
    const tf = await loadLibrary();
    const stopper = new tf.InterruptableStoppingCriteria();
    const onAbort = () => stopper.interrupt();
    signal.addEventListener("abort", onAbort, { once: true });

    const queue = new AsyncQueue<string>();
    let output = "";
    const streamer = new tf.TextStreamer(this.generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        output += text;
        queue.push(text);
      },
    });
    const sample = opts.temperature > 0;
    this.generator(messages, {
      max_new_tokens: opts.maxTokens ?? 1024,
      do_sample: sample,
      ...(sample ? { temperature: opts.temperature, top_k: opts.topK } : {}),
      streamer,
      stopping_criteria: stopper,
    }).then(
      () => queue.end(),
      (e: unknown) => queue.fail(e),
    );

    try {
      for await (const chunk of queue) yield chunk;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw abortError();
    const inputTokens = this.tokenize(messages).length;
    const outputTokens = this.generator.tokenizer.encode(output).length;
    return { inputTokens, outputTokens };
  }

  async deleteCache(model: CatalogModel) {
    if (!model.onnx) return;
    const cache = await caches.open("transformers-cache");
    for (const req of await cache.keys()) {
      if (req.url.includes(`/${model.onnx.repo}/`)) await cache.delete(req);
    }
  }
}
