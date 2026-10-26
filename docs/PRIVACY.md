# Local LLM — Privacy policy

_Last updated: 2026-10-26_

Local LLM is a Chrome extension that provides a language model to websites you approve. This policy explains what data the extension handles and where it goes.

## Summary

- The developer collects nothing. The extension has no analytics, no telemetry, no accounts and no server of its own.
- Local models run entirely on your device.
- Data leaves your device only when you set up a service yourself (a cloud model provider, web search, or a model download), and then it goes directly from your browser to that service.

## What the extension stores on your device

All of this stays in your browser's extension storage, and is removed when you uninstall the extension:

- **Settings:** which sites you enabled, your consent decisions, per-site limits and your chosen models.
- **API keys** for the cloud providers or search service you configure. You can lock them with a passphrase; they are then encrypted (AES-GCM), and the unlocked key is kept in memory only until the browser closes. Keys are never shared with websites.
- **Usage log:** for each request, the site's origin, the time, the backend used and token counts. It does not record prompts or responses. You can clear it in settings.
- **Model weights** you choose to download.
- **Playground tools** you create, stored in the extension's own database.

## When data leaves your device

Only in these cases, each of which you turn on:

| When | What is sent | Sent to |
| --- | --- | --- |
| You download a local model | A request for the model files | Hugging Face (huggingface.co and its download hosts) |
| You allow a site to use a cloud provider, or use one in the playground | The prompt, conversation and any attached images, with your API key | Only the provider you configured (for example Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, OpenRouter, or a server address you entered) |
| You turn on web search for a site, or use it in the playground | The search query | Tavily (with your key) or Google |
| A site you allowed fetches an image from its own search results | A request for that image | The website hosting the image |
| You use the playground's browser tools | Page content of tabs you name | Stays in the extension, and goes to your chosen model as part of the chat |

Each of those services handles the data under its own privacy policy and terms.

## What websites receive

A site you enable gets the model's responses to its own prompts, plus web search results if you turned search on for it. Sites never receive your API keys, your settings, other sites' data or your usage log.

## Changes

Changes to this policy will be published at this address, with a new "Last updated" date.

## Contact

Questions: open an issue at https://github.com/gosienna/project14_chromellmbackend/issues
