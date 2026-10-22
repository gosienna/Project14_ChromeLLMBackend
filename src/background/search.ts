// Web search for the playground and for sites with web search on: Tavily when it's set up and
// working, otherwise a Google results page. Dependencies are injected so the choice is unit-tested.

import { LLMError } from "../shared/errors";
import { fallbackNote, tavilyFallback, type ImageResult, type SearchResponse, type SearchResult, type TavilyFailure, type TavilyOutcome } from "../shared/search";

export interface SearchDeps {
  /** The Tavily key, or null. Throws when the key store is locked. */
  tavilyKey(): Promise<string | null | undefined>;
  tavilyPermitted(): Promise<boolean>;
  /** The offscreen host's webSearch op. */
  tavily(apiKey: string, query: string, maxResults: number, includeImages: boolean): Promise<TavilyOutcome>;
  googlePermitted(): Promise<boolean>;
  /** `images` is null when the Images tab couldn't be read. */
  google(query: string, maxResults: number, includeImages: boolean): Promise<{ results: SearchResult[]; images?: ImageResult[] | null }>;
}

export interface SearchOptions {
  /** Also return image urls: Tavily's images, or Google's Images tab. */
  includeImages?: boolean;
}

export async function runSearch(query: string, maxResults: number, deps: SearchDeps, { includeImages = false }: SearchOptions = {}): Promise<SearchResponse> {
  query = query.trim();
  if (!query) throw new LLMError("DataError", "web search requires a non-empty query");
  const why = await tryTavily(query, maxResults, deps, includeImages);
  if ("provider" in why) return why;
  if (!tavilyFallback(why.failure)) throw new LLMError("DataError", why.message);
  if (!(await deps.googlePermitted())) {
    const tavilyPart = why.failure === "nokey" ? "No Tavily API key" : why.message;
    throw new LLMError("NotAllowedError", `${tavilyPart}, and the Google search fallback is not granted (extension options → Tools)`);
  }
  const found = await deps.google(query, maxResults, includeImages);
  const note = fallbackNote(why.failure);
  if (!includeImages) return { query, provider: "google", results: found.results, note };
  const images = found.images ?? [];
  return { query, provider: "google", results: found.results, images, note: found.images ? note : `${note}; Google image results unavailable` };
}

async function tryTavily(query: string, maxResults: number, deps: SearchDeps, includeImages: boolean): Promise<SearchResponse | { failure: TavilyFailure; message: string }> {
  let key: string | null | undefined;
  try {
    key = await deps.tavilyKey();
  } catch {
    return { failure: "locked", message: "Key store is locked" };
  }
  if (!key) return { failure: "nokey", message: "No Tavily API key" };
  if (!(await deps.tavilyPermitted())) return { failure: "nopermission", message: "Permission to reach api.tavily.com has not been granted" };
  const out = await deps.tavily(key, query, maxResults, includeImages);
  if (out.ok) return { query: out.query, provider: "tavily", results: out.results, ...(includeImages ? { images: out.images ?? [] } : {}) };
  return { failure: out.status, message: out.message };
}
