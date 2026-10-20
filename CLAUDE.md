# CLAUDE.md

MV3 Chrome extension exposing a local or user-keyed cloud LLM to user-approved sites through a Prompt API–compatible `window.LanguageModel`. The plan is `docs/BUILD_PLAN.md`; progress against it is `docs/STATUS.md` — update STATUS when you finish a plan item.

## Commands

- `npm run typecheck` — TypeScript, no emit
- `npm test` — Vitest unit tests (`test/`, `packages/*/test/`)
- `npm run build` / `npm run build:test` — esbuild to `dist/` / `dist-test/`
- `npm run test:e2e` — builds `dist-test/` and runs Playwright (`e2e/`) against the unpacked extension. Uses the echo engine, so no model downloads. Run it after touching the polyfill, bridge, router or host.
- `npm run fetch:webllm-libs` — downloads WebLLM model `.wasm` libraries into `vendor/webllm-libs/` (gitignored, bundled by the build)

`.npmrc` sets `ignore-scripts=true` because `onnxruntime-node` (a transitive dep of Transformers.js we never use) downloads binaries on install.

## Layout

- `src/polyfill/` — MAIN-world stub defining `LanguageModel` and `window.localLLM`. No model, no extension APIs. Built twice (`polyfill.js`, `polyfill-override.js`) via the `__OVERRIDE_NATIVE__` define.
- `src/bridge/` — ISOLATED-world relay. MessageChannel handshake + nonce with the stub, schema validation, forwards over a `chrome.runtime` port.
- `src/background/` — service worker. `router.ts` is the trust boundary; `policy.ts` (consent gate) and `limits.ts` (rate limits, spend caps) are pure and unit-tested; `registration.ts` registers content scripts only for enabled, permitted origins; `host-link.ts` manages the offscreen document.
- `src/offscreen/` — the host: sessions, FIFO generation queue, `LocalRuntime` (one loaded model, idle unload), engines in `engines/`, cloud adapters in `adapters/`. Every backend implements `Backend` in `backend.ts`.
- `src/shared/` — protocol + validators, host protocol, settings/storage schema, catalog, providers, keystore, errors.
- `src/ui/` — options, popup, consent dialog, playground (chat + image input) (vanilla TS + `dom.ts` helper). `ui/playground/` holds the raw I/O views (`raw.ts`, `payload.ts`) and the Tools panel; `ui/tools/` the playground-only extension tools: registry in IndexedDB (`registry.ts`), built-ins ported from Project05 (`builtin.ts`, `browser.ts`, `console.ts`, `a11y-injected.ts`), registry tools (`meta.ts`) and the runner (`run.ts`) that executes custom tool code in the sandbox page `ui/tool-sandbox.html`.
- `packages/web/` — `@local-llm/web` detection/fallback helper.
- `demo/` — public conformance page.

## Rules that matter

- Trust only `port.sender.origin` in the router. Never read an origin, backend, model or key from a page message. `parsePageRequest` rejects unknown kinds and extra fields — keep it strict when adding fields. The one exception is the `llm-playground` port: it's accepted only from `ui/playground.html` and may name the backend and attach images; only it receives `trace` (raw request/response) and `reasoning` responses (`policy.ts` `deliversTo`).
- The extension's own tools (browser automation, web search, custom code, registry tools) exist only in the playground and run there; web pages only ever get the tools they declare themselves. Their permissions are optional (`downloads`, `debugger`, `<all_urls>`, `api.tavily.com`) and requested from the click that enables them. Custom tool code runs only in the manifest sandbox page (opaque origin, no extension APIs); keep it that way. The Tavily key follows the key rule: router reads it, the offscreen host calls Tavily.
- Pages get model output only. Keys never leave `chrome.storage.local` except to the offscreen host for a provider call; never log prompts or keys (usage log holds origin, time, backend, token counts).
- Offscreen documents only have `chrome.runtime` messaging (no `storage`, `getManifest`, `tabs`…). Anything the host needs comes from the router in the request.
- New sites default to the local backend only. Never fall back to cloud unless the user allowed it for that site.
- Errors crossing to the page use Prompt API `DOMException` names (`LLMError` in `shared/errors.ts`).
- No required host permissions and no new required permissions in updates (store policy). All code, including engine `.wasm`, is bundled; only weights download at runtime. Build output stays unminified.
- If a native `LanguageModel` exists, the stub leaves it alone unless "override native" is on.
