// Web-chat backends: open the provider's site in a minimized tab using the user's logged-in
// Chrome session, submit the prompt, and scrape the reply. No API keys.

export interface WebUiProviderDef {
  id: string;
  name: string;
  /** chrome.permissions optional host pattern requested when the backend is enabled. */
  hostPattern: string;
  /** Page opened for a new chat. */
  startUrl: string;
  /** Synthetic model id exposed as `${id}:${defaultModel}`. */
  defaultModel: string;
  /** Rough context window for listing / caps (web UIs do not report one). */
  contextWindow: number;
}

export const WEBUI_PROVIDERS: WebUiProviderDef[] = [
  {
    id: "chatgpt-web",
    name: "ChatGPT (web)",
    hostPattern: "https://chatgpt.com/*",
    startUrl: "https://chatgpt.com/",
    defaultModel: "default",
    contextWindow: 128_000,
  },
  {
    id: "gemini-web",
    name: "Gemini (web)",
    hostPattern: "https://gemini.google.com/*",
    startUrl: "https://gemini.google.com/app",
    defaultModel: "default",
    contextWindow: 128_000,
  },
  {
    id: "claude-web",
    name: "Claude (web)",
    hostPattern: "https://claude.ai/*",
    startUrl: "https://claude.ai/new",
    defaultModel: "default",
    contextWindow: 200_000,
  },
];

export function findWebUiProvider(id: string): WebUiProviderDef | undefined {
  return WEBUI_PROVIDERS.find((p) => p.id === id);
}

export function isWebUiProviderId(id: string): boolean {
  return WEBUI_PROVIDERS.some((p) => p.id === id);
}
