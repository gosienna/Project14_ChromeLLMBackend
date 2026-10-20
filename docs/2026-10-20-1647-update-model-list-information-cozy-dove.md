# Cloud model catalog per provider

## Context

Cloud providers today carry one `defaultModel` string each ([providers.ts](src/shared/providers.ts)), and several are stale (`gpt-4o-mini`, `grok-3-mini` and `deepseek-chat` are no longer on xAI's/DeepSeek's model lists). The options page has a free-text model box with no information, and `CloudBackend` claims 128k context, image input and native tools for every model ([cloud-backend.ts:19-49](src/offscreen/cloud-backend.ts#L19-L49)). The user wants a curated model list per provider showing input → output modalities, reasoning, tool support and current price, with prices researched now (2026-10-20).

Decisions taken: OpenRouter gets a curated static list like the rest; each provider lists its current lineup plus commonly used still-served legacy models (~5–9 each).

## Data: new `src/shared/cloud-models.ts`

```ts
export interface CloudModel {
  id: string;            // API model id sent to the provider
  name: string;
  input: Array<"text" | "image" | "audio" | "video" | "pdf">;   // output is always text
  contextWindow: number;
  maxOutput?: number;
  /** "hybrid": can be turned off; "always": cannot. */
  reasoning?: "hybrid" | "always";
  /** Tool calling through this extension's adapter (OpenAI = Chat Completions). "prompted" uses PromptedTools. */
  tools: "native" | "prompted";
  /** USD per 1M tokens, standard tier, short prompts. */
  price: { input: number; output: number; cachedInput?: number;
           long?: { above: number; input: number; output: number };   // prompt-length tier
           note?: string };   // e.g. "off-peak half price", "rises Dec 1, 2026"
  legacy?: boolean;
}
export const CLOUD_MODELS: Record<string, CloudModel[]>;   // keyed by provider id
export const PRICES_AS_OF = "2026-10-20";
export function findCloudModel(providerId: string, modelId: string): CloudModel | undefined;
export function priceLabel(m: CloudModel): string;      // "$2 / $10 per 1M"
export function cloudIoLabel(m: CloudModel): string;    // "text+image→text", matches catalog.ts ioLabel style
```

Header comment cites the source pages and the as-of date, matching `catalog.ts`'s style of documenting where facts came from.

### Researched contents (verified from provider pages unless noted)

**Anthropic** (all: text+image in, 1M ctx, 128K out, native tools)
| id | reasoning | $ in / out | notes |
|---|---|---|---|
| claude-fable-5-1 | always | 10 / 50 | cache 0.25 |
| claude-opus-5-5 | always | 4 / 20 | cache 0.20 |
| claude-sonnet-5-5 | hybrid | 2 / 10 | cache 0.10 |
| claude-haiku-5-5 (default) | hybrid | 0.10 / 0.50 | >100K prompt: 0.50 / 2.50 |
| claude-opus-5 (legacy) | hybrid | 5 / 25 | |
| claude-sonnet-4-6 (legacy) | hybrid | 3 / 15 | |
| claude-haiku-4-5 (legacy) | hybrid | 1 / 5 | 200K ctx, 64K out |

**OpenAI** (text+image in, text out). Chat Completions caveat from model pages: GPT-6.1 Sol has no tool calls on Chat Completions; GPT-6 Luna only with effort `none`. Those get `tools: "prompted"`.
| id | ctx | reasoning | tools | $ in / out | long (>272K) |
|---|---|---|---|---|---|
| gpt-6-astra | 1.05M | always | prompted* | 10 / 50 | 20 / 75 |
| gpt-6.1-sol | 1.05M | always | prompted | 2 / 10 | 4 / 15 |
| gpt-6-luna (default) | 1.05M | hybrid | prompted | 0.10 / 0.50 | 0.20 / 0.75 |
| gpt-5.6-terra | 1.05M | hybrid | native | 2 / 12 | 4 / 18 |
| gpt-5.6-luna | 1.05M | hybrid | native | 0.20 / 1.20 | 0.40 / 1.80 |
| gpt-5.4-mini (legacy) | 400K | hybrid | native | 0.75 / 4.50 | |
| gpt-4.1-mini (legacy) | 1M | — | native | 0.40 / 1.60 | |
| gpt-4o-mini (legacy) | 128K | — | native | 0.15 / 0.60 | |

\*Astra's page doesn't say whether tools work on Chat Completions; I'll check it at implementation with a one-line curl against the docs. If it's still unclear, it stays `prompted`, which works either way. I'll also confirm context sizes for 5.4-mini and 4.1-mini from their model pages.

**Google Gemini** (text+image+audio+video+pdf in, native tools, all thinking)
| id | ctx / out | $ in / out | notes |
|---|---|---|---|
| gemini-4-argon | 1M / 64K | 2 / 10 | rises to 4 / 20 on Dec 1, 2026 |
| gemini-3.8-flash (default) | 1M / 64K | 0.75 / 3.75 | rises to 1.50 / 7.50 on Jan 1, 2027 |
| gemini-3.5-flash-lite | 1M / 64K | 0.30 / 2.50 | |
| gemini-3.1-flash-lite | 1M / 64K | 0.25 / 1.50 | |
| gemini-3.1-pro-preview | 1M / 64K | 2 / 12 | >200K: 4 / 18 |
| gemini-2.5-flash (legacy) | 1M / 64K | 0.30 / 2.50 | access limited to existing users |
| gemini-2.5-flash-lite (legacy) | 1M / 64K | 0.10 / 0.40 | same |

**xAI** (text+image in, native tools)
| id | ctx | reasoning | $ in / out | ≥200K |
|---|---|---|---|---|
| grok-4.7 | 500K | always | 2 / 6 | 4 / 12 |
| grok-4.3 (default) | 1M | hybrid (default low) | 1.25 / 2.50 | 2.50 / 5 |
| grok-4.20-0309-reasoning | 1M | always | 1.25 / 2.50 | 2.50 / 5 |
| grok-4.20-0309-non-reasoning | 1M | — | 1.25 / 2.50 | 2.50 / 5 |

**DeepSeek** (1M ctx, 384K out, native tools, hybrid thinking). The official page lists prices in CNY; the USD figures come from aggregators and match the CNY ratio.
| id | input | $ in / out (peak) | note |
|---|---|---|---|
| deepseek-flash (default) | text+image | 0.30 / 1.20 | off-peak half price |
| deepseek-v4-pro | text | 1.32 / 3.96 | off-peak half price |

**OpenRouter**: `openrouter/auto` (price shown as "varies by routed model") plus ~5 routes: Claude Sonnet 5.5, GPT-6.1 Sol, Gemini 3.8 Flash, Grok 4.7, Kimi K3 / Qwen3.8 Max. At implementation I'll pull the exact ids, context, modalities, `supported_parameters` (tools/reasoning) and per-token prices with `curl -s https://openrouter.ai/api/v1/models | jq`, because WebFetch returned a variant of that endpoint without pricing.

## Wiring

1. **[providers.ts](src/shared/providers.ts)**: set `defaultModel` to the defaults marked above (anthropic: claude-haiku-5-5; openai: gpt-6-luna; gemini: gemini-3.8-flash; xai: grok-4.3; deepseek: deepseek-flash; openrouter: openrouter/auto).
2. **[settings.ts](src/shared/settings.ts) normalize**: map the retired stored ids `grok-3-mini` → `grok-4.3` and `deepseek-chat`/`deepseek-reasoner` → `deepseek-flash` for built-in providers. Other stored ids, including custom ones, are left alone.
3. **[cloud-backend.ts](src/offscreen/cloud-backend.ts)**: look up `findCloudModel(provider.id, model)`. When the model is known, `contextWindow()`, `acceptsImages()` and `toolMode()` come from it. Unknown models and custom providers keep today's values (128K / true / native). The offscreen host has no storage, but the catalog is bundled static data, so no new message fields are needed. Prompted tools already work for any backend via `withTools` ([with-tools.ts:10](src/offscreen/tools/with-tools.ts#L10)).
4. **[options.ts](src/ui/options.ts) cloud section**: replace the free-text "Default model" input with a `<select>` grouped as Current / Legacy. Option labels follow the local picker's format ([options.ts:152](src/ui/options.ts#L152)): `name · text+image→text · tools · reasoning · $in/$out`. A last option, "Custom model ID…", reveals the existing text input, and a stored id that isn't in the list selects it automatically. Under the table, a per-provider details table (Model, Input → output, Context, Reasoning, Tools, Price per 1M in/out, notes) for the enabled or expanded provider, plus a "Prices as of 2026-10-20, standard tier, USD — check the provider's pricing page" line. Custom endpoints keep the text input only.
5. **[playground.ts:190](src/ui/playground.ts#L190)**: show the model's `name` when it's known.
6. **Docs**: README cloud-provider section gets the default models and a pointer to the in-app table; STATUS.md Phase 4 gets a line about the curated catalog and per-model capabilities.

Reasoning is shown as information only. The cloud adapters send no thinking or effort parameters and don't parse reasoning streams. That's a separate change, and I'll mention it rather than do it.

## Tests

- New `test/cloud-models.test.ts`: every built-in provider's `defaultModel` is in its list; ids are unique per provider; prices are non-negative and `long.above > 0`; `priceLabel`/`cloudIoLabel` formatting; `findCloudModel` for unknown ids.
- `CloudBackend`: known model → catalog context, images and tool mode; e.g. gpt-6.1-sol → `prompted`, deepseek-v4-pro → no images. Unknown → fallbacks.
- settings normalize migrates `grok-3-mini` and `deepseek-chat`.

## Verification

- `npm run typecheck && npm test`
- `npm run test:e2e`. The playground spec touches backend listing; the echo engine is unaffected.
- `npm run build`, load `dist/` unpacked, open Options → Cloud providers: check the grouped dropdown, the details table, and that "Custom model ID…" round-trips a free-text id. In the playground, an enabled provider shows the friendly model name.
