# Build status

Tracks `docs/BUILD_PLAN.md`. Legend: **done** = implemented and covered by unit or e2e tests; **built, untested** = implemented but not exercised against a real model or provider yet.

## Phase 1 — relay chain with a dummy engine — done

- Main-world stub `window.LanguageModel` (`availability`, `params`, `create`, `clone`, `destroy`, `prompt`, `promptStreaming`, `append`, `measureInputUsage`, `inputUsage`/`inputQuota` plus `contextUsage`/`contextWindow` aliases, `AbortSignal`, `downloadprogress` monitor) and `window.localLLM.info()`
- Content-script relay: MessageChannel handshake with per-page nonce, `event.source === window`, schema validation, visibility observed in the isolated world
- Service worker router, offscreen host, echo engine
- E2E: round trip, streaming, clone, destroy, abort, usage log has no prompt text

## Phase 2 — local engines — built, untested against real weights

- `TransformersEngine` (WebGPU, WASM fallback; ORT wasm bundled under `vendor/ort/`), `WebLLMEngine` (model libraries bundled from `vendor/webllm-libs/`), `WllamaEngine` (GGUF on CPU; COOP/COEP set for multi-threading), optional `NanoEngine` (Chrome built-in)
- Auto-selection (WebGPU → WebLLM if MLC build, else Transformers.js; no WebGPU → wllama), per-model engine pin
- Capability probe, lazy load, one model at a time, FIFO queue, idle unload (default 10 min), download/delete from options, `downloadprogress` to pages
- Not yet verified: real downloads and generation in Chrome on the device matrix (the development container cannot reach huggingface.co). Benchmarks (tokens/sec, TTFT, memory over 20 sessions) not started.

## Phase 3 — consent and permissions — done

- Browser gate: `chrome.permissions.request` from popup/options, content scripts registered only for permitted, enabled origins (top frame only), synced in place on change
- Model gate: Allow once (per tab, session storage) / Always / Deny dialog, cloud wording, third-party-script warning; revocable; revocation destroys sessions and closes ports immediately
- Hidden tabs need prior "Always"; per-origin concurrent sessions, tokens/minute, max context; daily per-site and monthly per-provider token caps
- E2E: unapproved origin sees nothing, consent dialog flow, deny, session limit, revocation, iframes excluded, hijack attempt ignored

## Phase 4 — cloud providers — built, adapters unit-tested

- `AnthropicAdapter`, `GeminiAdapter`, `OpenAICompatAdapter` (OpenAI, xAI, DeepSeek, OpenRouter, custom base URLs) with SSE parsing, error mapping to `DOMException` names, token usage
- Keys in `chrome.storage.local`, optional passphrase lock (PBKDF2 → AES-GCM, unlocked key in `chrome.storage.session`)
- Provider host permissions requested when enabled; per-site allowed backends; fallback only when allowed for the site
- Not yet verified against live provider APIs.

## Not started / v2

- Structured output (`responseConstraint`), tool calling under `window.localLLM.tools`, model hints, embeddings
- `quotaoverflow` event dispatch (overflow currently evicts oldest turns silently)
- Ollama mDNS discovery (the plan's "carry over" code isn't in this repository; use a custom OpenAI-compatible endpoint)
- Conformance suite run against native Chrome Prompt API in CI; lifecycle tests (worker killed mid-stream, extension update)

## Open questions from the plan

Still open: richer `window.localLLM` in v1, default model and ~1 GB first download, which providers ship enabled, new extension vs. mode of the existing agent extension. Current defaults: standard namespace plus `localLLM.info()`, Qwen2.5 0.5B default, all providers off until the user enables them, standalone extension.
