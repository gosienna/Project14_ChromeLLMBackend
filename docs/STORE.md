# Publish Local LLM on the Chrome Web Store

The extension is prepared for submission. The dashboard steps below still have to be done in your Google account: this repository cannot sign in, pay the developer fee, or click Submit for review.

Chrome's current rules, used for the copy below: [publish](https://developer.chrome.com/docs/webstore/publish), [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [images](https://developer.chrome.com/docs/webstore/images), [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy). The package limit is 2 GB. A new developer account can publish a limited number of items at first.

## 1. Developer account

1. Open the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in with the Google account that should own the listing. Use an account you will keep; the listing cannot be moved later without Google's help.
3. Pay the one-time registration fee (US$5) and accept the developer agreement.
4. Add a contact email. The store shows it to users.

## 2. Privacy policy URL

The policy is [`docs/privacy.html`](privacy.html). The same file is copied into the extension at `ui/privacy.html` and linked from the options page. The store will not accept a `chrome-extension://` URL. It needs a public page.

After this file is on the default branch:

1. On GitHub, open the repository **Settings → Pages**.
2. Build and deployment: **Deploy from a branch**.
3. Branch: `main`, folder: **`/docs`**, then Save.
4. Wait until the site is live, then open:

`https://gosienna.github.io/Project14_ChromeLLMBackend/privacy.html`

Use that URL in the dashboard. If you host the file somewhere else you control, use that URL instead, and keep it the same text as `docs/privacy.html`.

## 3. Build the zip

From a clean checkout:

```bash
npm install
npm run fetch:webllm-libs   # bundles the WebLLM .wasm libraries; required
npm run pack                # writes release/local-llm-0.1.0.zip
```

`release/` is gitignored. The zip's root is the extension (`manifest.json` at the top, not inside a folder). Do not upload `dist-test/` or a zip of the source tree. Do not minify the build.

Upload `src/icons/128.png` as the store icon. It is 128×128 with the artwork inset to 96×96, which is what the [image guidelines](https://developer.chrome.com/docs/webstore/images) ask for.

Screenshots and promo tiles are in [`store/`](../store/). Regenerate them with `node scripts/store-screenshots.mjs` after a UI change. Upload these five screenshots, in order:

| File | What it shows |
| --- | --- |
| `store/01-sites.png` | Options: which sites may use the model |
| `store/02-local-model.png` | Choosing and downloading a local model. The capability line says WebGPU is unavailable because the screenshot was taken in headless Chromium. On a machine with WebGPU that line says yes. |
| `store/03-cloud-providers.png` | Cloud providers, off until the user enables one |
| `store/04-tools.png` | Web search and image download, off by default |
| `store/05-playground.png` | The in-extension chat |

Optional promo tiles: `store/promo-440x280.png` (small) and `store/marquee-1400x560.png` (marquee).

## 4. Store listing — paste these

**Name:** Local LLM

If that name is taken, use **Local LLM for websites**.

**Summary** (132 characters):

```
An on-device language model for websites you approve, or your own cloud API key. Sites receive replies only.
```

**Description:**

```
Local LLM lets a website you approve use a language model through the standard window.LanguageModel API, the same shape as Chrome's built-in Prompt API.

What you control
• You choose which sites can use it. Every other site cannot see the extension.
• The first time a site creates a session, you pick Always allow, Allow once, or Deny.
• The default model runs on your device. Prompts for that model stay on your computer.
• Cloud providers stay off until you turn one on and paste your own API key. The consent dialog tells you when a prompt will leave the device. Providers: Anthropic, OpenAI, Gemini, xAI, DeepSeek, OpenRouter, or a server you run yourself.
• You can set limits and revoke a site at any time. The usage log records the site, the time, and token counts. It never records the prompt.

Using it
• Click the toolbar icon on a site and choose Enable on this site, then reload the page.
• Or open the playground to chat without a website, attach images, and optionally turn on tools that act on your own tabs.
• Download a local model from the options page, or let it download the first time a site uses it.

For the site
• The site calls LanguageModel.create() and session.prompt(). It receives the model's text. It does not receive your API keys or your other tabs.

Local LLM has no ads and does not send your prompts to the developer. Chrome 116 or later. Local models are fastest with WebGPU.
```

**Category:** Productivity

**Language:** English

**Official URL:** `https://github.com/gosienna/Project14_ChromeLLMBackend`

**Support URL:** `https://github.com/gosienna/Project14_ChromeLLMBackend/issues`

**Mature content:** No

**Visibility:** Public, all regions, unless you want it unlisted.

**Distribution:** leave the version's publish target as public after review. You can submit as "publish immediately after review" or publish manually once it is approved.

## 5. Privacy practices tab — paste these

**Single purpose:**

```
Provides a language model to websites the user approves, through the standard window.LanguageModel API. The model runs on the device, or, only after the user turns it on, through an API key the user supplies. A site receives the model's text output and nothing else.
```

**Remote code:** No, I am not using remote code.

All JavaScript and WebAssembly (Transformers.js, ONNX Runtime Web, WebLLM and its per-model libraries, wllama, KaTeX) is inside the zip. ONNX Runtime's `wasmPaths` points at `vendor/ort/` in the package. The build is not minified. Model weights are data, downloaded only when the user asks, from `huggingface.co`, `cdn-lfs.huggingface.co`, and `cas-bridge.xethub.hf.co`. Custom tool code is written by the user in the playground and runs in the extension's sandbox page. It is not downloaded from a server.

**Permission justifications** (one field per row the dashboard shows):

| Permission | Justification |
| --- | --- |
| `offscreen` | Hosts the model runtime (WebGPU and WebAssembly) in one offscreen document shared by every approved site, so the weights load once. |
| `scripting` | Injects `window.LanguageModel` only on sites the user has enabled, using `chrome.scripting.registerContentScripts`. Also runs the playground's page tools after the user turns those tools on. |
| `storage` | Stores settings, per-site consent, the usage log (origin, time, backend, token counts; no prompt text), and API keys the user pastes. |
| `unlimitedStorage` | Caches model weights, from a few hundred MB to several GB, in the extension origin so every site shares one copy. |
| `downloads` (optional) | Used only by the playground's download tool, after the user enables that tool and Chrome asks. Not used by the language model. |
| `<all_urls>` (optional host) | Not requested at install. Requested from a button in two places: the playground Tools panel, so tools the user enables can read a tab they ask about, and options → Tools "Images for sites", so an image URL from that site's own search can be downloaded. Websites never receive this access. |
| `https://api.anthropic.com/*` | Optional. Requested only when the user enables Anthropic, so the extension can send that site's prompt to Anthropic with the user's key. |
| `https://api.openai.com/*` | Optional. Requested only when the user enables OpenAI. |
| `https://generativelanguage.googleapis.com/*` | Optional. Requested only when the user enables Gemini. |
| `https://api.x.ai/*` | Optional. Requested only when the user enables xAI. |
| `https://api.deepseek.com/*` | Optional. Requested only when the user enables DeepSeek. |
| `https://openrouter.ai/*` | Optional. Requested only when the user enables OpenRouter. |
| `http://localhost/*` and `http://127.0.0.1/*` | Optional. Requested only when the user adds a local OpenAI-compatible server (Ollama, LM Studio, or similar) and turns it on. |
| `https://api.tavily.com/*` | Optional. Requested when the user saves a Tavily key for web search. The search query is sent to Tavily. The key stays in the extension. |
| `https://www.google.com/*` | Optional. Requested when the user allows the Google fallback for web search. The extension opens a results page in a minimized window, reads titles, links, and snippets, and closes it. |

**Data usage — check these two, and no others:**

- **Authentication information.** API keys the user pastes. Stored in extension storage. Sent only to the provider the user enabled, as the credential for that call. Not sent to the developer. Mark this as transferred off the device, to the third-party provider the user configured.
- **Website content.** Prompts a site or the playground sends to the model, and page text the playground tools read after the user enables them. A local model keeps this on the device. A cloud model sends the prompt to the provider the user configured. A web search sends the query to Tavily or Google. Mark the part that goes to a provider as transferred to that third party. The developer does not receive it.

Leave unchecked: personally identifiable information, health, financial and payment, personal communications, location, web history, user activity. The extension does not collect those. The usage log's site origin is a setting the user made, stored locally, not a browsing history.

**Certify all three:**

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

The transfers above are the feature the user turned on (their cloud provider, or a search they allowed). They are described in the privacy policy's Limited Use section.

**Privacy policy URL:** the GitHub Pages URL from step 2.

## 6. Submit

1. **Add new item** → upload `release/local-llm-0.1.0.zip`.
2. Fill Store listing, Privacy, and Distribution.
3. If the dashboard asks whether you are a trader in the European Economic Area, answer for yourself. A person publishing a free extension they do not sell is often a non-trader. Only you know which applies.
4. Submit for review.

Review takes longer when the package declares `<all_urls>`, even as an optional host permission. That is expected. Do not remove the justification.

If the name "Local LLM" is rejected as already used, change the manifest `name`, rebuild with `npm run pack`, and upload the new zip. The listing name and the manifest name should match.

## 7. Updates

Do not add a new **required** permission in a later version. Chrome disables the extension for existing users until they accept the new permission. New optional permissions are allowed. Keep `host_permissions` empty.

Bump `version` in `src/manifest.json` (and it is copied into the build) before packing the next zip. Upload the new zip to the same store item.

## What was checked in the package

- Required `host_permissions` is empty. Site and provider access is `optional_host_permissions`.
- `debugger` is not declared. Chrome does not allow it as an optional permission, and a required debugger permission is outside the single purpose. Console tools in the playground use `chrome.scripting` instead.
- Engine runtimes and `.wasm` are bundled. `npm run pack` refuses to run without `vendor/webllm-libs`.
- Weight-download hosts are listed above.
- Build output is readable, not minified.
- The privacy policy is written. Publishing it at a public URL is step 2, and it is not live until GitHub Pages (or another host) is turned on.
