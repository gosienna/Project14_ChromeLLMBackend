# Web search: Google-tab fallback, site API, and Project15 tool

## Context
Project14 (Chrome LLM backend) has a Tavily `web_search` tool, but only the playground can use it, and it fails outright when there's no key or the quota runs out. Three changes:
1. When Tavily can't be used, fall back to opening a Google results page in a minimized window and scraping the results.
2. Let user-approved sites call search through the page API, so they can put it into their own LLM tool loop.
3. Give Project15 (LearnWithLLM) a `web_search` tool built on that API.

Your decisions: sites get access through a **per-site toggle, off by default**, and the Google fallback opens in a **minimized, unfocused window** that closes after extraction.

Note: both repos have uncommitted work (Project14: router, polyfill, protocol, bridge, limits; Project15: turn, tools, system-prompt, main…). Build on it and don't revert it.

Per Project14's CLAUDE.md, the first step after approval is to copy this plan to `Project14_ChromeLLMBackend/docs/<date +%Y-%m-%d-%H%M>-web-search-fallback.md`.

---

## Part A — Project14: search service with fallback

### A1. Shared search module: `src/background/search.ts` (new)
Move `webSearch()` out of `router.ts:526-536` into this module and extend it:
```ts
export interface SearchResult { title: string; url: string; snippet: string; score: number | null }
export interface SearchResponse { query: string; provider: "tavily" | "google"; results: SearchResult[]; note?: string }
export async function search(query: string, maxResults: number): Promise<SearchResponse>
```
- **Tavily first.** Use it when `getKey("tavily")` returns a key (catch a locked keystore and fall through) and `chrome.permissions.contains({origins:["https://api.tavily.com/*"]})` passes. Otherwise skip to Google.
- **Fall back to Google** when Tavily is skipped or comes back "unusable": a network error, or HTTP 401/403/429/432/433 (432/433 are Tavily's plan-limit and pay-as-you-go-limit codes). A 400 (bad query) is reported as an error, not a fallback.
- When the fallback happens, put the reason in `note` (e.g. "Tavily quota exhausted; results from Google").
- Put the decision in a pure, unit-tested function `tavilyFallback(status: number | "network" | "nokey"): boolean`, next to the Google parser.

### A2. Host returns Tavily status instead of a string
`src/offscreen/host.ts:377-386` `tavilySearch`: on a non-OK response, return `{ ok:false, status, message }` instead of throwing. Return `{ ok:true, query, results }` on success, and `{ok:false,status:"network"}` when `fetch` throws. Update the `webSearch` op's return type in `src/shared/host-protocol.ts:51`.

### A3. Google fallback (runs in the service worker, which has `tabs` and `scripting`)
`src/background/google-search.ts` (new):
- **Permission.** Requires the optional host permission `https://www.google.com/*`. Add it to `optional_host_permissions` in `src/manifest.json`; it is not required (store rule). Requesting `<all_urls>` would also cover it. If neither is granted, throw `NotAllowedError` ("Grant Google search fallback in options → Tools").
- **Window lifecycle:**
  - Open `chrome.windows.create({ url: "https://www.google.com/search?q=…&num=N&hl=en", state: "minimized", focused: false, type: "normal" })`.
  - Wait on `tabs.onUpdated` until `status === "complete"`, with a 15s timeout.
  - Extract with `chrome.scripting.executeScript({ target:{tabId}, func: extractGoogleResults, args:[max] })`.
  - Remove the window in `finally`.
- **Serialization.** Run Google searches one at a time through a small promise queue, so parallel tool calls don't open several windows.
- **Extractor `extractGoogleResults(max)`.** A self-contained function (it gets serialized into the page), in `src/shared/google-extract.ts` so it can be unit-tested against fixture HTML with happy-dom/linkedom:
  - Find `#search a:has(h3)` and read the title from `h3`.
  - Unwrap `/url?q=` hrefs.
  - Read the snippet from the closest result block (`[data-sncf], .VwiC3b`, or the block's `innerText` minus the title), capped at 300 chars.
  - Drop google.com links and duplicates.
  - Detect a CAPTCHA or consent page (`form[action*="sorry"]`, `#captcha-form`, host `consent.google.com`) and return `{blocked:true}`. That becomes a `NetworkError`-style message: "Google asked for verification; open google.com once or add a Tavily key".

### A4. Playground uses the same service
Change the `tool:web_search` case in `router.ts:520` to call `search()`, so the playground gets the fallback too. Update the `web_search` tool description in `src/ui/tools/builtin.ts:42-56` to mention the fallback.

### A5. Page API: new `search` request kind
- **`src/shared/protocol.ts`:**
  - Add `{ kind:"search"; id; query: string; maxResults: number }` to `PageRequest`, and its fields to `FIELDS`.
  - Validate in `parsePageRequest`: `query` must be a non-empty string of at most 500 chars, and `maxResults` an integer from 1 to 10.
  - Keep the extra-fields rejection.
- **`src/shared/settings.ts`:** add `SiteConfig.webSearch?: boolean` (absent means off). Leave `defaultSite` unchanged.
- **`src/background/policy.ts` `gate`:** add `search` as a kind. It needs a permitted site, `consent === "always"` or a once grant, and `site.webSearch === true`. Otherwise deny with "Web search is not enabled for this site (extension options → Sites)". Unit test in `test/policy.test.ts`.
- **`src/background/limits.ts`:** add a per-origin search rate limit (10 per minute), reusing the `TokenRateLimiter` pattern with cost 1. Exceeding it throws `QuotaExceededError`.
- **`router.ts` `handlePageRequest`:** `case "search"` calls `search(req.query, req.maxResults)` and replies `{kind:"result", value}`. Errors go through `LLMError` with DOMException names: `NotAllowedError` when no provider is usable, `NetworkError` when blocked or timed out. Don't add `search` to `PLAYGROUND_KINDS`; the playground keeps its own message.
- **`src/bridge/bridge.ts`:** forward the new kind if the bridge filters kinds.
- **`src/polyfill/polyfill.ts`:** add to `localLLM`:
  ```ts
  search: (query: string, { maxResults = 5 } = {}) => request<SearchResponse>({ kind:"search", query, maxResults }),
  /** Ready-made tool declaration for LanguageModel.create({ tools }). */
  webSearchTool: (opts?: { maxResults?: number; name?: string }) => ({ name: "web_search", description: "…", inputSchema: {…}, execute: async ({query, max_results}) => JSON.stringify(await localLLM.search(query, {maxResults: max_results ?? opts?.maxResults})) }),
  ```
  `webSearchTool` keeps the rule that pages only get tools they declare: the page passes the tool in itself, and its `execute` runs in the page, so the existing 8-round host loop works unchanged. Expose `localLLM.capabilities = { search: true }` for feature detection.
- **`packages/web/src/index.ts`:** add `SearchResponse` types, `Found.search?`, and a `webSearchTool()` helper that wraps `found.search`, with a test in `packages/web/test/web.test.ts`.

### A6. Options UI
- **`src/ui/options.ts` sites section (near l.106):** a "Web search" checkbox per site that writes `webSearch` with `updateSite`.
- **`toolsSection` (l.395-423):** a "Google search fallback" row with a Grant button. The button calls `chrome.permissions.request({origins:["https://www.google.com/*"]})` from the click handler, shows the status, and explains that searches open a minimized window.

### A7. Docs
- **CLAUDE.md "Rules that matter":** revise the tools rule. The extension's tools stay playground-only, except `localLLM.search()`, which is gated per site (`SiteConfig.webSearch`, off by default), rate-limited, and run by the router (Tavily through the host, Google through a minimized tab in the service worker).
- **README:** API section, plus a `webSearchTool()` example in the inference loop.
- **`docs/STATUS.md`:** mark the item done.

### A8. Tests
- **Unit:**
  - `test/protocol.test.ts`: the search request is accepted, and bad or extra fields are rejected.
  - `test/policy.test.ts`: the `webSearch` gate.
  - `test/search.test.ts`: `tavilyFallback` and provider selection, with the Tavily op, key lookup, and Google runner injected as dependencies (the same injection style as `keystore`).
  - `test/google-extract.test.ts`: fixture HTML, unwrapping `/url?q=`, and CAPTCHA detection.
- **e2e:**
  - New `e2e/search.spec.ts`. In test builds, a `__TEST__` hook `setSearchStub` replaces the Google runner (no real Google access in CI).
  - Assert that `localLLM.search()` is denied without `webSearch`, works with it, and that `webSearchTool()` gets through a `/tool web_search {...}` echo-engine round.
- **Commands:** `npm run typecheck && npm test && npm run test:e2e`.

---

## Part B — Project15 (LearnWithLLM): web search tool

- **`src/types.ts`:** extend the `localLLM` type in `BackendWindow` (`src/llm/backend.ts:37-42`) with `search?(q, {maxResults}): Promise<SearchResponse>` and `capabilities?`, and add `SearchResponse`.
- **`src/llm/backend.ts`:** `searchAvailable(win)` returns true when `typeof win.localLLM?.search === "function"`.
- **`src/llm/tools.ts`:**
  - Add a `web_search` spec to `WHITEBOARD_TOOL_SPECS` (input `{query, max_results?}`) and `WHITEBOARD_TOOL_INFO`.
  - Its `execute` calls `host.search(query, max)` through `wrap()`.
  - Return compact JSON with a numbered list: title, url, and snippet (≤300 chars), plus `provider`/`note`, so it stays under the local-model result cap.
  - Add `search?: (q, n) => Promise<SearchResponse>` to `ToolHost` (l.16-27).
  - Only add the tool when `host.search` is set.
- **`src/llm/turn.ts`:**
  - Add `webSearch?: boolean` to `AskOptions` (l.87-92).
  - In `ask()` (l.269-290), when the setting is on and `searchAvailable(window)` is true, pass `search: (q,n) => window.localLLM!.search!(q,{maxResults:n})` to `createWhiteboardTools`.
  - If the site isn't allowed, the `NotAllowedError` comes back as the tool's error result. Map it in `errorNote` to "Enable Web search for this site in the extension options".
- **`src/llm/system-prompt.ts`:** when search is on, add a short `# Web search` section to `INSTRUCTIONS`: use `web_search` for current or unknown facts, then put a "Sources" list with links on the board.
- **UI:**
  - **Toolbar** (`src/ui/shell.ts:88`): a "Web search" toggle stored in localStorage (`learn-with-llm.webSearch`, using the `ui/mode.ts` pattern). Disable it with a tooltip when `searchAvailable` is false (old extension).
  - **Wiring:** `main.ts` `ask()` (l.122-132) passes the toggle through.
  - **Progress label:** `src/ui/progress-view.ts:20-36` gets a `web_search` case: "Searching the web: <query>".
  - **Source links:** add `allow-popups allow-popups-to-escape-sandbox` to the lesson iframe sandbox (`src/ui/whiteboard.ts:477`), so `target="_blank"` source links open in a new tab. It does not grant same-origin. The system prompt tells the model to write links with `target="_blank" rel="noopener"`.
- **`doc/BUILD_PLAN.md`:** move web search out of non-goals (l.64), and update the pinned Project14 contract (l.9-39) to include `localLLM.search`.
- **Tests:**
  - `src/llm/tools.test.ts`: the tool appears only when `search` is set, and its output format.
  - `src/llm/turn.test.ts`: with `scriptedModel`, the model calls `web_search`, then `whiteboard_insert`. The stub search is called and the error mapping works.
  - `src/ui/progress-view.test.ts`: the label.
- **Commands:** `npm test && npm run build`.

---

## Verification (end to end)
1. Project14: `npm run typecheck && npm test && npm run test:e2e` all pass.
2. Manual, with `npm run build`, loading `dist/` unpacked:
   - Playground `web_search` with a Tavily key gives `provider: "tavily"`.
   - With the key removed, grant the Google fallback. You'll see `provider: "google"` and a minimized window that opens and closes. Repeat with a bad key (401).
3. Enable `http://localhost:5173` in options, turn on Web search, and run Project15 `npm run dev`:
   - Turn on the toolbar toggle and ask about a recent event.
   - The progress card shows "Searching the web…", and the board gets a Sources list whose links open in new tabs.
   - With the site toggle off, you get the "Enable Web search…" note.
