// Google fallback for web search: open the results page in a minimized, unfocused window, read
// the results with chrome.scripting, close the window. One search at a time.

import { LLMError } from "../shared/errors";
import { collectGoogleResults, googleSearchUrl, normalizeGoogleResults, type GoogleRaw, type SearchResult } from "../shared/search";

export const GOOGLE_ORIGIN = "https://www.google.com/*";
const LOAD_TIMEOUT_MS = 15_000;

export async function googlePermitted(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [GOOGLE_ORIGIN] });
}

let queue: Promise<unknown> = Promise.resolve();

export function googleSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const run = queue.then(() => searchInWindow(query, maxResults));
  queue = run.catch(() => {});
  return run;
}

async function searchInWindow(query: string, maxResults: number): Promise<SearchResult[]> {
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
    return normalizeGoogleResults(raw, maxResults);
  } finally {
    if (win?.id !== undefined) await chrome.windows.remove(win.id).catch(() => {});
  }
}

function loaded(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      done();
      reject(new LLMError("NetworkError", "Google search page did not load in time"));
    }, LOAD_TIMEOUT_MS);
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") {
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
      if (t.status === "complete") {
        done();
        resolve();
      }
    }, () => {});
  });
}
