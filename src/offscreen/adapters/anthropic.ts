// Anthropic Messages API. System prompt is a top-level field; browser-originated calls need
// the anthropic-dangerous-direct-browser-access header.

import { LLMError } from "../../shared/errors";
import { estimateMessageTokens, type ChatMessage, type ToolCall, type Usage } from "../../shared/protocol";
import type { GenerateResult } from "../backend";
import { parseArgs } from "../tools/openai";
import { parseSSE } from "./sse";
import { guard, post, splitSystem, type Adapter } from "./types";

type Block = Record<string, unknown>;

/** Anthropic turns. Tool results of one round go together in a user turn of tool_result blocks. */
function anthropicMessages(messages: ChatMessage[]): Array<{ role: string; content: string | Block[] }> {
  const out: Array<{ role: string; content: string | Block[] }> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const prev = out.at(-1);
      if (prev?.role === "user" && Array.isArray(prev.content) && prev.content[0]?.type === "tool_result") prev.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments })),
        ],
      });
    } else {
      out.push({
        role: m.role,
        // Images go before the text, as Anthropic recommends; empty text blocks are rejected.
        content: m.images?.length
          ? [
              ...m.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } })),
              ...(m.content ? [{ type: "text", text: m.content }] : []),
            ]
          : m.content,
      });
    }
  }
  return out;
}

export const anthropicAdapter: Adapter = (cfg, messages, opts, signal, fetchImpl = fetch) =>
  guard(signal, (async function* (): AsyncGenerator<string, GenerateResult> {
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
        ...(opts.tools?.length ? { tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
        messages: anthropicMessages(rest),
      },
      signal,
    );
    const usage: Usage = { inputTokens: estimateMessageTokens(messages), outputTokens: 0 };
    // tool_use blocks by content index; their input arrives as partial JSON.
    const tools = new Map<number, { id: string; name: string; json: string }>();
    for await (const ev of parseSSE(res.body!)) {
      const data = JSON.parse(ev.data);
      switch (data.type) {
        case "message_start":
          usage.inputTokens = data.message?.usage?.input_tokens ?? usage.inputTokens;
          break;
        case "content_block_start":
          if (data.content_block?.type === "tool_use") tools.set(data.index, { id: data.content_block.id, name: data.content_block.name, json: "" });
          break;
        case "content_block_delta":
          if (data.delta?.type === "text_delta" && data.delta.text) yield data.delta.text;
          if (data.delta?.type === "input_json_delta") {
            const t = tools.get(data.index);
            if (t) t.json += data.delta.partial_json ?? "";
          }
          break;
        case "message_delta":
          usage.outputTokens = data.usage?.output_tokens ?? usage.outputTokens;
          break;
        case "error":
          throw new LLMError(data.error?.type === "overloaded_error" ? "QuotaExceededError" : "NetworkError", data.error?.message ?? "Anthropic error");
      }
    }
    const toolCalls: ToolCall[] = [...tools.entries()].sort(([a], [b]) => a - b).map(([, t]) => ({ id: t.id, name: t.name, arguments: parseArgs(t.json) }));
    return toolCalls.length ? { ...usage, toolCalls } : usage;
  })());
