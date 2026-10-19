# Local LLM — Chrome extension

An MV3 Chrome extension that serves a language model — running locally in the browser, or through the user's own cloud API keys — to websites the user approves, via a Prompt API–compatible `window.LanguageModel`. Web apps code against the standard API once; the extension supplies the model, loaded a single time and shared across every tab and site.

See [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) for the full plan and [`docs/STATUS.md`](docs/STATUS.md) for what is built.

```js
const status = await LanguageModel.availability(); // "available" | "downloadable" | "downloading" | "unavailable"
const session = await LanguageModel.create({
  initialPrompts: [{ role: "system", content: "You are concise." }],
  monitor(m) { m.addEventListener("downloadprogress", (e) => show(e.loaded)); },
});
const text = await session.prompt("Summarize this");
for await (const chunk of session.promptStreaming("Explain WebGPU")) render(chunk);
session.destroy();
```

## Request path

```
page ── window.LanguageModel (polyfill.js, MAIN world, holds no model)
  │  MessageChannel + per-page nonce
  ▼
content script relay (bridge.js, ISOLATED world: schema check, visibility)
  │  chrome.runtime port
  ▼
service worker (router: origin from port.sender only, consent, rate limits, spend caps)   ← trust boundary
  │  chrome.runtime port
  ▼
offscreen host (sessions, FIFO queue, one loaded model)
  ├─ local:  Transformers.js · WebLLM · wllama · Chrome built-in (Nano) · echo (tests)
  └─ cloud:  AnthropicAdapter · GeminiAdapter · OpenAICompatAdapter (OpenAI, xAI, DeepSeek, OpenRouter, Ollama, LM Studio, …)
```

## Getting started

```bash
npm install                 # .npmrc sets ignore-scripts (skips onnxruntime-node's binary download)
npm run fetch:webllm-libs   # bundle WebLLM model libraries (store policy: no remote code)
npm run build               # -> dist/
```

Load `dist/` at `chrome://extensions` (Developer mode → Load unpacked). Then:

1. Open a site and click the toolbar icon → **Enable on this site** (Chrome asks for the host permission).
2. Reload the page. The site now sees `window.LanguageModel`; its first `create()` shows the consent dialog.
3. Manage models, providers, keys, limits and the usage log in the options page.

The conformance demo (`npm run demo`, then open http://localhost:8787 and enable that origin) runs the same checks against the native Prompt API or the extension.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Production build to `dist/` (readable, not minified) |
| `npm run watch` | Rebuild on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests (protocol, policy, limits, SSE, adapters, keystore, helper package) |
| `npm run test:e2e` | Builds `dist-test/` and runs Playwright against the unpacked extension with the echo engine |
| `npm run demo` | Serves the conformance page |

## Helper package

[`packages/web`](packages/web) (`@local-llm/web`) lets apps detect the extension or native API and fall back gracefully:

```js
import { createOrFallback } from "@local-llm/web";
const session = await createOrFallback({ fallback: (reason) => null });
```
