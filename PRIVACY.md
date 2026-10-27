# Local LLM — Privacy Policy

_Last updated: 27 October 2026_

Local LLM ("the extension") is a Chrome extension that gives websites you approve access to a language model through the `window.LanguageModel` API. This policy explains what data the extension handles and where it goes.

## Summary

- The extension has no server of its own. The developer does not collect, receive, store, sell or share any of your data.
- There is no analytics, telemetry or tracking.
- Local models run entirely on your device.
- Data leaves your browser only when you configure a third-party service (a cloud AI provider or web search) and allow it to be used.

## Data the extension handles

| Data | Where it is kept | Leaves your device? |
| --- | --- | --- |
| Prompts and model outputs from sites you approve | In memory while a session runs; not saved | Only to a cloud provider you configured and allowed for that site |
| Settings and per-site permissions | `chrome.storage.local` on your device | No |
| Your own API keys for cloud providers or Tavily | `chrome.storage.local`, optionally encrypted with your passphrase | Only to that provider, when making a request you allowed |
| Usage log: site origin, time, backend, token counts (no prompt or output text) | `chrome.storage.local` | No. You can clear it at any time |
| Downloaded model weights | Extension storage on your device | No (downloaded from Hugging Face) |
| Playground chats and custom tools | On your device (extension storage / IndexedDB) | Only to the model backend you select |

## Third-party services

The extension contacts these services only when you enable them:

- **Hugging Face** (`huggingface.co` and its CDN hosts): model weight downloads, started by you. Hugging Face receives a normal download request (IP address, user agent).
- **Cloud AI providers** (Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, OpenRouter, or a local server on `localhost`): only if you add your own API key and allow a site to use that provider. That site's prompts are sent directly from your browser to the provider, under the provider's own terms and privacy policy.
- **Web search** (Tavily with your key, or Google Search): only if you turn web search on for a site or in the playground. The search query is sent to that service.

Websites never receive your API keys, settings, other sites' data or your browsing history. They receive model output only (and search results where you enabled web search).

## Optional permissions

Browser-automation tools in the extension's own Playground (reading pages, capturing console output via `debugger`, saving files via `downloads`) are optional permissions that you grant on the click that enables them. They run only when you use the Playground, and their results go only to the model backend you selected.

## Your choices

You can disable any site, remove API keys, clear the usage log, delete downloaded models, or uninstall the extension at any time. Uninstalling removes all data the extension stored.

## Children

The extension is not directed at children under 13 and does not knowingly collect their data.

## Changes

Changes to this policy will be published at this URL with a new date.

## Contact

Questions: open an issue at https://github.com/gosienna/Project14_ChromeLLMBackend/issues
