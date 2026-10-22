# Web search: image results (Tavily + Google Images tab)

## Context
`web_search` / `localLLM.search()` returns text results only, from Tavily or (fallback) a Google results page in a minimized window. We want image URLs too:
- **Tavily:** ask the API for images (`include_images`, `include_image_descriptions`). Same request, same credit.
- **Google fallback:** after the web results, load Google's Images tab in the same minimized tab and collect the top results' original image URLs.

The feature is opt-in per call (`includeImages`), so existing callers and the result size don't change.

## Shape
`src/shared/search.ts`:
```ts
export interface ImageResult {
  url: string;            // original image URL (http/https)
  description?: string;   // Tavily image description, or Google alt/title
  sourceUrl?: string;     // page the image is on (Google, when known)
  thumbnail?: string;     // Google gstatic thumbnail
  width?: number; height?: number;
}
SearchResponse.images?: ImageResult[]   // present only when includeImages was requested
```
The image count is capped at `maxResults`, which already allows up to 10.

## Part A: Project14

### A1. Pure logic (`src/shared/search.ts`)
- `TavilyOutcome` ok-branch gets `images?: ImageResult[]`.
- `googleImagesUrl(query)`: `https://www.google.com/search?q=…&udm=2&hl=en` (`udm=2` is the current Images tab).
- `collectGoogleImages(): GoogleImagesRaw` is self-contained because it runs via `executeScript`. It returns the same `blocked` detection as `collectGoogleResults`, plus candidates from three sources, in order:
  1. **Inline script data:** regex over `<script>` text for `["https://…",H,W]` triples. This is how Google embeds originals. Decode the escapes with `JSON.parse('"'+s+'"')`.
  2. **Legacy links:** `a[href*="/imgres?"]` → the `imgurl` / `imgrefurl` params, which give the URL plus its source page.
  3. **Thumbnails:** result tiles `img[src^="https://encrypted-tbn"]` with `alt`, used as a thumbnail-only last resort.
- `normalizeGoogleImages(raw, max): ImageResult[]`:
  - Keep http(s) URLs only.
  - Drop `gstatic.com` / `google.*` hosts as the *original* URL; they can still be used as `thumbnail`.
  - Dedupe, then trim to `max`.

### A2. Tavily (`src/offscreen/host.ts` `tavilySearch`)
- Add an `includeImages` parameter. When set, send `include_images: true, include_image_descriptions: true`.
- Map `body.images`, which can be `string[]` or `{url, description}[]`, to `ImageResult[]`.
- `src/shared/host-protocol.ts`: the `webSearch` op gets `includeImages: boolean`.

### A3. Google (`src/background/google-search.ts`)
- `googleSearch(query, max, includeImages)`. Inside the same queued `searchInWindow`, after the web results:
  - `chrome.tabs.update(tabId, { url: googleImagesUrl(query) })`
  - wait for `loaded(tabId)`
  - run `collectGoogleImages`
  - `normalizeGoogleImages`
- It keeps one window and closes it in `finally`.
- If the images page is blocked or times out but the web results are fine, return the web results with `images: []`. Then `runSearch` adds to `note` (for example "Google image results unavailable"). The whole search does not fail.
- The return type becomes `{ results, images? }`.

### A4. Selection (`src/background/search.ts`)
- `runSearch(query, max, deps, { includeImages = false } = {})` passes the flag to `deps.tavily` and `deps.google`, and sets `images` on the response only when requested.
- The fallback rules don't change: Tavily succeeding with zero images is still a success, with no Google fallback.

### A5. Entry points
- **`src/shared/protocol.ts`:** the `search` request gets `includeImages: boolean`. Add it to `FIELDS.search` and validate it as boolean. The polyfill always sends it.
- **`src/polyfill/polyfill.ts`:**
  - `search(q, { maxResults, includeImages, signal })`.
  - `webSearchTool()` gets an `include_images` boolean in its schema.
  - `capabilities: { search: true, images: true }`.
- **`src/background/router.ts`:**
  - Pass `req.includeImages` through in the page `search` case.
  - The playground `webSearch(args)` reads `args.include_images`.
  - `setSearchStub` accepts optional images.
- **`src/ui/tools/builtin.ts`:** add `include_images` to the `web_search` schema and description ("set to get image URLs, e.g. to show pictures").
- **`packages/web/src/index.ts`:** `ImageResult`, `SearchResponse.images?`, `SearchOptions.includeImages?`, and `include_images` in `webSearchTool()`.

### A6. Docs
- README API section.
- `docs/STATUS.md` entry.
- Per Project14 CLAUDE.md, copy this plan to `docs/<date +%Y-%m-%d-%H%M>-web-search-images.md` first.

### A7. Tests
- **`test/search.test.ts`:**
  - The flag reaches Tavily and Google.
  - `images` is absent when the flag is not set.
  - A Google images failure gives web results, a note, and `images: []`.
  - `normalizeGoogleImages` covers script triples with `=` escapes, gstatic filtering, `imgres` unwrapping, dedupe, and the cap.
  - `collectGoogleImages` runs against fixture HTML (the same DOM setup `collectGoogleResults` tests use).
- **`test/protocol.test.ts`:** `includeImages` is required and must be boolean.
- **`e2e/search.spec.ts`:** the stub returns images, and `localLLM.search(q, {includeImages:true})` returns them.
- Commands: `npm run typecheck && npm test && npm run test:e2e`.

## Part B: Project15 (light touch)
- **`src/llm/tools.ts`:** add `include_images` to the `web_search` spec. `compactResults` adds a numbered `images` list (url + description, ≤5) when present.
- **System prompt:** the model may embed relevant images on the board with `<img src=… alt=…>` and must credit the source.
- Add a test in `src/llm/tools.test.ts`.
- Commands: `npm test && npm run build`.

## Verification
1. Project14 unit + e2e tests pass.
2. Manual, with `npm run build` and `dist/` loaded unpacked:
   - Playground prompt: "find pictures of the Eiffel Tower", with a Tavily key. The tool result has `provider:"tavily"` and `images[]` with descriptions.
   - Remove the key. Now `provider:"google"`, the minimized window loads the results page, then the Images tab, and closes. `images[]` holds original (non-gstatic) URLs that open in a browser.
3. Project15: turn web search on, ask for a lesson with pictures, and confirm the images render on the board.
