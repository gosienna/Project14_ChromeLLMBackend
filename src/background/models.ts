// The models a site can run right now, for localLLM.models() and create({ model }). Pure logic
// so it can be unit-tested; router.ts supplies the settings, the host's download state and the
// providers that have a key and host permission.

import { CATALOG, ENGINE_PREFERENCE, canRun, contextLimit, findModel, resolveEngine, takesImages, toolMode, type CatalogModel, type DeviceCaps, type EngineId } from "../shared/catalog";
import { PRICES_AS_OF, UNLISTED_CONTEXT, cloudModels, type CloudModel } from "../shared/cloud-models";
import type { ModelInfo } from "../shared/protocol";
import type { ProviderDef } from "../shared/providers";
import { effectiveMaxContext, effectiveMaxOutput, type Settings, type SiteConfig } from "../shared/settings";

export interface ModelListInput {
  settings: Settings;
  site: SiteConfig;
  /** The host's status; null when it could not be reached (no local models are listed then). */
  host: { caps: DeviceCaps; downloaded: string[]; nano: boolean } | null;
  /** Providers from the site's allowed backends that are enabled, have a key and host permission. */
  providers: ProviderDef[];
}

/** The local model the router uses when the setting names no catalog model. */
export const FALLBACK_LOCAL_MODEL = "qwen2.5-0.5b-instruct";

export function configuredLocalModel(settings: Settings): CatalogModel {
  return findModel(settings.local.modelId) ?? findModel(FALLBACK_LOCAL_MODEL)!;
}

/** "anthropic:claude-haiku-5-5" -> backend and model id. Provider ids never contain ":"; model ids may. */
export function parseModelId(id: string): { backend: string; model: string } | null {
  const i = id.indexOf(":");
  return i > 0 && i < id.length - 1 ? { backend: id.slice(0, i), model: id.slice(i + 1) } : null;
}

const ENGINES: EngineId[] = [...ENGINE_PREFERENCE, "nano", "dummy"];

function localModels({ settings, site, host }: ModelListInput): ModelInfo[] {
  if (!host || !site.allowedBackends.includes("local")) return [];
  const { caps, downloaded, nano } = host;
  const configured = configuredLocalModel(settings);
  const maxContext = effectiveMaxContext(settings.limits);
  const maxOutputTokens = effectiveMaxOutput(settings.limits);
  const out: ModelInfo[] = [];
  for (const model of CATALOG) {
    // Same rules as LocalRuntime.availability: weights on disk and a build this device can run.
    const ready = (e: EngineId) =>
      e === "dummy"
        ? !!model.dummy && model.id === configured.id
        : canRun(model, e, caps) && downloaded.includes(`${e}:${model.id}`) && (e !== "nano" || nano);
    const resolved = resolveEngine(model, settings.local.enginePin[model.id] ?? "auto", caps);
    const engine = resolved && ready(resolved) ? resolved : ENGINES.find(ready);
    if (!engine) continue;
    const contextWindow = contextLimit(model, engine);
    const inputQuota = Math.min(contextWindow, maxContext);
    out.push({
      id: `local:${model.id}`,
      name: model.name,
      backend: "local",
      provider: "Local",
      engine,
      default: site.backend === "local" && model.id === configured.id && engine === resolved,
      input: takesImages(model, engine) ? ["text", "image"] : ["text"],
      output: ["text"],
      contextWindow,
      inputQuota,
      maxOutputTokens: Math.min(maxOutputTokens, inputQuota),
      ...(model.reasoning ? { reasoning: model.reasoning } : {}),
      tools: toolMode(model, engine),
      price: { input: 0, output: 0 },
      ...(model.sizeMB ? { sizeMB: model.sizeMB } : {}),
    });
  }
  return out;
}

function cloudEntry(provider: ProviderDef, m: CloudModel, isDefault: boolean, settings: Settings): ModelInfo {
  const inputQuota = Math.min(m.maxInput ?? m.contextWindow, effectiveMaxContext(settings.limits));
  return {
    id: `${provider.id}:${m.id}`,
    name: m.name,
    backend: provider.id,
    provider: provider.name,
    default: isDefault,
    input: m.input,
    output: ["text"],
    contextWindow: m.contextWindow,
    inputQuota,
    maxOutputTokens: Math.min(m.maxOutput ?? Infinity, effectiveMaxOutput(settings.limits), inputQuota),
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    tools: m.tools,
    price: m.price ? { ...m.price, asOf: PRICES_AS_OF } : null,
    ...(m.legacy ? { legacy: true } : {}),
  };
}

function providerModels(provider: ProviderDef, { settings, site }: ModelListInput): ModelInfo[] {
  const configured = settings.providers[provider.id]?.model || provider.defaultModel;
  const curated = cloudModels(provider.id);
  // A custom endpoint or a typed id: CloudBackend's defaults for models outside the list.
  const unlisted: CloudModel[] = curated.some((m) => m.id === configured)
    ? []
    : [{ id: configured, name: configured, input: ["text", "image"], contextWindow: UNLISTED_CONTEXT, tools: "native" }];
  return [...unlisted, ...curated].map((m) => cloudEntry(provider, m, site.backend === provider.id && m.id === configured, settings));
}

/** Runnable models for the site, its default first, then in the order of its allowed backends. */
export function listModels(input: ModelListInput): ModelInfo[] {
  const byBackend = new Map<string, ModelInfo[]>([["local", localModels(input)]]);
  for (const p of input.providers) byBackend.set(p.id, providerModels(p, input));
  const list = input.site.allowedBackends.flatMap((b) => byBackend.get(b) ?? []);
  return [...list.filter((m) => m.default), ...list.filter((m) => !m.default)];
}
