# Local LLM — Chrome extension

An MV3 Chrome extension that serves a language model — running locally in the browser, or through the user's own cloud API keys — to websites the user approves, via a Prompt API–compatible `window.LanguageModel`. Web apps code against the standard API once; the extension supplies the model, loaded a single time and shared across every tab and site.

- **For web developers:** jump to [Using the backend from a web app](#using-the-backend-from-a-web-app).
- **For extension developers:** see [Development](#development), [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) (the plan) and [`docs/STATUS.md`](docs/STATUS.md) (what is built).

```js
const session = await LanguageModel.create();
console.log(await session.prompt("Write a haiku about browsers"));
```

---

## Contents

1. [How it works in one minute](#how-it-works-in-one-minute)
2. [Installing the extension](#installing-the-extension)
3. [Using the backend from a web app](#using-the-backend-from-a-web-app)
   - [What the end user has to do first](#1-what-the-end-user-has-to-do-first)
   - [Detecting the API](#2-detecting-the-api)
   - [Checking availability](#3-checking-availability)
   - [Creating a session](#4-creating-a-session)
   - [Prompting](#5-prompting)
   - [Streaming](#6-streaming)
   - [Conversations and context](#7-conversations-and-context)
   - [Cancelling](#8-cancelling)
   - [Cloning and destroying sessions](#9-cloning-and-destroying-sessions)
   - [Model information](#10-model-information)
   - [Errors](#11-errors)
   - [Limits](#12-limits)
   - [Falling back when there is no model](#13-falling-back-when-there-is-no-model)
   - [Complete example](#14-complete-example)
   - [Testing your integration](#15-testing-your-integration)
   - [API reference](#api-reference)
   - [Security and privacy notes for app developers](#security-and-privacy-notes-for-app-developers)
4. [Architecture](#architecture)
5. [Development](#development)

---

## How it works in one minute

- Your page calls the standard [Prompt API](https://github.com/webmachinelearning/prompt-api) (`LanguageModel.create()`, `session.prompt()`, …). No SDK, no API key and no server are needed on your side.
- The extension injects `window.LanguageModel` **only into sites the user has enabled**, and asks the user's consent the first time your site creates a session.
- Requests travel from your page to the extension, which runs the model the user picked: an on-device model (Transformers.js, WebLLM, wllama or Chrome's built-in Gemini Nano) or a cloud provider using **the user's own key** (Anthropic, OpenAI, Gemini, xAI, DeepSeek, OpenRouter, Ollama or any OpenAI-compatible endpoint).
- Your page receives only the model's text output.

Code written for Chrome's native Prompt API runs unchanged on the extension, and the other way round.

## Installing the extension

Until it is published on the Chrome Web Store, build and load it unpacked:

```bash
npm install                 # .npmrc sets ignore-scripts (skips onnxruntime-node's binary download)
npm run fetch:webllm-libs   # bundle WebLLM model libraries (store policy: no remote code)
npm run build               # -> dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `dist/`.
2. Open the extension's options page (toolbar icon → **Settings, models and usage**) and pick a local model. Optionally click **Download / load** to fetch the weights now. Otherwise they download on first use (Qwen2.5 0.5B, about 480 MB).
3. Optional: under **Cloud providers**, enable a provider and paste your API key.

Requires Chrome 116 or later. Local models run fastest with WebGPU; without it the extension falls back to CPU (wllama).

---

## Using the backend from a web app

### 1. What the end user has to do first

`window.LanguageModel` does not exist on your site until the user does both of these:

1. **Enable the site.** On your site, they click the extension's toolbar icon, choose **Enable on this site** and accept Chrome's permission prompt, then reload. They can also add the site on the options page.
2. **Grant consent.** The first time your page calls `LanguageModel.create()`, the extension shows a dialog: **Always allow**, **Allow once (this tab)** or **Deny**.

Until step 1, the extension is invisible to your site: it can't be detected at all. Tell your users what to do, for example with an "Enable local AI" hint that links to these steps.

### 2. Detecting the API

The extension injects its script as the page starts loading, so `LanguageModel` is normally defined before your own scripts run:

```js
if ("LanguageModel" in window) {
  // Native Chrome Prompt API or this extension
}

const isExtension = "localLLM" in window; // only the extension defines window.localLLM
```

If your code may run very early, for example from an inline script in `<head>`, wait for the extension's ready event:

```js
function waitForLanguageModel(timeout = 500) {
  if ("LanguageModel" in window) return Promise.resolve(window.LanguageModel);
  return new Promise((resolve) => {
    const done = () => resolve(window.LanguageModel ?? null);
    window.addEventListener("localllm:ready", done, { once: true });
    setTimeout(done, timeout);
  });
}
```

The [`@local-llm/web`](#13-falling-back-when-there-is-no-model) helper does this for you.

**Chrome's built-in model:** if the browser already provides a native `LanguageModel`, the extension leaves it alone. Your page talks to Chrome's model directly unless the user turns on **Override Chrome's native LanguageModel** in the extension's settings.

### 3. Checking availability

```js
const status = await LanguageModel.availability();
```

| Value | Meaning for your site |
| --- | --- |
| `"available"` | Ready. The model is downloaded, or the site uses a cloud backend. |
| `"downloadable"` | Usable, but `create()` will first either ask the user for consent or download the model. Show a progress UI (see below). |
| `"downloading"` | A download is already in progress. |
| `"unavailable"` | The user denied your site, or no backend can run on this device. Use your fallback. |

An origin that hasn't been granted consent yet always sees `"downloadable"`, never `"available"`, so that it doesn't learn the user's model state.

`LanguageModel.params()` returns `{ defaultTopK, maxTopK, defaultTemperature, maxTemperature }` for the backend in use.

### 4. Creating a session

```js
const session = await LanguageModel.create({
  initialPrompts: [
    { role: "system", content: "You are a concise assistant for a recipe site." },
    { role: "user", content: "What is a roux?" },
    { role: "assistant", content: "Equal parts fat and flour cooked together to thicken sauces." },
  ],
  temperature: 0.7, // optional; if you set one of temperature/topK, set both
  topK: 3,
  signal: abortController.signal, // optional
  monitor(m) {
    m.addEventListener("downloadprogress", (e) => {
      progressBar.value = e.loaded; // 0 … 1
    });
  },
});
```

- `create()` resolves once the user has consented and the model is loaded. On the first call this can take a while: the consent dialog, then possibly a model download of several hundred MB.
- `initialPrompts` may start with **one** `system` message; the rest are example turns.
- Options are validated: an unknown role, `temperature` outside 0–2 or a lone `temperature`/`topK` throws.
- Only text is supported. Passing `expectedInputs` or `expectedOutputs` with a type other than `"text"` throws `NotSupportedError`.

### 5. Prompting

```js
const answer = await session.prompt("How do I keep it from going lumpy?");
```

Input can be a string or an array of messages:

```js
await session.prompt([
  { role: "user", content: "Translate to French:" },
  { role: "user", content: [{ type: "text", value: "Good morning" }] },
]);
```

The session remembers the conversation: each `prompt()` sees all previous turns.

Not supported yet: `responseConstraint` (JSON-schema structured output, planned for v2) throws `NotSupportedError`.

### 6. Streaming

`promptStreaming()` returns a `ReadableStream<string>` of text **deltas**, meaning each chunk is new text to append:

```js
output.textContent = "";
for await (const chunk of session.promptStreaming("Explain WebGPU in two paragraphs")) {
  output.textContent += chunk;
}
```

Local and cloud backends stream the same way. Cancelling the stream, for example by breaking out of the loop or calling `reader.cancel()`, stops generation.

### 7. Conversations and context

```js
session.inputUsage;  // tokens used by the conversation so far
session.inputQuota;  // the session's maximum (contextUsage / contextWindow are aliases)

await session.measureInputUsage("How long is this?"); // count tokens without sending

await session.append([{ role: "user", content: "Context: the user is vegetarian." }]); // add without generating
```

When a conversation outgrows `inputQuota`, the oldest non-system turns are dropped. If a single prompt is larger than the quota by itself, it rejects with `QuotaExceededError`. The quota is the smaller of the model's context window and the user's **Max context tokens** setting (default 8192).

Token counts come from the model's tokenizer with Transformers.js. For other backends they are estimates (about 4 characters per token).

### 8. Cancelling

Every call takes an `AbortSignal`:

```js
const ac = new AbortController();
stopButton.onclick = () => ac.abort();

try {
  const text = await session.prompt("Write a long story", { signal: ac.signal });
} catch (e) {
  if (e.name === "AbortError") console.log("stopped by user");
  else throw e;
}
```

Aborting stops the generation in the extension: a local model stops generating and a cloud request is cancelled. An aborted turn is not added to the conversation.

### 9. Cloning and destroying sessions

```js
const branch = await session.clone(); // copy of the conversation so far; then independent
await branch.prompt("Alternative answer?");

session.destroy(); // frees the session; any in-flight request rejects with AbortError
```

Always call `destroy()` on sessions you no longer need. Each site may have only **2** open sessions by default. Sessions are also freed automatically when the tab is closed or navigates away.

### 10. Model information

The extension adds a small non-standard namespace, which is absent with Chrome's native API:

```js
if (window.localLLM) {
  const info = await window.localLLM.info();
  // { name: "Qwen2.5 0.5B Instruct (default)", backend: "webllm", version: "0.1.0" }
  // backend is the local engine ("transformers" | "webllm" | "wllama" | "nano"), or the provider name for cloud
}
```

The user chooses the model and backend. Your site can't select them.

### 11. Errors

All failures reject with a `DOMException`. Check `error.name`:

| `name` | When | Suggested handling |
| --- | --- | --- |
| `NotAllowedError` | The user denied consent or revoked the site; a background tab tried to use the model without "Always" consent; a cloud key is missing or locked | Fall back; explain how to enable |
| `QuotaExceededError` | Too many open sessions; a per-minute, daily or monthly token limit reached; a prompt larger than the context window | Destroy unused sessions, retry later, or shorten input |
| `AbortError` | Your `signal` was aborted, or the session was destroyed | Usually ignore |
| `InvalidStateError` | The session was destroyed, or the extension restarted and lost it | Create a new session |
| `NotSupportedError` | Non-text modality; `responseConstraint`; no model can run on this device | Fall back |
| `NetworkError` | A cloud provider was unreachable or returned an error | Retry or fall back |
| `DataError` | A cloud provider rejected the request (for example an invalid model name) | Fall back |
| `OperationError` | The extension restarted mid-request, or an internal error | Retry once with a new session |

Invalid arguments, such as a bad role or a malformed message array, throw a plain `TypeError`.

### 12. Limits

The user can change all of these in the extension's options; the defaults are:

| Limit | Default | Error when exceeded |
| --- | --- | --- |
| Open sessions per site | 2 | `QuotaExceededError` on `create()`/`clone()` |
| Tokens per minute per site | 20,000 | `QuotaExceededError` on `prompt()` |
| Tokens per day per site | 200,000 | `QuotaExceededError` |
| Max context per session | 8,192 tokens | Oldest turns dropped; `QuotaExceededError` if one prompt is too large |
| Monthly tokens per cloud provider | 2,000,000 | `QuotaExceededError` |

Also:
- Local generation is queued: one request runs at a time across all sites, so expect some waiting under load.
- Background tabs can only start generation if the user chose **Always allow** for your site.
- Only the top-level page gets the API. Iframes, including same-origin ones, don't.

### 13. Falling back when there is no model

Plan for the model to be missing: the extension isn't installed, the site isn't enabled, the user denied it, or the device can't run a model. The [`@local-llm/web`](packages/web) helper in this repository wraps detection and fallback. It isn't published to npm yet: build it from `packages/web` (`npm run build` there) or copy `packages/web/src/index.ts` into your project.

```js
import { createOrFallback, detect, getLanguageModel } from "@local-llm/web";

detect(); // "native" | "extension" | null, synchronous

const found = await getLanguageModel({ timeout: 500 }); // waits for the extension to inject
if (found) console.log(found.source, await found.info());

// Create a session, or run your fallback with a reason
const session = await createOrFallback({
  create: { initialPrompts: [{ role: "system", content: "Be brief." }] },
  fallback: (reason) => {
    console.warn("No local model:", reason); // "no-implementation" | "unavailable" | "NotAllowedError: …"
    return null;
  },
});
```

A common pattern is to use the local model when present and your own server otherwise:

```js
async function ask(question) {
  const session = await createOrFallback({ fallback: () => null });
  if (!session) {
    const res = await fetch("/api/ask", { method: "POST", body: JSON.stringify({ question }) });
    return res.text();
  }
  try {
    return await session.prompt(question);
  } finally {
    session.destroy();
  }
}
```

### 14. Complete example

A chat box with streaming, a stop button, download progress and fallback, in plain HTML and JavaScript:

```html
<div id="log"></div>
<progress id="dl" max="1" hidden></progress>
<form id="f"><input id="q" autocomplete="off" /><button>Send</button><button type="button" id="stop">Stop</button></form>

<script type="module">
  const log = document.getElementById("log");
  const dl = document.getElementById("dl");
  let session, ac;

  async function getSession() {
    if (session) return session;
    if (!("LanguageModel" in window)) throw new Error("Enable the Local LLM extension on this site.");
    if ((await LanguageModel.availability()) === "unavailable") throw new Error("No model available.");
    session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: "You are a helpful, concise assistant." }],
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => { dl.hidden = e.loaded >= 1; dl.value = e.loaded; });
      },
    });
    return session;
  }

  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const q = document.getElementById("q").value;
    const out = log.appendChild(document.createElement("p"));
    ac = new AbortController();
    try {
      const s = await getSession();
      for await (const chunk of s.promptStreaming(q, { signal: ac.signal })) out.textContent += chunk;
    } catch (err) {
      if (err.name === "AbortError") return;
      if (err.name === "InvalidStateError") session = null; // lost; recreate next time
      out.textContent = `⚠ ${err.name}: ${err.message}`;
    }
  };
  document.getElementById("stop").onclick = () => ac?.abort();
  addEventListener("pagehide", () => session?.destroy());
</script>
```

### 15. Testing your integration

- **Local origin:** serve your app (for example `http://localhost:3000`), then enable that origin from the toolbar icon or the options page. Ports are respected: enabling `localhost:3000` doesn't enable `localhost:8080`.
- **Without downloading a model:** in the extension's options, set the model to **Echo (test engine, no model)**. Every prompt then returns `Echo #<turn>: <your text>`, which is instant and deterministic, so it suits UI work and automated tests.
- **Conformance page:** `npm run demo`, open http://localhost:8787 and enable that origin. It runs a checklist (availability, create, prompt, streaming, abort, clone, destroy, errors) against whichever implementation is present, the extension or Chrome's native one.
- **Reset consent:** the options page has **Reset consent** and **Revoke** per site, to replay the first-run experience.

### API reference

| Member | Notes |
| --- | --- |
| `LanguageModel.availability(options?)` | `"available" \| "downloadable" \| "downloading" \| "unavailable"`; reflects consent state |
| `LanguageModel.params()` | `{ defaultTopK, maxTopK, defaultTemperature, maxTemperature }` |
| `LanguageModel.create(options?)` | `initialPrompts`, `temperature` + `topK`, `signal`, `monitor`, `expectedInputs`/`expectedOutputs` (text only) |
| `session.prompt(input, { signal })` | Resolves with the full text |
| `session.promptStreaming(input, { signal })` | `ReadableStream<string>` of deltas |
| `session.append(input, { signal })` | Adds messages without generating |
| `session.measureInputUsage(input)` | Token count (`countPromptTokens` alias) |
| `session.inputUsage`, `session.inputQuota` | Also as `contextUsage`, `contextWindow` |
| `session.temperature`, `session.topK` | Effective sampling values |
| `session.clone({ signal })` | Copies the conversation |
| `session.destroy()` | Frees the session |
| `window.localLLM.info()` | Extension only: `{ name, backend, version }` |
| `window.localLLM.version`, `window.localLLM.overridesNative` | Extension only |
| `localllm:ready` event on `window` | Fired when the extension's API is injected |
| Not yet | `responseConstraint`, tool calling (planned under `window.localLLM.tools`), image/audio input, `quotaoverflow` event |

### Security and privacy notes for app developers

- **Your site never handles keys or model files.** Cloud keys stay inside the extension; your page receives model output only.
- **The user controls the backend.** A site may be served by a local model or by a cloud provider the user allowed for it. When cloud is used, the consent dialog tells the user that prompts leave their device and are billed to their key. Don't assume prompts stay on the device.
- **All scripts on an approved site share access.** Once the user approves your origin, any script running on it can call the model, third-party ads and analytics included. Keep untrusted scripts off pages that use it, or use a dedicated subdomain.
- **No browsing data crosses over.** The API exposes only text generation: no page content, tabs, history or extension features.
- **Usage is visible to the user.** The extension logs origin, time and token counts (never prompt text), and the user can revoke your site at any time. Handle `NotAllowedError` gracefully.

---

## Architecture

```
page ── window.LanguageModel (polyfill.js, MAIN world, holds no model)
  │  MessageChannel + per-page nonce
  ▼
content script relay (bridge.js, ISOLATED world: schema check, visibility)
  │  chrome.runtime port
  ▼
service worker (router: origin from port.sender only, consent, rate limits, spend caps)   ← trust boundary
  │  chrome.runtime port
  ▼
offscreen host (sessions, FIFO queue, one loaded model)
  ├─ local:  Transformers.js · WebLLM · wllama · Chrome built-in (Nano) · echo (tests)
  └─ cloud:  AnthropicAdapter · GeminiAdapter · OpenAICompatAdapter (OpenAI, xAI, DeepSeek, OpenRouter, Ollama, LM Studio, …)
```

- The page-side stub only tracks request ids; it holds no model and has no extension privileges.
- The service worker trusts only the origin Chrome reports for the connection, never anything inside a message, and validates every message against a strict schema.
- The offscreen host loads the model once for every tab and site and streams text pieces back up the same path.

See `CLAUDE.md` for the source layout and the rules each layer follows.

## Development

| Command | What it does |
| --- | --- |
| `npm run build` | Production build to `dist/` (readable, not minified) |
| `npm run watch` | Rebuild on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests (protocol, policy, limits, SSE, adapters, keystore, helper package) |
| `npm run test:e2e` | Builds `dist-test/` and runs Playwright against the unpacked extension with the echo engine |
| `npm run demo` | Serves the conformance page on http://localhost:8787 |
| `npm run fetch:webllm-libs` | Downloads WebLLM model libraries into `vendor/webllm-libs/` for bundling |

Further docs: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md), [`docs/STATUS.md`](docs/STATUS.md), [`docs/STORE.md`](docs/STORE.md) (Chrome Web Store notes).
