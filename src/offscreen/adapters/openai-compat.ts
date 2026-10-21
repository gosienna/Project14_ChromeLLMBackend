// OpenAI Chat Completions shape: OpenAI, xAI Grok, DeepSeek, OpenRouter, and any compatible
// endpoint the user enters (Ollama, LM Studio, Mistral, Groq...).

import { LLMError } from "../../shared/errors";
import { estimateMessageTokens, estimateTokens, type Usage } from "../../shared/protocol";
import type { GenerateResult } from "../backend";
import { openAIToolFields, openAITools, ToolCallAccumulator } from "../tools/openai";
import { parseSSE } from "./sse";
import { dataUrl, guard, post, type Adapter } from "./types";

/** OpenAI reasoning models (o-series, GPT-5 and later) reject any temperature but the default. */
const OPENAI_REASONING = /^(?:o\d|gpt-(?:[5-9]|\d{2}))/;

/**
 * OpenAI itself takes `max_completion_tokens` on every model and rejects `max_tokens` on newer
 * ones. Other compatible endpoints (Ollama, older servers) may only know `max_tokens`.
 */
export function openAIParams(providerId: string, model: string, temperature: number, maxTokens?: number): Record<string, number> {
  if (providerId !== "openai") return { temperature, ...(maxTokens ? { max_tokens: maxTokens } : {}) };
  return {
    ...(OPENAI_REASONING.test(model) ? {} : { temperature }),
    ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
  };
}

export const openAICompatAdapter: Adapter = (cfg, messages, opts, signal, fetchImpl = fetch) =>
  guard(signal, (async function* (): AsyncGenerator<string, GenerateResult> {
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
        ...openAIParams(cfg.provider.id, cfg.model, opts.temperature, opts.maxTokens),
        ...(opts.tools?.length ? { tools: openAITools(opts.tools) } : {}),
        messages: messages.map((m) => ({
          role: m.role,
          content: m.images?.length
            ? [
                ...(m.content ? [{ type: "text", text: m.content }] : []),
                ...m.images.map((i) => ({ type: "image_url", image_url: { url: dataUrl(i) } })),
              ]
            : m.toolCalls?.length && !m.content ? null : m.content,
          ...openAIToolFields(m),
        })),
      },
      signal,
    );
    let usage: Usage | null = null;
    let out = "";
    const calls = new ToolCallAccumulator();
    for await (const ev of parseSSE(res.body!)) {
      if (ev.data === "[DONE]") break;
      const data = JSON.parse(ev.data);
      if (data.error) throw new LLMError("NetworkError", data.error.message ?? "Provider error");
      calls.add(data.choices?.[0]?.delta?.tool_calls);
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) {
        out += delta;
        yield delta;
      }
      if (data.usage) usage = { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 };
    }
    const result = usage ?? { inputTokens: estimateMessageTokens(messages), outputTokens: estimateTokens(out) };
    const toolCalls = calls.finish();
    return toolCalls.length ? { ...result, toolCalls } : result;
  })());
