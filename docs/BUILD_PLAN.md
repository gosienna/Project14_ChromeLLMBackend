# Local LLM Extension — Build Plan

Oct 19, 2026 · @kewei

## Goal and scope

Ship an MV3 Chrome extension that serves an LLM, running locally or through the user's cloud provider keys, and exposes it to any user-approved website through a Prompt API–compatible `window.LanguageModel`. Web apps code against the standard API once; the extension supplies the model, loaded a single time and shared across every tab and site.

**In scope**

- Local inference with Transformers.js (`@huggingface/transformers` v4), WebLLM and wllama, behind one engine interface and hosted in an offscreen document
- Cloud inference behind the same API, using the user's own API keys: Anthropic, OpenAI, Google Gemini, xAI Grok, DeepSeek, OpenRouter, plus any OpenAI-compatible endpoint (Ollama, LM Studio, Mistral, Groq and others)
- Per-origin consent, rate limits and a settings page to review and revoke access
- A small `@local-llm/web` helper package so apps can detect the extension and fall back gracefully

**Non-goals for v1**

- Exposing page content, other tabs or browser actions to calling sites (the agent features of the existing extension stay internal)
- Firefox / Safari builds
- Fine-tuning, embeddings or image generation (embeddings are a candidate for v2)

## Architecture

&#91;embedded content: request path · page to backend\]

A request travels down four layers; the service worker is the trust boundary, and the offscreen host loads the model once for every tab and site. Responses stream back up the same path.

## Public API

The page-facing surface mirrors Chrome's Prompt API, so code written for native Gemini Nano runs unchanged on the extension. Extensions to the standard live under a separate namespace and never shadow it.

```js
const status = await LanguageModel.availability();   // "available" | "downloadable" | "downloading" | "unavailable"
const session = await LanguageModel.create({
  initialPrompts: [{ role: "system", content: "You are concise." }],
  temperature: 0.7,
  monitor(m) { m.addEventListener("downloadprogress", e => show(e.loaded)); }
});
const text = await session.prompt("Summarize this");
for await (const chunk of session.promptStreaming("Explain WebGPU")) render(chunk);
session.destroy();
```

| Method | v1 | Notes |
| --- | --- | --- |
| `availability()`, `params()` | Yes | Reflects consent state: an unapproved origin sees `"downloadable"` and triggers the prompt on `create()` |
| `create()`, `clone()`, `destroy()` | Yes | Session state (chat history, KV cache handle) lives in the offscreen host, keyed by session id |
| `prompt()`, `promptStreaming()` | Yes | Streaming over a port; `AbortSignal` supported |
| `measureInputUsage()`, `contextWindow` | Yes | From the active model's tokenizer |
| Structured output (`responseConstraint`) | v2 | JSON-schema constrained decoding |
| Tool calling | v2 | Under `window.localLLM.tools`, not the standard namespace |

**Injection rule:** if a native `LanguageModel` already exists, leave it alone unless the user enables "override native" in settings. Expose `window.localLLM.info()` for model name, backend and version.

## Components

Seven parts, each with one job; the page never touches anything below the content script.

| Component | Responsibility | Key details |
| --- | --- | --- |
| `manifest.json` | Declares permissions and entry points | `permissions`: `offscreen`, `storage`, `scripting`, `unlimitedStorage`; `optional_host_permissions`: `<all_urls>` for sites plus each provider's API domain; no required host permissions |
| Main-world stub (`polyfill.js`) | Defines `window.LanguageModel` | Registered per approved origin via `chrome.scripting.registerContentScripts` with `world: "MAIN"`, `runAt: "document_start"`; holds no model, only request ids and promise/stream bookkeeping |
| Content script relay (`bridge.js`) | Page ↔ extension bridge | Listens to `window.postMessage` with a per-page nonce, validates message shape, forwards over a long-lived `chrome.runtime.connect` port |
| Service worker (`router.ts`) | Trust boundary and routing | Reads origin from `port.sender.origin` only; checks consent store; applies rate limits; ensures the offscreen document exists; queues requests |
| Offscreen host (`host.html` / `engine.ts`) | Owns the model | One WebGPU device, loaded model, session map, generation loop; streams tokens back by session id |
| Backend adapters | Same interface, different engines | Local: `TransformersEngine`, `WebLLMEngine`, `WllamaEngine` in the offscreen document. Remote: `AnthropicAdapter`, `GeminiAdapter`, `OpenAICompatAdapter` (OpenAI, Grok, DeepSeek, OpenRouter, Ollama, custom URLs). Optional `NanoBackend` (Chrome built-in). One `generate(messages, opts, signal)` contract |
| UI | Consent and control | Consent popup per origin; options page for models, backend choice, site list, usage log; toolbar badge showing active sessions |

Reuse from the existing extension: the offscreen WebGPU host, backend abstraction and Ollama mDNS endpoint carry over directly. New work is the stub, relay, consent layer and API conformance.

## Security and consent

Chrome authorizes the extension; the extension must authorize each website. Two gates, both explicit:

1. **Browser gate (Chrome):** the user enables a site, which calls `chrome.permissions.request({ origins: ["https://app.example.com/*"] })`. Only then is the stub registered for that origin. Unapproved sites cannot detect the extension.
2. **Model gate (ours):** on first `create()` from an origin, show "app.example.com wants to use your local model — Allow once / Always / Deny". Decisions persist in `chrome.storage.local` and are revocable on the options page.

**Hardening rules**

- Trust only `sender.origin` from the port, never origin claims inside messages
- Per-origin limits: concurrent sessions (default 2), tokens per minute, max context length
- Hidden or background tabs may not start generation without prior "Always" consent
- Calling sites get model output only: no page content, tab data, browsing history or agent tools cross the boundary
- Validate every message against a schema in the relay and router; drop unknown types
- Relay accepts messages only from its own window (\`event.source === window\`), ignoring other frames; same-page scripts share that origin's consent, so the bridge grants no extra privilege
- Usage log (origin, time, token counts, no prompt text) visible to the user

**Known limit:** once a site is approved, any script running on that site, including its third-party ads, can call the API. State this in the consent dialog.

## Model management

Weights are downloaded once into the extension's own origin, so every website shares one copy. Code is always bundled; only weights come from the network.

**Local engines.** Three in-browser engines sit behind one engine interface in the offscreen document; only one is loaded at a time.

| Engine | Package | Compute path | Model format | Role |
| --- | --- | --- | --- | --- |
| Transformers.js | `@huggingface/transformers` v4 | WebGPU, WASM fallback, WebNN | ONNX (q4 / q4f16) | Default engine: broadest model catalog; embeddings in v2 |
| WebLLM | `@mlc-ai/web-llm` | WebGPU only | MLC prebuilt builds | Fastest chat on capable GPUs; built-in JSON mode and tool calling |
| wllama | `@wllama/wllama` | CPU via WASM, multi-threaded | GGUF | Fallback when WebGPU is missing; same model files as Ollama |

- **Auto-selection:** WebGPU present → Transformers.js, or WebLLM when the chosen model has an MLC build; no WebGPU → wllama. The user can pin an engine per model in options.
- **wllama threads:** multi-threading needs cross-origin isolation, so set the manifest's `cross_origin_opener_policy` and `cross_origin_embedder_policy` keys; single-thread works without them.
- **WebLLM model libraries:** each model needs a compiled `.wasm` library, which counts as code under store policy. Bundle the libraries for curated models and point `model_lib` at extension URLs; download only the weights.

* **Catalog:** a curated list per engine (ONNX for Transformers.js, MLC builds for WebLLM, GGUF for wllama) with size, context window and minimum VRAM; start with one small default (about 0.5–1.5B parameters) and one larger option
* **Download:** user-initiated from the options page or the first consent dialog; resumable, with progress surfaced to calling pages through the `downloadprogress` monitor
* **Storage:** Cache API or OPFS in the extension origin, with `unlimitedStorage`; show disk use and a delete button per model
* **Capability check:** probe `navigator.gpu.requestAdapter()` and adapter limits before offering a model; hide models the device can't run and report `"unavailable"`
* **Lifecycle:** load lazily on first request; unload after an idle timeout (default 10 minutes) to free GPU memory; one loaded model at a time in v1
* **Concurrency:** a FIFO queue in the offscreen host; one generation runs at a time, with per-session KV cache kept up to a memory cap
* **Backend fallback:** if WebGPU is unavailable, route to another backend only if the user has enabled it for that site; never silently fall back to cloud

## Cloud providers

Cloud providers plug in as backend adapters behind the same `LanguageModel` API, using the user's own keys. Three adapters cover every listed provider, because most now speak the OpenAI-compatible format.

| Provider | API shape | Adapter | Notes |
| --- | --- | --- | --- |
| Anthropic | Messages API | `AnthropicAdapter` | `x-api-key` and `anthropic-version` headers; system prompt is a top-level field; browser-originated calls need `anthropic-dangerous-direct-browser-access: true` |
| OpenAI | Chat Completions | `OpenAICompatAdapter` | Bearer key; the reference shape for the generic adapter |
| Google Gemini | Gemini API (`streamGenerateContent`) | `GeminiAdapter` | Roles are `user` / `model`; an OpenAI-compatible endpoint also exists if one adapter is preferred |
| xAI Grok | OpenAI-compatible | `OpenAICompatAdapter` | Base URL `https://api.x.ai/v1` |
| DeepSeek | OpenAI-compatible | `OpenAICompatAdapter` | Base URL `https://api.deepseek.com` |
| OpenRouter | OpenAI-compatible | `OpenAICompatAdapter` | One key for many vendors' models; base URL `https://openrouter.ai/api/v1` |
| Custom (Ollama, LM Studio, Mistral, Groq) | OpenAI-compatible | `OpenAICompatAdapter` | User enters the base URL; host permission requested at that moment |

**Adapter contract**

- Input: Prompt API messages (system, user, assistant) mapped to each provider's format
- Output: an async iterator of text chunks parsed from the provider's SSE stream, so pages get identical streaming from local and cloud
- Errors mapped to the Prompt API's `DOMException` names (`AbortError`, `QuotaExceededError`, `NetworkError`, `NotAllowedError`)
- Token usage returned on every call for the usage log and spend caps
- Calls run in the offscreen document or service worker; host permissions for provider domains let the extension origin call them without CORS proxies

**Keys, routing and cost**

- Keys live in `chrome.storage.local`, never cross to pages and never appear in logs; optional passphrase lock (WebCrypto AES-GCM, PBKDF2-derived key) with the unlocked key held in `chrome.storage.session`
- Each provider's domain sits in `optional_host_permissions` and is requested only when the user enables that provider
- The user maps each approved site to allowed backends; new sites default to local only
- When a site would use a cloud backend, the consent dialog says so plainly: prompts leave the device and usage is billed to the user's key
- Spend caps per site (daily tokens) and per provider (monthly estimate), shown in the usage log with estimated cost
- The user sets a default model per provider; pages may pass a model hint through `window.localLLM` in v2, never a forced choice

## Roadmap

&#91;embedded content: roadmap · 4 phases, 4 gates\]

Phase 1 proves the relay chain with a dummy engine before any model work; most of the existing extension's offscreen and backend code lands in Phase 2. Phase 3 must finish before any public build, because consent and permissions shape the store submission.

## Chrome Web Store readiness

Design for a standard review from day one: no broad required host permissions, all code bundled, plain disclosures. Broad host patterns like `<all_urls>` are a documented cause of longer reviews ([Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)).

- [ ] Host access only through `optional_host_permissions`; required `host_permissions` empty
- [ ] Bundle Transformers.js, WebLLM (including per-model libraries), wllama, ONNX Runtime Web `.wasm` files and all JS; set `env.backends.onnx.wasm.wasmPaths` to local paths so nothing loads from a CDN
- [ ] Model weights fetched at runtime are data, not code; document the download hosts
- [ ] Single-purpose statement: "Provides an on-device language model to websites the user approves"
- [ ] Justification text for `offscreen`, `scripting`, `storage`, `unlimitedStorage`
- [ ] Privacy policy and data-use certification: no prompts or outputs collected; cloud backend sends data only to the provider the user configures
- [ ] Readable, non-obfuscated build output
- [ ] Never add new required permissions in updates; that disables the extension for existing users until they re-approve

## Testing strategy

Test the API contract hardest: it is what third-party apps depend on.

| Layer | What to test | Tooling |
| --- | --- | --- |
| Unit | Router consent logic, rate limiter, message schemas, backend adapters with a mock engine | Vitest |
| API conformance | Same test suite run against native Chrome Prompt API and against the extension; results must match in shape and errors | Playwright with a loaded unpacked extension |
| Security | Unapproved origin sees no `LanguageModel`; spoofed origin fields ignored; iframe and background-tab rules; revocation takes effect immediately | Playwright, hostile test pages |
| Inference | Tokens/sec, time to first token, memory after 20 sequential sessions, idle unload frees GPU memory | Benchmark page, `chrome://gpu` |
| Lifecycle | Service worker killed mid-stream; offscreen document recreated; extension update during a session | Playwright + `chrome.runtime.reload()` |
| Devices | Integrated GPU laptop, discrete GPU desktop, Apple Silicon, no-WebGPU machine | Manual matrix |

Ship a public demo page that runs the conformance checks, so app developers can verify their setup.

## Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Prompt API spec changes | Apps break or the polyfill drifts from native | Pin to a spec version; track Chrome release notes; conformance suite in CI |
| Native Prompt API becomes widely available | Reduces the need for the extension | Differentiate on model choice, larger models, Ollama bridge and tool calling |
| Offscreen document or service worker killed mid-generation | Streams cut off | Keep-alive while streaming; resumable session state; clear error to the page |
| GPU memory pressure on low-end devices | Crashes, slow tabs | Capability check, small default model, idle unload, one model at a time |
| Abuse by approved sites or their third-party scripts | GPU drain, unwanted use | Rate limits, usage log, one-click revoke, consent text that names the risk |
| Store review delay or rejection | Slips launch | Optional permissions, bundled code, clear justifications (see readiness checklist) |

**Open questions**

- [ ] Target the standard `LanguageModel` namespace only, or also ship a richer `window.localLLM` API from v1?
- [ ] Which default model, and is about 1 GB an acceptable first download?
- [ ] Which cloud providers ship enabled in the first public build, and are per-site spend caps enough protection for billed keys?
- [ ] Is this a new extension or a mode of the existing agent extension? Combining them raises the review bar and mixes purposes.
