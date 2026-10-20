// OpenAI Chat Completions tool shapes, shared by the OpenAI-compatible adapter and wllama
// (llama.cpp's chat API follows OpenAI's).

import { randomId, type ChatMessage, type ToolCall, type ToolDecl } from "../../shared/protocol";

export const openAITools = (tools: ToolDecl[]) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

/** The tool parts of a history turn; spread into the provider's message object. */
export function openAIToolFields(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.toolCalls?.length) {
    return {
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
    };
  }
  return {};
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Assembles streamed `delta.tool_calls` fragments, which arrive keyed by index. */
export class ToolCallAccumulator {
  private parts = new Map<number, { id: string; name: string; args: string }>();

  add(deltas: ToolCallDelta[] | undefined) {
    for (const d of deltas ?? []) {
      const i = d.index ?? 0;
      const p = this.parts.get(i) ?? { id: "", name: "", args: "" };
      if (d.id) p.id = d.id;
      if (d.function?.name) p.name += d.function.name;
      if (d.function?.arguments) p.args += d.function.arguments;
      this.parts.set(i, p);
    }
  }

  finish(): ToolCall[] {
    return [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, p]) => p.name)
      .map(([, p]) => ({ id: p.id || randomId(), name: p.name, arguments: parseArgs(p.args) }));
  }
}

/** Tool arguments as an object; malformed JSON becomes an empty object rather than failing the turn. */
export function parseArgs(json: string): Record<string, unknown> {
  try {
    const v = json.trim() ? JSON.parse(json) : {};
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
