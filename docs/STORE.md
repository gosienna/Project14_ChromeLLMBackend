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
| `optional_host_permissions` | Requested per site when the user enables it, and per cloud provider when the user turns it on. No host access is required at install. |

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
- [ ] Privacy policy published at a public URL
- [ ] Never add new required permissions in updates
