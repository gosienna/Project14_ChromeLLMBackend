// @local-llm/web: find a Prompt API implementation — Chrome's native LanguageModel or the
// Local LLM extension's — and fall back gracefully when neither is present.
//
//   import { getLanguageModel } from "@local-llm/web";
//   const lm = await getLanguageModel();
//   if (lm) { const s = await lm.LanguageModel.create(); console.log(await s.prompt("Hi")); }
//   else { /* call your server instead */ }

export type Availability = "unavailable" | "downloadable" | "downloading" | "available";
export type Source = "native" | "extension";

/** Minimal shape of the Prompt API's LanguageModel class. */
export interface LanguageModelStatic {
  availability(options?: object): Promise<Availability>;
  params?(): Promise<unknown>;
  create(options?: object): Promise<LanguageModelSession>;
}

export interface LanguageModelSession {
  prompt(input: unknown, options?: { signal?: AbortSignal }): Promise<string>;
  promptStreaming(input: unknown, options?: { signal?: AbortSignal }): ReadableStream<string>;
  measureInputUsage?(input: unknown): Promise<number>;
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
  readonly inputUsage?: number;
  readonly inputQuota?: number;
}

export interface ExtensionInfo {
  name: string;
  backend: string;
  version: string;
}

export interface Found {
  LanguageModel: LanguageModelStatic;
  source: Source;
  /** Model and backend details when the extension provides the API. */
  info(): Promise<ExtensionInfo | null>;
}

type Win = { LanguageModel?: LanguageModelStatic; localLLM?: { info(): Promise<ExtensionInfo> } };

const win = (): Win | undefined => (typeof window === "undefined" ? undefined : (window as unknown as Win));

function current(): Found | null {
  const w = win();
  if (!w?.LanguageModel) return null;
  const ext = w.localLLM;
  return {
    LanguageModel: w.LanguageModel,
    // The extension never shadows a native implementation unless the user opts in, in which
    // case window.localLLM is present alongside it.
    source: ext ? "extension" : "native",
    info: async () => (ext ? ext.info() : null),
  };
}

/** Synchronous check: which implementation, if any, is present right now. */
export function detect(): Source | null {
  return current()?.source ?? null;
}

/**
 * Resolve with the available implementation, waiting up to `timeout` ms for the extension's
 * stub (it is injected at document_start, so this is usually immediate). Null if none.
 */
export function getLanguageModel({ timeout = 500 }: { timeout?: number } = {}): Promise<Found | null> {
  const found = current();
  const w = win();
  if (found || !w) return Promise.resolve(found);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("localllm:ready", done);
      resolve(current());
    };
    const timer = setTimeout(done, timeout);
    window.addEventListener("localllm:ready", done);
  });
}

export interface CreateOrFallbackOptions<T> {
  /** Passed to LanguageModel.create(). */
  create?: object;
  /** Called when no model is usable (missing, unavailable, or the user denied access). */
  fallback: (reason: string) => T | Promise<T>;
  timeout?: number;
}

/** Create a session if possible, otherwise run the fallback. */
export async function createOrFallback<T>(opts: CreateOrFallbackOptions<T>): Promise<LanguageModelSession | T> {
  const found = await getLanguageModel({ timeout: opts.timeout });
  if (!found) return opts.fallback("no-implementation");
  try {
    if ((await found.LanguageModel.availability()) === "unavailable") return opts.fallback("unavailable");
    return await found.LanguageModel.create(opts.create);
  } catch (e) {
    return opts.fallback(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}
