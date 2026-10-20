// Prompted tool calling, for backends without a native tool API (WebLLM, Transformers.js,
// Chrome's built-in model, GGUFs whose template has no tool support). Tools are described in the
// system prompt and the model replies <tool_call>{"name", "arguments"}</tool_call>, the
// Qwen/Hermes convention many small models were trained on; a reply that is only a JSON object
// {"name", "arguments" | "parameters"} also counts (Llama style). Results go back as
// <tool_response> user turns, so any chat template only ever sees system, user and assistant.

import { randomId, type ChatMessage, type ToolCall, type ToolDecl } from "../../shared/protocol";
import { partialTag } from "../engines/think-splitter";

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

export function toolInstructions(tools: ToolDecl[]): string {
  const list = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
  return [
    "You can call tools to help answer. To call a tool, reply with only:",
    `${OPEN}{"name": "<tool name>", "arguments": {<arguments as JSON>}}${CLOSE}`,
    "Use one tag per call; you may make several calls. Results come back in <tool_response> tags. Once you have what you need, answer normally, without tags.",
    "Available tools:",
    JSON.stringify(list),
  ].join("\n");
}

const callText = (c: ToolCall) => `${OPEN}${JSON.stringify({ name: c.name, arguments: c.arguments })}${CLOSE}`;

/** The conversation as plain system/user/assistant turns, with tool instructions when `tools` is set. */
export function promptedMessages(messages: ChatMessage[], tools?: ToolDecl[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const response = `<tool_response name="${m.name ?? ""}">\n${m.content}\n</tool_response>`;
      const prev = out.at(-1);
      // Results of one round share a user turn, so templates that require alternating roles accept them.
      if (prev?.role === "user" && prev.content.startsWith("<tool_response")) out[out.length - 1] = { ...prev, content: `${prev.content}\n${response}` };
      else out.push({ role: "user", content: response });
    } else if (m.toolCalls?.length) {
      out.push({ role: m.role, content: [m.content, ...m.toolCalls.map(callText)].filter(Boolean).join("\n") });
    } else {
      out.push(m);
    }
  }
  if (tools?.length) {
    const instructions = toolInstructions(tools);
    if (out[0]?.role === "system") out[0] = { ...out[0], content: `${out[0].content}\n\n${instructions}` };
    else out.unshift({ role: "system", content: instructions });
  }
  return out;
}

/** A call parsed from model text, or null if it isn't a well-formed call to an offered tool. */
function parseCall(text: string, tools: ToolDecl[]): ToolCall | null {
  let v: unknown;
  try {
    v = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { name, arguments: a, parameters: p } = v as Record<string, unknown>;
  if (typeof name !== "string" || !tools.some((t) => t.name === name)) return null;
  let args = a ?? p ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return { id: randomId(), name, arguments: args as Record<string, unknown> };
}

/**
 * Streams a reply, passing answer text through and collecting tool calls. A possible partial
 * <tool_call> tag at the end of a chunk is held back; a reply that starts with "{" is held whole,
 * since it may be a bare JSON call. Malformed calls are returned as text.
 */
export class ToolCallParser {
  private mode: "undecided" | "tags" | "json" = "undecided";
  private lead = "";
  private json = "";
  private held = "";
  private inCall = false;
  private call = "";
  private calls: ToolCall[] = [];

  constructor(private tools: ToolDecl[]) {}

  /** Answer text to show now. */
  push(text: string): string {
    if (this.mode === "undecided") {
      this.lead += text;
      const start = this.lead.trimStart();
      if (!start) return "";
      this.mode = start.startsWith("{") ? "json" : "tags";
      text = this.lead;
      this.lead = "";
    }
    if (this.mode === "json") {
      this.json += text;
      return "";
    }
    return this.scan(text);
  }

  /** Remaining answer text, and the calls the reply made. */
  finish(): { text: string; toolCalls: ToolCall[] } {
    let text = this.lead;
    if (this.mode === "json") {
      const call = parseCall(this.json, this.tools);
      if (call) this.calls.push(call);
      else text += this.json;
    } else if (this.inCall) {
      // Models often stop right after the JSON without closing the tag.
      const call = parseCall(this.call + this.held, this.tools);
      if (call) this.calls.push(call);
      else text += OPEN + this.call + this.held;
    } else {
      text += this.held;
    }
    this.held = this.call = this.json = this.lead = "";
    return { text, toolCalls: this.calls };
  }

  private scan(text: string): string {
    let buf = this.held + text;
    this.held = "";
    let out = "";
    while (buf) {
      const tag = this.inCall ? CLOSE : OPEN;
      const i = buf.indexOf(tag);
      const end = i >= 0 ? i : buf.length - partialTag(buf, tag);
      if (this.inCall) this.call += buf.slice(0, end);
      else out += buf.slice(0, end);
      if (i < 0) {
        this.held = buf.slice(end);
        break;
      }
      if (this.inCall) {
        const call = parseCall(this.call, this.tools);
        if (call) this.calls.push(call);
        else out += OPEN + this.call + CLOSE;
        this.call = "";
      }
      this.inCall = !this.inCall;
      buf = buf.slice(i + tag.length);
    }
    return out;
  }
}
