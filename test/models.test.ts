import { describe, expect, it } from "vitest";
import { listModels, parseModelId, type ModelListInput } from "../src/background/models";
import type { DeviceCaps } from "../src/shared/catalog";
import { BUILTIN_PROVIDERS, customProvider } from "../src/shared/providers";
import { DEFAULT_SETTINGS, defaultSite, effectiveMaxContext, effectiveMaxOutput, type Settings, type SiteConfig } from "../src/shared/settings";

const GPU: DeviceCaps = { webgpu: true, maxBufferMB: 1024, jspi: true, mem64: true };
const CPU: DeviceCaps = { webgpu: false, maxBufferMB: 0, jspi: true, mem64: true };
const anthropic = BUILTIN_PROVIDERS.find((p) => p.id === "anthropic")!;
const openai = BUILTIN_PROVIDERS.find((p) => p.id === "openai")!;

const settings = (patch: Partial<Settings> = {}): Settings => structuredClone({ ...DEFAULT_SETTINGS, ...patch });
const site = (patch: Partial<SiteConfig> = {}): SiteConfig => ({ ...defaultSite("https://app.example.com"), ...patch });

function input(patch: Partial<ModelListInput> = {}): ModelListInput {
  return {
    settings: settings(),
    site: site(),
    host: { caps: GPU, downloaded: [], nano: false },
    providers: [],
    ...patch,
  };
}

const ids = (i: ModelListInput) => listModels(i).map((m) => m.id);

describe("local models", () => {
  it("lists only downloaded builds", () => {
    expect(ids(input())).toEqual([]);
    const list = listModels(input({ host: { caps: GPU, downloaded: ["webllm:qwen2.5-0.5b-instruct", "wllama:qwen3-0.6b"], nano: false } }));
    expect(list.map((m) => m.id)).toEqual(["local:qwen2.5-0.5b-instruct", "local:qwen3-0.6b"]);
    const qwen = list[0];
    expect(qwen).toMatchObject({ backend: "local", provider: "Local", engine: "webllm", default: true, input: ["text"], output: ["text"], price: { input: 0, output: 0 } });
    expect(qwen.sizeMB).toBeGreaterThan(0);
    expect(list[1]).toMatchObject({ engine: "wllama", default: false, reasoning: "hybrid", tools: "native" });
  });

  it("drops builds this device can't run", () => {
    expect(ids(input({ host: { caps: CPU, downloaded: ["webllm:qwen2.5-0.5b-instruct"], nano: false } }))).toEqual([]);
  });

  it("uses another downloaded build when the resolved one isn't there, without marking it default", () => {
    const [m] = listModels(input({ host: { caps: GPU, downloaded: ["wllama:qwen2.5-0.5b-instruct"], nano: false } }));
    expect(m).toMatchObject({ engine: "wllama", default: false });
  });

  it("follows the engine pin", () => {
    const s = settings();
    s.local.enginePin["qwen2.5-0.5b-instruct"] = "wllama";
    const [m] = listModels(input({ settings: s, host: { caps: GPU, downloaded: ["webllm:qwen2.5-0.5b-instruct", "wllama:qwen2.5-0.5b-instruct"], nano: false } }));
    expect(m).toMatchObject({ engine: "wllama", default: true });
  });

  it("needs Chrome's model for Nano", () => {
    const downloaded = ["nano:chrome-nano"];
    expect(ids(input({ host: { caps: GPU, downloaded, nano: false } }))).toEqual([]);
    expect(ids(input({ host: { caps: GPU, downloaded, nano: true } }))).toEqual(["local:chrome-nano"]);
  });

  it("lists the echo engine only when it is the configured model", () => {
    const s = settings();
    s.local.modelId = "echo-test";
    expect(listModels(input({ settings: s }))).toMatchObject([{ id: "local:echo-test", engine: "dummy", default: true }]);
    expect(ids(input())).not.toContain("local:echo-test");
  });

  it("caps context and output by the user's limits", () => {
    const s = settings();
    s.limits = { ...s.limits, maxContext: 4096, maxOutputTokens: 1000 };
    const [m] = listModels(input({ settings: s, host: { caps: GPU, downloaded: ["wllama:qwen3-0.6b"], nano: false } }));
    expect(m).toMatchObject({ contextWindow: 40960, inputQuota: 4096, maxOutputTokens: 1000 });
  });

  it("lists nothing local when the site may not use local or the host is unreachable", () => {
    const host = { caps: GPU, downloaded: ["wllama:qwen3-0.6b"], nano: false };
    expect(ids(input({ host, site: site({ allowedBackends: ["anthropic"], backend: "anthropic" }) }))).toEqual([]);
    expect(ids(input({ host: null }))).toEqual([]);
  });
});

describe("cloud models", () => {
  const cloudSite = site({ allowedBackends: ["local", "anthropic"], backend: "anthropic" });

  it("lists the curated models of runnable providers allowed for the site", () => {
    const list = listModels(input({ site: cloudSite, providers: [anthropic] }));
    expect(list[0]).toMatchObject({ id: "anthropic:claude-haiku-5-5", provider: "Anthropic", default: true, input: ["text", "image", "pdf"], contextWindow: 1_000_000 });
    expect(list[0].price).toMatchObject({ input: 0.1, output: 0.5, asOf: expect.any(String) });
    expect(list.filter((m) => m.default)).toHaveLength(1);
    expect(list.find((m) => m.id === "anthropic:claude-haiku-4-5")?.legacy).toBe(true);
  });

  it("leaves out providers that aren't allowed for the site", () => {
    expect(ids(input({ site: cloudSite, providers: [anthropic, openai] })).some((id) => id.startsWith("openai:"))).toBe(false);
  });

  it("adds a configured model outside the curated list with defaults", () => {
    const custom = customProvider("custom-x", "Ollama", "http://localhost:11434/v1", "llama3.2:latest");
    const list = listModels(input({ site: site({ allowedBackends: ["custom-x"], backend: "custom-x" }), providers: [custom] }));
    expect(list).toMatchObject([{ id: "custom-x:llama3.2:latest", name: "llama3.2:latest", default: true, contextWindow: 128_000, tools: "native", price: null }]);
  });

  it("caps output by the model's own limit and the user's", () => {
    const m = listModels(input({ site: cloudSite, providers: [anthropic] })).find((x) => x.id === "anthropic:claude-haiku-5-5")!;
    expect(m).toMatchObject({ inputQuota: DEFAULT_SETTINGS.limits.maxContext, maxOutputTokens: Math.min(DEFAULT_SETTINGS.limits.maxOutputTokens, DEFAULT_SETTINGS.limits.maxContext) });
  });

  it("uses the model window when context is unlimited", () => {
    const s = settings();
    s.limits = { ...s.limits, maxContextUnlimited: true };
    const local = listModels(input({ settings: s, host: { caps: GPU, downloaded: ["wllama:qwen3-0.6b"], nano: false } }))[0];
    expect(local).toMatchObject({ contextWindow: 40960, inputQuota: 40960 });
    const cloud = listModels(input({ settings: s, site: cloudSite, providers: [anthropic] })).find((x) => x.id === "anthropic:claude-haiku-5-5")!;
    expect(cloud.inputQuota).toBe(cloud.contextWindow);
  });

  it("lets a reply use the context left when output is unlimited", () => {
    const s = settings();
    s.limits = { ...s.limits, maxContext: 4096, maxOutputUnlimited: true };
    const local = listModels(input({ settings: s, host: { caps: GPU, downloaded: ["wllama:qwen3-0.6b"], nano: false } }))[0];
    expect(local).toMatchObject({ inputQuota: 4096, maxOutputTokens: 4096 });
    const cloud = listModels(input({ settings: s, site: cloudSite, providers: [anthropic] })).find((x) => x.id === "anthropic:claude-haiku-5-5")!;
    expect(cloud.maxOutputTokens).toBe(4096);
  });

  it("keeps an unlimited cap finite across JSON messaging", () => {
    const limits = { ...DEFAULT_SETTINGS.limits, maxContextUnlimited: true, maxOutputUnlimited: true };
    const wire = JSON.parse(JSON.stringify({ maxContext: effectiveMaxContext(limits), maxOutputTokens: effectiveMaxOutput(limits) })) as {
      maxContext: number;
      maxOutputTokens: number;
    };
    expect(wire.maxContext).toBeGreaterThan(131072);
    expect(Math.min(131072, wire.maxContext)).toBe(131072);
    expect(Math.min(wire.maxOutputTokens, 5000)).toBe(5000);
  });

  it("orders default first, then by allowed backends", () => {
    const list = ids(input({ site: cloudSite, providers: [anthropic], host: { caps: GPU, downloaded: ["wllama:qwen3-0.6b"], nano: false } }));
    expect(list[0]).toBe("anthropic:claude-haiku-5-5");
    expect(list[1]).toBe("local:qwen3-0.6b");
  });
});

describe("parseModelId", () => {
  it("splits on the first colon", () => {
    expect(parseModelId("local:qwen3-0.6b")).toEqual({ backend: "local", model: "qwen3-0.6b" });
    expect(parseModelId("openrouter:meta/llama-3:free")).toEqual({ backend: "openrouter", model: "meta/llama-3:free" });
    expect(parseModelId("nocolon")).toBeNull();
    expect(parseModelId(":x")).toBeNull();
    expect(parseModelId("local:")).toBeNull();
  });
});
