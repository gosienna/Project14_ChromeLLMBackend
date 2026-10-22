// Web search: result types, the Tavily → Google fallback rule, and Google results-page parsing.
// Pure logic; background/search.ts and background/google-search.ts supply the chrome side.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
}

/** An image found for the query. */
export interface ImageResult {
  /** The original image. */
  url: string;
  /** Tavily's description, or the image's alt text on Google. */
  description?: string;
  /** The page the image appears on, when known. */
  sourceUrl?: string;
  /** A small Google-hosted copy, when known. */
  thumbnail?: string;
  width?: number;
  height?: number;
}

export interface SearchResponse {
  query: string;
  provider: "tavily" | "google";
  results: SearchResult[];
  /** Only when images were asked for. */
  images?: ImageResult[];
  /** Why the fallback was used, when it was. */
  note?: string;
}

/** What the offscreen host's webSearch op resolves to. */
export type TavilyOutcome =
  | { ok: true; query: string; results: SearchResult[]; images?: ImageResult[] }
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

/** Google's Images tab. */
export function googleImagesUrl(query: string): string {
  return `https://www.google.com/search?${new URLSearchParams({ q: query, udm: "2", hl: "en" })}`;
}

/** What the in-page image collector returns, before cleanup. */
export interface GoogleImagesRaw {
  blocked: boolean;
  /** `["url",height,width]` triples from the page's inline data, in page order; urls still JSON-escaped. */
  data: Array<{ url: string; h: number; w: number }>;
  /** `/imgres?imgurl=…&imgrefurl=…` links (older layouts). */
  links: string[];
  /** Result thumbnails with their alt text. */
  thumbs: Array<{ src: string; alt: string }>;
}

/**
 * Runs in the Google Images tab via chrome.scripting.executeScript, so it must not reference
 * anything outside its own body. Google embeds each result's original image url in inline
 * script data as ["url",height,width], right after its thumbnail's triple.
 */
export function collectGoogleImages(): GoogleImagesRaw {
  const blocked =
    location.hostname.startsWith("consent.") ||
    location.pathname.startsWith("/sorry") ||
    !!document.querySelector('#captcha-form, form[action*="sorry"]');
  const data: GoogleImagesRaw["data"] = [];
  const re = /\["(https?:\/\/[^"\s]{8,2000}?)",(\d+),(\d+)\]/g;
  for (const s of Array.from(document.scripts)) {
    const text = s.textContent ?? "";
    for (const m of text.matchAll(re)) {
      data.push({ url: m[1], h: Number(m[2]), w: Number(m[3]) });
      if (data.length >= 400) break;
    }
  }
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/imgres?"]'), (a) => a.href).slice(0, 100);
  const thumbs = Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="https://encrypted-tbn"]'), (i) => ({ src: i.src, alt: i.alt })).slice(0, 100);
  return { blocked, data, links, thumbs };
}

const isGoogleHost = (host: string) => /(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)gstatic\.com$/.test(host);

function httpUrl(s: string | null | undefined): URL | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** Decode a JSON-escaped string from Google's inline data (\u003d, \/ and so on). */
function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

/**
 * Original image urls from the Images tab: inline data first (pairing each with the thumbnail
 * triple before it), then /imgres links, then bare thumbnails if nothing else was found.
 */
export function normalizeGoogleImages(raw: GoogleImagesRaw, max: number): ImageResult[] {
  const seen = new Set<string>();
  const out: ImageResult[] = [];
  const add = (img: ImageResult) => {
    if (out.length >= max || seen.has(img.url)) return;
    seen.add(img.url);
    out.push(img);
  };
  const alts = new Map(raw.thumbs.map((t) => [t.src, clean(t.alt)]));
  let thumb: string | undefined;
  for (const d of raw.data) {
    const u = httpUrl(unescapeJson(d.url));
    if (!u) continue;
    if (isGoogleHost(u.hostname)) {
      if (/(^|\.)gstatic\.com$/.test(u.hostname)) thumb = u.href;
      continue;
    }
    const description = thumb ? alts.get(thumb) : undefined;
    add({ url: u.href, ...(description ? { description } : {}), ...(thumb ? { thumbnail: thumb } : {}), width: d.w, height: d.h });
    thumb = undefined;
  }
  for (const href of raw.links) {
    const link = httpUrl(href) ?? httpUrl(new URL(href, "https://www.google.com").href);
    const img = httpUrl(link?.searchParams.get("imgurl"));
    if (!img || isGoogleHost(img.hostname)) continue;
    const source = httpUrl(link?.searchParams.get("imgrefurl"));
    add({ url: img.href, ...(source ? { sourceUrl: source.href } : {}) });
  }
  if (!out.length) {
    for (const t of raw.thumbs) {
      const u = httpUrl(t.src);
      const description = clean(t.alt);
      if (u) add({ url: u.href, ...(description ? { description } : {}), thumbnail: u.href });
    }
  }
  return out;
}
