import { describe, expect, it } from "vitest";
import { parsePageRequest, parsePageResponse } from "../src/shared/protocol";

describe("parsePageRequest", () => {
  it("accepts well-formed requests", () => {
    expect(parsePageRequest({ kind: "availability", id: "r1" })).toBeTruthy();
    expect(parsePageRequest({ kind: "create", id: "r2", options: { temperature: 0.7, topK: 3, initialPrompts: [{ role: "system", content: "hi" }] }, monitor: true })).toBeTruthy();
    expect(parsePageRequest({ kind: "prompt", id: "r3", sessionId: "abc123", input: [{ role: "user", content: "x" }], stream: true })).toBeTruthy();
    expect(parsePageRequest({ kind: "abort", id: "r4", target: "r3" })).toBeTruthy();
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

describe("parsePageResponse", () => {
  it("validates response shapes", () => {
    expect(parsePageResponse({ kind: "chunk", id: "r1", text: "a" })).toBeTruthy();
    expect(parsePageResponse({ kind: "chunk", id: "r1", text: 1 })).toBeNull();
    expect(parsePageResponse({ kind: "error", id: "r1", name: "AbortError", message: "x" })).toBeTruthy();
    expect(parsePageResponse({ kind: "bogus", id: "r1" })).toBeNull();
  });
});
