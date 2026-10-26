# Chrome Web Store submission

Everything the Developer Dashboard asks for, in the order its tabs ask for it. Copy the text blocks as they are.

## 1. Package

```sh
npm ci
npm run fetch:webllm-libs   # required: bundles the WebLLM model libraries (code, so it must ship in the package)
npm run typecheck && npm test && npm run test:e2e
npm run build
cd dist && zip -qr -X ../local-llm-extension-$(node -p "require('./manifest.json').version").zip .
```

Upload the zip from the repository root. `manifest.json` must be at the top of the zip, not inside a `dist/` folder. Each upload needs a higher `version` in `src/manifest.json` than the last one.

## 2. Store listing tab

**Name:** Local LLM (from the manifest)

**Summary** (manifest `description`, 132 characters max):

> Provides an on-device language model to websites the user approves.

**Category:** Developer Tools

**Language:** English

**Description:**

```
Local LLM gives the websites you choose a language model through the standard Prompt API (window.LanguageModel), the same API Chrome's built-in AI uses. Web apps write their code once; this extension supplies the model, loaded a single time and shared by every tab.

RUNS ON YOUR DEVICE
• Open models (Qwen, Gemma, SmolLM and others) run in your browser with WebGPU or WebAssembly.
• Model weights download once, on your request, and stay in the extension's storage.
• Prompts sent to a local model never leave your computer.

YOU DECIDE WHICH SITES GET IT
• Nothing is exposed until you enable a site, and each site asks for your consent on first use.
• New sites can use the local model only.
• Per-site rate limits, plus a usage log that records counts but no prompt text.

OPTIONAL: YOUR OWN CLOUD KEYS
• Connect Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, OpenRouter or a local server (Ollama, LM Studio) with your own API key.
• A site uses the cloud only if you allow it for that site. Prompts go straight from your browser to the provider you picked.
• Keys stay in the extension and can be locked with a passphrase.

OPTIONAL: WEB SEARCH FOR SITES
• Off by default. When you turn it on for a site, that site can ask the extension to run a web search (Tavily with your key, or Google).

PLAYGROUND
• Chat with any configured model, attach images, inspect raw requests and responses, and try tool calling, including browser automation tools you turn on yourself.

FOR DEVELOPERS
• Code against window.LanguageModel and detect the extension with the @local-llm/web helper. Source code and documentation: https://github.com/gosienna/project14_chromellmbackend

No account, no telemetry, no ads.
```

**Graphics:**

| Asset | Size | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | `src/icons/128.png` |
| Screenshot 1 | 1280×800 | `docs/store/options.png` (settings page) |
| Screenshot 2+ | 1280×800 | To do: a playground chat with a real model, and the consent prompt on a site. Take them on a machine with WebGPU. |
| Small promo tile | 440×280 PNG | To do (required) |
| Marquee | 1400×560 | Optional |

## 3. Privacy tab

**Single purpose:**

```
Provides a language model, running on the device or through the user's own cloud provider keys, to websites the user approves, through the Prompt API (window.LanguageModel).
```

**Permission justifications:**

| Permission | Justification to paste |
| --- | --- |
| `offscreen` | Hosts the model runtime (WebGPU/WebAssembly) in one offscreen document shared by every approved site, so model weights are loaded into memory once. |
| `scripting` | Registers the script that defines window.LanguageModel, only on sites the user has enabled in settings (chrome.scripting.registerContentScripts). No script runs on other sites. |
| `storage` | Stores the user's settings, per-site consent decisions, a usage log of counts (no prompt text) and the user's own provider API keys. |
| `unlimitedStorage` | Model weights the user chooses to download are hundreds of megabytes to several gigabytes. They are stored in the extension's IndexedDB so every site shares one copy. |
| `downloads` (optional) | Requested only when the user turns on the playground's "save file" tool, which saves a file the user's chat asks for to the Downloads folder. Not available to websites. |
| `debugger` (optional) | Requested only when the user turns on the playground's console-capture tool, which reads a tab's console output to help the user debug a page. Attaches only to the tab the user names, shows Chrome's debugging banner, and is not available to websites. |
| Host permissions (all optional) | Each site's host permission is requested when the user enables that site. Each cloud provider's API host is requested when the user turns that provider on. api.tavily.com and www.google.com are requested when the user turns on web search. <all_urls> is requested only when the user turns on the playground's browser tools or image results from web search, to fetch images and pages the user asked for. No host access is required at install. |

**Remote code:** select **"No, I am not using remote code."** Justification, if asked:

```
All JavaScript and WebAssembly is in the package, including the inference engines (Transformers.js, ONNX Runtime Web, WebLLM with its per-model libraries, wllama). Only model weights, which are data, are downloaded at runtime, from huggingface.co. The extension never fetches code from a server. In the playground (an extension page, not available to websites), the user can turn on developer tools that run code typed by the user or proposed by the chat model: custom tool functions run only in a manifest-sandboxed page with an opaque origin and no extension API access, and a script tool runs a function in a tab the user names. Both are off by default and, by default, ask the user for confirmation before every run.
```

**Data usage** — tick these and leave the rest unticked:

| Data type | Tick? | Why |
| --- | --- | --- |
| Authentication information | Yes | The user's provider API keys are stored and sent to that provider. |
| Website content | Yes | Prompts a site sends (and images the user attaches) are processed, and sent to a cloud provider when the user allows it. |
| Web history | No | |
| User activity | No | |
| Personally identifiable information, health, financial, personal communications, location | No | |

Then tick all three certifications (no selling, no unrelated use, no creditworthiness use). They hold: nothing is sent to the developer, and data goes only to services the user configures.

**Privacy policy URL:**

```
https://github.com/gosienna/project14_chromellmbackend/blob/main/docs/PRIVACY.md
```

This link works only once the repository is public and `docs/PRIVACY.md` is on `main`. If the repository stays private, publish the policy anywhere public (GitHub Pages, a gist) and use that URL.

## 4. Distribution tab

- **Visibility:** start with **Unlisted** so testers can install from the store link while the listing is checked, then switch to Public.
- **Regions:** all.

## Review risks

Things a reviewer is likely to question, roughly in order:

1. **Model-written code (highest risk).** Two playground tools run code a model writes, and with a cloud model a reviewer may count either as executing remotely hosted code, which Manifest V3 policy forbids:
   - `execute_script` (`ui/tools/browser.ts`) evaluates a model-written function string in a tab's MAIN world. This is the likelier objection, since it runs in web pages.
   - `create_tool` / `update_tool` (`ui/tools/meta.ts`) save model-written code that later runs in the sandbox page (no extension APIs).

   Both are off until the user enables them in the playground, and both ask before each run by default (`confirm: true`, which the user can turn off). If the review is rejected for remote code, ship a store build without these three tools.
2. **`debugger` and `<all_urls>`**, even as optional permissions, lead to a manual review that takes longer (days to a few weeks). The justifications above stay narrow on purpose.
3. **Google fallback search** scripts a google.com results page in a minimized window. A reviewer may ask about it; if they object, make Tavily the only provider in the store build.
4. **Wording.** "On-device" in the summary is accurate for the default, but the description must keep saying that cloud use is optional and per-site, or it can be judged misleading.

## Checklist

- [x] Required `host_permissions` empty; site and provider access through `optional_host_permissions`
- [x] Engine runtimes and `.wasm` bundled (`npm run fetch:webllm-libs` before packaging)
- [x] Weight download hosts documented
- [x] Single-purpose statement and permission justifications, including the optional ones
- [x] Readable build output
- [x] Privacy policy written (`docs/PRIVACY.md`)
- [ ] Privacy policy at a public URL
- [ ] Screenshots of a real chat and the consent prompt; small promo tile
- [ ] `npm run typecheck` clean (`e2e/extension.spec.ts:64`)
- [ ] Never add new required permissions in updates
