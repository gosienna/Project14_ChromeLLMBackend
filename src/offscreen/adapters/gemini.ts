// Google Gemini streamGenerateContent. Roles are "user" / "model"; system prompt goes in
// systemInstruction.

import { cappedOutputTokens } from "../../shared/cloud-models";
import { LLMError } from "../../shared/errors";
import { estimateMessageTokens, randomId, type ChatMessage, type ToolCall, type Usage } from "../../shared/protocol";
import type { GenerateResult } from "../backend";
import { parseSSE } from "./sse";
import { guard, post, splitSystem, type Adapter } from "./types";

type Part = Record<string, unknown>;

/** Gemini turns. Calls go back with their thought signature; results of one round share a user turn. */
function geminiContents(messages: ChatMessage[]): Array<{ role: string; parts: Part[] }> {
  const out: Array<{ role: string; parts: Part[] }> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const part = { functionResponse: { name: m.name, response: { result: m.content } } };
      const prev = out.at(-1);
      if (prev?.role === "user" && prev.parts[0]?.functionResponse) prev.parts.push(part);
      else out.push({ role: "user", parts: [part] });
    } else if (m.toolCalls?.length) {
      out.push({
        role: "model",
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.arguments }, ...(c.signature ? { thoughtSignature: c.signature } : {}) })),
        ],
      });
    } else {
      out.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          ...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })),
          ...(m.content || !m.images?.length ? [{ text: m.content }] : []),
        ],
      });
    }
  }
  return out;
}

export const geminiAdapter: Adapter = (cfg, messages, opts, signal, fetchImpl = fetch) =>
  guard(signal, (async function* (): AsyncGenerator<string, GenerateResult> {
    const { system, rest } = splitSystem(messages);
    const res = await post(
      fetchImpl,
      `${cfg.provider.baseUrl}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`,
      { "x-goog-api-key": cfg.apiKey },
      {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: geminiContents(rest),
        // parametersJsonSchema takes full JSON Schema, unlike the OpenAPI-subset `parameters`.
        ...(opts.tools?.length
          ? { tools: [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }] }
          : {}),
        generationConfig: {
          temperature: opts.temperature,
          topK: opts.topK,
          // A single streamGenerateContent call rejects maxOutputTokens above 65536.
          ...(opts.maxTokens ? { maxOutputTokens: cappedOutputTokens("gemini", cfg.model, opts.maxTokens, opts.maxTokens) } : {}),
        },
      },
      signal,
    );
    const usage: Usage = { inputTokens: estimateMessageTokens(messages), outputTokens: 0 };
    const toolCalls: ToolCall[] = [];
    for await (const ev of parseSSE(res.body!)) {
      const data = JSON.parse(ev.data);
      if (data.error) throw new LLMError("NetworkError", data.error.message ?? "Gemini error");
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === "string" && p.text && !p.thought) yield p.text;
        // Gemini calls carry no id; the signature must be sent back with the call.
        if (p.functionCall?.name) {
          toolCalls.push({ id: randomId(), name: p.functionCall.name, arguments: p.functionCall.args ?? {}, ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}) });
        }
      }
      if (data.usageMetadata) {
        usage.inputTokens = data.usageMetadata.promptTokenCount ?? usage.inputTokens;
        usage.outputTokens = data.usageMetadata.candidatesTokenCount ?? usage.outputTokens;
      }
      if (data.promptFeedback?.blockReason) throw new LLMError("NotAllowedError", `Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
    }
    return toolCalls.length ? { ...usage, toolCalls } : usage;
  })());
