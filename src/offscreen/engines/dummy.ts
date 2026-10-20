// Deterministic echo engine. Proves the relay chain without a model (Phase 1) and backs tests.

import { abortError } from "../../shared/errors";
import { estimateMessageTokens, estimateTokens, randomId, type ChatMessage } from "../../shared/protocol";
import type { GenerateOptions, GenerateResult } from "../backend";
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

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, GenerateResult> {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const turns = messages.filter((m) => m.role === "user").length;
    const usage = () => ({ inputTokens: estimateMessageTokens(messages), outputTokens: 1 });
    opts.onTrace?.({ engine: this.id, request: { messages, ...(opts.tools?.length ? { tools: opts.tools } : {}) } });
    // "/tool <name> <json args>" stands in for a model calling a tool it was offered.
    const ask = messages.at(-1) === last ? last?.content.match(/^\/tool (\S+) (.*)$/s) : null;
    if (ask && opts.tools?.some((t) => t.name === ask[1])) {
      return { ...usage(), toolCalls: [{ id: randomId(), name: ask[1], arguments: JSON.parse(ask[2]) }] };
    }
    const tool = messages.at(-1)?.role === "tool" ? messages.at(-1) : undefined;
    const images = last?.images?.length ? ` [${last.images.map((i) => i.mimeType).join(", ")}]` : "";
    const reply = tool ? `Tool ${tool.name} said: ${tool.content}` : `Echo #${turns}: ${last?.content ?? ""}${images}`;
    // "/think …" stands in for a reasoning model, to test the reasoning path end to end.
    if (last?.content.startsWith("/think") && opts.reasoning !== false) opts.onReasoning?.(`Thinking about: ${last.content}`);
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
