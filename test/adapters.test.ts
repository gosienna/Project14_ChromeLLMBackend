import { describe, expect, it } from "vitest";
import { anthropicAdapter, takesTemperature } from "../src/offscreen/adapters/anthropic";
import { geminiAdapter } from "../src/offscreen/adapters/gemini";
import { openAICompatAdapter, openAIParams } from "../src/offscreen/adapters/openai-compat";
import type { Adapter } from "../src/offscreen/adapters/types";
import type { ChatMessage } from "../src/shared/protocol";
import { BUILTIN_PROVIDERS } from "../src/shared/providers";
import { streamOf } from "./streams";

const provider = (id: string) => BUILTIN_PROVIDERS.find((p) => p.id === id)!;
const sse = (events: object[], done = false) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");

function mockFetch(body: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 200 ? streamOf(body) : body, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const IMG = { mimeType: "image/png", data: "iVBORw0KGgo=" } as const;
const withImage: ChatMessage[] = [{ role: "user", content: "what is this", images: [IMG] }, { role: "assistant", content: "a cat" }, { role: "user", content: "", images: [IMG] }];

async function run(adapter: Adapter, id: string, f: typeof fetch, signal = new AbortController().signal, messages: ChatMessage[] = [{ role: "system", content: "S" }, { role: "user", content: "hi" }]) {
  const gen = adapter({ provider: provider(id), model: "m", apiKey: "KEY" }, messages, { temperature: 0.5, topK: 3 }, signal, f);
  const chunks: string[] = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return { text: chunks.join(""), usage: step.value };
}

describe("anthropicAdapter", () => {
  it("maps system prompt, headers and SSE events", async () => {
    const { f, calls } = mockFetch(sse([
      { type: "message_start", message: { usage: { input_tokens: 12 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
      { type: "message_delta", usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]));
    const r = await run(anthropicAdapter, "anthropic", f);
    expect(r).toEqual({ text: "Hello", usage: { inputTokens: 12, outputTokens: 2 } });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("KEY");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.system).toBe("S");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps HTTP errors to Prompt API error names", async () => {
    const { f } = mockFetch("bad key", 401);
    await expect(run(anthropicAdapter, "anthropic", f)).rejects.toMatchObject({ name: "NotAllowedError" });
    const { f: f2 } = mockFetch("slow down", 429);
    await expect(run(anthropicAdapter, "anthropic", f2)).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("sends temperature only to models that still take it", async () => {
    for (const id of ["claude-3-5-sonnet-20241022", "claude-opus-4-20250514", "claude-opus-4-1-20250805", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(takesTemperature(id), id).toBe(true);
    }
    for (const id of ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "m"]) {
      expect(takesTemperature(id), id).toBe(false);
    }
    const { f, calls } = mockFetch(sse([{ type: "message_stop" }]));
    await run(anthropicAdapter, "anthropic", f);
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty("temperature");
  });
});

describe("openAICompatAdapter", () => {
  it("streams deltas and reads usage", async () => {
    const { f, calls } = mockFetch(sse([
      { choices: [{ delta: { content: "A" } }] },
      { choices: [{ delta: { content: "B" } }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
    ], true));
    const r = await run(openAICompatAdapter, "xai", f);
    expect(r).toEqual({ text: "AB", usage: { inputTokens: 7, outputTokens: 2 } });
    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer KEY");
  });

  it("surfaces aborts as AbortError", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = (async (_u: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(run(openAICompatAdapter, "openai", f, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses max_completion_tokens on OpenAI and drops temperature for its reasoning models", () => {
    expect(openAIParams("openai", "gpt-6-luna", 0.5, 100)).toEqual({ max_completion_tokens: 100 });
    expect(openAIParams("openai", "gpt-5.4-mini", 0.5, 100)).toEqual({ max_completion_tokens: 100 });
    expect(openAIParams("openai", "o4-mini", 0.5)).toEqual({});
    expect(openAIParams("openai", "gpt-4.1-mini", 0.5, 100)).toEqual({ temperature: 0.5, max_completion_tokens: 100 });
    // Other compatible endpoints keep the classic fields.
    expect(openAIParams("xai", "grok-4.3", 0.5, 100)).toEqual({ temperature: 0.5, max_tokens: 100 });
    expect(openAIParams("custom-ollama", "gpt-oss", 0.5, 100)).toEqual({ temperature: 0.5, max_tokens: 100 });
  });
});

describe("geminiAdapter", () => {
  it("maps roles and system instruction", async () => {
    const { f, calls } = mockFetch(sse([
      { candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
      { candidates: [{ content: { parts: [{ text: "!" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } },
    ]));
    const r = await run(geminiAdapter, "gemini", f);
    expect(r).toEqual({ text: "Hi!", usage: { inputTokens: 4, outputTokens: 2 } });
    expect(calls[0].url).toContain("/models/m:streamGenerateContent?alt=sse");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("S");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });
});

describe("image input", () => {
  const body = (calls: Array<{ init: RequestInit }>) => JSON.parse(calls[0].init.body as string);

  it("anthropic: base64 image blocks before the text, no empty text block", async () => {
    const { f, calls } = mockFetch(sse([{ type: "message_stop" }]));
    await run(anthropicAdapter, "anthropic", f, undefined, withImage);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: IMG.data } };
    expect(body(calls).messages).toEqual([
      { role: "user", content: [image, { type: "text", text: "what is this" }] },
      { role: "assistant", content: "a cat" },
      { role: "user", content: [image] },
    ]);
  });

  it("openai-compat: data URL image parts, and no extra fields leak into messages", async () => {
    const { f, calls } = mockFetch(sse([], true));
    await run(openAICompatAdapter, "openai", f, undefined, withImage);
    const image = { type: "image_url", image_url: { url: `data:image/png;base64,${IMG.data}` } };
    expect(body(calls).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "what is this" }, image] },
      { role: "assistant", content: "a cat" },
      { role: "user", content: [image] },
    ]);
  });

  it("gemini: inlineData parts", async () => {
    const { f, calls } = mockFetch(sse([]));
    await run(geminiAdapter, "gemini", f, undefined, withImage);
    const image = { inlineData: { mimeType: "image/png", data: IMG.data } };
    expect(body(calls).contents).toEqual([
      { role: "user", parts: [image, { text: "what is this" }] },
      { role: "model", parts: [{ text: "a cat" }] },
      { role: "user", parts: [image] },
    ]);
  });
});
