// Deterministic echo engine. Proves the relay chain without a model (Phase 1) and backs tests.

import { abortError } from "../../shared/errors";
import { estimateMessageTokens, estimateTokens, type ChatMessage, type Usage } from "../../shared/protocol";
import type { GenerateOptions } from "../backend";
import type { LocalEngine } from "./types";

export class DummyEngine implements LocalEngine {
  readonly id = "dummy" as const;

  async load(_m: unknown, _c: unknown, onProgress: (f: number) => void) {
    onProgress(0);
    onProgress(1);
  }

  async unload() {}

  async countTokens(messages: ChatMessage[]) {
    return estimateMessageTokens(messages);
  }

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage> {
    const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const turns = messages.filter((m) => m.role === "user").length;
    const reply = `Echo #${turns}: ${last}`;
    const words = reply.split(/(?<=\s)/);
    for (const w of words.slice(0, opts.maxTokens ?? words.length)) {
      if (signal.aborted) throw abortError();
      await new Promise((r) => setTimeout(r, 5));
      yield w;
    }
    return { inputTokens: estimateMessageTokens(messages), outputTokens: estimateTokens(reply) };
  }

  async deleteCache() {}
}
