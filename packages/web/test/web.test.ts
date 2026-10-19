import { afterEach, describe, expect, it } from "vitest";
import { createOrFallback, detect, getLanguageModel } from "../src/index";

const g = globalThis as Record<string, unknown>;

function fakeWindow() {
  const target = new EventTarget();
  const w = Object.assign(target, {}) as EventTarget & Record<string, unknown>;
  g.window = w;
  return w;
}

afterEach(() => {
  delete g.window;
});

const fakeLM = (availability = "available") => ({
  availability: async () => availability,
  create: async () => ({ prompt: async () => "ok" }),
});

describe("@local-llm/web", () => {
  it("returns null without a window or implementation", async () => {
    expect(detect()).toBeNull();
    fakeWindow();
    expect(await getLanguageModel({ timeout: 10 })).toBeNull();
  });

  it("distinguishes native from extension", () => {
    const w = fakeWindow();
    w.LanguageModel = fakeLM();
    expect(detect()).toBe("native");
    w.localLLM = { info: async () => ({ name: "m", backend: "dummy", version: "0.1.0" }) };
    expect(detect()).toBe("extension");
  });

  it("waits for the extension's ready event", async () => {
    const w = fakeWindow();
    const p = getLanguageModel({ timeout: 1000 });
    setTimeout(() => {
      w.LanguageModel = fakeLM();
      w.localLLM = { info: async () => null };
      w.dispatchEvent(new Event("localllm:ready"));
    }, 5);
    expect((await p)?.source).toBe("extension");
  });

  it("falls back when unavailable or denied", async () => {
    const w = fakeWindow();
    w.LanguageModel = fakeLM("unavailable");
    expect(await createOrFallback({ fallback: (r) => `fb:${r}`, timeout: 10 })).toBe("fb:unavailable");
    w.LanguageModel = { availability: async () => "available", create: async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); } };
    expect(await createOrFallback({ fallback: (r) => r, timeout: 10 })).toBe("NotAllowedError: no");
  });
});
