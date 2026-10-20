# Build status

Tracks `docs/BUILD_PLAN.md`. Legend: **done** = implemented and covered by unit or e2e tests; **built, untested** = implemented but not exercised against a real model or provider yet.

## Phase 1 — relay chain with a dummy engine — done

- Main-world stub `window.LanguageModel` (`availability`, `params`, `create`, `clone`, `destroy`, `prompt`, `promptStreaming`, `append`, `measureInputUsage`, `inputUsage`/`inputQuota` plus `contextUsage`/`contextWindow` aliases, `AbortSignal`, `downloadprogress` monitor) and `window.localLLM.info()`
- Content-script relay: MessageChannel handshake with per-page nonce, `event.source === window`, schema validation, visibility observed in the isolated world
- Service worker router, offscreen host, echo engine
- E2E: round trip, streaming, clone, destroy, abort, usage log has no prompt text

## Phase 2 — local engines — built, untested against real weights

- `TransformersEngine` (WebGPU, WASM fallback; ORT wasm bundled under `vendor/ort/`), `WebLLMEngine` (model libraries bundled from `vendor/webllm-libs/`), `WllamaEngine` (GGUF on WebGPU or CPU; streams weights into GPU memory with JSPI + Memory64, so models beyond the 4 GB wasm heap load; COOP/COEP set for multi-threading), optional `NanoEngine` (Chrome built-in)
- Auto-selection (WebGPU → first of WebLLM, Transformers.js, wllama that can run the model; no WebGPU → wllama), per-model engine pin; GGUFs over 3.5 GB need WebGPU + JSPI + Memory64, probed in the host
- Catalog: 86 local models from 0.26B to 122B: every chat model in Project05 (its WebLLM, wllama and Transformers.js lists) merged with ours into one entry per model with a build per engine, plus Gemini Nano and the echo engine. Every file, shard and image projector checked against the Hugging Face API (none gated); twenty WebLLM libraries bundled (~132 MB). Project05's non-chat models (captioning, OCR, classification, speech, embeddings) are left out: the Prompt API is chat only
- Vision: 25 GGUFs load with their image projector on wllama (images re-encoded to JPEG for llama.cpp), Phi-3.5 vision on WebLLM, Gemma 4 E2B/E4B and Ministral 3 on Transformers.js through AutoProcessor. `takesImages()` decides per model and engine
- Capabilities per model and engine: input → output (`ioLabel`) and native tool calling (`takesTools`, wllama only). The `tools` flag comes from each GGUF's chat template on Hugging Face (50 models), not from family assumptions. Options shows them in the model list and a per-engine table. Pages cannot pass tools yet
- Reasoning models (Qwen3, gpt-oss): llama.cpp separates thinking (`reasoning_format: "deepseek"`, plus a `<think>` splitter fallback); pages get the answer only, the playground shows thinking; options toggle turns thinking off or down
- Weights stored in IndexedDB: Transformers.js and wllama share `model-store.ts` (64 MB Blob chunks, file record written last so interrupted downloads read as absent); WebLLM uses its `cacheBackend: "indexeddb"`. Older Cache Storage / OPFS copies are removed once on first start
- Capability probe, lazy load, one model at a time, FIFO queue, idle unload (default 10 min), download/delete from options, `downloadprogress` to pages
- Not yet verified: real downloads and generation in Chrome on the device matrix, including large-model loads and out-of-memory handling. Benchmarks (tokens/sec, TTFT, memory over 20 sessions) not started.

## Phase 3 — consent and permissions — done

- Browser gate: `chrome.permissions.request` from popup/options, content scripts registered only for permitted, enabled origins (top frame only), synced in place on change
- Model gate: Allow once (per tab, session storage) / Always / Deny dialog, cloud wording, third-party-script warning; revocable; revocation destroys sessions and closes ports immediately
- Hidden tabs need prior "Always"; per-origin concurrent sessions, tokens/minute, max context; daily per-site and monthly per-provider token caps
- E2E: unapproved origin sees nothing, consent dialog flow, deny, session limit, revocation, iframes excluded, hijack attempt ignored

## Phase 4 — cloud providers — built, adapters unit-tested

- `AnthropicAdapter`, `GeminiAdapter`, `OpenAICompatAdapter` (OpenAI, xAI, DeepSeek, OpenRouter, custom base URLs) with SSE parsing, error mapping to `DOMException` names, token usage
- Keys in `chrome.storage.local`, optional passphrase lock (PBKDF2 → AES-GCM, unlocked key in `chrome.storage.session`)
- Provider host permissions requested when enabled; per-site allowed backends; fallback only when allowed for the site
- Curated model list per provider (`shared/cloud-models.ts`, prices as of 2026-10-20): options model picker and per-provider Models tables (input → output, context, reasoning, tools, list price); `CloudBackend` takes context window, image input and tool mode from it (unlisted ids keep 128K / images / native); usage log records the cloud model and prices it; retired default ids (`grok-3-mini`, `deepseek-chat`, `deepseek-reasoner`) migrate on load. Reasoning is informational: adapters don't send thinking/effort parameters yet
- Not yet verified against live provider APIs.

## Playground — done (echo engine); image input unit-tested per adapter

- `ui/playground.html`, opened from the popup (**Open playground**) or the options nav: a chat with the local model or any enabled provider, with streaming, Stop, New chat, an optional system prompt and temperature
- Image input: attach, paste or drop images (PNG/JPEG/WebP/GIF). Images over 1568 px on the long edge are downscaled, and each is capped at about 5 MB and 8 per message. They go to Anthropic, OpenAI-compatible and Gemini adapters, Chrome's built-in model (`expectedInputs`) and the echo engine. Text-only local engines get `NotSupportedError`, and `localLLM.info()` reports `images`
- Router: separate `llm-playground` port accepted only from the playground's URL. The backend is chosen by the page, there's no site consent, and provider monthly caps apply. Web pages still can't send images (`parsePageRequest` rejects them unless the playground flag is set)
- E2E: chat, image round trip, Stop, New chat, other extension pages refused on the playground port. Not yet verified against live vision APIs or Gemini Nano's multimodal input.

## Tool calling — done

- Standard Prompt API shape: `LanguageModel.create({ tools: [{ name, description, inputSchema, execute }] })`. `execute` runs in the page; the extension sees declarations only (validated strictly: ≤ 32 tools, name pattern, description ≤ 4 KB, schema ≤ 64 KB)
- Host loop: generate → `tool-call` to the page → `tool-result` back (router scopes the target to the page's connection, like abort) → generate again; calls of one round run in parallel; up to 8 rounds, then a final round without tools. Tool turns stay in the session history; quota trimming drops a call together with its results
- Native: Anthropic (`tool_use` / `tool_result`), OpenAI-compatible (`tool_calls`), Gemini (`functionCall` with thought signatures, `parametersJsonSchema`), wllama on GGUFs whose template handles tools, echo engine (tests). Prompted for every other engine: tool list in the system prompt, `<tool_call>` / bare-JSON replies parsed in `tools/prompted.ts`
- `localLLM.info()` reports `tools: "native" | "prompted"`; options shows the mode per model and engine
- Tests: protocol validation, parser and prompt rewriting, adapters with streamed tool calls, wrapper; E2E round trip, streaming, clone, thrown errors, abort during a tool, malformed tools. Not yet verified against live providers or real local models

## Playground: raw I/O and extension tools — done

- Raw view per reply (Project05 Dialogue pattern): every generation round's exact request (provider JSON body without headers, or engine call args), rendered prompt (Transformers.js), and response (text, reasoning, tool calls, usage, raw SSE events for cloud). Host emits `trace` responses only for the playground (`HostRequest.trace`, `deliversTo`); images/binary shrunk to placeholders (`offscreen/trace.ts`)
- Pending request preview (tree) and **Edit JSON** → Apply: the next Send starts a fresh session from the edited messages and tools (`ui/playground/payload.ts` validates)
- Tool registry in IndexedDB (`local-llm-tools`): Project05's browser tools (snapshot/click with refs, read_page, links, HTML, tabs, navigate, click, type, scroll, modify_element, execute_script, wait, fetch_url, download_file, console messages) and Tavily `web_search`, seeded disabled; user/custom tools with sandboxed code (`ui/tool-sandbox.html`, `api.callTool`); registry tools `list_tools`/`get_tool`/`create_tool`/`update_tool`/`delete_tool`. Tools panel: enable per tool or group (requests optional permissions), "Ask first" (on for acting/writing tools and all custom code), form or JSON Schema editor, code editor, reset/delete
- Replies rendered as Markdown and LaTeX (`ui/markdown.ts`, port of Project05's escape-first renderer + KaTeX 0.19 bundled with its CSS and woff2 fonts under `ui/katex/`); links http(s)/mailto only, images shown as links, `$5 and $10` stays text; plain-text toggle in Session options. Transcript pinning ignores scroll events caused by layout changes
- Tool results capped (3 000 chars local, 8 000 cloud); changing tools mid-chat continues in a new session with the transcript
- Tests: trace sanitizer/adapter tracing/error trace, registry seeding/validation/reset, registry tools, schema form round trip, payload validation; E2E raw view, edited request, custom tool in sandbox with Run/Deny, registry tool, browser tools on a test page. Not yet verified: web_search against Tavily, download/console tools, real models choosing these tools

## Not started / v2

- Structured output (`responseConstraint`), model hints, embeddings
- `quotaoverflow` event dispatch (overflow currently evicts oldest turns silently)
- Ollama mDNS discovery (the plan's "carry over" code isn't in this repository; use a custom OpenAI-compatible endpoint)
- Conformance suite run against native Chrome Prompt API in CI; lifecycle tests (worker killed mid-stream, extension update)

## Open questions from the plan

Still open: richer `window.localLLM` in v1, default model and ~1 GB first download, which providers ship enabled, new extension vs. mode of the existing agent extension. Current defaults: standard namespace plus `localLLM.info()`, Qwen2.5 0.5B default, all providers off until the user enables them, standalone extension.
