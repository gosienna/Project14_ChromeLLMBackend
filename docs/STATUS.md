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
- Forced abort (`offscreen/abortable.ts`): abort releases the FIFO turn even if the engine ignores its signal; an engine still busy 5 s after abort is unloaded and reloads on the next request; queued requests leave the line when aborted. Popup shows requests running or queued, with **Force stop all** and a per-site stop (`stop` admin op). Unit-tested with a hanging generator; a stuck model *load* is not covered yet
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

## Model list and choice for pages — done (echo engine)

- `window.localLLM.models()` lists the models a site can run now: downloaded local builds this device can run (Nano also needs Chrome's model; the echo engine only when configured), and for each cloud provider in the site's allowed backends that is enabled, keyed and permitted, its curated models plus the configured id. Each entry has id, name, provider, engine, default flag, input/output types, context window, session quota, max output, reasoning, tool mode, price (USD/1M, `asOf`; local 0; null when unknown) and size. Built in the router (`background/models.ts`, pure), from the host's status (`nano` added) and the router's key/permission checks
- `LanguageModel.create({ model })`: the router accepts only ids from that site's list, builds a single backend (no fallback) and names the model in the consent dialog. `parsePageRequest` allows `options.model` (string ≤ 256, printable); the router strips it before the host
- Local runtime: `prepare` and `countTokens` load through the generation FIFO (`ensureQueued`), so a site loading another local model waits instead of unloading one mid-generation
- `@local-llm/web` `Found.models()`; the demo page shows the list
- Tests: list building (downloads, caps, pins, Nano, echo, cloud scope, unlisted ids, limits, ordering), id parsing, protocol, gate; E2E list + choice + unknown id + denied site. Not yet verified with real downloaded models or live providers

## Opt-in reasoning for pages — done (echo engine)

- `create({ reasoning: true })` (non-standard) makes the router deliver `reasoning` responses to that page session and its clones; `prompt()`/`promptStreaming()` take `onReasoning(text)`. The router strips the flag before the host and tracks session ids (`reasoningSessions`); `trace` stays playground-only. `parsePageResponse` now passes `reasoning` through the bridge
- First user: LearnWithLLM's Debug mode
- Tests: protocol field, `deliversTo`; E2E plain vs opted-in vs clone with the echo engine's `/think`. Not yet verified with real reasoning models

## Idle close of page connections — done (echo engine)

- Chrome stops the worker after 30s idle and the page's port then goes dead silently. The router now closes a page port after 25s with no message either way and nothing in flight (`IDLE_CLOSE_MS`, `idleCloseIn` in `limits.ts`), sending a `closed` notice first; the port's sessions are released. Every new page port gets a `connected` notice (`PortNotice`, `parsePortNotice`)
- The bridge fails the closed port's requests, posts `closed` to the page and reconnects on the next request; a new port without `connected` in 5s is given up as `unresponsive`. The stub fires `localllm:closed` with `detail.reason`
- First user: LearnWithLLM's status line
- Tests: `idleCloseIn`, `parsePortNotice`; E2E idle close + reconnect with a shortened period (`__test.setIdleCloseMs`)

## Web search for pages, Google fallback — done (stubbed provider)

- `background/search.ts` `runSearch`: Tavily when a key and permission exist, else (or on 401/403/429/432/433/5xx/network) the Google fallback; 400/422 are reported. The host's `webSearch` op now resolves to `TavilyOutcome` with the status instead of throwing
- `background/google-search.ts`: results page in a minimized, unfocused window, one search at a time, 15s load timeout, read with `collectGoogleResults` and cleaned by `normalizeGoogleResults` (`shared/search.ts`); verification/consent pages give `NetworkError`. Optional host permission `https://www.google.com/*`, granted in options → Tools
- Page API: `search` request kind; `localLLM.search()`, `localLLM.webSearchTool()`, `localLLM.capabilities`. Gate: model consent plus `SiteConfig.webSearch` (options → Sites, off by default); 10 searches/min per origin. The playground's `web_search` uses the same search. `@local-llm/web`: `found.search`, `webSearchTool(found)`
- First user: LearnWithLLM's web search toggle
- Tests: protocol, gate, `runSearch` provider choice, `tavilyFallback`, `normalizeGoogleResults`, web package; E2E with `__test.setSearchStub`. Not yet verified: real Google results page markup, real Tavily quota responses

## Image results for web search — done (stubbed provider)

- `includeImages` on `localLLM.search()` / `include_images` on every `web_search` tool (playground, `webSearchTool()`, `@local-llm/web`, LearnWithLLM). Response gets `images: [{ url, description?, sourceUrl?, thumbnail?, width?, height? }]`, capped at `maxResults`; absent unless asked
- Tavily: `include_images` + `include_image_descriptions` on the same request. Google fallback: after the web results, the same minimized tab loads the Images tab (`udm=2`); `collectGoogleImages` gathers `["url",h,w]` triples from inline script data, `/imgres` links and thumbnails; `normalizeGoogleImages` decodes, drops gstatic/google hosts as originals, pairs thumbnails, dedupes. If the Images tab fails, web results still return with `images: []` and a note
- `capabilities.imageSearch`; the `search` page request now requires `includeImages: boolean`
- Tests: `runSearch` image flag and Images-tab failure, `normalizeGoogleImages`, protocol, web package; E2E with images in the stub. Not yet verified: real Google Images markup, real Tavily image responses

## Not started / v2

- Structured output (`responseConstraint`), embeddings
- `quotaoverflow` event dispatch (overflow currently evicts oldest turns silently)
- Ollama mDNS discovery (the plan's "carry over" code isn't in this repository; use a custom OpenAI-compatible endpoint)
- Conformance suite run against native Chrome Prompt API in CI; lifecycle tests (worker killed mid-stream, extension update)

## Open questions from the plan

Still open: richer `window.localLLM` in v1, default model and ~1 GB first download, which providers ship enabled, new extension vs. mode of the existing agent extension. Current defaults: standard namespace plus `localLLM.info()`, Qwen2.5 0.5B default, all providers off until the user enables them, standalone extension.

## Images in the playground, and localLLM.fetchImage — done

- Playground: Markdown `![alt](url)` renders as `<img data-src>`; `ui/remote-image.ts` fetches the image (extension pages run with COEP `require-corp`, so plain remote `<img>` fails) and shows a `blob:` URL, cached per url and revoked on New chat. Failures become a link with an "Allow images" button (`<all_urls>`). Tool results with an `images` list (web_search with `include_images`) show a thumbnail grid (`runToolWithValue` keeps the value)
- Page API: `fetch-image` request / `localLLM.fetchImage(url)` → `{ url, type, blob }`. Same gate as search; only urls that origin's searches returned (`SearchedImages`, 300 per origin, cleared on revoke and lost on worker restart); raster types, 8 MB; 30/min per origin. Options → Tools "Images for sites" grants `<all_urls>`. `@local-llm/web`: `found.fetchImage`
- First user: LearnWithLLM stores fetched images on the topic (`whiteboard_add_image`)
- Tests: Markdown image markup, `checkImageResponse`, `SearchedImages`, protocol, gate; E2E Markdown image via blob URL and failed-image link, tool-card grid, `fetchImage` allowlist. Not yet verified: real image hosts with and without `<all_urls>`
