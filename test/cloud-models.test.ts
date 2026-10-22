import { describe, expect, it } from "vitest";
import { estimateCost } from "../src/background/limits";
import { CloudBackend } from "../src/offscreen/cloud-backend";
import { CLOUD_MODELS, cloudCost, cloudIoLabel, findCloudModel, fmtTokens, priceLabel, priceNotes } from "../src/shared/cloud-models";
import { BUILTIN_PROVIDERS, customProvider } from "../src/shared/providers";
import { getSettings, saveSettings, DEFAULT_SETTINGS } from "../src/shared/settings";
import { fakeArea } from "./fake-storage";

const provider = (id: string) => BUILTIN_PROVIDERS.find((p) => p.id === id)!;
const backend = (id: string, model: string) => new CloudBackend({ kind: "cloud", provider: provider(id), model, apiKey: "K" });

describe("cloud model list", () => {
  it("covers every built-in provider and includes its default model", () => {
    for (const p of BUILTIN_PROVIDERS) expect(findCloudModel(p.id, p.defaultModel), p.id).toBeDefined();
  });
  it("has unique ids and sane numbers", () => {
    for (const [id, models] of Object.entries(CLOUD_MODELS)) {
      expect(new Set(models.map((m) => m.id)).size, id).toBe(models.length);
      for (const m of models) {
        expect(m.input).toContain("text");
        expect(m.contextWindow).toBeGreaterThan(0);
        if (m.maxInput) expect(m.maxInput).toBeLessThanOrEqual(m.contextWindow);
        if (m.maxOutput) expect(m.maxOutput).toBeLessThanOrEqual(m.contextWindow);
        if (!m.price) continue;
        expect(m.price.input).toBeGreaterThanOrEqual(0);
        expect(m.price.output).toBeGreaterThanOrEqual(m.price.input);
        if (m.price.long) expect(m.price.long.input).toBeGreaterThan(m.price.input);
      }
    }
  });
  it("formats labels", () => {
    const haiku = findCloudModel("anthropic", "claude-haiku-5-5")!;
    expect(cloudIoLabel(haiku)).toBe("text+image+pdf→text");
    expect(priceLabel(haiku)).toBe("$0.10 / $0.50");
    expect(priceNotes(haiku)).toBe(">100K prompt: $0.50 / $2.50 · cached input $0.01");
    expect(priceLabel(findCloudModel("openai", "gpt-4o-mini")!)).toBe("$0.15 / $0.60");
    expect(priceLabel(findCloudModel("openrouter", "google/gemini-3.8-flash")!)).toBe("$0.825 / $4.125");
    expect(priceLabel(findCloudModel("openrouter", "openrouter/auto")!)).toBe("varies");
    expect(fmtTokens(1_050_000)).toBe("1.05M");
    expect(fmtTokens(1_048_576)).toBe("1M");
    expect(fmtTokens(128_000)).toBe("128K");
    expect(fmtTokens(65_536)).toBe("64K");
  });
  it("prices usage at the model's base rate", () => {
    expect(cloudCost("openai", "gpt-6.1-sol", 1_000_000, 100_000)).toBeCloseTo(3);
    expect(cloudCost("openai", "unknown", 1, 1)).toBeNull();
    const e = { origin: "https://a.com", backend: "anthropic", time: 0, inputTokens: 1_000_000, outputTokens: 0 };
    expect(estimateCost({ ...e, model: "claude-opus-5-5" })).toBeCloseTo(4);
    expect(estimateCost(e)).toBeCloseTo(0.1); // logged without a model: provider default
    expect(estimateCost({ ...e, backend: "custom-x" })).toBe(0);
  });
});

describe("CloudBackend capabilities", () => {
  it("come from the model list", () => {
    const sol = backend("openai", "gpt-6.1-sol");
    expect(sol.contextWindow()).toBe(1_050_000);
    expect(sol.maxInput()).toBe(922_000);
    expect(sol.maxOutput()).toBe(128_000);
    expect(backend("anthropic", "claude-opus-5-5").maxInput()).toBeUndefined();
    expect(backend("xai", "grok-4.3").maxOutput()).toBe(128_000);
    expect(backend("gemini", "gemini-3.8-flash").maxOutput()).toBe(65_536);
    expect(sol.toolMode()).toBe("prompted");
    expect(backend("openai", "gpt-5.6-terra").toolMode()).toBe("native");
    expect(backend("deepseek", "deepseek-v4-pro").acceptsImages()).toBe(false);
    expect(backend("deepseek", "deepseek-flash").acceptsImages()).toBe(true);
  });
  it("fall back for unlisted models and custom endpoints", () => {
    const b = backend("openai", "ft:my-model");
    expect([b.contextWindow(), b.acceptsImages(), b.toolMode()]).toEqual([128_000, true, "native"]);
    const custom = new CloudBackend({ kind: "cloud", provider: customProvider("custom-1", "Ollama", "http://localhost:11434/v1", "llama3.2"), model: "llama3.2", apiKey: "" });
    expect(custom.toolMode()).toBe("native");
  });
});

describe("settings migration", () => {
  it("replaces retired default models and keeps the rest", async () => {
    const area = fakeArea();
    const providers = {
      ...DEFAULT_SETTINGS.providers,
      xai: { enabled: true, model: "grok-3-mini", monthlyTokenCap: 5 },
      deepseek: { enabled: false, model: "deepseek-chat", monthlyTokenCap: 0 },
      openai: { enabled: true, model: "gpt-4o-mini", monthlyTokenCap: 0 },
    };
    await saveSettings({ ...DEFAULT_SETTINGS, providers }, area);
    const s = await getSettings(area);
    expect(s.providers.xai).toEqual({ enabled: true, model: "grok-4.3", monthlyTokenCap: 5 });
    expect(s.providers.deepseek.model).toBe("deepseek-flash");
    expect(s.providers.openai.model).toBe("gpt-4o-mini");
  });
});
