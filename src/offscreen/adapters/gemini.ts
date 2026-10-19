// Google Gemini streamGenerateContent. Roles are "user" / "model"; system prompt goes in
// systemInstruction.

import { LLMError } from "../../shared/errors";
import { estimateMessageTokens, type Usage } from "../../shared/protocol";
import { parseSSE } from "./sse";
import { guard, post, splitSystem, type Adapter } from "./types";

export const geminiAdapter: Adapter = (cfg, messages, opts, signal, fetchImpl = fetch) =>
  guard(signal, (async function* (): AsyncGenerator<string, Usage> {
    const { system, rest } = splitSystem(messages);
    const res = await post(
      fetchImpl,
      `${cfg.provider.baseUrl}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`,
      { "x-goog-api-key": cfg.apiKey },
      {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: rest.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: {
          temperature: opts.temperature,
          topK: opts.topK,
          ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
        },
      },
      signal,
    );
    const usage: Usage = { inputTokens: estimateMessageTokens(messages), outputTokens: 0 };
    for await (const ev of parseSSE(res.body!)) {
      const data = JSON.parse(ev.data);
      if (data.error) throw new LLMError("NetworkError", data.error.message ?? "Gemini error");
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) if (typeof p.text === "string" && p.text && !p.thought) yield p.text;
      if (data.usageMetadata) {
        usage.inputTokens = data.usageMetadata.promptTokenCount ?? usage.inputTokens;
        usage.outputTokens = data.usageMetadata.candidatesTokenCount ?? usage.outputTokens;
      }
      if (data.promptFeedback?.blockReason) throw new LLMError("NotAllowedError", `Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
    }
    return usage;
  })());
