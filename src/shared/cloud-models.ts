// Curated cloud model list per built-in provider: what each model takes, whether it reasons,
// how tools work through our adapter, and list prices. Checked against each provider's
// models and pricing pages (OpenRouter: its /api/v1/models listing) on PRICES_AS_OF.
// Users can still type any model id; unknown ids fall back to CloudBackend's defaults.

export type CloudInput = "text" | "image" | "audio" | "video" | "pdf";

export interface CloudPrice {
  /** USD per million tokens, standard tier, short prompts. */
  input: number;
  output: number;
  cachedInput?: number;
  /** Higher rates for the whole request once the prompt exceeds `above` tokens. */
  long?: { above: number; input: number; output: number };
  note?: string;
}

export interface CloudModel {
  /** Model id sent to the provider. */
  id: string;
  name: string;
  /** What the model accepts; output is text for every listed model. The adapters send text and images only. */
  input: CloudInput[];
  contextWindow: number;
  maxOutput?: number;
  /** Reasoning model: "hybrid" can be told not to think; "always" cannot. */
  reasoning?: "hybrid" | "always";
  /**
   * Tool calling through this extension's adapter. OpenAI goes through Chat Completions, where
   * GPT-6 Astra and GPT-6.1 Sol can't call tools and GPT-6 Luna only with reasoning off, so those
   * use prompted tools.
   */
  tools: "native" | "prompted";
  /** Absent when the price depends on where the request is routed. */
  price?: CloudPrice;
  /** Older but still served; listed under "Legacy". */
  legacy?: boolean;
}

export const PRICES_AS_OF = "2026-10-20";

/** Context assumed for model ids outside the curated list (custom endpoints, ids the user typed). */
export const UNLISTED_CONTEXT = 128_000;

const CLAUDE: CloudInput[] = ["text", "image", "pdf"];
const GPT: CloudInput[] = ["text", "image"];
const GEMINI: CloudInput[] = ["text", "image", "audio", "video", "pdf"];
const GROK: CloudInput[] = ["text", "image"];

const openAILong = (input: number, output: number) => ({ above: 272_000, input, output });
const grokLong = (input: number, output: number) => ({ above: 200_000, input, output });

export const CLOUD_MODELS: Record<string, CloudModel[]> = {
  anthropic: [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", input: CLAUDE, contextWindow: 1_000_000, maxOutput: 128_000, reasoning: "always", tools: "native",
      price: { input: 10, output: 50, cachedInput: 0.25 } },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", input: CLAUDE, contextWindow: 1_000_000, maxOutput: 128_000, reasoning: "always", tools: "native",
      price: { input: 4, output: 20, cachedInput: 0.2 } },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", input: CLAUDE, contextWindow: 1_000_000, maxOutput: 128_000, reasoning: "hybrid", tools: "native",
      price: { input: 2, output: 10, cachedInput: 0.1 } },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", input: CLAUDE, contextWindow: 1_000_000, maxOutput: 128_000, reasoning: "hybrid", tools: "native",
      price: { input: 0.1, output: 0.5, cachedInput: 0.01, long: { above: 100_000, input: 0.5, output: 2.5 } } },
    { id: "claude-opus-5", name: "Claude Opus 5", input: CLAUDE, contextWindow: 1_000_000, maxOutput: 128_000, reasoning: "hybrid", tools: "native", legacy: true,
      price: { input: 5, output: 25, cachedInput: 0.5 } },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: CLAUDE, contextWindow: 1_000_000, maxOutput: 64_000, reasoning: "hybrid", tools: "native", legacy: true,
      price: { input: 3, output: 15, cachedInput: 0.3 } },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", input: CLAUDE, contextWindow: 200_000, maxOutput: 64_000, reasoning: "hybrid", tools: "native", legacy: true,
      price: { input: 1, output: 5, cachedInput: 0.1 } },
  ],
  openai: [
    { id: "gpt-6-astra", name: "GPT-6 Astra", input: GPT, contextWindow: 1_050_000, maxOutput: 128_000, reasoning: "always", tools: "prompted",
      price: { input: 10, output: 50, cachedInput: 1, long: openAILong(20, 75) } },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", input: GPT, contextWindow: 1_050_000, maxOutput: 128_000, reasoning: "always", tools: "prompted",
      price: { input: 2, output: 10, cachedInput: 0.1, long: openAILong(4, 15) } },
    { id: "gpt-6-luna", name: "GPT-6 Luna", input: GPT, contextWindow: 1_050_000, maxOutput: 128_000, reasoning: "hybrid", tools: "prompted",
      price: { input: 0.1, output: 0.5, cachedInput: 0.01, long: openAILong(0.2, 0.75) } },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", input: GPT, contextWindow: 1_050_000, maxOutput: 128_000, reasoning: "hybrid", tools: "native",
      price: { input: 2, output: 12, cachedInput: 0.2, long: openAILong(4, 18) } },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", input: GPT, contextWindow: 1_050_000, maxOutput: 128_000, reasoning: "hybrid", tools: "native",
      price: { input: 0.2, output: 1.2, cachedInput: 0.02, long: openAILong(0.4, 1.8) } },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", input: GPT, contextWindow: 400_000, maxOutput: 128_000, reasoning: "hybrid", tools: "native", legacy: true,
      price: { input: 0.75, output: 4.5, cachedInput: 0.075 } },
    { id: "gpt-4.1-mini", name: "GPT-4.1 mini", input: GPT, contextWindow: 1_047_576, maxOutput: 32_768, tools: "native", legacy: true,
      price: { input: 0.4, output: 1.6, cachedInput: 0.1 } },
    { id: "gpt-4o-mini", name: "GPT-4o mini", input: GPT, contextWindow: 128_000, maxOutput: 16_384, tools: "native", legacy: true,
      price: { input: 0.15, output: 0.6, cachedInput: 0.075 } },
  ],
  gemini: [
    { id: "gemini-4-argon", name: "Gemini 4 Argon", input: GEMINI, contextWindow: 1_048_576, maxOutput: 65_536, reasoning: "always", tools: "native",
      price: { input: 2, output: 10, note: "$4 / $20 from Dec 1, 2026" } },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", input: GEMINI, contextWindow: 1_048_576, maxOutput: 65_536, reasoning: "always", tools: "native",
      price: { input: 0.75, output: 3.75, note: "$1.50 / $7.50 from Jan 1, 2027" } },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", input: GEMINI, contextWindow: 1_048_576, maxOutput: 65_536, reasoning: "always", tools: "native",
      price: { input: 0.3, output: 2.5 } },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", input: GEMINI, contextWindow: 1_048_576, maxOutput: 65_536, reasoning: "always", tools: "native",
      price: { input: 0.25, output: 1.5 } },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (preview)", input: GEMINI, contextWindow: 1_048_576, maxOutput: 65_536, reasoning: "always", tools: "native",
      price: { input: 2, output: 12, long: { above: 200_000, input: 4, output: 18 } } },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", input: GEMINI, contextWindow: 1_048_576, maxOutput: 65_536, reasoning: "hybrid", tools: "native", legacy: true,
      price: { input: 0.3, output: 2.5, note: "only for accounts that used 2.5 before" } },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", input: GEMINI, contextWindow: 1_048_576, maxOutput: 65_536, reasoning: "hybrid", tools: "native", legacy: true,
      price: { input: 0.1, output: 0.4, note: "only for accounts that used 2.5 before" } },
  ],
  xai: [
    { id: "grok-4.7", name: "Grok 4.7", input: GROK, contextWindow: 500_000, reasoning: "always", tools: "native",
      price: { input: 2, output: 6, cachedInput: 0.5, long: grokLong(4, 12) } },
    { id: "grok-4.3", name: "Grok 4.3", input: GROK, contextWindow: 1_000_000, reasoning: "hybrid", tools: "native",
      price: { input: 1.25, output: 2.5, cachedInput: 0.2, long: grokLong(2.5, 5) } },
    { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning", input: GROK, contextWindow: 1_000_000, reasoning: "always", tools: "native", legacy: true,
      price: { input: 1.25, output: 2.5, long: grokLong(2.5, 5) } },
    { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20", input: GROK, contextWindow: 1_000_000, tools: "native", legacy: true,
      price: { input: 1.25, output: 2.5, long: grokLong(2.5, 5) } },
  ],
  deepseek: [
    // DeepSeek bills in CNY by time of day; these are its USD peak rates.
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", input: ["text", "image"], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: "hybrid", tools: "native",
      price: { input: 0.3, output: 1.2, cachedInput: 0.006, note: "half price off-peak (outside 09–12, 14–18 Beijing time on weekdays)" } },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", input: ["text"], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: "hybrid", tools: "native",
      price: { input: 1.32, output: 3.96, cachedInput: 0.044, note: "half price off-peak (outside 09–12, 14–18 Beijing time on weekdays)" } },
  ],
  openrouter: [
    { id: "openrouter/auto", name: "Auto Router", input: ["text", "image", "audio", "video", "pdf"], contextWindow: 2_000_000, tools: "native" },
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", input: CLAUDE, contextWindow: 1_000_000, reasoning: "hybrid", tools: "native",
      price: { input: 2, output: 10 } },
    { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", input: ["text", "image", "pdf"], contextWindow: 1_050_000, reasoning: "always", tools: "native",
      price: { input: 2, output: 10 } },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", input: GEMINI, contextWindow: 1_048_576, reasoning: "always", tools: "native",
      price: { input: 0.825, output: 4.125 } },
    { id: "x-ai/grok-4.7", name: "Grok 4.7", input: ["text", "image", "pdf"], contextWindow: 500_000, reasoning: "always", tools: "native",
      price: { input: 2, output: 6 } },
    { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", input: ["text", "image"], contextWindow: 1_048_576, reasoning: "hybrid", tools: "native",
      price: { input: 0.3, output: 1.2 } },
    { id: "qwen/qwen3.8-max-0902", name: "Qwen3.8 Max", input: ["text", "image", "video"], contextWindow: 1_000_000, reasoning: "hybrid", tools: "native",
      price: { input: 2, output: 6 } },
  ],
};

export function cloudModels(providerId: string): CloudModel[] {
  return CLOUD_MODELS[providerId] ?? [];
}

export function findCloudModel(providerId: string, modelId: string): CloudModel | undefined {
  return cloudModels(providerId).find((m) => m.id === modelId);
}

export const takesCloudImages = (m: CloudModel) => m.input.includes("image");

export function cloudIoLabel(m: CloudModel): string {
  return `${m.input.join("+")}→text`;
}

/** "$10", "$0.50", "$0.075": cents always shown, more digits only when the price has them. */
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(Math.max(2, String(n).split(".")[1]?.length ?? 0))}`;

/** "$2 / $10" per million input / output tokens; "varies" for routers. */
export function priceLabel(m: CloudModel): string {
  return m.price ? `${usd(m.price.input)} / ${usd(m.price.output)}` : "varies";
}

/** Long-prompt tier, cache and scheduled changes, for the details table. */
export function priceNotes(m: CloudModel): string {
  const p = m.price;
  if (!p) return "price of the model it routes to";
  return [
    p.long ? `>${fmtTokens(p.long.above)} prompt: ${usd(p.long.input)} / ${usd(p.long.output)}` : "",
    p.cachedInput !== undefined ? `cached input ${usd(p.cachedInput)}` : "",
    p.note ?? "",
  ].filter(Boolean).join(" · ");
}

/** Token counts as providers quote them: 65,536 → "64K", 1,048,576 → "1M", 1,050,000 → "1.05M". */
export function fmtTokens(n: number): string {
  // Binary units only for sizes that are binary and not round decimals (128,000 is both 125 KiB and 128K).
  const unit = (dec: number, bin: number) => (n % dec !== 0 && n % bin === 0 ? bin : dec);
  if (n >= 1_000_000) return `${+(n / unit(1_000_000, 2 ** 20)).toFixed(2)}M`;
  return `${Math.round(n / unit(1000, 1024))}K`;
}

/** USD for a usage-log entry at the model's base rates; null when the model or its price is unknown. */
export function cloudCost(providerId: string, modelId: string | undefined, inputTokens: number, outputTokens: number): number | null {
  const p = modelId ? findCloudModel(providerId, modelId)?.price : undefined;
  return p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : null;
}
