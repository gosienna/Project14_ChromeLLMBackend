import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BASE64,
  MAX_IMAGES_PER_MESSAGE,
  estimateMessageTokens,
  parsePageRequest,
  parsePageResponse,
  parsePortNotice,
  type ImageInput,
} from "../src/shared/protocol";

describe("parsePageRequest", () => {
  it("accepts well-formed requests", () => {
    expect(parsePageRequest({ kind: "availability", id: "r1" })).toBeTruthy();
    expect(parsePageRequest({ kind: "create", id: "r2", options: { temperature: 0.7, topK: 3, initialPrompts: [{ role: "system", content: "hi" }] }, monitor: true })).toBeTruthy();
    expect(parsePageRequest({ kind: "prompt", id: "r3", sessionId: "abc123", input: [{ role: "user", content: "x" }], stream: true })).toBeTruthy();
    expect(parsePageRequest({ kind: "abort", id: "r4", target: "r3" })).toBeTruthy();
  });

  it("accepts models requests and a model id on create", () => {
    expect(parsePageRequest({ kind: "models", id: "r1" })).toBeTruthy();
    expect(parsePageRequest({ kind: "models", id: "r1", backend: "anthropic" })).toBeNull();
    const create = (model: unknown) => parsePageRequest({ kind: "create", id: "r1", options: { model }, monitor: false });
    expect(create("openrouter:meta/llama-3:free")).toBeTruthy();
    expect(create(5)).toBeNull();
    expect(create("")).toBeNull();
    expect(create("x".repeat(257))).toBeNull();
    expect(create("local:a\nb")).toBeNull();
  });

  it("accepts a boolean reasoning opt-in on create", () => {
    const create = (reasoning: unknown) => parsePageRequest({ kind: "create", id: "r1", options: { reasoning }, monitor: false });
    expect(create(true)).toBeTruthy();
    expect(create(false)).toBeTruthy();
    expect(create("yes")).toBeNull();
  });

  it("drops unknown kinds and extra fields", () => {
    expect(parsePageRequest({ kind: "readTabs", id: "r1" })).toBeNull();
    expect(parsePageRequest({ kind: "availability", id: "r1", origin: "https://evil.example" })).toBeNull();
    expect(parsePageRequest({ kind: "prompt", id: "r1", sessionId: "s", input: [], stream: true, apiKey: "x" })).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(parsePageRequest({ kind: "prompt", id: "r1", sessionId: "s", input: [{ role: "tool", content: "x" }], stream: true })).toBeNull();
    expect(parsePageRequest({ kind: "prompt", id: "r1", sessionId: "s", input: [{ role: "user", content: 5 }], stream: true })).toBeNull();
    expect(parsePageRequest({ kind: "create", id: "r1", options: { temperature: 99 }, monitor: false })).toBeNull();
    expect(parsePageRequest({ kind: "destroy", id: "r1", sessionId: "../x" })).toBeNull();
    expect(parsePageRequest({ kind: "availability", id: "x".repeat(100) })).toBeNull();
    expect(parsePageRequest({ kind: "prompt", id: "r1" })).toBeNull();
    expect(parsePageRequest(null)).toBeNull();
    expect(parsePageRequest("availability")).toBeNull();
  });
});

describe("search request", () => {
  const ok = { kind: "search", id: "r1", query: "weather", maxResults: 5, includeImages: false };
  it("accepts a query and result count", () => expect(parsePageRequest(ok)).toEqual(ok));
  it("rejects empty, long or extra input", () => {
    expect(parsePageRequest({ ...ok, query: "  " })).toBeNull();
    expect(parsePageRequest({ ...ok, query: "x".repeat(501) })).toBeNull();
    expect(parsePageRequest({ ...ok, maxResults: 0 })).toBeNull();
    expect(parsePageRequest({ ...ok, maxResults: 11 })).toBeNull();
    expect(parsePageRequest({ ...ok, maxResults: 2.5 })).toBeNull();
    expect(parsePageRequest({ ...ok, provider: "google" })).toBeNull();
    expect(parsePageRequest({ kind: "search", id: "r1", query: "q" })).toBeNull();
    expect(parsePageRequest({ kind: "search", id: "r1", query: "q", maxResults: 5 })).toBeNull();
    expect(parsePageRequest({ ...ok, includeImages: "yes" })).toBeNull();
  });
});

describe("fetch-image request", () => {
  const ok = { kind: "fetch-image", id: "r1", url: "https://img.example/a.jpg" };
  it("accepts an http(s) url", () => expect(parsePageRequest(ok)).toEqual(ok));
  it("rejects other schemes, long urls and extra fields", () => {
    expect(parsePageRequest({ ...ok, url: "file:///etc/passwd" })).toBeNull();
    expect(parsePageRequest({ ...ok, url: "data:image/png;base64,AA" })).toBeNull();
    expect(parsePageRequest({ ...ok, url: `https://a.example/${"x".repeat(2048)}` })).toBeNull();
    expect(parsePageRequest({ ...ok, url: "https://a.example/a b" })).toBeNull();
    expect(parsePageRequest({ ...ok, origin: "https://evil.example" })).toBeNull();
    expect(parsePageRequest({ kind: "fetch-image", id: "r1" })).toBeNull();
  });
});

describe("image input", () => {
  const img = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  const prompt = (input: unknown) => ({ kind: "prompt", id: "r1", sessionId: "s1", input, stream: true });

  it("is rejected from pages", () => {
    expect(parsePageRequest(prompt([{ role: "user", content: "x", images: [img] }]))).toBeNull();
  });

  it("is accepted from the playground on user turns", () => {
    expect(parsePageRequest(prompt([{ role: "user", content: "", images: [img] }]), { images: true })).toBeTruthy();
    expect(parsePageRequest(prompt([{ role: "assistant", content: "x", images: [img] }]), { images: true })).toBeNull();
  });

  it("validates type, encoding, size and count", () => {
    const one = (i: unknown) => parsePageRequest(prompt([{ role: "user", content: "x", images: [i] }]), { images: true });
    expect(one({ mimeType: "image/svg+xml", data: "PHN2Zz4=" })).toBeNull();
    expect(one({ mimeType: "image/png", data: "not base64!" })).toBeNull();
    expect(one({ mimeType: "image/png", data: "" })).toBeNull();
    expect(one({ ...img, url: "https://evil.example/x.png" })).toBeNull();
    expect(one({ mimeType: "image/png", data: "A".repeat(MAX_IMAGE_BASE64 + 4) })).toBeNull();
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => img);
    expect(parsePageRequest(prompt([{ role: "user", content: "x", images: many }]), { images: true })).toBeNull();
  });

  it("counts toward the token estimate", () => {
    expect(estimateMessageTokens([{ role: "user", content: "", images: [img as ImageInput] }])).toBeGreaterThanOrEqual(1000);
  });
});

describe("parsePageResponse", () => {
  it("validates response shapes", () => {
    expect(parsePageResponse({ kind: "chunk", id: "r1", text: "a" })).toBeTruthy();
    expect(parsePageResponse({ kind: "chunk", id: "r1", text: 1 })).toBeNull();
    expect(parsePageResponse({ kind: "reasoning", id: "r1", text: "hm" })).toBeTruthy();
    expect(parsePageResponse({ kind: "error", id: "r1", name: "AbortError", message: "x" })).toBeTruthy();
    expect(parsePageResponse({ kind: "bogus", id: "r1" })).toBeNull();
  });
});

describe("parsePortNotice", () => {
  it("accepts only the two notices, with no extra fields", () => {
    expect(parsePortNotice({ kind: "connected" })).toEqual({ kind: "connected" });
    expect(parsePortNotice({ kind: "closed", reason: "idle" })).toEqual({ kind: "closed", reason: "idle" });
    expect(parsePortNotice({ kind: "closed", reason: "other" })).toBeNull();
    expect(parsePortNotice({ kind: "connected", id: "r1" })).toBeNull();
    expect(parsePortNotice({ kind: "chunk", id: "r1", text: "a" })).toBeNull();
  });
});
