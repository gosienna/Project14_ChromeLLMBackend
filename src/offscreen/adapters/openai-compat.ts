// OpenAI Chat Completions shape: OpenAI, xAI Grok, DeepSeek, OpenRouter, and any compatible
// endpoint the user enters (Ollama, LM Studio, Mistral, Groq...).

import { LLMError } from "../../shared/errors";
import { estimateMessageTokens, estimateTokens, type Usage } from "../../shared/protocol";
import { parseSSE } from "./sse";
import { guard, post, type Adapter } from "./types";

export const openAICompatAdapter: Adapter = (cfg, messages, opts, signal, fetchImpl = fetch) =>
  guard(signal, (async function* (): AsyncGenerator<string, Usage> {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.provider.id === "openrouter") headers["X-Title"] = "Local LLM Extension";
    const res = await post(
      fetchImpl,
      `${cfg.provider.baseUrl}/chat/completions`,
      headers,
      {
        model: cfg.model,
        stream: true,
        stream_options: { include_usage: true },
        temperature: opts.temperature,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        messages,
      },
      signal,
    );
    let usage: Usage | null = null;
    let out = "";
    for await (const ev of parseSSE(res.body!)) {
      if (ev.data === "[DONE]") break;
      const data = JSON.parse(ev.data);
      if (data.error) throw new LLMError("NetworkError", data.error.message ?? "Provider error");
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) {
        out += delta;
        yield delta;
      }
      if (data.usage) usage = { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 };
    }
    return usage ?? { inputTokens: estimateMessageTokens(messages), outputTokens: estimateTokens(out) };
  })());
