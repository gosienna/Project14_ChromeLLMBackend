# Images in the playground, and stored images on LearnWithLLM topics

## Context
`web_search` can now return image urls, but nothing shows them:
- The Project14 playground prints tool results as raw JSON. Its Markdown renderer deliberately turns `![alt](url)` into a link.
- The Project15 whiteboard can only hotlink urls, so an image breaks when the link dies.

**Your decisions:**
- **Playground:** show images both in `web_search` tool cards and from Markdown `![]()`.
- **Project15:** the model saves an image explicitly (`whiteboard_add_image`), and the topic stores a **cached copy** of it in IndexedDB. Because of CORS, the web app can't fetch most images itself. The extension does it through a new, gated `localLLM.fetchImage()`.

**Constraint found during exploration:**
- Extension pages run under COEP `require-corp` (`src/manifest.json`, needed for wllama threads). A plain `<img src="https://…">` fails unless the server sends CORP.
- So the playground loads remote images itself: it `fetch`es each one and shows it from a `blob:` URL.
- With the optional `<all_urls>` permission, that fetch bypasses CORS. Without it, the fetch works only for hosts that send CORS headers.

---

## Part A: Project14 playground

### A1. Remote image loader: `src/ui/remote-image.ts` (new)
- `loadImage(url): Promise<string | null>` returns a cached `blob:` URL, keyed by url in a `Map` of promises.
  - The cache matters because Markdown re-renders every frame while a reply streams; the same image must not be refetched.
  - It runs `fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" })`.
  - It accepts only `image/(png|jpeg|gif|webp|avif|bmp)` up to 10 MB.
  - Any failure gives `null`.
- `hydrateImages(root)`: for each `img[data-src]` without `src`, sets `src` on success. On failure it replaces the image with a link plus a small "Allow images" button.
  - The button calls `chrome.permissions.request({ origins: ["<all_urls>"] })` from the click handler.
  - On success it clears the failure cache and re-hydrates.
- `revokeImages()` is called on New chat, next to the existing `urls` cleanup in `playground.ts`.

### A2. Markdown images: `src/ui/markdown.ts`
- `![alt](url)` with a safe `http(s)` url becomes `<img class="pg-md-img" data-src="…" alt="…" loading="lazy">`.
  - It has no `src`, so nothing loads until the playground hydrates it.
  - alt and url are escaped. Unsafe urls stay literal text, as today.
- Plain `[x](url)` links are unchanged.
- In `showAnswer` / `paint` (`playground.ts:155`, `:445`), call `hydrateImages(el)` after setting `innerHTML`.
- Update the "no `<img`" assertion in `test/markdown.test.ts`:
  - images render as `data-src` only;
  - `javascript:` still stays literal text;
  - `onerror` injection is still escaped.

### A3. Image grid in tool cards
- `runTool` (`src/ui/tools/run.ts`) returns `{ text, value }` instead of a string. Its caller and nested `callTool` use `.text`.
- `handleToolCall` passes `value` to `card.done(text, isError, value)`.
- `toolCard.done` (`playground.ts:333-367`): when `value.images` is a non-empty array, it renders `<div class="pg-tool-images">` above the result `<pre>`, and keeps the card open.
  - Each tile is `<a href=sourceUrl||url target=_blank><img data-src=url alt=description></a>`, followed by `hydrateImages`.
- The model still gets the capped JSON text, unchanged.
- CSS in `src/ui/style.css`:
  - `.pg-md-img { max-width:100%; max-height:360px; border-radius:8px }`
  - `.pg-tool-images` as a 96px thumbnail grid
  - a failed-image link style

### A4. Tests
- `test/markdown.test.ts` as above.
- `e2e/playground.spec.ts`: serve a PNG from the local test server and answer `![x](http://localhost:…/img.png)` through the echo engine. Assert that `.pg-md-img` gets a `blob:` src. The test build already grants localhost.
- `e2e/playground-tools.spec.ts`: use `setSearchStub` with images, then `/tool web_search {"query":"x","include_images":true}`. Assert that `.pg-tool-images img` has the right count.

---

## Part B: Project14 page API `localLLM.fetchImage(url)`

### B1. Request
- `src/shared/protocol.ts`: add `{ kind: "fetch-image"; id; url: string }` to `PageRequest` and `FIELDS`.
- Validation: `url` must be an http(s) URL of at most 2048 characters. Extra fields are rejected.

### B2. Gate and limits
- `policy.ts` `gate` treats `fetch-image` like `search`: consent, plus `site.webSearch === true`. The deny message says web search must be on.
- `router.ts` adds its own per-origin limiter, 30 per minute, using the `searchLimiter` pattern. Clear it in the same forget path.

### B3. Allowlist (no SSRF)
- The router remembers, per origin, the image urls it returned from that origin's `search` calls: `searchedImages: Map<origin, Set<url>>`, capped at 300 per origin and cleared on revoke.
- `fetch-image` for any other url fails with `NotAllowedError` ("Only images returned by localLLM.search() can be fetched").
- This way a site can't use the extension's host permissions to read arbitrary or intranet URLs.

### B4. Fetch: `src/background/fetch-image.ts` (new, service worker)
- Calls `fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow" })`.
- Checks content type `image/(png|jpeg|gif|webp|avif|bmp)`. SVG is refused.
- Size cap of 8 MB, checked against both `content-length` and the bytes actually read.
- Base64-encodes the bytes in chunks.
- Returns `{ url, type, data /* base64 */, bytes }`.
- **Errors:**
  - A network or CORS failure is a `NetworkError`. When `<all_urls>` isn't granted, the message adds "grant image access in options → Tools".
  - A bad type or size is a `DataError`.
- The validation is a pure function `checkImageResponse(type, length)`, so it can be unit-tested.

### B5. Polyfill and packages
- `localLLM.fetchImage(url): Promise<{ url, type, blob: Blob }>` builds the Blob in the page.
- `capabilities.fetchImage: true`.
- `packages/web`: `Found.fetchImage`, with types and a test.

### B6. Options
- `toolsSection`: add an "Images for sites" row next to Google search fallback.
- Its Grant button requests `<all_urls>`, with the explanation "lets sites with web search store images found by search; without it only CORS-enabled hosts work".

### B7. Docs and tests
- CLAUDE.md "Rules that matter": add `fetch-image` to the search exception, with the allowlist rule.
- README API section.
- STATUS entry.
- Unit tests:
  - protocol: valid, non-http, and extra fields
  - policy: the `fetch-image` gate
  - `checkImageResponse`
  - the allowlist helper
- e2e (`e2e/search.spec.ts`):
  - `fetchImage` before search gives `NotAllowedError`;
  - after a stubbed search whose image url points at the local test server, it returns a Blob with the right type.

---

## Part C: Project15 stored images

### C1. Data
- `src/types.ts`:
  ```ts
  export interface BoardImage {
    id: string; url: string; description: string; sourceUrl?: string;
    blob: Blob | null;        // cached copy; null when the download failed (falls back to url)
    type?: string; width?: number; height?: number; addedAt: number;
  }
  TopicRecord.images: BoardImage[]
  ```
- `LocalLlmNamespace.fetchImage?`
- `src/storage/db.ts`:
  - `DB_VERSION = 3`. The migration adds `images: []` when it's missing.
  - `createEmptyTopic` gets `images: []`.
  - Add a migration test in `src/storage/migrate.test.ts`.
  - Blobs are stored directly; IndexedDB structured clone supports them.

### C2. Tools (`src/llm/tools.ts`)
- **`ToolHost.fetchImage?: (url) => Promise<Blob>`.**
- **`whiteboard_add_image {url, description}`**, offered only when `host.fetchImage` is set (same pattern as `web_search`):
  - The url must be http(s).
  - The same url returns its existing id.
  - Cap of 20 images per topic.
  - Download through `host.fetchImage`, then downscale and re-encode in the page with `createImageBitmap` + `OffscreenCanvas`: longest side 1280 px, `image/webp` at quality 0.85. This keeps the board document small.
  - If the download fails, it still stores the entry with `blob: null` and says so in the result.
  - Returns `{ id: "img3", ref: "board-image:img3", cached, width, height }`.
- **`whiteboard_remove_image {id}`.**
- `whiteboard_view` with `"all"` also lists images as `{id, description, url, cached}`, without blobs.
- Saving goes through the existing `loadTopic` / `saveTopic`.

### C3. Rendering (`src/ui/whiteboard.ts`)
- `renderWhiteboard(host, sources, handlers, images?: Record<id, src>)` and `assembleBoardDocument(sources, images)`:
  - Replace `board-image:ID` in html, css and svg with the image's `src`. Unknown ids are left alone.
  - Inject `globalThis.lessonImages = {id: src}` for the lesson js.
  - The `src` is a `data:` URL, which the frame CSP already allows (`img-src data: https:`). The opaque-origin frame can't use the parent's `blob:` URLs.
  - When there's no cached copy, the original https url is used.
- `renderKey` includes the image ids.
- `main.ts`:
  - `paint` calls `await boardImageSources(topic)` before `renderWhiteboard`.
  - That helper converts Blob to a data URL with a memo keyed by topic id and image id, so repaints don't re-encode.
  - `activeSearch`-style `activeFetchImage(app)` passes `fetchImage` to the tutor, only when web search is on and `localLLM.fetchImage` exists.
- `turn.ts`: `deps.fetchImage?` goes through to `createWhiteboardTools` the same way `search` does (`turn.ts:102`, `:309`).

### C4. Prompt and UI
- **`system-prompt.ts`:**
  - **`IMAGE_INSTRUCTIONS`**, added when the tool is offered: to show a picture found by web_search, call `whiteboard_add_image` with its url and a short description. Then put `<img src="board-image:ID" alt="…" style="max-width:100%">` in the html. Credit the image's page in Sources. Never write `board-image:` ids that weren't returned.
  - **`boardStatus`** adds a line such as "Images: img1 (Eiffel Tower at night), img2 (…)".
  - **`pinnedSystem`** handles the block the way it handles the web-search block.
- **`src/ui/sources.ts`:** a Debug tab "Images" showing thumbnails with id, description, source link, a cached/not-cached marker and size. Update the `sources.test.ts` labels.
- **`progress-view.ts`:** "Saving image: <description>".
- **`doc/BUILD_PLAN.md`:** images move out of non-goals, and the contract gets `TopicRecord.images`, the `board-image:` scheme and DB v3.

### C5. Tests
- `tools.test.ts`:
  - `whiteboard_add_image` stores and dedupes; the cap holds; a fetch failure stores `blob: null`; remove works.
  - The tool is offered only with `fetchImage`.
  - Re-encoding is stubbed by injecting it through the host, so the tests don't need OffscreenCanvas.
- `whiteboard.test.ts`: `board-image:` replacement in html, css and svg, `lessonImages`, unknown ids left as they are, and the url fallback.
- `system-prompt.test.ts`: the image instructions and the images status line.
- `migrate.test.ts`: v2 → v3.
- Commands: `npm test && npm run build`.

---

## Verification
1. Project14: `npm run typecheck && npm test && npm run test:e2e`.
2. Project15: `npm test && npm run build`.
3. Manual, with the extension built and loaded, and `<all_urls>` granted in options → Tools:
   - Playground: `web_search` with `include_images` shows a thumbnail grid. A reply containing `![]()` shows the image inline.
   - Project15 (`npm run dev`, site enabled with web search on): ask for a lesson about the Eiffel Tower with a picture.
     - The board shows the image.
     - The Debug "Images" tab lists it as cached.
     - Reloading the page offline still shows it.
