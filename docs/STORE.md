# Chrome Web Store submission notes

## Single purpose

Provides an on-device language model to websites the user approves.

## Permission justifications

| Permission | Why |
| --- | --- |
| `offscreen` | Hosts the model runtime (WebGPU/WASM) in one offscreen document shared by every approved site, so weights load once. |
| `scripting` | Registers the `window.LanguageModel` script only on sites the user has enabled (`chrome.scripting.registerContentScripts`). |
| `storage` | Stores settings, per-site consent decisions, the usage log (no prompt text) and the user's own provider API keys. |
| `unlimitedStorage` | Model weights (hundreds of MB to a few GB) are cached in the extension's origin so every site shares one copy. |
| `optional_host_permissions` | Requested per site when the user enables it, and per cloud provider when the user turns it on. No host access is required at install. `<all_urls>` is requested only when the user enables a site or the Playground's browser tools; provider hosts only when that provider is turned on; `localhost` for a user-run local model server; `api.tavily.com` / `www.google.com` only when web search is turned on. |
| `downloads` (optional) | Playground tool that saves a file the user asked for to their Downloads folder. Requested on the click that enables it. |
| `debugger` (optional) | Playground tool that captures a tab's console output so the model can help debug a page the user is working on. Requested on the click that enables it; never used by websites. |

## Remote code

None. All JavaScript and WebAssembly (Transformers.js, ONNX Runtime Web, WebLLM and its per-model libraries, wllama) is bundled. ONNX Runtime's `wasmPaths` points at `vendor/ort/` inside the package. Build output is not minified.

Model weights are data, downloaded on user request from: `huggingface.co` (and its CDN hosts `cdn-lfs.huggingface.co`, `cas-bridge.xethub.hf.co`).

## Privacy policy (draft)

- The extension does not collect, transmit or sell prompts, outputs or browsing data. There is no telemetry.
- Local models run entirely on the device.
- If the user configures a cloud provider and allows a site to use it, that site's prompts are sent directly from the browser to that provider only, using the user's own API key, under the provider's terms.
- API keys are stored in the browser's extension storage, optionally encrypted with a user passphrase, and are never shared with websites.
- A local usage log records site origin, time, backend and token counts (no prompt or output text). The user can clear it at any time.

## Checklist

- [x] Required `host_permissions` empty; site and provider access through `optional_host_permissions`
- [x] Engine runtimes and `.wasm` bundled (`npm run fetch:webllm-libs` before packaging)
- [x] Weight download hosts documented
- [x] Single-purpose statement and permission justifications
- [x] Readable build output
- [ ] Privacy policy published at a public URL (`PRIVACY.md` → https://github.com/gosienna/Project14_ChromeLLMBackend/blob/main/PRIVACY.md)
- [ ] Never add new required permissions in updates

## Listing text (copy into the dashboard)

**Name:** Local LLM
**Category:** Developer Tools  ·  **Language:** English

**Summary (≤132 chars):**
On-device AI for sites you approve: a window.LanguageModel (Prompt API) backend with local models or your own API keys.

**Description:**
Local LLM gives the websites you choose a language model through the standard Prompt API (window.LanguageModel), the same interface as Chrome's built-in AI, so web apps written for it work in any Chrome.

• Local first: models run on your device with WebGPU or WebAssembly (WebLLM, Transformers.js, wllama). Weights download once from Hugging Face and are shared by every site.
• You stay in control: no site gets access until you enable it and approve it. New sites use the local model only.
• Bring your own key (optional): use Anthropic, OpenAI, Gemini, xAI, DeepSeek, OpenRouter or a local server, per site, with spend and rate limits.
• Playground: chat with any configured model, attach images, inspect raw requests, and try tool calling.
• Private: no telemetry and no developer server. The usage log keeps token counts, never prompt text.

For developers: detect the extension with window.localLLM, or use the @local-llm/web helper to fall back gracefully.

## Privacy practices tab

- **Single purpose:** see "Single purpose" above.
- **Remote code:** "No, I am not using remote code." (justification: see "Remote code" above).
- **Data usage:** tick **Website content** (prompts that approved sites send are processed to produce output) and **Authentication information** (user's own provider API keys, stored locally). Leave the rest unticked.
- Certify all three: not sold to third parties; not used for unrelated purposes; not used for creditworthiness/lending.
- **Privacy policy URL:** the PRIVACY.md link above.

## Review risks

- `debugger`, `<all_urls>` (even optional) and broad tool features usually trigger an in-depth review: expect days to a few weeks.
- The Playground sandbox (`ui/tool-sandbox.html`) runs user- or model-written tool code with `new Function`. It is a manifest sandbox page (opaque origin, no extension APIs) and asks before running, which is Chrome's documented pattern, but mention it in the reviewer notes if asked about remote code.
- Reviewers may question single purpose because of the Playground's browser tools. If rejected on that ground, ship the store build without the optional `debugger`/`downloads` tools.
