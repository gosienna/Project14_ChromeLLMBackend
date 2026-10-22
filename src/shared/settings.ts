// Persistent extension state in chrome.storage.local, and helpers to read it with defaults.

import type { EngineId } from "./catalog";
import { BUILTIN_PROVIDERS, type ProviderDef } from "./providers";

/** "local" or a provider id. */
export type BackendId = string;

export interface Limits {
  maxSessions: number;
  tokensPerMinute: number;
  maxContext: number;
  /** When set, `maxContext` is kept but ignored: a session uses the model's own context window. */
  maxContextUnlimited?: boolean;
  /** Cap on generated tokens per prompt (max_tokens); also bounded by the context left. */
  maxOutputTokens: number;
  /** When set, `maxOutputTokens` is kept but ignored: a reply may use the context still free. */
  maxOutputUnlimited?: boolean;
}

export interface Settings {
  overrideNative: boolean;
  local: {
    modelId: string;
    /** Per-model engine pin; missing or "auto" means auto-select. */
    enginePin: Record<string, EngineId | "auto">;
    /** Let reasoning models think before answering (slower, better answers). */
    reasoning: boolean;
  };
  providers: Record<string, { enabled: boolean; model: string; monthlyTokenCap: number }>;
  customProviders: ProviderDef[];
  idleUnloadMinutes: number;
  limits: Limits;
}

export interface SiteConfig {
  origin: string;
  /** Model gate decision. Absent: ask on first create(). */
  consent?: "always" | "deny";
  /** Backends this site may use. New sites default to local only. */
  allowedBackends: BackendId[];
  /** Backend used for new sessions; must be in allowedBackends. */
  backend: BackendId;
  /** Ignored while `dailyTokenUnlimited` is set. */
  dailyTokenCap: number;
  /** No daily token cap for this site. `dailyTokenCap` is kept for when this is turned off. */
  dailyTokenUnlimited?: boolean;
  /** Fall back from local to another allowed backend when WebGPU/local is unavailable. */
  allowFallback: boolean;
  /** The site may call localLLM.search(). Absent: off. */
  webSearch?: boolean;
}

export interface UsageEntry {
  origin: string;
  time: number;
  backend: BackendId;
  /** Cloud model id, for the cost estimate. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

export const DEFAULT_SETTINGS: Settings = {
  overrideNative: false,
  local: { modelId: "qwen2.5-0.5b-instruct", enginePin: {}, reasoning: true },
  providers: Object.fromEntries(
    BUILTIN_PROVIDERS.map((p) => [p.id, { enabled: false, model: p.defaultModel, monthlyTokenCap: 2_000_000 }]),
  ),
  customProviders: [],
  idleUnloadMinutes: 10,
  limits: { maxSessions: 2, tokensPerMinute: 20_000, maxContext: 8192, maxContextUnlimited: false, maxOutputTokens: 16384, maxOutputUnlimited: false },
};

/** The user's context cap. Unlimited is a finite stand-in: extension messages are JSON, and Infinity becomes null. */
export function effectiveMaxContext(limits: Pick<Limits, "maxContext" | "maxContextUnlimited">): number {
  return limits.maxContextUnlimited ? Number.MAX_SAFE_INTEGER : limits.maxContext;
}

/** The user's output cap. Unlimited is a finite stand-in so a reply can use the context still free. */
export function effectiveMaxOutput(limits: Pick<Limits, "maxOutputTokens" | "maxOutputUnlimited">): number {
  return limits.maxOutputUnlimited ? Number.MAX_SAFE_INTEGER : limits.maxOutputTokens;
}

/**
 * A cap after it has crossed `chrome.runtime` messaging. Non-finite values (Infinity serialized
 * as null) must not reach `Math.min`, which would treat them as 0 and reject every prompt.
 */
export function receivedCap(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
}

export function defaultSite(origin: string): SiteConfig {
  return { origin, allowedBackends: ["local"], backend: "local", dailyTokenCap: 200_000, allowFallback: false };
}

export const USAGE_LOG_MAX = 1000;

type Area = chrome.storage.StorageArea;
const local = (): Area => chrome.storage.local;

export async function getSettings(area: Area = local()): Promise<Settings> {
  const { settings } = await area.get("settings");
  const s = (settings ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    local: { ...DEFAULT_SETTINGS.local, ...s.local },
    providers: migrateModels({ ...DEFAULT_SETTINGS.providers, ...s.providers }),
    limits: { ...DEFAULT_SETTINGS.limits, ...s.limits },
  };
}

/** Former default model ids the providers no longer serve, mapped to their replacements. */
const RETIRED_MODELS: Record<string, Record<string, string>> = {
  xai: { "grok-3-mini": "grok-4.3" },
  deepseek: { "deepseek-chat": "deepseek-flash", "deepseek-reasoner": "deepseek-flash" },
};

function migrateModels(providers: Settings["providers"]): Settings["providers"] {
  for (const [id, renames] of Object.entries(RETIRED_MODELS)) {
    const cfg = providers[id];
    const next = cfg && renames[cfg.model];
    if (next) providers[id] = { ...cfg, model: next };
  }
  return providers;
}

export async function saveSettings(settings: Settings, area: Area = local()): Promise<void> {
  await area.set({ settings });
}

export async function getSites(area: Area = local()): Promise<Record<string, SiteConfig>> {
  const { sites } = await area.get("sites");
  return (sites ?? {}) as Record<string, SiteConfig>;
}

export async function getSite(origin: string, area: Area = local()): Promise<SiteConfig | undefined> {
  return (await getSites(area))[origin];
}

export async function updateSite(
  origin: string,
  patch: (s: SiteConfig) => SiteConfig | null,
  area: Area = local(),
): Promise<void> {
  const sites = await getSites(area);
  const next = patch(sites[origin] ?? defaultSite(origin));
  if (next) sites[origin] = next;
  else delete sites[origin];
  await area.set({ sites });
}

export async function getUsage(area: Area = local()): Promise<UsageEntry[]> {
  const { usage } = await area.get("usage");
  return (usage ?? []) as UsageEntry[];
}

export async function appendUsage(entry: UsageEntry, area: Area = local()): Promise<void> {
  const usage = await getUsage(area);
  usage.push(entry);
  await area.set({ usage: usage.slice(-USAGE_LOG_MAX) });
}

export function allProviders(settings: Settings): ProviderDef[] {
  return [...BUILTIN_PROVIDERS, ...settings.customProviders];
}

export function findProvider(settings: Settings, id: string): ProviderDef | undefined {
  return allProviders(settings).find((p) => p.id === id);
}

/** Origin pattern used for chrome.permissions and registerContentScripts. */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

/** Normalize user input such as "app.example.com" or "https://app.example.com/path" to an origin. */
export function normalizeOrigin(input: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
  const u = new URL(withScheme);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) sites are supported");
  return u.origin;
}
