// The playground's pending request as editable JSON (Project05's Dialogue "Edit JSON"): what the
// next Send passes to the backend, before engine- or provider-specific formatting (the Raw view of
// each reply shows that exact payload). An applied edit replaces the conversation for that Send.

import { MAX_TOOLS, TOOL_NAME, type ChatMessage, type ToolDecl } from "../../shared/protocol";

export interface Payload {
  messages: ChatMessage[];
  tools?: ToolDecl[];
}

export function serializePayload(p: Payload): string {
  return JSON.stringify({ messages: p.messages, ...(p.tools?.length ? { tools: p.tools } : {}) }, null, 2);
}

/**
 * Parse an edited payload. Messages are system/user/assistant text turns (a system prompt only
 * first), ending with the user turn to send; tools must name tools in the registry.
 */
export function parsePayload(text: string, knownTools: Set<string>): { payload: Payload } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "The root must be a JSON object" };
  const { messages, tools, ...rest } = v as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) return { error: `Unknown field: ${extra[0]} (use messages and tools)` };
  if (!Array.isArray(messages) || !messages.length) return { error: "messages must be a non-empty array" };
  const out: ChatMessage[] = [];
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== "object") return { error: `messages[${i}] must be an object` };
    const { role, content } = m as Record<string, unknown>;
    if (role !== "system" && role !== "user" && role !== "assistant") return { error: `messages[${i}].role must be system, user or assistant` };
    if (typeof content !== "string") return { error: `messages[${i}].content must be a string` };
    if (role === "system" && i > 0) return { error: "A system message may only come first" };
    out.push({ role, content });
  }
  if (out.at(-1)!.role !== "user") return { error: "The last message must be the user turn to send" };
  if (tools === undefined) return { payload: { messages: out } };
  if (!Array.isArray(tools)) return { error: "tools must be an array" };
  if (tools.length > MAX_TOOLS) return { error: `At most ${MAX_TOOLS} tools` };
  const decls: ToolDecl[] = [];
  for (const [i, t] of tools.entries()) {
    const { name, description, inputSchema } = (t ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) return { error: `tools[${i}].name is not a valid tool name` };
    if (!knownTools.has(name)) return { error: `tools[${i}]: no tool named "${name}" in the registry (add it in the Tools panel)` };
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return { error: `tools[${i}].inputSchema must be an object` };
    decls.push({ name, description: String(description ?? ""), inputSchema: inputSchema as Record<string, unknown> });
  }
  return { payload: { messages: out, tools: decls } };
}
