import { describe, expect, it } from "vitest";
import { gate } from "../src/background/policy";
import { anthropicAdapter } from "../src/offscreen/adapters/anthropic";
import { geminiAdapter } from "../src/offscreen/adapters/gemini";
import { openAICompatAdapter } from "../src/offscreen/adapters/openai-compat";
import type { Adapter } from "../src/offscreen/adapters/types";
import type { Backend, GenerateOptions, GenerateResult } from "../src/offscreen/backend";
import { promptedMessages, ToolCallParser } from "../src/offscreen/tools/prompted";
import { withTools } from "../src/offscreen/tools/with-tools";
import { parsePageRequest, parsePageResponse, type ChatMessage, type ToolDecl } from "../src/shared/protocol";
import { BUILTIN_PROVIDERS } from "../src/shared/providers";
import { streamOf } from "./streams";

const weather: ToolDecl = {
  name: "getWeather",
  description: "Weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const tools = [weather];

describe("tool protocol", () => {
  const create = (t: unknown) => ({ kind: "create", id: "c1", monitor: false, options: { tools: t } });
  it("accepts tool declarations at create", () => {
    expect(parsePageRequest(create([weather]))).not.toBeNull();
  });
  it("rejects bad names, duplicates, extra keys and oversized schemas", () => {
    expect(parsePageRequest(create([{ ...weather, name: "bad name" }]))).toBeNull();
    expect(parsePageRequest(create([weather, weather]))).toBeNull();
    expect(parsePageRequest(create([{ ...weather, execute: "x" }]))).toBeNull();
    expect(parsePageRequest(create([{ ...weather, inputSchema: { big: "x".repeat(70_000) } }]))).toBeNull();
    expect(parsePageRequest(create(Array.from({ length: 33 }, (_, i) => ({ ...weather, name: `t${i}` }))))).toBeNull();
  });
  it("validates tool results and tool calls", () => {
    expect(parsePageRequest({ kind: "tool-result", id: "r2", target: "r1", callId: "abc", result: "sunny", isError: false })).not.toBeNull();
    expect(parsePageRequest({ kind: "tool-result", id: "r2", target: "r1", callId: "abc", result: 5, isError: false })).toBeNull();
    expect(parsePageRequest({ kind: "tool-result", id: "r2", target: "r1", callId: "abc", result: "x" })).toBeNull();
    expect(parsePageResponse({ kind: "tool-call", id: "r1", callId: "abc", name: "getWeather", arguments: { city: "Paris" } })).not.toBeNull();
    expect(parsePageResponse({ kind: "tool-call", id: "r1", callId: "abc", name: "getWeather", arguments: "Paris" })).toBeNull();
  });
  it("never accepts tool turns from pages", () => {
    const prompt = (input: unknown) => ({ kind: "prompt", id: "p1", sessionId: "s1", stream: false, input });
    expect(parsePageRequest(prompt([{ role: "tool", content: "x" }]))).toBeNull();
    expect(parsePageRequest(prompt([{ role: "assistant", content: "", toolCalls: [] }]))).toBeNull();
  });
  it("lets tool results through the consent gate like abort", () => {
    expect(gate({ kind: "tool-result", site: undefined, permitted: false, onceGrant: false, visible: false })).toEqual({ action: "allow" });
  });
});

function parse(chunks: string[]) {
  const p = new ToolCallParser(tools);
  const shown = chunks.map((c) => p.push(c)).join("");
  const { text, toolCalls } = p.finish();
  return { text: shown + text, calls: toolCalls.map(({ name, arguments: a }) => ({ name, arguments: a })) };
}

describe("ToolCallParser", () => {
  const call = '{"name": "getWeather", "arguments": {"city": "Paris"}}';
  it("passes plain answers through", () => expect(parse(["It is ", "sunny."])).toEqual({ text: "It is sunny.", calls: [] }));
  it("parses a tagged call split across chunks", () =>
    expect(parse(["Let me check. <tool_", "call>", call.slice(0, 20), call.slice(20), "</tool_ca", "ll>"])).toEqual({
      text: "Let me check. ",
      calls: [{ name: "getWeather", arguments: { city: "Paris" } }],
    }));
  it("parses several calls and an unclosed last tag", () =>
    expect(parse([`<tool_call>${call}</tool_call>\n<tool_call>{"name":"getWeather","arguments":{"city":"Oslo"}}`]).calls).toEqual([
      { name: "getWeather", arguments: { city: "Paris" } },
      { name: "getWeather", arguments: { city: "Oslo" } },
    ]));
  it("accepts a bare JSON call with parameters (Llama style)", () =>
    expect(parse(['{"name": "getWeather", "parameters": {"city": "Rome"}}'])).toEqual({ text: "", calls: [{ name: "getWeather", arguments: { city: "Rome" } }] }));
  it("leaves unknown tools, bad JSON and ordinary JSON as text", () => {
    expect(parse(['<tool_call>{"name": "launch", "arguments": {}}</tool_call>']).calls).toEqual([]);
    expect(parse(["<tool_call>{oops</tool_call>"]).text).toBe("<tool_call>{oops</tool_call>");
    expect(parse(['{"answer": 42}'])).toEqual({ text: '{"answer": 42}', calls: [] });
  });
  it("accepts arguments given as a JSON string", () =>
    expect(parse(['<tool_call>{"name": "getWeather", "arguments": "{\\"city\\": \\"Lima\\"}"}</tool_call>']).calls).toEqual([
      { name: "getWeather", arguments: { city: "Lima" } },
    ]));
});

const history: ChatMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Weather in Paris and Oslo?" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "a", name: "getWeather", arguments: { city: "Paris" } },
      { id: "b", name: "getWeather", arguments: { city: "Oslo" } },
    ],
  },
  { role: "tool", toolCallId: "a", name: "getWeather", content: "sunny" },
  { role: "tool", toolCallId: "b", name: "getWeather", content: "snow" },
];

describe("promptedMessages", () => {
  it("adds tool instructions to the system prompt and rewrites tool turns as plain turns", () => {
    const out = promptedMessages(history, tools);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(out[0].content).toMatch(/^Be brief\.\n\nYou can call tools/);
    expect(out[0].content).toContain('"name":"getWeather"');
    expect(out[2].content).toBe('<tool_call>{"name":"getWeather","arguments":{"city":"Paris"}}</tool_call>\n<tool_call>{"name":"getWeather","arguments":{"city":"Oslo"}}</tool_call>');
    expect(out[3].content).toBe('<tool_response name="getWeather">\nsunny\n</tool_response>\n<tool_response name="getWeather">\nsnow\n</tool_response>');
    expect(history[3].content).toBe("sunny"); // input untouched
  });
  it("creates a system prompt when there is none, and none without tools", () => {
    expect(promptedMessages([{ role: "user", content: "hi" }], tools)[0].role).toBe("system");
    expect(promptedMessages([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });
});

/** A text-only backend that replies with a fixed string, recording what it was sent. */
function textBackend(reply: string) {
  const seen: Array<{ messages: ChatMessage[]; opts: GenerateOptions }> = [];
  const backend: Backend = {
    id: "local",
    kind: "local",
    describe: () => ({ name: "t", backend: "webllm" }),
    availability: async () => "available",
    prepare: async () => {},
    contextWindow: () => 4096,
    acceptsImages: () => false,
    params: () => ({ defaultTopK: 3, maxTopK: 8, defaultTemperature: 1, maxTemperature: 2 }),
    toolMode: () => "prompted",
    countTokens: async (m) => m.length,
    async *generate(messages, opts): AsyncGenerator<string, GenerateResult> {
      seen.push({ messages, opts });
      for (const c of reply.match(/.{1,7}/gs) ?? []) yield c;
      return { inputTokens: 1, outputTokens: 1 };
    },
  };
  return { backend, seen };
}

async function drain(gen: AsyncGenerator<string, GenerateResult>) {
  let text = "";
  let step = await gen.next();
  while (!step.done) {
    text += step.value;
    step = await gen.next();
  }
  return { text, result: step.value };
}

describe("withTools", () => {
  const opts = { temperature: 1, topK: 3 };
  it("gives a text-only backend tool calls through the prompt", async () => {
    const { backend, seen } = textBackend('Checking.<tool_call>{"name":"getWeather","arguments":{"city":"Paris"}}</tool_call>');
    const { text, result } = await drain(withTools(backend).generate([{ role: "user", content: "Paris?" }], { ...opts, tools }, new AbortController().signal));
    expect(text).toBe("Checking.");
    expect(result.toolCalls?.map((c) => c.arguments)).toEqual([{ city: "Paris" }]);
    expect(seen[0].opts.tools).toBeUndefined(); // the inner backend never sees native tools
    expect(seen[0].messages[0].content).toContain("You can call tools");
  });
  it("still rewrites tool history when tools are withheld", async () => {
    const { backend, seen } = textBackend("Paris is sunny.");
    const { text, result } = await drain(withTools(backend).generate(history, opts, new AbortController().signal));
    expect(text).toBe("Paris is sunny.");
    expect(result.toolCalls).toBeUndefined();
    expect(seen[0].messages.some((m) => m.role === "tool")).toBe(false);
  });
  it("leaves native backends alone", () => {
    const { backend } = textBackend("");
    const native = { ...backend, toolMode: () => "native" as const };
    expect(withTools(native)).toBe(native);
  });
});

const provider = (id: string) => BUILTIN_PROVIDERS.find((p) => p.id === id)!;
const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function callAdapter(adapter: Adapter, id: string, events: object[], messages: ChatMessage[] = [{ role: "user", content: "Paris?" }]) {
  const calls: RequestInit[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response(streamOf(sse(events)));
  }) as unknown as typeof fetch;
  const { text, result } = await drain(adapter({ provider: provider(id), model: "m", apiKey: "K" }, messages, { temperature: 0.5, topK: 3, tools }, new AbortController().signal, f));
  return { text, result, body: JSON.parse(calls[0].body as string) };
}

describe("native tool calling in cloud adapters", () => {
  it("OpenAI-compatible: sends tools, assembles streamed calls, maps tool turns", async () => {
    const { result, body } = await callAdapter(openAICompatAdapter, "openai", [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "getWeather", arguments: '{"ci' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] },
    ]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "getWeather", description: weather.description, parameters: weather.inputSchema } }]);
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "getWeather", arguments: { city: "Paris" } }]);
    const turns = (await callAdapter(openAICompatAdapter, "openai", [], history)).body.messages;
    expect(turns[2]).toMatchObject({ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "getWeather", arguments: '{"city":"Paris"}' } }, { id: "b" }] });
    expect(turns[3]).toEqual({ role: "tool", tool_call_id: "a", content: "sunny" });
  });

  it("Anthropic: sends tools, assembles tool_use blocks, groups tool results", async () => {
    const { text, result, body } = await callAdapter(anthropicAdapter, "anthropic", [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "getWeather" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } },
      { type: "content_block_stop", index: 1 },
    ]);
    expect(text).toBe("Checking.");
    expect(body.tools).toEqual([{ name: "getWeather", description: weather.description, input_schema: weather.inputSchema }]);
    expect(result.toolCalls).toEqual([{ id: "toolu_1", name: "getWeather", arguments: { city: "Paris" } }]);
    const turns = (await callAdapter(anthropicAdapter, "anthropic", [], history)).body.messages;
    expect(turns.map((t: { role: string }) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[1].content[0]).toEqual({ type: "tool_use", id: "a", name: "getWeather", input: { city: "Paris" } });
    expect(turns[2].content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "sunny" },
      { type: "tool_result", tool_use_id: "b", content: "snow" },
    ]);
  });

  it("Gemini: sends function declarations, returns calls with signatures, maps responses", async () => {
    const { result, body } = await callAdapter(geminiAdapter, "gemini", [
      { candidates: [{ content: { parts: [{ functionCall: { name: "getWeather", args: { city: "Paris" } }, thoughtSignature: "sig" }] } }] },
    ]);
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: "getWeather", description: weather.description, parametersJsonSchema: weather.inputSchema }] }]);
    expect(result.toolCalls).toMatchObject([{ name: "getWeather", arguments: { city: "Paris" }, signature: "sig" }]);
    const signed: ChatMessage[] = [history[1], { role: "assistant", content: "", toolCalls: [{ id: "a", name: "getWeather", arguments: { city: "Paris" }, signature: "sig" }] }, history[3]];
    const turns = (await callAdapter(geminiAdapter, "gemini", [], signed)).body.contents;
    expect(turns[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "getWeather", args: { city: "Paris" } }, thoughtSignature: "sig" }] });
    expect(turns[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "getWeather", response: { result: "sunny" } } }] });
  });
});
