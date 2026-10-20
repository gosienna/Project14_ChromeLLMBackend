// Optional NanoBackend: Chrome's built-in model (Gemini Nano), when the browser exposes the
// Prompt API to extension pages. Lets users route sites to the native model via this extension.

import { abortError } from "../../shared/errors";
import type { ChatMessage, ImageInput, Usage } from "../../shared/protocol";
import type { GenerateOptions } from "../backend";
import type { LocalEngine } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const native = () => (globalThis as any).LanguageModel;

export function nanoSupported(): boolean {
  return typeof native()?.create === "function";
}

function toBlob(img: ImageInput): Blob {
  const bin = atob(img.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: img.mimeType });
}

/** Prompt API multimodal message: content becomes a list of typed parts when images are attached. */
function toNative(m: ChatMessage) {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [...m.images.map((i) => ({ type: "image", value: toBlob(i) })), ...(m.content ? [{ type: "text", value: m.content }] : [])],
  };
}

export class NanoEngine implements LocalEngine {
  readonly id = "nano" as const;

  async load(_m: unknown, _c: unknown, onProgress: (f: number) => void) {
    if (!nanoSupported()) throw new Error("Chrome's built-in model is not available");
    const s = await native().create({
      monitor(m: EventTarget) {
        m.addEventListener("downloadprogress", (e) => onProgress((e as ProgressEvent).loaded));
      },
    });
    s.destroy();
    onProgress(1);
  }

  async unload() {}

  async countTokens(messages: ChatMessage[]) {
    return messages.reduce((n, m) => n + Math.ceil(m.content.length / 4) + 4, 0);
  }

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage> {
    const initialPrompts = messages.slice(0, -1).map(toNative);
    const last = messages[messages.length - 1];
    const images = messages.some((m) => m.images?.length);
    opts.onTrace?.({
      engine: this.id,
      request: {
        create: { initialPrompts, temperature: opts.temperature, topK: opts.topK, ...(images ? { expectedInputs: [{ type: "text" }, { type: "image" }] } : {}) },
        promptStreaming: last.images?.length ? [toNative(last)] : last.content,
      },
    });
    const session = await native().create({
      initialPrompts,
      temperature: opts.temperature,
      topK: opts.topK,
      signal,
      ...(images ? { expectedInputs: [{ type: "text" }, { type: "image" }] } : {}),
    });
    let out = "";
    try {
      for await (const chunk of session.promptStreaming(last.images?.length ? [toNative(last)] : last.content, { signal })) {
        out += chunk;
        yield chunk as string;
      }
    } catch (e) {
      if (signal.aborted) throw abortError();
      throw e;
    } finally {
      session.destroy();
    }
    return { inputTokens: await this.countTokens(messages), outputTokens: Math.ceil(out.length / 4) };
  }

  async deleteCache() {}
}
