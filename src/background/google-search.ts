// Google fallback for web search: open the results page in a minimized, unfocused window, read
// the results with chrome.scripting, close the window. One search at a time.

import { LLMError } from "../shared/errors";
import {
  collectGoogleImages,
  collectGoogleResults,
  googleImagesUrl,
  googleSearchUrl,
  normalizeGoogleImages,
  normalizeGoogleResults,
  type GoogleImagesRaw,
  type GoogleRaw,
  type ImageResult,
  type SearchResult,
} from "../shared/search";

export const GOOGLE_ORIGIN = "https://www.google.com/*";
const LOAD_TIMEOUT_MS = 15_000;

export async function googlePermitted(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [GOOGLE_ORIGIN] });
}

let queue: Promise<unknown> = Promise.resolve();

/** What a Google search found; `images` is null when the Images tab couldn't be read. */
export interface GoogleFound {
  results: SearchResult[];
  images?: ImageResult[] | null;
}

export function googleSearch(query: string, maxResults: number, includeImages = false): Promise<GoogleFound> {
  const run = queue.then(() => searchInWindow(query, maxResults, includeImages));
  queue = run.catch(() => {});
  return run;
}

async function searchInWindow(query: string, maxResults: number, includeImages: boolean): Promise<GoogleFound> {
  const win = await chrome.windows.create({ url: googleSearchUrl(query, maxResults), state: "minimized", focused: false, type: "normal" });
  const tabId = win?.tabs?.[0]?.id;
  try {
    if (tabId === undefined) throw new LLMError("OperationError", "Could not open a Google search window");
    await loaded(tabId);
    let raw: GoogleRaw | undefined;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: collectGoogleResults });
      raw = res?.result as GoogleRaw | undefined;
    } catch {
      // Redirected somewhere we can't script, e.g. consent.google.com.
      raw = { blocked: true, items: [] };
    }
    if (!raw || raw.blocked) {
      throw new LLMError("NetworkError", "Google asked for verification; open google.com once in Chrome, or add a Tavily key");
    }
    const results = normalizeGoogleResults(raw, maxResults);
    if (!includeImages) return { results };
    // Same tab, Images tab next. A failure here costs the images, not the search.
    const images = await imagesInTab(tabId, query, maxResults).catch(() => null);
    return { results, images };
  } finally {
    if (win?.id !== undefined) await chrome.windows.remove(win.id).catch(() => {});
  }
}

async function imagesInTab(tabId: number, query: string, maxResults: number): Promise<ImageResult[] | null> {
  const before = (await chrome.tabs.get(tabId)).url;
  await chrome.tabs.update(tabId, { url: googleImagesUrl(query) });
  await loaded(tabId, before);
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: collectGoogleImages });
  const raw = res?.result as GoogleImagesRaw | undefined;
  return !raw || raw.blocked ? null : normalizeGoogleImages(raw, maxResults);
}

/** Resolves when the tab has finished loading, on a page other than `leaving` if given. */
function loaded(tabId: number, leaving?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      done();
      reject(new LLMError("NetworkError", "Google search page did not load in time"));
    }, LOAD_TIMEOUT_MS);
    const moved = (url?: string) => leaving === undefined || url !== leaving;
    const listener = (id: number, info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === "complete" && moved(tab.url)) {
        done();
        resolve();
      }
    };
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    chrome.tabs.onUpdated.addListener(listener);
    // It may have finished before the listener was added.
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete" && moved(t.url)) {
        done();
        resolve();
      }
    }, () => {});
  });
}
