// Web search: result types, the Tavily → Google fallback rule, and Google results-page parsing.
// Pure logic; background/search.ts and background/google-search.ts supply the chrome side.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
}

export interface SearchResponse {
  query: string;
  provider: "tavily" | "google";
  results: SearchResult[];
  /** Why the fallback was used, when it was. */
  note?: string;
}

/** What the offscreen host's webSearch op resolves to. */
export type TavilyOutcome =
  | { ok: true; query: string; results: SearchResult[] }
  | { ok: false; status: number | "network"; message: string };

/** Why Tavily was skipped or failed: an HTTP status, a network error, or it isn't set up. */
export type TavilyFailure = number | "network" | "nokey" | "nopermission" | "locked";

/**
 * True when the Google fallback should be tried. Missing setup, auth, quota and network failures
 * fall back; a request Tavily rejected as malformed (400, 422) would fail on Google too.
 */
export function tavilyFallback(why: TavilyFailure): boolean {
  if (typeof why !== "number") return true;
  return why === 401 || why === 403 || why === 429 || why === 432 || why === 433 || why >= 500;
}

export function fallbackNote(why: TavilyFailure): string {
  switch (why) {
    case "nokey":
      return "No Tavily API key; results from Google";
    case "nopermission":
      return "Tavily permission not granted; results from Google";
    case "locked":
      return "Key store is locked; results from Google";
    case "network":
      return "Tavily unreachable; results from Google";
    case 401:
    case 403:
      return "Tavily rejected the API key; results from Google";
    case 429:
    case 432:
    case 433:
      return "Tavily usage limit reached; results from Google";
    default:
      return `Tavily error ${why}; results from Google`;
  }
}

export const MAX_SNIPPET = 300;

export function googleSearchUrl(query: string, maxResults: number): string {
  const q = new URLSearchParams({ q: query, num: String(Math.min(20, maxResults + 3)), hl: "en" });
  return `https://www.google.com/search?${q}`;
}

/** What the in-page collector returns, before cleanup. */
export interface GoogleRaw {
  blocked: boolean;
  items: Array<{ href: string; title: string; snippet: string }>;
}

/**
 * Runs in the Google results tab via chrome.scripting.executeScript, so it must not reference
 * anything outside its own body. Collects candidates; normalizeGoogleResults cleans them up.
 */
export function collectGoogleResults(): GoogleRaw {
  const blocked =
    location.hostname.startsWith("consent.") ||
    location.pathname.startsWith("/sorry") ||
    !!document.querySelector('#captcha-form, form[action*="sorry"]');
  const items: GoogleRaw["items"] = [];
  const root = document.querySelector("#search, #rso, #main") ?? document.body;
  for (const h3 of Array.from(root.querySelectorAll("a h3"))) {
    const a = h3.closest("a");
    if (!a) continue;
    // The result block: the nearest ancestor that also holds the snippet.
    let block: Element | null = a;
    for (let i = 0; i < 6 && block && block.parentElement; i++) {
      block = block.parentElement;
      if (block.matches("[data-hveid], .g, .MjjYud")) break;
    }
    const sn = block?.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
    const title = (h3 as HTMLElement).innerText || h3.textContent || "";
    let snippet = (sn as HTMLElement | null)?.innerText ?? "";
    if (!snippet && block) snippet = ((block as HTMLElement).innerText || "").replace(title, "");
    items.push({ href: a.href, title, snippet });
  }
  return { blocked, items };
}

/** Unwrap /url?q= redirects, drop Google's own links and duplicates, trim to `max`. */
export function normalizeGoogleResults(raw: GoogleRaw, max: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of raw.items) {
    const url = unwrapGoogleHref(item.href);
    if (!url) continue;
    const host = new URL(url).hostname;
    if (/(^|\.)google\.[a-z.]+$/.test(host) || host.endsWith("googleusercontent.com")) continue;
    const key = url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    const title = clean(item.title);
    if (!title) continue;
    seen.add(key);
    out.push({ title, url, snippet: clean(item.snippet).slice(0, MAX_SNIPPET), score: null });
    if (out.length >= max) break;
  }
  return out;
}

function unwrapGoogleHref(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href, "https://www.google.com");
  } catch {
    return null;
  }
  if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === "/url") {
    const target = u.searchParams.get("q") ?? u.searchParams.get("url");
    return target ? unwrapGoogleHref(target) : null;
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
