import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "../src/offscreen/adapters/anthropic";
import { geminiAdapter } from "../src/offscreen/adapters/gemini";
import { openAICompatAdapter } from "../src/offscreen/adapters/openai-compat";
import type { Adapter } from "../src/offscreen/adapters/types";
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

async function run(adapter: Adapter, id: string, f: typeof fetch, signal = new AbortController().signal) {
  const gen = adapter({ provider: provider(id), model: "m", apiKey: "KEY" }, [{ role: "system", content: "S" }, { role: "user", content: "hi" }], { temperature: 0.5, topK: 3 }, signal, f);
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
