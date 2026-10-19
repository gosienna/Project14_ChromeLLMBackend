// Cloud providers. Three adapters cover all of them; most speak the OpenAI-compatible format.

export type AdapterKind = "anthropic" | "gemini" | "openai-compat";

export interface ProviderDef {
  id: string;
  name: string;
  adapter: AdapterKind;
  baseUrl: string;
  defaultModel: string;
  /** Pattern requested through optional_host_permissions when the provider is enabled. */
  hostPattern: string;
  keyRequired: boolean;
}

export const BUILTIN_PROVIDERS: ProviderDef[] = [
  { id: "anthropic", name: "Anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-haiku-5-5", hostPattern: "https://api.anthropic.com/*", keyRequired: true },
  { id: "openai", name: "OpenAI", adapter: "openai-compat", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", hostPattern: "https://api.openai.com/*", keyRequired: true },
  { id: "gemini", name: "Google Gemini", adapter: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-2.5-flash", hostPattern: "https://generativelanguage.googleapis.com/*", keyRequired: true },
  { id: "xai", name: "xAI Grok", adapter: "openai-compat", baseUrl: "https://api.x.ai/v1", defaultModel: "grok-3-mini", hostPattern: "https://api.x.ai/*", keyRequired: true },
  { id: "deepseek", name: "DeepSeek", adapter: "openai-compat", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat", hostPattern: "https://api.deepseek.com/*", keyRequired: true },
  { id: "openrouter", name: "OpenRouter", adapter: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto", hostPattern: "https://openrouter.ai/*", keyRequired: true },
];

/** Host match pattern for a user-entered base URL (Ollama, LM Studio, Mistral, Groq...). */
export function hostPatternFor(baseUrl: string): string {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Base URL must be http(s)");
  return `${u.protocol}//${u.hostname}/*`;
}

export function customProvider(id: string, name: string, baseUrl: string, model: string): ProviderDef {
  return { id, name, adapter: "openai-compat", baseUrl: baseUrl.replace(/\/+$/, ""), defaultModel: model, hostPattern: hostPatternFor(baseUrl), keyRequired: false };
}
