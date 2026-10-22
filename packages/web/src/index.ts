// @local-llm/web: find a Prompt API implementation — Chrome's native LanguageModel or the
// Local LLM extension's — and fall back gracefully when neither is present.
//
//   import { getLanguageModel } from "@local-llm/web";
//   const lm = await getLanguageModel();
//   if (lm) { const s = await lm.LanguageModel.create(); console.log(await s.prompt("Hi")); }
//   else { /* call your server instead */ }
//
// With web search (the user allows it per site in the extension's options):
//   const tool = lm && webSearchTool(lm);
//   const s = await lm.LanguageModel.create({ tools: tool ? [tool] : [] });

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

/** A model the site can run now, from the extension's localLLM.models(). */
export interface ModelInfo {
  /** Pass to LanguageModel.create({ model }). */
  id: string;
  name: string;
  /** "local" or a provider id. */
  backend: string;
  provider: string;
  engine?: string;
  /** What create() uses without a `model`. */
  default: boolean;
  /** What the model takes ("text", "image", "audio", "video", "pdf"); pages send text only. */
  input: string[];
  output: string[];
  contextWindow: number;
  /** Context a session gets. */
  inputQuota: number;
  maxOutputTokens: number;
  reasoning?: "hybrid" | "always";
  tools: "native" | "prompted";
  /** USD per million tokens; 0 for local models, null when unknown. */
  price: { input: number; output: number; cachedInput?: number; long?: { above: number; input: number; output: number }; note?: string; asOf?: string } | null;
  sizeMB?: number;
  legacy?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
}

/** An image found for the query (search with includeImages). */
export interface ImageResult {
  /** The original image. */
  url: string;
  description?: string;
  /** The page the image appears on, when known. */
  sourceUrl?: string;
  /** A small Google-hosted copy, when known. */
  thumbnail?: string;
  width?: number;
  height?: number;
}

/** localLLM.search() result: from Tavily, or from a Google results page when Tavily isn't usable. */
export interface SearchResponse {
  query: string;
  provider: "tavily" | "google";
  results: SearchResult[];
  /** Only when includeImages was set: Tavily's images, or Google's Images tab. */
  images?: ImageResult[];
  /** Why the Google fallback was used. */
  note?: string;
}

export interface SearchOptions {
  maxResults?: number;
  /** Also return image urls. */
  includeImages?: boolean;
  signal?: AbortSignal;
}

/** A page-declared tool for LanguageModel.create({ tools }); execute() runs in the page. */
export interface ToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface Found {
  LanguageModel: LanguageModelStatic;
  source: Source;
  /** Model and backend details when the extension provides the API. */
  info(): Promise<ExtensionInfo | null>;
  /** Models the site can run now; empty with Chrome's native API, which has one model. */
  models(): Promise<ModelInfo[]>;
  /**
   * Web search through the extension, when the user allowed it for this site. Null with
   * Chrome's native API or an extension version without search.
   */
  search: ((query: string, options?: SearchOptions) => Promise<SearchResponse>) | null;
  /**
   * Download an image that this site's search returned (search with includeImages), to keep a
   * copy. Null without an extension version that supports it.
   */
  fetchImage: ((url: string, options?: { signal?: AbortSignal }) => Promise<FetchedImage>) | null;
}

export interface FetchedImage {
  url: string;
  type: string;
  blob: Blob;
}

type Win = {
  LanguageModel?: LanguageModelStatic;
  localLLM?: {
    info(): Promise<ExtensionInfo>;
    models?(): Promise<ModelInfo[]>;
    search?(query: string, options?: SearchOptions): Promise<SearchResponse>;
    fetchImage?(url: string, options?: { signal?: AbortSignal }): Promise<FetchedImage>;
  };
};

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
    models: async () => (ext?.models ? ext.models() : []),
    search: ext?.search ? (query, options) => ext.search!(query, options) : null,
    fetchImage: ext?.fetchImage ? (url, options) => ext.fetchImage!(url, options) : null,
  };
}

/**
 * A web_search tool backed by `found.search`, for LanguageModel.create({ tools }). The model
 * calls it during prompt(); results come back as JSON with title, url and snippet.
 */
export function webSearchTool(found: Found, { name = "web_search", maxResults = 5 }: { name?: string; maxResults?: number } = {}): ToolDeclaration | null {
  const search = found.search;
  if (!search) return null;
  return {
    name,
    description:
      "Search the web. Returns a JSON list of results with title, url and snippet, plus image urls when include_images is set. Use it for current events or facts you are unsure of, and cite the urls you use.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max_results: { type: "integer", minimum: 1, maximum: 10, description: `How many results (default ${maxResults})` },
        include_images: { type: "boolean", description: "Also return image urls for the query" },
      },
      required: ["query"],
    },
    execute: async (args) =>
      JSON.stringify(await search(String(args.query ?? ""), { maxResults: Number(args.max_results) || maxResults, includeImages: args.include_images === true })),
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
