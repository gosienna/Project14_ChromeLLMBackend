import { describe, expect, it } from "vitest";
import { fillAndSendFor, readFor } from "../src/shared/webui-drivers";
import { flattenWebUiPrompt } from "../src/shared/webui-prompt";
import { WEBUI_PROVIDERS, findWebUiProvider, isWebUiProviderId } from "../src/shared/webui-providers";
import { enabledBackendIds, DEFAULT_SETTINGS } from "../src/shared/settings";
import { streamWebUi } from "../src/offscreen/webui-backend";

describe("webui providers", () => {
  it("lists chatgpt, gemini, and claude web backends", () => {
    expect(WEBUI_PROVIDERS.map((p) => p.id)).toEqual(["chatgpt-web", "gemini-web", "claude-web"]);
    expect(isWebUiProviderId("chatgpt-web")).toBe(true);
    expect(isWebUiProviderId("openai")).toBe(false);
    expect(findWebUiProvider("gemini-web")?.hostPattern).toBe("https://gemini.google.com/*");
  });

  it("exposes a fill and read driver per provider", () => {
    for (const id of ["chatgpt-web", "gemini-web", "claude-web"] as const) {
      expect(typeof fillAndSendFor(id)).toBe("function");
      expect(typeof readFor(id)).toBe("function");
    }
  });

  it("appears in enabledBackendIds only when enabled", () => {
    const off = enabledBackendIds(DEFAULT_SETTINGS);
    expect(off).not.toContain("chatgpt-web");
    const on = enabledBackendIds({
      ...DEFAULT_SETTINGS,
      providers: {
        ...DEFAULT_SETTINGS.providers,
        "chatgpt-web": { enabled: true, model: "default", monthlyTokenCap: 1_000_000 },
      },
    });
    expect(on).toContain("chatgpt-web");
  });
});

describe("flattenWebUiPrompt", () => {
  it("labels roles and skips empty turns", () => {
    expect(
      flattenWebUiPrompt([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "  " },
      ]),
    ).toBe("System: Be brief.\n\nUser: Hi\n\nAssistant: Hello");
  });
});

describe("streamWebUi", () => {
  it("yields progressive suffixes then usage", async () => {
    const gen = streamWebUi(async (onDelta) => {
      onDelta("Hel");
      onDelta("Hello");
      return { text: "Hello", inputTokens: 2, outputTokens: 1 };
    });
    const chunks: string[] = [];
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }
    expect(chunks.join("")).toBe("Hello");
    expect(next.value).toEqual({ inputTokens: 2, outputTokens: 1 });
  });
});
