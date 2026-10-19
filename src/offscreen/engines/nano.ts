// Optional NanoBackend: Chrome's built-in model (Gemini Nano), when the browser exposes the
// Prompt API to extension pages. Lets users route sites to the native model via this extension.

import { abortError } from "../../shared/errors";
import type { ChatMessage, Usage } from "../../shared/protocol";
import type { GenerateOptions } from "../backend";
import type { LocalEngine } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const native = () => (globalThis as any).LanguageModel;

export function nanoSupported(): boolean {
  return typeof native()?.create === "function";
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
    const initialPrompts = messages.slice(0, -1);
    const last = messages[messages.length - 1];
    const session = await native().create({ initialPrompts, temperature: opts.temperature, topK: opts.topK, signal });
    let out = "";
    try {
      for await (const chunk of session.promptStreaming(last.content, { signal })) {
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
