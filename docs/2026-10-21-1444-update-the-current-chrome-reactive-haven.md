# Expose runnable models to pages: `localLLM.models()` + `create({ model })`

## Context

Pages can only learn about the one backend the user picked for their site, through `localLLM.info()` (name, backend, images, tools). They can't see which other models are ready to run, or what those models can do and cost. The user wants the page API to list the models that can run **right now** (local models already downloaded and runnable on this device, cloud models from providers that have a key and host permission), with context window, input/output types, price and so on. Pages should also be able to pick one of them.

Decisions (from the user):
- **Scope**: a page sees only models from backends its site may use (`SiteConfig.allowedBackends`, local only by default). It never learns about providers the user didn't allow for that site.
- **Selection**: `LanguageModel.create({ model: "<id>" })` picks a listed model. The router accepts only ids that are in the list it builds itself for that site, so the page can name a model but can't widen what the user allowed. A chosen model gets no fallback.

Execution note (CLAUDE.md): first copy this plan to `docs/<date +%Y-%m-%d-%H%M>-update-the-current-chrome-reactive-haven.md`.

## API shape

```ts
const models = await window.localLLM.models();   // ModelInfo[], default first
const s = await LanguageModel.create({ model: models[1].id });
```

`ModelInfo` (new, in `src/shared/protocol.ts` so polyfill and `packages/web` share it):

```ts
interface ModelInfo {
  id: string;              // "local:qwen3-0.6b" | "<providerId>:<modelId>" (split on the first ":"; provider ids never contain one)
  name: string;            // "Qwen3 0.6B", "Claude Haiku 5.5"
  backend: string;         // "local" | provider id
  provider: string;        // "Local" | provider display name
  engine?: EngineId;       // local: the engine create() will use
  default: boolean;        // what create() without `model` uses for this site
  input: string[];         // modalities the model takes: text, image, audio, video, pdf
  output: ["text"];
  contextWindow: number;   // model maximum (contextLimit(model, engine) / CloudModel.contextWindow / 128K for unlisted ids)
  inputQuota: number;      // what a session gets: min(contextWindow, limits.maxContext)
  maxOutputTokens?: number;// CloudModel.maxOutput, capped by limits.maxOutputTokens
  reasoning?: "hybrid" | "always";
  tools: "native" | "prompted";
  price: { input: number; output: number; cachedInput?: number; long?: {...}; note?: string; asOf?: string } | null;
                           // USD per 1M tokens; local {input:0, output:0}; null = unknown or depends on routing
  sizeMB?: number;         // local download size
  legacy?: boolean;
}
```

## What counts as runnable

- **Local**: every catalog model with a `downloaded` key (`engine:modelId` from the host) whose engine `canRun` on the probed caps. Nano also needs Chrome's model (`nanoSupported()`). The configured model is also listed when it is the echo engine (`dummy`, always available). Engine per model: the resolved engine for its pin/auto if that build is downloaded, else the first downloaded build that can run.
- **Cloud**: for each provider in `site.allowedBackends`, include it only if `backendSpec(id)` succeeds (enabled, key set, host permission). List its curated `CLOUD_MODELS` entries plus the configured model if it isn't curated (custom endpoints, typed ids), using CloudBackend's defaults (128K, text+image, native tools, `price: null`).
- `default`: the entry `backendSpec(site.backend)` would run (provider's configured model, or local model with its resolved engine).

## Changes

1. **`src/shared/catalog.ts`**: export `resolveEngine(model, pin, caps)`, taking the logic out of `LocalRuntime.resolveEngine`, which then calls it.
2. **`src/shared/host-protocol.ts` + `src/offscreen/host.ts`**: add `nano: boolean` (`nanoSupported()`) to `HostStatus` / the `status` admin op.
3. **New `src/background/models.ts`**: a pure `listModels({ settings, site, caps, downloaded, nano, providers })` builds `ModelInfo[]` from the catalog (`takesImages`, `toolMode`, `contextLimit`, `ioLabel` semantics), `cloud-models.ts` (`findCloudModel`, `PRICES_AS_OF`) and the limits. Also `parseModelId(id)`. Pure like `policy.ts`/`limits.ts`, so it can be unit-tested.
4. **`src/shared/protocol.ts`**:
   - `PageRequest` gets `{ kind: "models"; id }`, with `FIELDS.models = []`.
   - `SessionOptions.model?: string`. `isSessionOptions` allows the key: a string of 1–256 chars with no control characters. The router only compares it against its own list, so it's never used as given.
   - Add the `ModelInfo` type.
5. **`src/background/policy.ts`**: `gate()` treats `models` as discovery, like `info`.
6. **`src/background/router.ts`**:
   - `siteModels(site, settings)`: gets `admin({ op: "status" })` (no local entries if the host fails), collects runnable allowed providers through `backendSpec` (try/catch, the same pattern as `backendChain`), then calls `listModels`.
   - `case "models"`: if the site is denied or has no `SiteConfig`, reply `[]`. Otherwise reply with `siteModels(...)` directly, without forwarding to the host.
   - `case "create"` with `options.model`: look the id up in `siteModels`. If it's missing, throw `LLMError("NotSupportedError", "Model … is not available to this site")`. Otherwise build a single-entry chain: local `{ ...spec, model: findModel(catalogId), engine: entry.engine }`, cloud `{ ...backendSpec(provider), model: cloudId }`. The consent dialog shows the model name. Forward the options without `model`.
   - Spend caps and the usage log already key on provider id (`sessionBackend`) and `describe().name` (the cloud model id), so the chosen model is priced correctly with no change.
7. **`src/offscreen/local-runtime.ts`**: two sites can now use different local models, and only one stays loaded. `LocalBackend.prepare()` and `countTokens()` call `ensure()` outside the FIFO, so they could unload a model mid-generation. Run both through the same queue as `generate()` (a small `runtime.serial(fn)` sharing `exclusive`'s queue). Switching models still reloads between turns. That's slow but correct, and the README will say so.
8. **`src/polyfill/polyfill.ts`**: `localLLM.models = () => request<ModelInfo[]>({ kind: "models" })`. `create()` passes `options.model` through after a `typeof === "string"` check, otherwise `TypeError`. Native Chrome ignores the unknown option.
9. **`packages/web/src/index.ts`**: `Found.models(): Promise<ModelInfo[]>` (`[]` for native), plus the exported type.
10. **`demo/index.html`**: show the `models()` table next to the existing `info()` output.

## Docs

- README §11 "Model information": `models()` example and `ModelInfo` fields, `create({ model })`, site scoping, and the notes that pages still send text only (`input` describes the model) and that switching local models reloads weights. Add rows to the API table and replace "Your site can't select them".
- CLAUDE.md "Rules that matter": the page may name a model only through `create({ model })`, and the router accepts only ids from its own `siteModels` list for that origin.
- BUILD_PLAN line 143 (model hint in v2): note it's done this way. STATUS: new section.

## Tests

- **`test/models.test.ts`** (new): downloaded-only filtering; a build that can't run on caps is dropped (WebLLM without WebGPU); engine choice; nano gating; echo listed when configured; cloud curated list plus an uncurated configured id (`price: null`, 128K); providers not in `allowedBackends` excluded; `default` flag; `inputQuota`/`maxOutputTokens` capping; `parseModelId` with OpenRouter ids such as `x/y:free`.
- **`test/protocol.test.ts`**: `models` request valid and with extra fields rejected; `create.options.model` accepted, and rejected when non-string, empty or too long.
- **`test/policy.test.ts`**: `models` allowed as discovery and denied for unpermitted sites. **`test/catalog.test.ts`**: `resolveEngine`.
- **`e2e/extension.spec.ts`** (echo engine): `models()` returns `local:echo-test` with `default: true`; `create({ model: "local:echo-test" })` round-trips; an unknown id rejects with `NotSupportedError`. A site whose `allowedBackends` includes a custom localhost provider lists it (no network call), and an enabled provider not allowed for the site is absent. A denied site gets `[]`.

## Verification

`npm run typecheck && npm test && npm run test:e2e`. Then a manual check: load `dist/`, download one small local model in options, enable a site and the demo page, and confirm that `localLLM.models()` lists only that model, plus cloud models once a provider with a key is allowed for the site. Then `create({ model })` on a second downloaded model and confirm options shows it loaded. Update `docs/STATUS.md`.
