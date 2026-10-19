// Anthropic Messages API. System prompt is a top-level field; browser-originated calls need
// the anthropic-dangerous-direct-browser-access header.

import { LLMError } from "../../shared/errors";
import { estimateMessageTokens, type Usage } from "../../shared/protocol";
import { parseSSE } from "./sse";
import { guard, post, splitSystem, type Adapter } from "./types";

export const anthropicAdapter: Adapter = (cfg, messages, opts, signal, fetchImpl = fetch) =>
  guard(signal, (async function* (): AsyncGenerator<string, Usage> {
    const { system, rest } = splitSystem(messages);
    const res = await post(
      fetchImpl,
      `${cfg.provider.baseUrl}/messages`,
      {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      {
        model: cfg.model,
        max_tokens: opts.maxTokens ?? 4096,
        stream: true,
        temperature: Math.min(opts.temperature, 1),
        ...(system ? { system } : {}),
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
      },
      signal,
    );
    const usage: Usage = { inputTokens: estimateMessageTokens(messages), outputTokens: 0 };
    for await (const ev of parseSSE(res.body!)) {
      const data = JSON.parse(ev.data);
      switch (data.type) {
        case "message_start":
          usage.inputTokens = data.message?.usage?.input_tokens ?? usage.inputTokens;
          break;
        case "content_block_delta":
          if (data.delta?.type === "text_delta" && data.delta.text) yield data.delta.text;
          break;
        case "message_delta":
          usage.outputTokens = data.usage?.output_tokens ?? usage.outputTokens;
          break;
        case "error":
          throw new LLMError(data.error?.type === "overloaded_error" ? "QuotaExceededError" : "NetworkError", data.error?.message ?? "Anthropic error");
      }
    }
    return usage;
  })());
